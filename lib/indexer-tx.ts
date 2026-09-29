import { cached } from "@/lib/cache";
import { indexerPool, poolFor } from "@/lib/indexer-db";
import { coverageOf, type CoverageRange } from "@/lib/indexer-coverage";

/**
 * Transaction, account and IBC reads on the indexer's version-4 tables
 * (docs/INDEXER.md, "Contract with Scan (extract version 4)").
 *
 * Every read gates on the capability it needs and fails soft: no pool, a
 * capability not yet covered, or a table the deployed schema doesn't have yet
 * all come back as null, and each caller keeps its live path for that case.
 */

// ── roles ───────────────────────────────────────────────────────────────────

/** tx_party.roles bits, as the indexer writes them. */
export const ROLE = {
  signer: 1,
  feePayer: 2,
  feeGranter: 4,
  sender: 8,
  recipient: 16,
  delegator: 32,
  validator: 64,
  voter: 128,
  depositor: 256,
  proposer: 512,
  granter: 1024,
  grantee: 2048,
  relayer: 4096,
  other: 8192,
} as const;

/**
 * The words a list shows for a party's roles, most telling first. Signing and
 * paying the fee say least, so they only show when nothing else applies.
 */
const ROLE_WORDS: [number, string][] = [
  [ROLE.relayer, "relayed"],
  [ROLE.sender, "sent"],
  [ROLE.recipient, "received"],
  [ROLE.delegator, "delegated"],
  [ROLE.validator, "validator"],
  [ROLE.voter, "voted"],
  [ROLE.depositor, "deposited"],
  [ROLE.proposer, "proposed"],
  [ROLE.granter, "granter"],
  [ROLE.grantee, "grantee"],
  [ROLE.feeGranter, "fee grant"],
  [ROLE.signer, "signed"],
  [ROLE.feePayer, "paid fee"],
  [ROLE.other, "party"],
];

/** Up to `max` words for a roles bitmask; signer/fee payer only as a fallback. */
export function roleWords(mask: number, max = 2): string[] {
  const words: string[] = [];
  for (const [bit, word] of ROLE_WORDS) {
    if ((mask & bit) === 0) continue;
    if ((bit === ROLE.signer || bit === ROLE.feePayer || bit === ROLE.other) && words.length > 0) {
      continue;
    }
    words.push(word);
    if (words.length >= max) break;
  }
  return words;
}

// ── account history ─────────────────────────────────────────────────────────

export interface MovementRow {
  txHash: string;
  kind: string;
  from: string | null;
  to: string | null;
  denom: string;
  amount: string;
}

export interface PartyTx {
  hash: string;
  height: string;
  time: string;
  code: number;
  msgTypes: string[];
  roles: number;
  feeCoins: { denom: string; amount: string }[];
  gasUsed: string | null;
  gasWanted: string | null;
  signer: string | null;
  /** This address's own movements in the transaction, in event order. */
  movements: MovementRow[];
}

export interface PartyPage {
  txs: PartyTx[];
  /** True when more party rows exist above the coverage floor. */
  more: boolean;
  /** Lowest height tx_party covers; history below it comes from the old path. */
  floor: number;
  /** Whether movements come from version-4 transfers (both eras correct). */
  exactMovements: boolean;
}

/** Keyset cursor for the tx_party walk: newest first, hash descending. */
export interface PartyCursor {
  height: string;
  hash: string;
}

export function encodePartyCursor(c: PartyCursor): string {
  return `i4:${c.height}:${c.hash}`;
}

export function decodePartyCursor(value: string | null | undefined): PartyCursor | null {
  const m = value?.match(/^i4:(\d+):([0-9A-Fa-f]+)$/);
  return m ? { height: m[1], hash: m[2] } : null;
}

