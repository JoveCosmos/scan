import { beforeEach, describe, expect, it, vi } from "vitest";

// A pg pool stand-in: each query is answered by the first handler whose
// pattern matches its SQL, and every call is recorded for assertions.
type Handler = { match: RegExp; rows: unknown[] | ((values: unknown[]) => unknown[]) } | { match: RegExp; error: Error };
let handlers: Handler[] = [];
let calls: { text: string; values: unknown[] }[] = [];
let poolEnabled = true;

const fakePool = {
  query: async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const h = handlers.find((x) => x.match.test(text));
    if (!h) throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    if ("error" in h) throw h.error;
    return { rows: typeof h.rows === "function" ? h.rows(values) : h.rows };
  },
};

vi.mock("@/lib/indexer-db", () => ({
  poolFor: () => (poolEnabled ? fakePool : null),
}));

import {
  ROLE,
  decodePartyCursor,
  encodePartyCursor,
  movementsQuery,
  netMovement,
  packetLatency,
  packetStatus,
  partyHistory,
  partyHistoryQuery,
  roleWords,
  packetsForTx,
  txFromIndex,
  type PacketRow,
} from "@/lib/indexer-tx";
import { coverageOf } from "@/lib/indexer-coverage";

let chainSeq = 0;
/** Each test gets its own chain id so the module caches never cross tests. */
const freshChain = () => `test-chain-${++chainSeq}`;

const covered = (lo = 100, hi = 1000) => ({
  match: /FROM indexer_coverage/,
  rows: [{ lo: String(lo), hi: String(hi), lo_time: null, hi_time: null }],
});

beforeEach(() => {
  handlers = [];
  calls = [];
  poolEnabled = true;
});

describe("roleWords", () => {
  it("names the telling roles first and hides signer when something else applies", () => {
    expect(roleWords(ROLE.signer | ROLE.sender)).toEqual(["sent"]);
    expect(roleWords(ROLE.relayer | ROLE.signer | ROLE.feePayer)).toEqual(["relayed"]);
    expect(roleWords(ROLE.delegator | ROLE.recipient)).toEqual(["received", "delegated"]);
  });
  it("falls back to signed or paid fee when that is all there is", () => {
    expect(roleWords(ROLE.signer | ROLE.feePayer)).toEqual(["signed"]);
    expect(roleWords(ROLE.feePayer)).toEqual(["paid fee"]);
    expect(roleWords(0)).toEqual([]);
  });
});

describe("party cursor", () => {
  it("round-trips and rejects anything else", () => {
    const c = { height: "123", hash: "ABCDEF01" };
    expect(decodePartyCursor(encodePartyCursor(c))).toEqual(c);
    expect(decodePartyCursor("i:123:ABC")).toBeNull();
    expect(decodePartyCursor("i4:12x:ABC")).toBeNull();
    expect(decodePartyCursor(null)).toBeNull();
  });
});

describe("partyHistoryQuery", () => {
  const range = { lo: 10, hi: 99, loTime: null, hiTime: null };
  it("walks the primary key newest first within the covered range", () => {
    const q = partyHistoryQuery("c", "addr", range, 50, null);
    expect(q.text).toMatch(/FROM tx_party p\s+JOIN tx t/);
    expect(q.text).toMatch(/p\.height BETWEEN \$3 AND \$4/);
    expect(q.text).toMatch(/ORDER BY p\.height DESC, p\.tx_hash DESC/);
    expect(q.text).not.toMatch(/\$6/);
    expect(q.values).toEqual(["c", "addr", 10, 99, 51]);
  });
  it("adds the keyset condition for older pages", () => {
    const q = partyHistoryQuery("c", "addr", range, 20, { height: "55", hash: "AA" });
    expect(q.text).toMatch(/\(p\.height, p\.tx_hash\) < \(\$6::bigint, \$7\)/);
    expect(q.values).toEqual(["c", "addr", 10, 99, 21, "55", "AA"]);
  });
});

describe("movementsQuery", () => {
  it("reads only this address's non-fee rows in event order", () => {
    const q = movementsQuery("c", "me", ["H1", "H2"]);
    expect(q.text).toMatch(/kind <> 'fee'/);
    expect(q.text).toMatch(/from_addr = \$3 OR to_addr = \$3/);
    expect(q.text).toMatch(/ORDER BY tx_hash, event_seq NULLS LAST/);
    expect(q.values).toEqual(["c", ["H1", "H2"], "me"]);
  });
});

