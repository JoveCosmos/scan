import { Pool, type PoolClient } from "pg";
import type {
  ExtractedBlock,
  IbcPacketRow,
  GovProposalRow,
  SlashRow,
  VoteRow,
} from "./extract";

/**
 * Postgres writes.
 *
 * A batch of heights is written inside a single transaction that also advances
 * the cursor, so the cursor can never claim a height whose rows are missing.
 * Every write is idempotent — upserts on natural keys, or a per-transaction
 * replace for `transfer` — which makes replaying a height harmless, the
 * property the whole crash-recovery story rests on.
 *
 * Rows are written a table at a time for the whole batch (`unnest` over one
 * array per column), not a statement per row. A refill writes tens of millions
 * of rows and a 2,000-output MultiSend is 2,000 of them in one transaction;
 * per-row round trips were the old writer's ceiling.
 */

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // The worker is one process doing one height at a time; a large pool would
    // only mask a bug.
    max: 4,
    application_name: "gata-indexer",
    // Without these, a pool that runs out of clients waits forever. The backfill
    // loop logs and retries anything that throws, so a failure is visible and
    // recoverable — but a wait produces no error, no log line and no progress,
    // and the job looks identical to one that has simply gone quiet. Better to
    // fail loudly into the retry that already exists.
    connectionTimeoutMillis: 10_000,
  });
}

/** Last occurrence wins, by key - one row per conflict target per statement. */
function lastBy<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

/** Column-wise merge: each field takes the latest non-null value seen. */
function mergeBy<T extends object>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const prev = m.get(k);
    if (!prev) {
      m.set(k, { ...r });
      continue;
    }
    for (const [f, v] of Object.entries(r)) {
      if (v !== null && v !== undefined) (prev as Record<string, unknown>)[f] = v;
    }
  }
  return [...m.values()];
}

const col = <T, V>(rows: T[], f: (r: T) => V): V[] => rows.map(f);