/** The documented account-history query, as text and parameters. */
export function partyHistoryQuery(
  chainId: string,
  address: string,
  range: CoverageRange,
  limit: number,
  before: PartyCursor | null
): { text: string; values: unknown[] } {
  const values: unknown[] = [chainId, address, range.lo, range.hi, limit + 1];
  let keyset = "";
  if (before) {
    values.push(before.height, before.hash);
    keyset = "AND (p.height, p.tx_hash) < ($6::bigint, $7)";
  }
  return {
    text: `SELECT p.height::text, p.tx_hash, p.roles, t.time::text, t.code, t.msg_types,
                  t.fee_coins, t.fee_denom, t.fee_amount::text,
                  t.gas_used::text, t.gas_wanted::text, t.signer
             FROM tx_party p
             JOIN tx t ON t.chain_id = p.chain_id AND t.hash = p.tx_hash
            WHERE p.chain_id = $1 AND p.address = $2
              AND p.height BETWEEN $3 AND $4
              ${keyset}
            ORDER BY p.height DESC, p.tx_hash DESC
            LIMIT $5`,
    values,
  };
}

/** This address's own movements for a page of transactions. */
export function movementsQuery(
  chainId: string,
  address: string,
  hashes: string[]
): { text: string; values: unknown[] } {
  return {
    text: `SELECT tx_hash, kind, from_addr, to_addr, denom, amount::text
             FROM transfer
            WHERE chain_id = $1 AND tx_hash = ANY($2) AND kind <> 'fee'
              AND (from_addr = $3 OR to_addr = $3)
            ORDER BY tx_hash, event_seq NULLS LAST, msg_index, coin_index`,
    values: [chainId, hashes, address],
  };
}

function parseCoinsJson(value: unknown): { denom: string; amount: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c) =>
    c && typeof c === "object" && typeof c.denom === "string" && c.amount != null
      ? [{ denom: c.denom, amount: String(c.amount) }]
      : []
  );
}

/**
 * One page of an address's transactions from tx_party: every transaction it
 * touched in any role, failed ones included. Null when tx_party is not covered
 * or the read fails; the caller then uses the older union.
 */
export async function partyHistory(
  chainId: string,
  address: string,
  limit = 50,
  before: PartyCursor | null = null
): Promise<PartyPage | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const [range, transfers] = await Promise.all([
    coverageOf(chainId, "tx_party"),
    coverageOf(chainId, "transfers"),
  ]);
  if (!range) return null;

  try {
    const q = partyHistoryQuery(chainId, address, range, limit, before);
    const res = await pool.query<{
      height: string;
      tx_hash: string;
      roles: number;
      time: string;
      code: number;
      msg_types: string[] | null;
      fee_coins: unknown;
      fee_denom: string | null;
      fee_amount: string | null;
      gas_used: string | null;
      gas_wanted: string | null;
      signer: string | null;
    }>(q.text, q.values);

    const rows = res.rows.slice(0, limit);
    const byHash = new Map<string, MovementRow[]>();
    if (rows.length > 0) {
      const m = movementsQuery(chainId, address, rows.map((r) => r.tx_hash));
      const mv = await pool.query<{
        tx_hash: string;
        kind: string;
        from_addr: string | null;
        to_addr: string | null;
        denom: string;
        amount: string;
      }>(m.text, m.values);
      for (const r of mv.rows) {
        const list = byHash.get(r.tx_hash) ?? [];
        list.push({
          txHash: r.tx_hash,
          kind: r.kind,
          from: r.from_addr,
          to: r.to_addr,
          denom: r.denom,
          amount: r.amount,
        });
        byHash.set(r.tx_hash, list);
      }
    }

    return {
      txs: rows.map((r) => {
        const coins = parseCoinsJson(r.fee_coins);
        return {
          hash: r.tx_hash,
          height: r.height,
          time: r.time,
          code: r.code,
          msgTypes: r.msg_types ?? [],
          roles: r.roles,
          feeCoins:
            coins.length > 0
              ? coins
              : r.fee_denom && r.fee_amount
                ? [{ denom: r.fee_denom, amount: r.fee_amount }]
                : [],
          gasUsed: r.gas_used,
          gasWanted: r.gas_wanted,
          signer: r.signer,
          movements: byHash.get(r.tx_hash) ?? [],
        };
      }),
      more: res.rows.length > limit,
      floor: range.lo,
      exactMovements: transfers !== null && transfers.lo <= range.lo,
    };
  } catch {
    return null;
  }
}