describe("netMovement", () => {
  const row = (from: string, to: string, amount: string, denom = "uatone") => ({
    txHash: "H",
    kind: "transfer",
    from,
    to,
    denom,
    amount,
  });
  it("sums incoming coins per denom and names a single counterparty", () => {
    const m = netMovement([row("a", "me", "5"), row("a", "me", "7")], "me");
    expect(m).toEqual({ from: "a", to: "me", amount: [{ denom: "uatone", amount: "12" }] });
  });
  it("prefers what was paid when a transaction both sent and received", () => {
    const m = netMovement([row("me", "pool", "10"), row("pool", "me", "3", "uosmo")], "me");
    expect(m?.from).toBe("me");
    expect(m?.amount).toEqual([{ denom: "uatone", amount: "10" }]);
  });
  it("leaves the counterparty empty when there are several", () => {
    const m = netMovement([row("a", "me", "1"), row("b", "me", "1")], "me");
    expect(m?.from).toBeNull();
  });
  it("returns null when the address moved nothing", () => {
    expect(netMovement([row("a", "b", "1")], "me")).toBeNull();
  });
});

describe("packet status and latency", () => {
  const base: PacketRow = {
    direction: "out",
    srcPort: "transfer",
    srcChannel: "channel-0",
    dstPort: "transfer",
    dstChannel: "channel-9",
    sequence: "1",
    sender: null,
    receiver: null,
    denom: null,
    amount: null,
    memo: null,
    sendHeight: "1",
    sendTx: "S",
    sendTime: "2026-09-26T00:00:00Z",
    recvHeight: null,
    recvTx: null,
    recvTime: null,
    recvRelayer: null,
    ackHeight: null,
    ackTx: null,
    ackTime: null,
    ackRelayer: null,
    ackOk: null,
    ackError: null,
    timeoutTx: null,
  };
  it("reads the furthest state reached", () => {
    expect(packetStatus(base)).toBe("pending");
    expect(packetStatus({ ...base, ackTx: "A", ackOk: true })).toBe("acked");
    expect(packetStatus({ ...base, ackTx: "A", ackOk: false })).toBe("error");
    expect(packetStatus({ ...base, timeoutTx: "T" })).toBe("timeout");
    expect(packetStatus({ ...base, direction: "in", recvTx: "R" })).toBe("received");
  });
  it("measures send to the last leg seen", () => {
    expect(packetLatency({ ...base, ackTime: "2026-09-26T00:00:42Z" })).toBe(42);
    expect(packetLatency(base)).toBeNull();
  });
});

describe("coverage gating", () => {
  it("is null without a pool, and when the function is missing", async () => {
    poolEnabled = false;
    expect(await coverageOf(freshChain(), "tx_party")).toBeNull();
    poolEnabled = true;
    handlers = [{ match: /indexer_coverage/, error: new Error("function indexer_coverage does not exist") }];
    expect(await coverageOf(freshChain(), "tx_party")).toBeNull();
  });

  it("partyHistory does not touch tx_party when the capability is not covered", async () => {
    handlers = [{ match: /indexer_coverage/, rows: [] }];
    expect(await partyHistory(freshChain(), "me")).toBeNull();
    expect(calls.some((c) => /tx_party/.test(c.text))).toBe(false);
  });
});

