import { describe, expect, it } from "vitest";
import {
  commitHeight,
  commitSignatures,
  resolveMissed,
  type BlockResponse,
} from "../indexer/src/extract";

const SET = ["AAA", "BBB", "CCC"];

/** A commit slot. Absent slots carry an empty address, exactly as a node sends. */
function sig(flag: number, address = "") {
  return flag === 2
    ? { block_id_flag: 2, validator_address: address, signature: "sig" }
    : { block_id_flag: flag, validator_address: "", signature: null };
}

function block(height: string, sigs: unknown[]): BlockResponse {
  return {
    result: {
      block: {
        header: { height: String(Number(height) + 1), time: "2026-09-15T00:00:00Z" },
        last_commit: { height, signatures: sigs as never },
      },
    },
  };
}

describe("commit signatures", () => {
  it("reads the commit height, which is one below the carrying block", () => {
    const b = block("100", [sig(2, "AAA")]);
    expect(commitHeight(b)).toBe("100");
    expect(b.result?.block?.header?.height).toBe("101");
    expect(commitSignatures(b)).toHaveLength(1);
  });

  it("returns nothing for a block with no commit", () => {
    expect(commitHeight({ result: { block: { header: {} } } })).toBeNull();
    expect(commitSignatures({})).toEqual([]);
  });

  it("names the absent validator by its position in the set", () => {
    const r = resolveMissed(
      [sig(2, "AAA"), sig(1), sig(2, "CCC")],
      SET,
      "100"
    );
    expect(r.mismatch).toBe(false);
    expect(r.missed).toEqual([{ height: "100", consAddr: "BBB", flag: "absent" }]);
  });

  it("separates a nil vote from an absence — one is disagreement, not downtime", () => {
    const r = resolveMissed([sig(2, "AAA"), sig(3), sig(1)], SET, "100");
    expect(r.missed).toEqual([
      { height: "100", consAddr: "BBB", flag: "nil" },
      { height: "100", consAddr: "CCC", flag: "absent" },
    ]);
  });

  it("writes nothing when the set is the wrong size", () => {
    const r = resolveMissed([sig(2, "AAA"), sig(1)], SET, "100");
    expect(r).toEqual({ missed: [], mismatch: true });
  });

  it("writes nothing when a present slot disagrees with the set", () => {
    // The whole point: a stale set would otherwise blame whoever sits at that
    // index. A signer whose address does not match is proof it is stale.
    const r = resolveMissed(
      [sig(2, "AAA"), sig(1), sig(2, "ZZZ")],
      SET,
      "100"
    );
    expect(r).toEqual({ missed: [], mismatch: true });
  });

  it("detects a swap that keeps the set size identical", () => {
    // One validator out, one in: same length, so length alone would miss it.
    const r = resolveMissed(
      [sig(2, "AAA"), sig(2, "NEW"), sig(2, "CCC")],
      SET,
      "100"
    );
    expect(r.mismatch).toBe(true);
  });

  it("accepts a fully signed commit and writes no rows", () => {
    const r = resolveMissed(
      [sig(2, "AAA"), sig(2, "BBB"), sig(2, "CCC")],
      SET,
      "100"
    );
    expect(r).toEqual({ missed: [], mismatch: false });
  });

  it("reads the string flag encoding some nodes send", () => {
    const r = resolveMissed(
      [
        { block_id_flag: "BLOCK_ID_FLAG_COMMIT", validator_address: "AAA" },
        { block_id_flag: "BLOCK_ID_FLAG_ABSENT", validator_address: "" },
        { block_id_flag: "BLOCK_ID_FLAG_NIL", validator_address: "" },
      ],
      SET,
      "100"
    );
    expect(r.missed).toEqual([
      { height: "100", consAddr: "BBB", flag: "absent" },
      { height: "100", consAddr: "CCC", flag: "nil" },
    ]);
  });

  it("treats an empty commit as nothing to say, not as a mismatch", () => {
    expect(resolveMissed([], [], "100")).toEqual({ missed: [], mismatch: false });
  });
});