/**
 * One line's movement from an address's rows: outgoing wins when a
 * transaction both sent and received (a swap reads as what was paid), coins
 * summed per denom, and the counterparty named only when it is one address.
 */
export function netMovement(
  movements: MovementRow[],
  address: string
): { from: string | null; to: string | null; amount: { denom: string; amount: string }[] } | null {
  const out = movements.filter((m) => m.from === address && m.to !== address);
  const inc = movements.filter((m) => m.to === address && m.from !== address);
  const side = out.length > 0 ? out : inc;
  if (side.length === 0) return null;
  const sums = new Map<string, bigint>();
  for (const m of side) {
    if (!/^\d+$/.test(m.amount)) continue;
    sums.set(m.denom, (sums.get(m.denom) ?? BigInt(0)) + BigInt(m.amount));
  }
  const others = new Set(side.map((m) => (out.length > 0 ? m.to : m.from)));
  const other = others.size === 1 ? [...others][0] : null;
  return {
    from: out.length > 0 ? address : other,
    to: out.length > 0 ? other : address,
    amount: [...sums].map(([denom, amount]) => ({ denom, amount: amount.toString() })),
  };
}

// ── staking history ─────────────────────────────────────────────────────────

export interface StakingEventRow {
  height: string;
  txHash: string;
  time: string;
  kind: string;
  validator: string | null;
  validatorDst: string | null;
  delegator: string | null;
  amount: string | null;
  denom: string | null;
  completionTime: string | null;
}

/** An address's staking events, newest first. Null when not covered. */
export async function stakingHistory(
  chainId: string,
  delegator: string,
  limit = 100
): Promise<StakingEventRow[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const range = await coverageOf(chainId, "staking_event");
  if (!range) return null;
  return cached(`idx4:stake:${chainId}:${delegator}`, 30_000, async () => {
    const res = await pool.query<{
      height: string;
      tx_hash: string;
      time: string;
      kind: string;
      validator: string | null;
      validator_dst: string | null;
      delegator: string | null;
      amount: string | null;
      denom: string | null;
      completion_time: string | null;
    }>(
      `SELECT height::text, tx_hash, time::text, kind, validator, validator_dst,
              delegator, amount::text, denom, completion_time::text
         FROM staking_event
        WHERE chain_id = $1 AND delegator = $2 AND height BETWEEN $3 AND $4
        ORDER BY staking_event.height DESC, event_seq DESC
        LIMIT $5`,
      [chainId, delegator, range.lo, range.hi, limit]
    );
    return res.rows.map((r) => ({
      height: r.height,
      txHash: r.tx_hash,
      time: r.time,
      kind: r.kind,
      validator: r.validator,
      validatorDst: r.validator_dst,
      delegator: r.delegator,
      amount: r.amount,
      denom: r.denom,
      completionTime: r.completion_time,
    }));
  }).catch(() => null);
}

// ── IBC packets ─────────────────────────────────────────────────────────────

export interface PacketRow {
  direction: "in" | "out";
  srcPort: string;
  srcChannel: string;
  dstPort: string | null;
  dstChannel: string | null;
  sequence: string;
  sender: string | null;
  receiver: string | null;
  denom: string | null;
  amount: string | null;
  memo: string | null;
  sendHeight: string | null;
  sendTx: string | null;
  sendTime: string | null;
  recvHeight: string | null;
  recvTx: string | null;
  recvTime: string | null;
  recvRelayer: string | null;
  ackHeight: string | null;
  ackTx: string | null;
  ackTime: string | null;
  ackRelayer: string | null;
  ackOk: boolean | null;
  ackError: string | null;
  timeoutTx: string | null;
}

/** Where a packet stands, from what has been seen of it on this chain. */
export function packetStatus(p: PacketRow): "acked" | "error" | "timeout" | "received" | "pending" {
  if (p.timeoutTx) return "timeout";
  if (p.ackOk === false) return "error";
  if (p.ackOk === true || p.ackTx) return "acked";
  if (p.recvTx) return "received";
  return "pending";
}