async function writeBlocks(
  client: PoolClient,
  chainId: string,
  data: ExtractedBlock[]
): Promise<void> {
  const full = data.filter((b) => !b.abciResultsMissing);
  const hollow = data.filter((b) => b.abciResultsMissing);

  // ── block ──
  if (full.length > 0) {
    await client.query(
      `INSERT INTO block (chain_id, height, time, proposer_cons, hash, tx_count, extract_version)
       SELECT $1, * FROM unnest($2::bigint[], $3::timestamptz[], $4::text[], $5::text[], $6::int[], $7::smallint[])
       ON CONFLICT (chain_id, height) DO UPDATE SET
         time = EXCLUDED.time,
         proposer_cons = EXCLUDED.proposer_cons,
         hash = EXCLUDED.hash,
         tx_count = EXCLUDED.tx_count,
         -- Only ever forwards. A refill re-reading a height must raise this, but
         -- an older build writing the same height must never lower it and quietly
         -- withdraw rows a newer extractor already stored.
         extract_version = GREATEST(block.extract_version, EXCLUDED.extract_version)`,
      [
        chainId,
        col(full, (b) => b.block.height),
        col(full, (b) => b.block.time),
        col(full, (b) => b.block.proposerCons),
        col(full, (b) => b.block.hash),
        col(full, (b) => b.block.txCount),
        col(full, (b) => b.extractVersion),
      ]
    );
  }
  if (hollow.length > 0) {
    // A node that dropped its ABCI results has nothing trustworthy to say about
    // what these blocks' transactions did. A block we already hold keeps what
    // it has; a new one is recorded as present but incomplete (version 0), so
    // coverage stops short of it until an archive that kept results refills it.
    await client.query(
      `INSERT INTO block (chain_id, height, time, proposer_cons, hash, tx_count, extract_version)
       SELECT $1, * FROM unnest($2::bigint[], $3::timestamptz[], $4::text[], $5::text[], $6::int[], $7::smallint[])
       ON CONFLICT (chain_id, height) DO NOTHING`,
      [
        chainId,
        col(hollow, (b) => b.block.height),
        col(hollow, (b) => b.block.time),
        col(hollow, (b) => b.block.proposerCons),
        col(hollow, (b) => b.block.hash),
        col(hollow, (b) => b.block.txCount),
        col(hollow, () => 0),
      ]
    );
  }

  // Missed signatures come from /block, not from the ABCI results: they are good
  // for every block, hollow or not.
  const missed = lastBy(
    data.flatMap((b) => b.missed),
    (m) => `${m.height}|${m.consAddr}`
  );
  if (missed.length > 0) {
    await client.query(
      `INSERT INTO missed_signature (chain_id, height, cons_addr, flag)
       SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::text[])
       ON CONFLICT (chain_id, height, cons_addr) DO UPDATE SET flag = EXCLUDED.flag`,
      [chainId, col(missed, (m) => m.height), col(missed, (m) => m.consAddr), col(missed, (m) => m.flag)]
    );
  }

  if (full.length === 0) return;

  // ── tx ──
  const txs = lastBy(full.flatMap((b) => b.txs), (t) => t.hash);
  if (txs.length > 0) {
    await client.query(
      `INSERT INTO tx (chain_id, hash, height, tx_index, time, code, codespace,
                       fee_denom, fee_amount, fee_coins, gas_used, gas_wanted,
                       signer, signers, fee_granter, memo, msg_types)
       SELECT $1, t.hash, t.height, t.tx_index, t.time, t.code, t.codespace,
              t.fee_denom, t.fee_amount, t.fee_coins::jsonb, t.gas_used, t.gas_wanted,
              t.signer,
              ARRAY(SELECT jsonb_array_elements_text(t.signers::jsonb)),
              t.fee_granter, t.memo,
              ARRAY(SELECT jsonb_array_elements_text(t.msg_types::jsonb))
         FROM unnest($2::text[], $3::bigint[], $4::int[], $5::timestamptz[], $6::int[], $7::text[],
                     $8::text[], $9::numeric[], $10::text[], $11::bigint[], $12::bigint[],
                     $13::text[], $14::text[], $15::text[], $16::text[], $17::text[])
           AS t(hash, height, tx_index, time, code, codespace, fee_denom, fee_amount, fee_coins,
                gas_used, gas_wanted, signer, signers, fee_granter, memo, msg_types)
       ON CONFLICT (chain_id, hash) DO UPDATE SET
         height = EXCLUDED.height,
         tx_index = EXCLUDED.tx_index,
         time = EXCLUDED.time,
         code = EXCLUDED.code,
         codespace = EXCLUDED.codespace,
         fee_denom = EXCLUDED.fee_denom,
         fee_amount = EXCLUDED.fee_amount,
         fee_coins = EXCLUDED.fee_coins,
         gas_used = EXCLUDED.gas_used,
         gas_wanted = EXCLUDED.gas_wanted,
         signer = EXCLUDED.signer,
         signers = EXCLUDED.signers,
         fee_granter = EXCLUDED.fee_granter,
         memo = EXCLUDED.memo,
         msg_types = EXCLUDED.msg_types`,
      [
        chainId,
        col(txs, (t) => t.hash),
        col(txs, (t) => t.height),
        col(txs, (t) => t.txIndex),
        col(txs, (t) => t.time),
        col(txs, (t) => t.code),
        col(txs, (t) => t.codespace),
        col(txs, (t) => t.feeDenom),
        col(txs, (t) => t.feeAmount),
        col(txs, (t) => JSON.stringify(t.feeCoins)),
        col(txs, (t) => t.gasUsed),
        col(txs, (t) => t.gasWanted),
        col(txs, (t) => t.signer),
        col(txs, (t) => JSON.stringify(t.signers)),
        col(txs, (t) => t.feeGranter),
        col(txs, (t) => t.memo),
        col(txs, (t) => JSON.stringify(t.msgTypes)),
      ]
    );
  }

  // ── transfer: replaced per transaction ──
  // Rows written by an older extractor sit under the old (message, kind) key,
  // and some of them are wrong (pre-upgrade transfers stored as fees), so the
  // transaction's rows are replaced wholesale rather than upserted over.
  const hashes = txs.map((t) => t.hash);
  if (hashes.length > 0) {
    await client.query(`DELETE FROM transfer WHERE chain_id = $1 AND tx_hash = ANY($2::text[])`, [chainId, hashes]);
  }
  const transfers = full.flatMap((b) => b.transfers);
  if (transfers.length > 0) {
    await client.query(
      `INSERT INTO transfer (chain_id, tx_hash, event_seq, coin_index, msg_index, authz_msg_index,
                             height, time, kind, from_addr, to_addr, denom, amount)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::int[],
                                $7::bigint[], $8::timestamptz[], $9::text[], $10::text[], $11::text[],
                                $12::text[], $13::numeric[])`,
      [
        chainId,
        col(transfers, (t) => t.txHash),
        col(transfers, (t) => t.eventSeq),
        col(transfers, (t) => t.coinIndex),
        col(transfers, (t) => t.msgIndex),
        col(transfers, (t) => t.authzMsgIndex),
        col(transfers, (t) => t.height),
        col(transfers, (t) => t.time),
        col(transfers, (t) => t.kind),
        col(transfers, (t) => t.fromAddr),
        col(transfers, (t) => t.toAddr),
        col(transfers, (t) => t.denom),
        col(transfers, (t) => t.amount),
      ]
    );
  }

  // ── tx_party ──
  const parties = lastBy(full.flatMap((b) => b.txParties), (p) => `${p.address}|${p.height}|${p.txHash}`);
  if (parties.length > 0) {
    await client.query(
      `INSERT INTO tx_party (chain_id, address, height, tx_hash, roles)
       SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::int[])
       ON CONFLICT (chain_id, address, height, tx_hash) DO UPDATE SET roles = EXCLUDED.roles`,
      [chainId, col(parties, (p) => p.address), col(parties, (p) => p.height), col(parties, (p) => p.txHash), col(parties, (p) => p.roles)]
    );
  }

  // ── tx_msg ──
  const msgs = lastBy(full.flatMap((b) => b.txMsgs), (m) => `${m.txHash}|${m.msgIndex}|${m.innerIndex}`);
  if (msgs.length > 0) {
    await client.query(
      `INSERT INTO tx_msg (chain_id, tx_hash, msg_index, inner_index, type_url, sender, height)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::bigint[])
       ON CONFLICT (chain_id, tx_hash, msg_index, inner_index) DO UPDATE SET
         type_url = EXCLUDED.type_url, sender = EXCLUDED.sender, height = EXCLUDED.height`,
      [
        chainId,
        col(msgs, (m) => m.txHash),
        col(msgs, (m) => m.msgIndex),
        col(msgs, (m) => m.innerIndex),
        col(msgs, (m) => m.typeUrl),
        col(msgs, (m) => m.sender),
        col(msgs, (m) => m.height),
      ]
    );
  }

  // ── validator_key (before anything that resolves through it) ──
  const keys = full.flatMap((b) => b.validatorKeys);
  if (keys.length > 0) {
    const first = new Map<string, (typeof keys)[number]>();
    for (const k of keys) if (!first.has(k.operator)) first.set(k.operator, k);
    const ks = [...first.values()];
    await client.query(
      `INSERT INTO validator_key (chain_id, operator, cons_hex, cons_valcons, first_height)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[])
       ON CONFLICT (chain_id, operator) DO UPDATE SET
         cons_hex = EXCLUDED.cons_hex,
         cons_valcons = EXCLUDED.cons_valcons,
         first_height = LEAST(validator_key.first_height, EXCLUDED.first_height)`,
      [chainId, col(ks, (k) => k.operator), col(ks, (k) => k.consHex), col(ks, (k) => k.consValcons), col(ks, (k) => k.height)]
    );
  }

  // ── votes: the latest per voter, and every vote as cast ──
  const allVotes = full.flatMap((b) => b.votes);
  if (allVotes.length > 0) {
    await writeVotes(client, chainId, allVotes);
  }

  // ── slash_event ──
  const slashes = full.flatMap((b) => b.slashes);
  if (slashes.length > 0) await writeSlashes(client, chainId, slashes);

  // ── staking_event ──
  const staking = full.flatMap((b) => b.stakingEvents);
  if (staking.length > 0) {
    await client.query(
      `INSERT INTO staking_event (chain_id, height, tx_hash, event_seq, time, kind, validator, validator_dst,
                                  delegator, amount, denom, completion_time, creation_height,
                                  msg_index, authz_msg_index)
       SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::int[], $5::timestamptz[], $6::text[], $7::text[],
                                $8::text[], $9::text[], $10::numeric[], $11::text[], $12::timestamptz[],
                                $13::bigint[], $14::int[], $15::int[])
       ON CONFLICT (chain_id, height, tx_hash, event_seq) DO UPDATE SET
         time = EXCLUDED.time, kind = EXCLUDED.kind, validator = EXCLUDED.validator,
         validator_dst = EXCLUDED.validator_dst, delegator = EXCLUDED.delegator,
         amount = EXCLUDED.amount, denom = EXCLUDED.denom,
         completion_time = EXCLUDED.completion_time, creation_height = EXCLUDED.creation_height,
         msg_index = EXCLUDED.msg_index, authz_msg_index = EXCLUDED.authz_msg_index`,
      [
        chainId,
        col(staking, (s) => s.height),
        col(staking, (s) => s.txHash),
        col(staking, (s) => s.eventSeq),
        col(staking, (s) => s.time),
        col(staking, (s) => s.kind),
        col(staking, (s) => s.validator),
        col(staking, (s) => s.validatorDst),
        col(staking, (s) => s.delegator),
        col(staking, (s) => s.amount),
        col(staking, (s) => s.denom),
        col(staking, (s) => s.completionTime),
        col(staking, (s) => s.creationHeight),
        col(staking, (s) => s.msgIndex),
        col(staking, (s) => s.authzMsgIndex),
      ]
    );
  }

  // ── validator_power ──
  const power = lastBy(full.flatMap((b) => b.validatorPower), (v) => `${v.height}|${v.consAddr}`);
  if (power.length > 0) {
    await client.query(
      `INSERT INTO validator_power (chain_id, height, cons_addr, power)
       SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::numeric[])
       ON CONFLICT (chain_id, height, cons_addr) DO UPDATE SET power = EXCLUDED.power`,
      [chainId, col(power, (v) => v.height), col(power, (v) => v.consAddr), col(power, (v) => v.power)]
    );
  }

  // ── gov_deposit ──
  const deposits = full.flatMap((b) => b.govDeposits);
  if (deposits.length > 0) {
    await client.query(
      `INSERT INTO gov_deposit (chain_id, tx_hash, event_seq, proposal_id, depositor, coins, height, time)
       SELECT $1, t.tx_hash, t.event_seq, t.proposal_id, t.depositor, t.coins::jsonb, t.height, t.time
         FROM unnest($2::text[], $3::int[], $4::bigint[], $5::text[], $6::text[], $7::bigint[], $8::timestamptz[])
           AS t(tx_hash, event_seq, proposal_id, depositor, coins, height, time)
       ON CONFLICT (chain_id, tx_hash, event_seq) DO UPDATE SET
         proposal_id = EXCLUDED.proposal_id, depositor = EXCLUDED.depositor,
         coins = EXCLUDED.coins, height = EXCLUDED.height, time = EXCLUDED.time`,
      [
        chainId,
        col(deposits, (d) => d.txHash),
        col(deposits, (d) => d.eventSeq),
        col(deposits, (d) => d.proposalId),
        col(deposits, (d) => d.depositor),
        col(deposits, (d) => JSON.stringify(d.coins)),
        col(deposits, (d) => d.height),
        col(deposits, (d) => d.time),
      ]
    );
  }

  // ── gov_proposal: column-scoped ──
  const proposals = mergeBy<GovProposalRow>(full.flatMap((b) => b.govProposals), (p) => p.proposalId);
  if (proposals.length > 0) {
    await client.query(
      `INSERT INTO gov_proposal (chain_id, proposal_id, submit_height, submit_tx, submit_time, proposer,
                                 messages, outcome, outcome_height, outcome_time)
       SELECT $1, t.proposal_id, t.submit_height, t.submit_tx, t.submit_time, t.proposer,
              CASE WHEN t.messages IS NULL THEN NULL
                   ELSE ARRAY(SELECT jsonb_array_elements_text(t.messages::jsonb)) END,
              t.outcome, t.outcome_height, t.outcome_time
         FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::timestamptz[], $6::text[], $7::text[],
                     $8::text[], $9::bigint[], $10::timestamptz[])
           AS t(proposal_id, submit_height, submit_tx, submit_time, proposer, messages,
                outcome, outcome_height, outcome_time)
       ON CONFLICT (chain_id, proposal_id) DO UPDATE SET
         submit_height  = COALESCE(EXCLUDED.submit_height, gov_proposal.submit_height),
         submit_tx      = COALESCE(EXCLUDED.submit_tx, gov_proposal.submit_tx),
         submit_time    = COALESCE(EXCLUDED.submit_time, gov_proposal.submit_time),
         proposer       = COALESCE(EXCLUDED.proposer, gov_proposal.proposer),
         messages       = COALESCE(EXCLUDED.messages, gov_proposal.messages),
         outcome        = COALESCE(EXCLUDED.outcome, gov_proposal.outcome),
         outcome_height = COALESCE(EXCLUDED.outcome_height, gov_proposal.outcome_height),
         outcome_time   = COALESCE(EXCLUDED.outcome_time, gov_proposal.outcome_time)`,
      [
        chainId,
        col(proposals, (p) => p.proposalId),
        col(proposals, (p) => p.submitHeight ?? null),
        col(proposals, (p) => p.submitTx ?? null),
        col(proposals, (p) => p.submitTime ?? null),
        col(proposals, (p) => p.proposer ?? null),
        col(proposals, (p) => (p.messages ? JSON.stringify(p.messages) : null)),
        col(proposals, (p) => p.outcome ?? null),
        col(proposals, (p) => p.outcomeHeight ?? null),
        col(proposals, (p) => p.outcomeTime ?? null),
      ]
    );
  }

  // ── ibc_packet: column-scoped ──
  const packets = mergeBy<IbcPacketRow>(
    full.flatMap((b) => b.ibcPackets),
    (p) => `${p.direction}|${p.srcPort}|${p.srcChannel}|${p.sequence}`
  );
  if (packets.length > 0) await writePackets(client, chainId, packets);
}

