import { describe, expect, it } from "vitest";
import send from "./fixtures/gnoland-tx-send.json";
import call from "./fixtures/gnoland-tx-call.json";
import {
  gnoHashToHex,
  hexToGnoHash,
  normalizeGnoHash,
  decodeGnoTx,
  fromNodeTx,
  gnoMessageTransfer,
  type GnoNodeTx,
} from "@/lib/gno";

const SEND_HASH = "blaECkHs0QwUjKZxhvL1dIqz1mQSkKJWVvU8eCIaETU=";

describe("gno transaction hashes", () => {
  it("round-trips base64 and hex", () => {
    const hex = gnoHashToHex(SEND_HASH);
    expect(hex).toMatch(/^[0-9A-F]{64}$/);
    expect(hexToGnoHash(hex!)).toBe(SEND_HASH);
    expect(hexToGnoHash(`0x${hex!.toLowerCase()}`)).toBe(SEND_HASH);
  });

  it("normalizes either form and rejects anything else", () => {
    expect(normalizeGnoHash(SEND_HASH)).toBe(SEND_HASH);
    expect(normalizeGnoHash(gnoHashToHex(SEND_HASH)!)).toBe(SEND_HASH);
    expect(normalizeGnoHash("not a hash")).toBeNull();
    expect(normalizeGnoHash("abcd")).toBeNull();
  });
});

describe("node fallback decoding", () => {
  it("decodes a bank send from the node's raw transaction", () => {
    const decoded = decodeGnoTx((send as GnoNodeTx).tx);
    expect(decoded.messages).toHaveLength(1);
    expect(decoded.messages[0]).toMatchObject({
      kind: "send",
      type: "/bank.send",
      from: "g1juss2tuc97sr77rn6vprhh9lr7d9e07uu68x59",
      to: "g19ulvh44r54nc44pekne4cy6e7lptheq7a0wavt",
      amount: [{ amount: "11421", denom: "ugnot" }],
    });
    expect(decoded.fee).toEqual({ amount: "1027", denom: "ugnot" });
    expect(decoded.gasWanted).toBe(1966470);
  });

  it("maps the node record onto the shared shape", () => {
    const rec = fromNodeTx(send as GnoNodeTx);
    expect(rec).toMatchObject({
      hash: SEND_HASH,
      height: 333184,
      success: true,
      gasUsed: 936478,
      source: "node",
    });
    expect(rec.bankTransfers[0]).toMatchObject({
      from: "g1juss2tuc97sr77rn6vprhh9lr7d9e07uu68x59",
      amount: [{ amount: "11421", denom: "ugnot" }],
    });
    expect(gnoMessageTransfer(rec.messages[0])).toMatchObject({
      from: "g1juss2tuc97sr77rn6vprhh9lr7d9e07uu68x59",
      to: "g19ulvh44r54nc44pekne4cy6e7lptheq7a0wavt",
    });
  });

  it("decodes a realm call's caller, package and function", () => {
    const rec = fromNodeTx(call as GnoNodeTx);
    expect(rec.messages[0]).toMatchObject({
      kind: "call",
      type: "/vm.exec",
      caller: "g18dd5mstjqlcg9ngqpg26azeya6wqg7upd9t8xa",
      pkgPath: "gno.land/r/g1leu8d2vsplhehcfkjg50mwgdpxdkt8tztu95wr/bubblerumble4",
      func: "Heartbeat",
    });
    expect(rec.fee).toEqual({ amount: "15000", denom: "ugnot" });
  });
});