/** Seconds from send to the latest leg seen here, when both ends carry a time. */
export function packetLatency(p: PacketRow): number | null {
  const start = p.sendTime ? Date.parse(p.sendTime) : NaN;
  const end = p.ackTime ?? p.recvTime;
  const stop = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < start) return null;
  return Math.round((stop - start) / 1000);
}

const PACKET_COLUMNS = `direction, src_port, src_channel, dst_port, dst_channel, sequence::text,
  sender, receiver, denom, amount::text, memo,
  send_height::text, send_tx, send_time::text,
  recv_height::text, recv_tx, recv_time::text, recv_relayer,
  ack_height::text, ack_tx, ack_time::text, ack_relayer, ack_ok, ack_error, timeout_tx`;

type PacketDbRow = {
  direction: string;
  src_port: string;
  src_channel: string;
  dst_port: string | null;
  dst_channel: string | null;
  sequence: string;
  sender: string | null;
  receiver: string | null;
  denom: string | null;
  amount: string | null;
  memo: string | null;
  send_height: string | null;
  send_tx: string | null;
  send_time: string | null;
  recv_height: string | null;
  recv_tx: string | null;
  recv_time: string | null;
  recv_relayer: string | null;
  ack_height: string | null;
  ack_tx: string | null;
  ack_time: string | null;
  ack_relayer: string | null;
  ack_ok: boolean | null;
  ack_error: string | null;
  timeout_tx: string | null;
};

function toPacket(r: PacketDbRow): PacketRow {
  return {
    direction: r.direction === "in" ? "in" : "out",
    srcPort: r.src_port,
    srcChannel: r.src_channel,
    dstPort: r.dst_port,
    dstChannel: r.dst_channel,
    sequence: r.sequence,
    sender: r.sender,
    receiver: r.receiver,
    denom: r.denom,
    amount: r.amount,
    memo: r.memo,
    sendHeight: r.send_height,
    sendTx: r.send_tx,
    sendTime: r.send_time,
    recvHeight: r.recv_height,
    recvTx: r.recv_tx,
    recvTime: r.recv_time,
    recvRelayer: r.recv_relayer,
    ackHeight: r.ack_height,
    ackTx: r.ack_tx,
    ackTime: r.ack_time,
    ackRelayer: r.ack_relayer,
    ackOk: r.ack_ok,
    ackError: r.ack_error,
    timeoutTx: r.timeout_tx,
  };
}

/** The packets a transaction sent, received, acknowledged or timed out. */
export async function packetsForTx(chainId: string, txHash: string): Promise<PacketRow[] | null> {
  const hash = txHash.toUpperCase();
  const pool = poolFor(chainId);
  if (!pool) return null;
  const range = await coverageOf(chainId, "ibc_packet");
  if (!range) return null;
  return cached(`idx4:pkt-tx:${chainId}:${hash}`, 15_000, async () => {
    const res = await pool.query<PacketDbRow>(
      `SELECT ${PACKET_COLUMNS} FROM ibc_packet
        WHERE chain_id = $1
          AND (send_tx = $2 OR recv_tx = $2 OR ack_tx = $2 OR timeout_tx = $2)
        ORDER BY ibc_packet.sequence`,
      [chainId, hash]
    );
    return res.rows.map(toPacket);
  }).catch(() => null);
}

/** An address's transfers over IBC, newest first. */
export async function packetsForAddress(
  chainId: string,
  address: string,
  limit = 100
): Promise<PacketRow[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const range = await coverageOf(chainId, "ibc_packet");
  if (!range) return null;
  return cached(`idx4:pkt-addr:${chainId}:${address}`, 30_000, async () => {
    const res = await pool.query<PacketDbRow>(
      `SELECT ${PACKET_COLUMNS} FROM (
         SELECT * FROM ibc_packet WHERE chain_id = $1 AND sender = $2
         UNION
         SELECT * FROM ibc_packet WHERE chain_id = $1 AND receiver = $2
       ) p
       ORDER BY COALESCE(send_height, recv_height) DESC NULLS LAST
       LIMIT $3`,
      [chainId, address, limit]
    );
    return res.rows.map(toPacket);
  }).catch(() => null);
}

