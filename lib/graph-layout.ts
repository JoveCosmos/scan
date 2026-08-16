import { COLUMN_OF, type GraphEdge, type GraphNode } from "@/lib/graph-types";

/**
 * Where every node sits on the canvas.
 *
 * Kept out of the component so it can be tested as what it is — a pure function
 * from a graph to coordinates — and because the property that matters most about
 * it is one only a test states plainly: the same graph always lays out the same
 * way. That is the whole argument for this layout over a force simulation. A
 * simulation settles somewhere slightly different each run, and a node you have
 * already read drifts under the cursor while you reach for it.
 *
 * The algorithm is one left-to-right pass. A node's column comes from its kind;
 * its row is the mean row of the neighbours already placed to its left, and
 * collisions are resolved by pushing down, never by moving anything settled.
 */

export const NODE_W = 168;
export const NODE_H = 46;
export const COL_GAP = 104;
export const ROW_GAP = 14;

export interface Placed {
  node: GraphNode;
  x: number;
  y: number;
}

export function layout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbours.get(a);
    if (list) list.push(b);
    else neighbours.set(a, [b]);
  };
  for (const e of edges) {
    // An edge to a node that is not on the canvas yet is not an error — the
    // graph grows one expansion at a time, and half-attached edges are normal.
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }

  const columns = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const col = COLUMN_OF[n.kind];
    const list = columns.get(col);
    if (list) list.push(n);
    else columns.set(col, [n]);
  }

  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    // Highest rank first within a column: newest block at the top, and a block's
    // transactions in the order the block lists them. Ties fall back to id so
    // the result never depends on the order nodes happened to arrive in.
    const ordered = [...columns.get(col)!].sort(
      (a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.id.localeCompare(b.id)
    );

    const desired = new Map<string, number>();
    for (const n of ordered) {
      const ys = (neighbours.get(n.id) ?? [])
        .map((id) => placed.get(id)?.y)
        .filter((y): y is number => y !== undefined);
      // Nothing placed to anchor to — sink to the bottom of the column rather
      // than claim a position it has no reason to hold.
      desired.set(
        n.id,
        ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity
      );
    }

    const sorted = [...ordered].sort((a, b) => {
      const da = desired.get(a.id)!;
      const db = desired.get(b.id)!;
      // Infinity - Infinity is NaN, which would make the comparator incoherent
      // and the order engine-dependent; unanchored nodes keep their rank order.
      if (da === db) return 0;
      return da < db ? -1 : 1;
    });

    let cursor = -Infinity;
    for (const n of sorted) {
      const want = desired.get(n.id)!;
      const y = Math.max(Number.isFinite(want) ? want : 0, cursor);
      placed.set(n.id, { node: n, x: col * (NODE_W + COL_GAP), y });
      cursor = y + NODE_H + ROW_GAP;
    }
  }

  return placed;
}
