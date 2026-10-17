import { describe, expect, test } from "vitest";
import { BEHIND_BLOCKS, classify, OLD_MS } from "@/lib/endpoint-health";

const now = Date.parse("2026-10-17T18:00:00Z");
const head = (height: number, agoMs: number) => ({ height, time: now - agoMs });

describe("which endpoints are current", () => {
  test("one stuck months behind is stale; one that cannot be looked at is unknown", () => {
    // AtomOne testnet, 2026-10-17: nodeist at 7,505,168 from 10 June.
    const s = classify(
      ["cogwheel", "directory", "nodeist", "ours"],
      new Map([
        ["cogwheel", head(9_461_512, 6_000)],
        ["directory", null],
        ["nodeist", head(7_505_168, 129 * 86_400_000)],
        ["ours", head(9_461_512, 6_000)],
      ]),
      now
    );
    expect([...s]).toEqual([
      ["cogwheel", "current"],
      ["directory", "unknown"],
      ["nodeist", "stale"],
      ["ours", "current"],
    ]);
  });

  test("a few blocks behind is current; more than the margin is stale", () => {
    const s = classify(
      ["a", "b", "c"],
      new Map([
        ["a", head(1000, 1000)],
        ["b", head(1000 - BEHIND_BLOCKS, 60_000)],
        ["c", head(1000 - BEHIND_BLOCKS - 1, 60_000)],
      ]),
      now
    );
    expect(s.get("b")).toBe("current");
    expect(s.get("c")).toBe("stale");
  });

  test("a halted chain leaves every endpoint in", () => {
    const s = classify(
      ["a", "b"],
      new Map([
        ["a", head(500, OLD_MS * 6)],
        ["b", head(500, OLD_MS * 6)],
      ]),
      now
    );
    expect([...s.values()]).toEqual(["current", "current"]);
  });
});