export interface RelayerPacketStats {
  relayer: string;
  packets: number;
  /** Median seconds from send to the leg this relayer delivered. */
  medianLatency: number | null;
}

export interface ChannelPacketStats {
  channel: string;
  direction: "in" | "out";
  packets: number;
  errors: number;
  timeouts: number;
  medianLatency: number | null;
}

/**
 * Packet work per relayer and per channel over a window. A relayer counts for
 * each leg it delivered here: receives on inbound packets, acknowledgements
 * on outbound ones.
 */
export async function packetStats(
  chainId: string,
  days = 30
): Promise<{ relayers: RelayerPacketStats[]; channels: ChannelPacketStats[] } | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const range = await coverageOf(chainId, "ibc_packet");
  if (!range) return null;
  return cached(`idx4:pkt-stats:${chainId}:${days}`, 300_000, async () => {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [relayers, channels] = await Promise.all([
      pool.query<{ relayer: string; packets: string; median: string | null }>(
        `SELECT relayer, count(*)::text AS packets,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)::text AS median
           FROM (
             SELECT recv_relayer AS relayer,
                    EXTRACT(EPOCH FROM recv_time - send_time) AS secs
               FROM ibc_packet
              WHERE chain_id = $1 AND direction = 'in' AND recv_relayer IS NOT NULL
                AND recv_time >= $2
             UNION ALL
             SELECT ack_relayer, EXTRACT(EPOCH FROM ack_time - send_time)
               FROM ibc_packet
              WHERE chain_id = $1 AND direction = 'out' AND ack_relayer IS NOT NULL
                AND ack_time >= $2
           ) legs
          GROUP BY relayer
          ORDER BY count(*) DESC
          LIMIT 50`,
        [chainId, since]
      ),
      pool.query<{
        channel: string;
        direction: string;
        packets: string;
        errors: string;
        timeouts: string;
        median: string | null;
      }>(
        `SELECT CASE WHEN direction = 'out' THEN src_channel ELSE dst_channel END AS channel,
                direction,
                count(*)::text AS packets,
                count(*) FILTER (WHERE ack_ok = false)::text AS errors,
                count(*) FILTER (WHERE timeout_tx IS NOT NULL)::text AS timeouts,
                percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM COALESCE(ack_time, recv_time) - send_time)
                )::text AS median
           FROM ibc_packet
          WHERE chain_id = $1
            AND COALESCE(send_time, recv_time) >= $2
          GROUP BY 1, 2
          ORDER BY count(*) DESC`,
        [chainId, since]
      ),
    ]);
    const secs = (v: string | null) => {
      const n = v === null ? NaN : Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };
    return {
      relayers: relayers.rows.map((r) => ({
        relayer: r.relayer,
        packets: Number(r.packets),
        medianLatency: secs(r.median),
      })),
      channels: channels.rows
        .filter((c) => c.channel)
        .map((c) => ({
          channel: c.channel,
          direction: c.direction === "in" ? ("in" as const) : ("out" as const),
          packets: Number(c.packets),
          errors: Number(c.errors),
          timeouts: Number(c.timeouts),
          medianLatency: secs(c.median),
        })),
    };
  }).catch(() => null);
}

// ── transaction detail ──────────────────────────────────────────────────────

export interface IndexedTxDetail {
  hash: string;
  height: string;
  time: string;
  code: number;
  codespace: string | null;
  gasUsed: string | null;
  gasWanted: string | null;
  memo: string | null;
  signers: string[];
  feeCoins: { denom: string; amount: string }[];
  feeGranter: string | null;
  msgTypes: string[];
  /** From tx_msg when covered: top-level messages with authz inner ones under them. */
  messages: { msgIndex: number; typeUrl: string; sender: string | null; inner: { typeUrl: string; sender: string | null }[] }[] | null;
  /** Every movement, in event order, when transfers is covered. */
  movements: MovementRow[] | null;
  /** Whether memo, signers, fee coins and granter are populated (tx_meta). */
  hasMeta: boolean;
}

/**
 * A transaction as the index holds it. Used when the node can't serve the
 * transaction, and to fill what the node's answer lacks. Null when the index
 * doesn't have it.
 */