async function writeVotes(client: PoolClient, chainId: string, all: VoteRow[]): Promise<void> {
  // Every vote as cast: append-only, keyed by the event that carried it.
  const events = lastBy(all, (v) => `${v.txHash}|${v.eventSeq}`);
  await client.query(
    `INSERT INTO vote_event (chain_id, tx_hash, event_seq, proposal_id, voter, option, weighted, options, height, time)
     SELECT $1, t.tx_hash, t.event_seq, t.proposal_id, t.voter, t.option, t.weighted, t.options::jsonb, t.height, t.time
       FROM unnest($2::text[], $3::int[], $4::bigint[], $5::text[], $6::text[], $7::boolean[], $8::text[],
                   $9::bigint[], $10::timestamptz[])
         AS t(tx_hash, event_seq, proposal_id, voter, option, weighted, options, height, time)
     ON CONFLICT (chain_id, tx_hash, event_seq) DO UPDATE SET
       proposal_id = EXCLUDED.proposal_id, voter = EXCLUDED.voter, option = EXCLUDED.option,
       weighted = EXCLUDED.weighted, options = EXCLUDED.options,
       height = EXCLUDED.height, time = EXCLUDED.time`,
    [
      chainId,
      col(events, (v) => v.txHash),
      col(events, (v) => v.eventSeq),
      col(events, (v) => v.proposalId),
      col(events, (v) => v.voter),
      col(events, (v) => v.option),
      col(events, (v) => v.weighted),
      col(events, (v) => (v.options ? JSON.stringify(v.options) : null)),
      col(events, (v) => v.height),
      col(events, (v) => v.time),
    ]
  );

  // The final vote per voter. GREATEST-style guard on height, not a plain
  // overwrite: backfill descends, so it meets a voter's *earlier* vote after
  // their later one, and a plain upsert would replace a final vote with a
  // superseded one — silent corruption no error would reveal. Within the batch
  // the rows are in chain order, so the last one per voter is the latest.
  const latest = lastBy(all, (v) => `${v.proposalId}|${v.voter}`);
  await client.query(
    `INSERT INTO vote (chain_id, proposal_id, voter, option, weighted, options, height, time, tx_hash)
     SELECT $1, t.proposal_id, t.voter, t.option, t.weighted, t.options::jsonb, t.height, t.time, t.tx_hash
       FROM unnest($2::bigint[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::bigint[],
                   $8::timestamptz[], $9::text[])
         AS t(proposal_id, voter, option, weighted, options, height, time, tx_hash)
     ON CONFLICT (chain_id, proposal_id, voter) DO UPDATE SET
       option = EXCLUDED.option,
       weighted = EXCLUDED.weighted,
       options = EXCLUDED.options,
       height = EXCLUDED.height,
       time = EXCLUDED.time,
       tx_hash = EXCLUDED.tx_hash
     WHERE EXCLUDED.height > vote.height`,
    [
      chainId,
      col(latest, (v) => v.proposalId),
      col(latest, (v) => v.voter),
      col(latest, (v) => v.option),
      col(latest, (v) => v.weighted),
      col(latest, (v) => (v.options ? JSON.stringify(v.options) : null)),
      col(latest, (v) => v.height),
      col(latest, (v) => v.time),
      col(latest, (v) => v.txHash),
    ]
  );
}

