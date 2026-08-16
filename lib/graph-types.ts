/**
 * The canvas's wire contract, and nothing else.
 *
 * Deliberately a leaf: no imports at all. `lib/graph.ts` builds these values and
 * reaches the adapter, the chain registry and Postgres to do it; the client only
 * needs the shapes and the column map. Importing the builder for `COLUMN_OF`
 * pulled `pg` into the browser bundle and the page failed to compile, which is
 * the same trap the duplicated tx label maps exist to avoid — solved here by
 * sharing a module that can safely live on both sides rather than by copying.
 */

export type NodeKind = "block" | "tx" | "account" | "validator";

/**
 * Column per kind. The spatial grammar, in one place.
 *
 * Blocks → transactions → accounts → validators, which is the order value moves
 * in. Accounts and validators are split rather than sharing a "parties" column
 * because a delegation joins them: with both at the same depth that edge would
 * be drawn vertically between two neighbours and read as nothing at all.
 *
 * Geometry follows column, not edge direction. An edge is stored the way it is
 * meant — a sender points *at* the transaction it signed — and the renderer
 * draws it between columns, putting the arrowhead on the semantic target. That
 * keeps the data honest without ever drawing a line that doubles back.
 */
export const COLUMN_OF: Record<NodeKind, number> = {
  block: 0,
  tx: 1,
  account: 2,
  validator: 3,
};

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Headline, drawn inside the node. */
  label: string;
  /** Second line, drawn dimmer. */
  sub?: string;
  /** Ordering within a column — block height, or tx index. Higher sorts first. */
  rank?: number;
  /** The ordinary page for this thing. */
  href?: string;
  /** Seed string that expands this node's neighbours. */
  seed?: string;
  /** Detail rows for the inspector. */
  fields?: { label: string; value: string }[];
  /** Failed transactions read differently from successful ones. */
  tone?: "ok" | "bad";
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** What the caller asked for, echoed so the client can tell responses apart. */
  seed: string;
  /** Set when the seed could not be served. */
  error?: string;
}