export async function txFromIndex(chainId: string, hash: string): Promise<IndexedTxDetail | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const [meta, msgs, transfers] = await Promise.all([
    coverageOf(chainId, "tx_meta"),
    coverageOf(chainId, "tx_msg"),
    coverageOf(chainId, "transfers"),
  ]);
  return cached(`idx4:tx:${chainId}:${hash}`, 60_000, async () => {
    const base = await pool.query<{
      hash: string;
      height: string;
      time: string;
      code: number;
      gas_used: string | null;
      gas_wanted: string | null;
      signer: string | null;
      msg_types: string[] | null;
      fee_denom: string | null;
      fee_amount: string | null;
    }>(
      `SELECT hash, height::text, time::text, code, gas_used::text, gas_wanted::text,
              signer, msg_types, fee_denom, fee_amount::text
         FROM tx WHERE chain_id = $1 AND hash = $2`,
      [chainId, hash.toUpperCase()]
    );
    const t = base.rows[0];
    if (!t) return null;
    const height = Number(t.height);
    const covered = (r: CoverageRange | null) => r !== null && height >= r.lo && height <= r.hi;

    let codespace: string | null = null;
    let memo: string | null = null;
    let signers: string[] = t.signer ? [t.signer] : [];
    let feeCoins =
      t.fee_denom && t.fee_amount ? [{ denom: t.fee_denom, amount: t.fee_amount }] : [];
    let feeGranter: string | null = null;
    const hasMeta = covered(meta);
    if (hasMeta) {
      const m = await pool.query<{
        codespace: string | null;
        memo: string | null;
        signers: string[] | null;
        fee_coins: unknown;
        fee_granter: string | null;
      }>(
        `SELECT codespace, memo, signers, fee_coins, fee_granter
           FROM tx WHERE chain_id = $1 AND hash = $2`,
        [chainId, t.hash]
      );
      const r = m.rows[0];
      if (r) {
        codespace = r.codespace;
        memo = r.memo;
        if (r.signers && r.signers.length > 0) signers = r.signers;
        const coins = parseCoinsJson(r.fee_coins);
        if (coins.length > 0) feeCoins = coins;
        feeGranter = r.fee_granter;
      }
    }

    let messages: IndexedTxDetail["messages"] = null;
    if (covered(msgs)) {
      const res = await pool.query<{
        msg_index: number;
        inner_index: number;
        type_url: string;
        sender: string | null;
      }>(
        `SELECT msg_index, inner_index, type_url, sender FROM tx_msg
          WHERE chain_id = $1 AND tx_hash = $2
          ORDER BY msg_index, inner_index`,
        [chainId, t.hash]
      );
      messages = [];
      for (const r of res.rows) {
        if (r.inner_index < 0) {
          messages.push({ msgIndex: r.msg_index, typeUrl: r.type_url, sender: r.sender, inner: [] });
        } else {
          const parent = messages.find((m) => m.msgIndex === r.msg_index);
          if (parent) parent.inner.push({ typeUrl: r.type_url, sender: r.sender });
        }
      }
    }

    let movements: MovementRow[] | null = null;
    if (covered(transfers)) {
      const res = await pool.query<{
        kind: string;
        from_addr: string | null;
        to_addr: string | null;
        denom: string;
        amount: string;
      }>(
        `SELECT kind, from_addr, to_addr, denom, amount::text FROM transfer
          WHERE chain_id = $1 AND tx_hash = $2
          ORDER BY event_seq, coin_index`,
        [chainId, t.hash]
      );
      movements = res.rows.map((r) => ({
        txHash: t.hash,
        kind: r.kind,
        from: r.from_addr,
        to: r.to_addr,
        denom: r.denom,
        amount: r.amount,
      }));
    }

    return {
      hash: t.hash,
      height: t.height,
      time: t.time,
      code: t.code,
      codespace,
      gasUsed: t.gas_used,
      gasWanted: t.gas_wanted,
      memo,
      signers,
      feeCoins,
      feeGranter,
      msgTypes: t.msg_types ?? [],
      messages,
      movements,
      hasMeta,
    };
  }).catch(() => null);
}

// ── gno.land history and per-address counts (migration 011) ─────────────────