async function writeSlashes(client: PoolClient, chainId: string, all: SlashRow[]): Promise<void> {
  const unjails = lastBy(
    all.filter((s) => s.kind === "unjailed" && s.operator),
    (s) => `${s.height}|${s.operator}`
  );
  const events = lastBy(
    all.filter((s) => s.kind !== "unjailed"),
    (s) => `${s.height}|${s.consAddr}|${s.kind}`
  );

  if (events.length > 0) {
    // The operator is filled in through validator_key when the validator is known.
    await client.query(
      `INSERT INTO slash_event (chain_id, height, time, cons_addr, operator, kind, reason, burned)
       SELECT $1, t.height, t.time, t.cons_addr,
              (SELECT k.operator FROM validator_key k
                WHERE k.chain_id = $1 AND k.cons_valcons = t.cons_addr LIMIT 1),
              t.kind, t.reason, t.burned
         FROM unnest($2::bigint[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::numeric[])
           AS t(height, time, cons_addr, kind, reason, burned)
       ON CONFLICT (chain_id, height, cons_addr, kind) DO UPDATE SET
         time = EXCLUDED.time,
         operator = COALESCE(EXCLUDED.operator, slash_event.operator),
         reason = EXCLUDED.reason,
         burned = EXCLUDED.burned`,
      [
        chainId,
        col(events, (s) => s.height),
        col(events, (s) => s.time),
        col(events, (s) => s.consAddr),
        col(events, (s) => s.kind),
        col(events, (s) => s.reason),
        col(events, (s) => s.burned),
      ]
    );
  }

  if (unjails.length > 0) {
    // An unjail names only its operator. Its consensus address is resolved through
    // validator_key; until the validator is known the row carries the operator in
    // cons_addr, and an unresolved row is replaced once a later write resolves it
    // (see resolveUnjails below).
    await client.query(
      `DELETE FROM slash_event s
        USING unnest($2::bigint[], $3::text[]) AS t(height, operator)
        WHERE s.chain_id = $1 AND s.kind = 'unjailed' AND s.height = t.height AND s.operator = t.operator`,
      [chainId, col(unjails, (s) => s.height), col(unjails, (s) => s.operator)]
    );
    await client.query(
      `INSERT INTO slash_event (chain_id, height, time, cons_addr, operator, kind, reason, burned)
       SELECT $1, t.height, t.time, COALESCE(k.cons_valcons, t.operator), t.operator, 'unjailed', NULL, NULL
         FROM unnest($2::bigint[], $3::timestamptz[], $4::text[]) AS t(height, time, operator)
         LEFT JOIN validator_key k ON k.chain_id = $1 AND k.operator = t.operator
       ON CONFLICT (chain_id, height, cons_addr, kind) DO UPDATE SET operator = EXCLUDED.operator`,
      [chainId, col(unjails, (s) => s.height), col(unjails, (s) => s.time), col(unjails, (s) => s.operator)]
    );
  }
}

