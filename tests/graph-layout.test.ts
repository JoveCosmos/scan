import { describe, expect, it } from "vitest";
import { COLUMN_OF, type GraphEdge, type GraphNode } from "@/lib/graph-types";
import { COL_GAP, NODE_H, NODE_W, ROW_GAP, layout } from "@/lib/graph-layout";

const node = (
  id: string,
  kind: GraphNode["kind"],
  rank?: number
): GraphNode => ({ id, kind, label: id, rank });

describe("layout", () => {
  it("puts each kind in its own column", () => {
    const nodes = [
      node("b", "block"),
      node("t", "tx"),
      node("a", "account"),
      node("v", "validator"),
    ];
    const placed = layout(nodes, []);
    expect(placed.get("b")!.x).toBe(0);
    expect(placed.get("t")!.x).toBe(NODE_W + COL_GAP);
    expect(placed.get("a")!.x).toBe(2 * (NODE_W + COL_GAP));
    expect(placed.get("v")!.x).toBe(3 * (NODE_W + COL_GAP));
  });

  it("orders a column by rank, highest first", () => {
    const nodes = [
      node("low", "block", 1),
      node("high", "block", 3),
      node("mid", "block", 2),
    ];
    const placed = layout(nodes, []);
    expect(placed.get("high")!.y).toBeLessThan(placed.get("mid")!.y);
    expect(placed.get("mid")!.y).toBeLessThan(placed.get("low")!.y);
  });

  it("never overlaps two nodes in the same column", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(`b${i}`, "block", i));
    const placed = layout(nodes, []);
    const ys = [...placed.values()].map((p) => p.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(NODE_H + ROW_GAP);
    }
  });

  it("places a node beside the neighbour it hangs off", () => {
    // A block's only transaction should sit level with it, not at the top.
    const nodes = [
      node("b1", "block", 3),
      node("b2", "block", 2),
      node("b3", "block", 1),
      node("t", "tx"),
    ];
    const edges: GraphEdge[] = [{ from: "b3", to: "t" }];
    const placed = layout(nodes, edges);
    expect(placed.get("t")!.y).toBe(placed.get("b3")!.y);
  });

  it("centres a node between the neighbours it joins", () => {
    const nodes = [node("b1", "block", 2), node("b2", "block", 1), node("t", "tx")];
    const edges: GraphEdge[] = [
      { from: "b1", to: "t" },
      { from: "b2", to: "t" },
    ];
    const placed = layout(nodes, edges);
    const mid = (placed.get("b1")!.y + placed.get("b2")!.y) / 2;
    expect(placed.get("t")!.y).toBe(mid);
  });

  it("is deterministic — the same graph lays out identically every time", () => {
    // The whole argument for this layout over a force simulation. If it ever
    // stops holding, nodes drift under the cursor between renders.
    const nodes = [
      node("b1", "block", 2),
      node("b2", "block", 1),
      node("t1", "tx"),
      node("t2", "tx"),
      node("a1", "account"),
    ];
    const edges: GraphEdge[] = [
      { from: "b1", to: "t1" },
      { from: "b2", to: "t2" },
      { from: "t1", to: "a1" },
    ];
    const once = layout(nodes, edges);
    const twice = layout(nodes, edges);
    for (const [id, p] of once) {
      expect(twice.get(id)).toEqual(p);
    }
  });

  it("does not depend on the order nodes arrive in", () => {
    // Nodes accumulate as the reader expands, so insertion order is arbitrary.
    const nodes = [node("b1", "block", 2), node("b2", "block", 1), node("t", "tx")];
    const edges: GraphEdge[] = [{ from: "b1", to: "t" }];
    const forward = layout(nodes, edges);
    const reversed = layout([...nodes].reverse(), edges);
    for (const [id, p] of forward) {
      expect(reversed.get(id)).toEqual(p);
    }
  });

  it("ignores an edge to a node that is not on the canvas", () => {
    // Normal while the graph is still growing — must not throw or misplace.
    const nodes = [node("b", "block", 1), node("t", "tx")];
    const placed = layout(nodes, [
      { from: "b", to: "t" },
      { from: "t", to: "acct:not-here" },
    ]);
    expect(placed.size).toBe(2);
    expect(placed.get("t")!.y).toBe(placed.get("b")!.y);
  });

  it("handles an empty graph", () => {
    expect(layout([], []).size).toBe(0);
  });

  it("keeps accounts and validators apart, so a delegation spans columns", () => {
    // Same-column edges would be drawn as a short vertical line between two
    // neighbours and read as nothing at all.
    expect(COLUMN_OF.account).not.toBe(COLUMN_OF.validator);
  });
});