export interface GnoPartyRow {
  height: number;
  /** Uppercase hex, as gno_tx stores it. */
  hash: string;
  roles: number;
  time: string | null;
  success: boolean;
}

export interface GnoPartyPage {
  rows: GnoPartyRow[];
  /** "g4:<height>:<HEX>" for the next (older) page, or null at the end. */
  next: string | null;
}

/** Parse a "g4:<height>:<HEX>" cursor. */
export function parseGnoCursor(cursor: string | null | undefined): { height: number; hash: string } | null {
  const m = cursor?.match(/^g4:(\d+):([0-9A-F]+)$/i);
  return m ? { height: Number(m[1]), hash: m[2].toUpperCase() } : null;
}

/**
 * One page of a gno address's transactions from gno_tx_party, newest first,
 * keyset-paged on the primary key (the contract's query). Null when the index
 * is unavailable or does not cover gno history, so the caller keeps its
 * GraphQL path.
 */
export async function gnoPartyPage(
  chainId: string,
  address: string,
  cursor: string | null | undefined,
  limit = 50
): Promise<GnoPartyPage | null> {
  const cov = await coverageOf(chainId, "gno_tx_party");
  const pool = indexerPool();
  if (!cov || !pool) return null;
  const before = parseGnoCursor(cursor);
  try {
    const params: unknown[] = [chainId, address, cov.lo, cov.hi, limit + 1];
    let keyset = "";
    if (before) {
      params.push(before.height, before.hash);
      keyset = "AND (p.height, p.tx_hash) < ($6, $7)";
    }
    const res = await pool.query<{
      height: string;
      tx_hash: string;
      roles: number;
      time: string | null;
      success: boolean;
    }>(
      `SELECT p.height::text, p.tx_hash, p.roles, t.time::text, t.success
         FROM gno_tx_party p
         JOIN gno_tx t ON t.chain_id = p.chain_id AND t.hash = p.tx_hash
        WHERE p.chain_id = $1 AND p.address = $2
          AND p.height BETWEEN $3 AND $4
          ${keyset}
        ORDER BY p.height DESC, p.tx_hash DESC
        LIMIT $5`,
      params
    );
    const all = res.rows.map((r) => ({
      height: Number(r.height),
      hash: r.tx_hash,
      roles: r.roles,
      time: r.time,
      success: r.success,
    }));
    const rows = all.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      rows,
      next: all.length > limit && last ? `g4:${last.height}:${last.hash}` : null,
    };
  } catch {
    return null;
  }
}

export interface AddressTxCount {
  count: number;
  /** False while coverage has not reached the chain's first block: "at least". */
  exact: boolean;
  /** Where the counted range starts, for "since block …". */
  since: { height: number; time: string | null };
  first: { height: number; time: string | null } | null;
  last: { height: number; time: string | null } | null;
}

/**
 * An address's transaction count and first/last activity from
 * address_tx_count. A lower bound until the capability's coverage starts at
 * the chain's first block; exact from then on.
 */
export async function addressTxCount(
  chainId: string,
  address: string,
  firstBlock = 1
): Promise<AddressTxCount | null> {
  const cov = await coverageOf(chainId, "address_tx_count");
  const pool = indexerPool();
  if (!cov || !pool) return null;
  return cached(`idx:count:${chainId}:${address}`, 15_000, async () => {
    const res = await pool.query<{
      tx_count: string;
      first_height: string | null;
      last_height: string | null;
      first_time: string | null;
      last_time: string | null;
    }>(
      `SELECT tx_count::text, first_height::text, last_height::text,
              first_time::text, last_time::text
         FROM address_tx_count WHERE chain_id = $1 AND address = $2`,
      [chainId, address]
    );
    const r = res.rows[0];
    return {
      count: r ? Number(r.tx_count) : 0,
      exact: cov.lo <= firstBlock,
      since: { height: cov.lo, time: cov.loTime },
      first: r?.first_height ? { height: Number(r.first_height), time: r.first_time } : null,
      last: r?.last_height ? { height: Number(r.last_height), time: r.last_time } : null,
    };
  }).catch(() => null);
}
