import type { ChainConfig } from "@/lib/chains";
import { chainDenoms, symbolFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { policyFor } from "@/lib/tiers";
import { formatCoins } from "@/lib/coin";
import { formatToken } from "@/lib/overview";
import { proposerIndex } from "@/lib/uptime";
import { timeAgo, truncateMiddle } from "@/lib/format";
import type { Graph, GraphEdge, GraphNode } from "@/lib/graph-types";

/**
 * The canvas's data layer: a chain as a graph rather than a list of pages.
 *
 * Nodes carry a `kind`, and kind alone decides which column a node lands in —
 * blocks left, transactions centre, the parties they touch right. That fixed
 * grammar is the whole reason the canvas stays readable as it grows: time runs
 * down the page, causality runs across it, and expanding a node can never
 * rearrange what is already on screen into something unfamiliar.
 *
 * Every fetch is seeded and bounded. There is no "load the whole chain" path,
 * because a graph view that tries to draw everything is the failure mode this
 * layout is usually accused of.
 */

export type {
  NodeKind,
  GraphNode,
  GraphEdge,
  Graph,
} from "@/lib/graph-types";
export { COLUMN_OF } from "@/lib/graph-types";

const empty = (seed: string, error: string): Graph => ({ nodes: [], edges: [], seed, error });

function blockNode(
  base: string,
  b: { height: string; time: string; txCount: number; hash: string | null },
  proposer?: { moniker: string; operator: string } | null
): GraphNode {
  return {
    id: `block:${b.height}`,
    kind: "block",
    label: Number(b.height).toLocaleString(),
    sub: `${b.txCount} tx · ${timeAgo(b.time)}`,
    rank: Number(b.height),
    href: `${base}/blocks/${b.height}`,
    seed: `block:${b.height}`,
    fields: [
      { label: "Height", value: Number(b.height).toLocaleString() },
      { label: "Time", value: b.time },
      { label: "Transactions", value: String(b.txCount) },
      ...(proposer ? [{ label: "Proposer", value: proposer.moniker }] : []),
      ...(b.hash ? [{ label: "Hash", value: b.hash }] : []),
    ],
  };
}

function txNode(
  chain: ChainConfig,
  base: string,
  t: {
    hash: string;
    height: string;
    time: string | null;
    code: number | null;
    messages: { label: string }[];
    messageCount: number;
    transfer: { amount: { denom: string; amount: string }[] } | null;
    fee: { denom: string; amount: string }[];
  },
  index = 0
): GraphNode {
  const denoms = chainDenoms(chain);
  const amount =
    t.transfer && t.transfer.amount.length > 0
      ? formatCoins(t.transfer.amount, denoms, 2)
      : null;
  return {
    id: `tx:${t.hash}`,
    kind: "tx",
    label: t.messages[0]?.label ?? `${t.messageCount} messages`,
    sub: amount ?? truncateMiddle(t.hash, 8, 4),
    rank: -index,
    href: `${base}/txs/${encodeURIComponent(t.hash)}`,
    seed: `tx:${t.hash}`,
    tone: t.code === 0 ? "ok" : t.code === null ? undefined : "bad",
    fields: [
      { label: "Hash", value: t.hash },
      { label: "Status", value: t.code === 0 ? "success" : `failed (${t.code})` },
      { label: "Height", value: Number(t.height).toLocaleString() },
      ...(t.time ? [{ label: "Time", value: t.time }] : []),
      { label: "Messages", value: String(t.messageCount) },
      ...(amount ? [{ label: "Amount", value: amount }] : []),
      { label: "Fee", value: formatCoins(t.fee, denoms) },
    ],
  };
}

function partyNode(chain: ChainConfig, base: string, address: string): GraphNode {
  const isValidator = address.includes("valoper");
  return {
    id: `${isValidator ? "val" : "acct"}:${address}`,
    kind: isValidator ? "validator" : "account",
    label: truncateMiddle(address, 10, 6),
    sub: isValidator ? "validator" : chain.bech32Prefix,
    href: `${base}/${isValidator ? "validators" : "accounts"}/${address}`,
    seed: `${isValidator ? "validator" : "account"}:${address}`,
    fields: [{ label: "Address", value: address }],
  };
}

/** Merge helper: later nodes never overwrite an earlier, richer one. */
function push(into: Map<string, GraphNode>, node: GraphNode) {
  const existing = into.get(node.id);
  if (!existing) {
    into.set(node.id, node);
    return;
  }
  // Keep whichever has more to say, so a stub party node yields to a real one.
  if ((node.fields?.length ?? 0) > (existing.fields?.length ?? 0)) {
    into.set(node.id, { ...existing, ...node });
  }
}

export async function buildGraph(chain: ChainConfig, seed: string): Promise<Graph> {
  const adapter = getAdapter(chain);
  const policy = policyFor(chain);
  const base = `/${chain.chainId}`;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const [kind, ...restParts] = seed.split(":");
  const arg = restParts.join(":");

  switch (kind) {
    /** The opening view: the head of the chain, newest block first. */
    case "head": {
      const count = Math.max(1, Math.min(20, Number(arg) || 8));
      const [fetched, proposers] = await Promise.all([
        adapter.getRecentBlocks(count),
        proposerNames(chain, adapter),
      ]);
      // The count is a hint to the adapter, not a guarantee — gno's indexing
      // API returns one more than asked for.
      const blocks = fetched.slice(0, count);
      let previous: string | null = null;
      for (const b of blocks) {
        const node = blockNode(base, b, proposers.get(b.proposer));
        push(nodes, node);
        // The chain itself is the first set of edges — parent to child, down.
        if (previous) edges.push({ from: previous, to: node.id });
        previous = node.id;
      }
      break;
    }

    /** One block, and the transactions it contains. */
    case "block": {
      const detail = await adapter.getBlockDetail(arg);
      if (!detail) return empty(seed, `No block at height ${arg}.`);

      const proposer =
        detail.proposerMoniker && detail.proposerOperator
          ? { moniker: detail.proposerMoniker, operator: detail.proposerOperator }
          : null;
      const block = blockNode(base, detail, proposer);
      push(nodes, block);

      if (proposer) {
        const val = partyNode(chain, base, proposer.operator);
        push(nodes, { ...val, label: proposer.moniker, sub: "proposer" });
        edges.push({ from: block.id, to: val.id, label: "proposed by" });
      }

      if (detail.txCount > 0) {
        const txs = await adapter.getBlockTxs(detail);
        txs.slice(0, 24).forEach((t, i) => {
          const node = txNode(chain, base, t, i);
          push(nodes, node);
          edges.push({ from: block.id, to: node.id });
        });
      }
      break;
    }

    /** One transaction: the block above it, the parties beside it. */
    case "tx": {
      const t = await adapter.getTx(arg);
      if (!t) return empty(seed, `No transaction ${truncateMiddle(arg, 10, 6)}.`);

      const node = txNode(chain, base, t);
      push(nodes, node);

      push(nodes, {
        id: `block:${t.height}`,
        kind: "block",
        label: Number(t.height).toLocaleString(),
        rank: Number(t.height),
        href: `${base}/blocks/${t.height}`,
        seed: `block:${t.height}`,
        fields: [{ label: "Height", value: Number(t.height).toLocaleString() }],
      });
      edges.push({ from: `block:${t.height}`, to: node.id });

      const denoms = chainDenoms(chain);
      for (const m of t.messages) {
        if (!m.transfer) continue;
        const amount =
          m.transfer.amount.length > 0 ? formatCoins(m.transfer.amount, denoms, 2) : undefined;
        if (m.transfer.from) {
          const from = partyNode(chain, base, m.transfer.from);
          push(nodes, from);
          edges.push({ from: from.id, to: node.id, label: m.label });
        }
        if (m.transfer.to) {
          const to = partyNode(chain, base, m.transfer.to);
          push(nodes, to);
          edges.push({ from: node.id, to: to.id, label: amount });
        }
      }
      break;
    }

    /** An address and what it has been doing. */
    case "account": {
      const [acct, txs] = await Promise.all([
        adapter.getAccount(arg),
        policy.txs
          ? adapter.getAccountTxs(arg).catch(() => null)
          : Promise.resolve(null),
      ]);

      const denoms = chainDenoms(chain);
      const self: GraphNode = {
        ...partyNode(chain, base, arg),
        sub: acct.exists ? `${acct.balances.length} denom` : "no record",
        fields: [
          { label: "Address", value: arg },
          ...(acct.balances.length > 0
            ? [{ label: "Balance", value: formatCoins(acct.balances, denoms, 2) }]
            : []),
          ...(acct.delegatedTotal
            ? [
                {
                  label: "Delegated",
                  value: `${formatToken(acct.delegatedTotal, chain.exponent, 2)} ${symbolFor(
                    chain
                  )}`,
                },
              ]
            : []),
        ],
      };
      push(nodes, self);

      for (const [i, t] of (txs?.txs ?? []).slice(0, 12).entries()) {
        const node = txNode(chain, base, t, i);
        push(nodes, node);
        // The account sits right of its transactions, so the edge runs back
        // leftward; the renderer draws direction, not just adjacency.
        edges.push({ from: node.id, to: self.id });
      }
      break;
    }

    /** A validator and the stake behind it. */
    case "validator": {
      const all = await adapter.getValidators();
      const v = all.find((x) => x.operatorAddress === arg);
      if (!v) return empty(seed, `No validator ${truncateMiddle(arg, 12, 6)}.`);

      const self: GraphNode = {
        id: `val:${v.operatorAddress}`,
        kind: "validator",
        label: v.moniker,
        sub: `#${v.rank} · ${(v.votingPower * 100).toFixed(2)}%`,
        href: `${base}/validators/${v.operatorAddress}`,
        seed: `validator:${v.operatorAddress}`,
        fields: [
          { label: "Moniker", value: v.moniker },
          { label: "Rank", value: `#${v.rank}` },
          {
            label: "Staked",
            value: `${formatToken(v.tokens, chain.exponent, 2)} ${symbolFor(chain)}`,
          },
          { label: "Share", value: `${(v.votingPower * 100).toFixed(2)}%` },
          { label: "Commission", value: `${(v.commissionRate * 100).toFixed(2)}%` },
          { label: "Operator", value: v.operatorAddress },
        ],
      };
      push(nodes, self);

      const { delegators } = await adapter.getDelegators(v.operatorAddress);
      for (const d of delegators.slice(0, 12)) {
        const node = partyNode(chain, base, d.address);
        push(nodes, {
          ...node,
          sub: `${(d.share * 100).toFixed(2)}% of stake`,
        });
        edges.push({
          from: node.id,
          to: self.id,
          label: `${formatToken(d.amount, chain.exponent, 0)}`,
        });
      }
      break;
    }

    default:
      return empty(seed, `Cannot expand "${seed}".`);
  }

  return { nodes: [...nodes.values()], edges, seed };
}

/** Proposer names for the head view. Unnamed proposers are acceptable here; a
 *  failed canvas is not, so an unreachable validator set degrades to an empty
 *  index rather than throwing. */
async function proposerNames(chain: ChainConfig, adapter: ReturnType<typeof getAdapter>) {
  try {
    return proposerIndex(await adapter.getValidators(), chain.bech32Prefix);
  } catch {
    return new Map<string, { moniker: string; operator: string }>();
  }
}