describe("partyHistory", () => {
  it("returns a page with roles, fee coins, own movements and the floor", async () => {
    const chain = freshChain();
    handlers = [
      covered(100, 1000),
      {
        match: /FROM tx_party/,
        rows: [
          {
            height: "900",
            tx_hash: "H2",
            roles: ROLE.recipient,
            time: "2026-09-26T00:00:00Z",
            code: 0,
            msg_types: ["/cosmos.bank.v1beta1.MsgSend"],
            fee_coins: [{ denom: "uphoton", amount: "5" }],
            fee_denom: "uphoton",
            fee_amount: "5",
            gas_used: "1",
            gas_wanted: "2",
            signer: "a",
          },
          {
            height: "800",
            tx_hash: "H1",
            roles: ROLE.signer | ROLE.sender,
            time: "2026-09-25T00:00:00Z",
            code: 5,
            msg_types: null,
            fee_coins: null,
            fee_denom: "uphoton",
            fee_amount: "3",
            gas_used: null,
            gas_wanted: null,
            signer: "me",
          },
        ],
      },
      {
        match: /FROM transfer/,
        rows: [{ tx_hash: "H2", kind: "transfer", from_addr: "a", to_addr: "me", denom: "uatone", amount: "9" }],
      },
    ];
    const page = await partyHistory(chain, "me", 1);
    expect(page?.txs).toHaveLength(1);
    expect(page?.more).toBe(true);
    expect(page?.floor).toBe(100);
    expect(page?.txs[0]).toMatchObject({
      hash: "H2",
      roles: ROLE.recipient,
      feeCoins: [{ denom: "uphoton", amount: "5" }],
      movements: [{ from: "a", to: "me", amount: "9" }],
    });
    const movementsCall = calls.find((c) => /FROM transfer/.test(c.text));
    expect(movementsCall?.values).toEqual([chain, ["H2"], "me"]);
  });

  it("fails soft when the table is missing", async () => {
    handlers = [covered(), { match: /FROM tx_party/, error: new Error('relation "tx_party" does not exist') }];
    expect(await partyHistory(freshChain(), "me")).toBeNull();
  });
});

describe("txFromIndex", () => {
  it("assembles meta, nested authz messages and movements where covered", async () => {
    const chain = freshChain();
    // Base row, then meta row, both from `tx`; told apart by the columns asked for.
    handlers = [
      covered(1, 1000),
      {
        match: /SELECT codespace, memo, signers/,
        rows: [{ codespace: "sdk", memo: "hi", signers: ["s1", "s2"], fee_coins: [{ denom: "u", amount: "1" }], fee_granter: "g" }],
      },
      {
        match: /SELECT hash, height::text/,
        rows: [
          {
            hash: "ABC",
            height: "500",
            time: "2026-09-26T00:00:00Z",
            code: 0,
            gas_used: "10",
            gas_wanted: "20",
            signer: "s1",
            msg_types: ["/cosmos.authz.v1beta1.MsgExec"],
            fee_denom: "u",
            fee_amount: "1",
          },
        ],
      },
      {
        match: /FROM tx_msg/,
        rows: [
          { msg_index: 0, inner_index: -1, type_url: "/cosmos.authz.v1beta1.MsgExec", sender: "grantee" },
          { msg_index: 0, inner_index: 0, type_url: "/cosmos.staking.v1beta1.MsgDelegate", sender: "granter" },
        ],
      },
      {
        match: /FROM transfer/,
        rows: [{ kind: "transfer", from_addr: "a", to_addr: "b", denom: "u", amount: "3" }],
      },
    ];
    const d = await txFromIndex(chain, "abc");
    expect(calls.find((c) => /SELECT hash, height::text/.test(c.text))?.values).toEqual([chain, "ABC"]);
    expect(d).toMatchObject({
      hash: "ABC",
      codespace: "sdk",
      memo: "hi",
      signers: ["s1", "s2"],
      feeGranter: "g",
      hasMeta: true,
    });
    expect(d?.messages).toEqual([
      {
        msgIndex: 0,
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        sender: "grantee",
        inner: [{ typeUrl: "/cosmos.staking.v1beta1.MsgDelegate", sender: "granter" }],
      },
    ]);
    expect(d?.movements).toHaveLength(1);
  });

  it("returns null when the index doesn't have the transaction", async () => {
    handlers = [covered(), { match: /SELECT hash, height::text/, rows: [] }];
    expect(await txFromIndex(freshChain(), "nope")).toBeNull();
  });
});

describe("packetsForTx", () => {
  it("looks the hash up upper-cased across every leg", async () => {
    const chain = freshChain();
    handlers = [covered(), { match: /FROM ibc_packet/, rows: [] }];
    await packetsForTx(chain, "deadbeef");
    const q = calls.find((c) => /FROM ibc_packet/.test(c.text));
    expect(q?.text).toMatch(/send_tx = \$2 OR recv_tx = \$2 OR ack_tx = \$2 OR timeout_tx = \$2/);
    expect(q?.values).toEqual([chain, "DEADBEEF"]);
  });
});