async function writePackets(client: PoolClient, chainId: string, rows: IbcPacketRow[]): Promise<void> {
  const cols: [string, string, (r: IbcPacketRow) => unknown][] = [
    ["direction", "text", (r) => r.direction],
    ["src_port", "text", (r) => r.srcPort],
    ["src_channel", "text", (r) => r.srcChannel],
    ["sequence", "bigint", (r) => r.sequence],
    ["dst_port", "text", (r) => r.dstPort ?? null],
    ["dst_channel", "text", (r) => r.dstChannel ?? null],
    ["connection_id", "text", (r) => r.connection ?? null],
    ["sender", "text", (r) => r.sender ?? null],
    ["receiver", "text", (r) => r.receiver ?? null],
    ["denom", "text", (r) => r.denom ?? null],
    ["amount", "numeric", (r) => r.amount ?? null],
    ["memo", "text", (r) => r.memo ?? null],
    ["timeout_height", "text", (r) => r.timeoutHeight ?? null],
    ["timeout_timestamp", "numeric", (r) => r.timeoutTimestamp ?? null],
    ["send_height", "bigint", (r) => r.sendHeight ?? null],
    ["send_tx", "text", (r) => r.sendTx ?? null],
    ["send_time", "timestamptz", (r) => r.sendTime ?? null],
    ["recv_height", "bigint", (r) => r.recvHeight ?? null],
    ["recv_tx", "text", (r) => r.recvTx ?? null],
    ["recv_time", "timestamptz", (r) => r.recvTime ?? null],
    ["recv_relayer", "text", (r) => r.recvRelayer ?? null],
    ["ack_height", "bigint", (r) => r.ackHeight ?? null],
    ["ack_tx", "text", (r) => r.ackTx ?? null],
    ["ack_time", "timestamptz", (r) => r.ackTime ?? null],
    ["ack_relayer", "text", (r) => r.ackRelayer ?? null],
    ["ack_ok", "boolean", (r) => (r.ackOk === undefined ? null : r.ackOk)],
    ["ack_error", "text", (r) => r.ackError ?? null],
    ["timeout_at_height", "bigint", (r) => r.timeoutAtHeight ?? null],
    ["timeout_tx", "text", (r) => r.timeoutTx ?? null],
  ];
  const names = cols.map((c) => c[0]);
  const keys = new Set(["direction", "src_port", "src_channel", "sequence"]);
  const folded = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.direction}|${r.srcPort}|${r.srcChannel}|${r.sequence}`;
    const prev = folded.get(k);
    if (!prev) { folded.set(k, { ...r }); continue; }
    for (const [key, val] of Object.entries(r)) if (val !== undefined && val !== null) (prev as Record<string, unknown>)[key] = val;
  }
  const frows = [...folded.values()];
  const params = cols.map((c) => frows.map(c[2]));
  const unnest = cols.map((c, i) => `$${i + 2}::${c[1]}[]`).join(", ");
  // Column-scoped: each event fills its own columns, and a later event that does
  // not know a column never erases what an earlier one wrote.
  const updates = names
    .filter((n) => !keys.has(n))
    .map((n) => `${n} = COALESCE(EXCLUDED.${n}, ibc_packet.${n})`)
    .join(",\n         ");
  await client.query(
    `INSERT INTO ibc_packet (chain_id, ${names.join(", ")})
     SELECT $1, * FROM unnest(${unnest})
     ON CONFLICT (chain_id, direction, src_port, src_channel, sequence) DO UPDATE SET
         ${updates}`,
    [chainId, ...params]
  );
}

/**
 * Write heights without touching the cursor.
 *
 * Backfill fills history *below* what the head-follower has reached, so it must
 * not move a cursor whose meaning is "everything up to here is present". The
 * two can then run at once against the same tables: they never overlap, and
 * every write upserts, so even if they did the result is identical.
 */
export async function commitBlocks(
  pool: Pool,
  chainId: string,
  blocks: ExtractedBlock[]
): Promise<void> {
  if (blocks.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await writeBlocks(client, chainId, blocks);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The lowest height held for a chain, which is where backfill resumes.
 *
 * Derived from the data rather than kept in its own cursor: a backfill that
 * dies halfway through a multi-day run then resumes exactly where it stopped,
 * with no extra state to get out of step with reality.
 */
export async function lowestIndexed(
  pool: Pool,
  chainId: string
): Promise<number | null> {
  const res = await pool.query<{ min: string | null }>(
    "SELECT min(height)::text AS min FROM block WHERE chain_id = $1",
    [chainId]
  );
  const raw = res.rows[0]?.min;
  return raw === null || raw === undefined ? null : Number(raw);
}

/**
 * Write a run of consecutive heights and advance the cursor, atomically.
 *
 * The cursor moves to the last height in the batch only if every row committed;
 * a failure rolls the whole batch back and the worker retries from the old
 * cursor. `head` is the node's head as the batch was planned against, so a
 * reader can tell lag (head - last_height) from staleness (now - updated_at).
 */
export async function commitBatch(
  pool: Pool,
  chainId: string,
  blocks: ExtractedBlock[],
  head?: number
): Promise<void> {
  if (blocks.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await writeBlocks(client, chainId, blocks);

    const last = blocks[blocks.length - 1].block.height;
    await client.query(
      `INSERT INTO indexer_cursor (chain_id, last_height, updated_at, head_height)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (chain_id) DO UPDATE SET
         last_height = GREATEST(indexer_cursor.last_height, EXCLUDED.last_height),
         updated_at = now(),
         head_height = COALESCE(EXCLUDED.head_height, indexer_cursor.head_height)`,
      [chainId, last, head ?? null]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The follower is at the head and the node has nothing new.
 *
 * Without this, `updated_at` froze whenever a chain paused, and a reader gating
 * on it could not tell "caught up, nothing to write" from "stuck". It moves
 * only when the cursor really is at the head the node reported, so a stalled
 * follower still goes stale.
 */
export async function heartbeat(pool: Pool, chainId: string, head: number): Promise<void> {
  await pool.query(
    `UPDATE indexer_cursor
        SET updated_at = now(), head_height = $2
      WHERE chain_id = $1 AND last_height >= $2`,
    [chainId, head]
  );
}

/**
 * Heights an archive could not serve, recorded instead of skipped.
 *
 * A hole inside the stored range used to be invisible: coverage read min and
 * max, and a skipped height looked covered. Recorded here, coverage stops at the
 * nearest hole and a refill can target exactly these ranges.
 */
export async function recordGaps(
  pool: Pool,
  chainId: string,
  heights: number[],
  reason: string
): Promise<void> {
  if (heights.length === 0) return;
  const sorted = [...heights].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const h of sorted) {
    const r = ranges[ranges.length - 1];
    if (r && h === r[1] + 1) r[1] = h;
    else ranges.push([h, h]);
  }
  await pool.query(
    `INSERT INTO block_gap (chain_id, lo, hi, reason)
     SELECT $1, * FROM unnest($2::bigint[], $3::bigint[], $4::text[])
     ON CONFLICT (chain_id, lo) DO UPDATE SET hi = GREATEST(block_gap.hi, EXCLUDED.hi),
       reason = EXCLUDED.reason, found_at = now()`,
    [chainId, ranges.map((r) => r[0]), ranges.map((r) => r[1]), ranges.map(() => reason)]
  );
}

/**
 * A refill filled a recorded hole: the ranges it wrote are no longer gaps.
 *
 * "Filled" means written at the current version, not merely present. A refill
 * re-reads heights that already hold older rows; when the archive refuses one,
 * the old row is still there, and counting that as filled deleted the gap the
 * same batch had just recorded (51 AtomOne heights, 2026-09-26). Coverage still
 * stopped at them (they are old rows), but nothing said to fetch them again.
 */
export async function clearGaps(pool: Pool, chainId: string, lo: number, hi: number, version: number): Promise<void> {
  await pool.query(
    `DELETE FROM block_gap b
      WHERE b.chain_id = $1 AND b.lo >= $2 AND b.hi <= $3
        AND NOT EXISTS (
          SELECT 1 FROM generate_series(b.lo, b.hi) h
           WHERE NOT EXISTS (SELECT 1 FROM block k WHERE k.chain_id = $1 AND k.height = h AND k.extract_version >= $4))`,
    [chainId, lo, hi, version]
  );
}

/** Heights in [lo, hi] with no block, or one written by an older extractor. */
export async function staleHeights(pool: Pool, chainId: string, lo: number, hi: number, version: number): Promise<number[]> {
  const res = await pool.query<{ h: string }>(
    `SELECT h::text FROM generate_series($2::bigint, $3::bigint) h
      WHERE NOT EXISTS (SELECT 1 FROM block k WHERE k.chain_id = $1 AND k.height = h AND k.extract_version >= $4)
      ORDER BY h`,
    [chainId, lo, hi, version]
  );
  return res.rows.map((r) => Number(r.h));
}

/** Resolve unjail rows written before their validator's key was known. */
export async function resolveUnjails(pool: Pool, chainId: string): Promise<number> {
  const res = await pool.query(
    `WITH fix AS (
       SELECT s.height, s.operator, k.cons_valcons
         FROM slash_event s
         JOIN validator_key k ON k.chain_id = s.chain_id AND k.operator = s.operator
        WHERE s.chain_id = $1 AND s.kind = 'unjailed' AND s.cons_addr = s.operator
     ), gone AS (
       DELETE FROM slash_event s USING fix
        WHERE s.chain_id = $1 AND s.kind = 'unjailed' AND s.height = fix.height
          AND s.cons_addr = fix.operator
       RETURNING s.*
     )
     INSERT INTO slash_event (chain_id, height, time, cons_addr, operator, kind, reason, burned)
     SELECT g.chain_id, g.height, g.time, fix.cons_valcons, g.operator, 'unjailed', NULL, NULL
       FROM gone g JOIN fix ON fix.height = g.height AND fix.operator = g.operator
     ON CONFLICT (chain_id, height, cons_addr, kind) DO NOTHING`,
    [chainId]
  );
  // Slash rows written before the key was known get their operator too.
  await pool.query(
    `UPDATE slash_event s SET operator = k.operator
       FROM validator_key k
      WHERE s.chain_id = $1 AND k.chain_id = $1 AND s.operator IS NULL
        AND k.cons_valcons = s.cons_addr`,
    [chainId]
  );
  return res.rowCount ?? 0;
}

/** Where to resume, or null when this chain has never been indexed. */
export async function readCursor(
  pool: Pool,
  chainId: string
): Promise<number | null> {
  const res = await pool.query<{ last_height: string }>(
    "SELECT last_height FROM indexer_cursor WHERE chain_id = $1",
    [chainId]
  );
  const raw = res.rows[0]?.last_height;
  return raw === undefined ? null : Number(raw);
}
