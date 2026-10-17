import type { ChainConfig } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { gnoRender, gnoTxTimes } from "@/lib/gno-packages";
import { gnoNames } from "@/lib/gno-users";
import { gnoHashToHex, gql } from "@/lib/gno";
import { gnoIndexed, indexedCallsTo } from "@/lib/gno-index";

/**
 * gno.land's governance: GovDAO, a realm (gno.land/r/gov/dao) rather than a
 * chain module. Its members sit in tiers T1 to T3 (a vote weighs 3, 2 or 1),
 * and a proposal carries an executor that runs when it passes.
 *
 * The realm's Render pages are its public interface: the list (paged,
 * "?page=N"), each proposal (":<id>") and its voters (":<id>/votes"). They are
 * Markdown meant for gno.land's own site, so the parsing here is by the lines
 * the realm writes, and anything it cannot read is left out rather than
 * guessed.
 */

export const GOVDAO = "gno.land/r/gov/dao";

export type GovStatus = "accepted" | "rejected" | "active" | "executed" | "other";

export interface GovProposalSummary {
  id: number;
  title: string;
  /** "@moul" or a g1 address. */
  author: string;
  status: GovStatus;
  /** The realm's own word for it, for anything not mapped. */
  statusText: string;
  tiers: string[];
}

export interface GovVoter {
  option: "YES" | "NO" | "ABSTAIN";
  tier: string;
  /** "@moul" or a g1 address. */
  voter: string;
}

export interface GovProposal extends GovProposalSummary {
  /** The proposal's own description, Markdown. */
  body: string;
  /** The realm that built the executor, e.g. gno.land/r/sys/validators/v0. */
  executor: string | null;
  yes: number | null;
  no: number | null;
  abstain: number | null;
  voters: GovVoter[] | null;
}

function statusOf(text: string): GovStatus {
  const t = text.toLowerCase();
  if (/accepted/.test(t)) return "accepted";
  if (/rejected|denied/.test(t)) return "rejected";
  if (/executed/.test(t)) return "executed";
  if (/open for votes|active/.test(t)) return "active";
  return "other";
}

/** "[@moul](/u/moul)" → "@moul"; an address stays as written. */
function plainAuthor(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

/** Markdown escapes the realm adds ("run\_submitters") taken out. */
function unescape(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");
}

/** One page of the list. Exported for tests. */
export function parseProposalList(md: string): { proposals: GovProposalSummary[]; pages: number } {
  const proposals: GovProposalSummary[] = [];
  const blocks = md.split(/\n(?=###\s)/);
  for (const block of blocks) {
    const head = block.match(/^###\s+\[Prop #(\d+)\s+-\s+(.*?)\]\(/m);
    if (!head) continue;
    const author = block.match(/^Author:\s*(.+)$/m)?.[1] ?? "";
    const status = block.match(/^Status:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const tiers = block.match(/^Tiers eligible to vote:\s*(.+)$/m)?.[1] ?? "";
    proposals.push({
      id: Number(head[1]),
      title: unescape(head[2].trim()),
      author: plainAuthor(author),
      status: statusOf(status),
      statusText: status,
      tiers: tiers.split(",").map((t) => t.trim()).filter(Boolean),
    });
  }
  const pageLinks = [...md.matchAll(/\?page=(\d+)/g)].map((m) => Number(m[1]));
  return { proposals, pages: Math.max(1, ...pageLinks) };
}

/** One proposal's page and its vote list. Exported for tests. */
export function parseProposal(id: number, md: string, votesMd: string | null): GovProposal | null {
  const head = md.match(/^##\s+Prop #(\d+)\s+-\s+(.*)$/m);
  if (!head || Number(head[1]) !== id) return null;
  const lines = md.split("\n");
  const authorAt = lines.findIndex((l) => /^Author:/.test(l));
  // The description runs from after the author to the first rule before Stats.
  const statsAt = lines.findIndex((l) => /^###\s+Stats/.test(l));
  let end = statsAt > 0 ? statsAt : lines.length;
  while (end > 0 && /^\s*(---)?\s*$/.test(lines[end - 1])) end -= 1;
  const bodyLines = lines.slice(authorAt >= 0 ? authorAt + 1 : 1, end);
  const executorLine = bodyLines.findIndex((l) => /^Executor created in:/.test(l));
  const executor = executorLine >= 0 ? (bodyLines[executorLine].match(/`([^`]+)`/)?.[1] ?? null) : null;
  if (executorLine >= 0) bodyLines.splice(executorLine, 1);
  const stats = statsAt >= 0 ? lines.slice(statsAt).join("\n") : "";
  const pct = (label: string) => {
    const m = stats.match(new RegExp(`${label} PERCENT:\\s*([\\d.]+)%`, "i"));
    return m ? Number(m[1]) : null;
  };
  const statusText = stats.match(/^-\s+\*\*(.+?)\*\*/m)?.[1] ?? "";
  const tiers = stats.match(/Tiers eligible to vote:\s*(.+)$/m)?.[1] ?? "";

  return {
    id,
    title: unescape(head[2].trim()),
    author: plainAuthor(lines[authorAt]?.replace(/^Author:\s*/, "") ?? ""),
    status: statusOf(statusText),
    statusText,
    tiers: tiers.split(",").map((t) => t.trim()).filter(Boolean),
    body: bodyLines.join("\n").trim(),
    executor,
    yes: pct("YES"),
    no: pct("NO"),
    abstain: pct("ABSTAIN"),
    voters: votesMd === null ? null : parseVoters(votesMd),
  };
}

function parseVoters(md: string): GovVoter[] {
  const voters: GovVoter[] = [];
  let current: { option: GovVoter["option"]; tier: string } | null = null;
  for (const line of md.split("\n")) {
    const group = line.match(/^(YES|NO|ABSTAIN) from (T\d)/);
    if (group) {
      current = { option: group[1] as GovVoter["option"], tier: group[2] };
      continue;
    }
    const item = line.match(/^-\s+(.+)$/);
    if (item && current) voters.push({ ...current, voter: plainAuthor(item[1]) });
  }
  return voters;
}

/** Every proposal, newest first. Null when the realm cannot be read. */
export function govdaoProposals(chain: ChainConfig): Promise<GovProposalSummary[] | null> {
  return cached(
    `govdao-list:${chain.chainId}`,
    60_000,
    async () => {
      const first = await gnoRender(chain, GOVDAO, "");
      if (!first) throw new Error("GovDAO unavailable");
      const { proposals, pages } = parseProposalList(first);
      const rest = await Promise.all(
        Array.from({ length: Math.min(pages, 50) - 1 }, (_, i) => gnoRender(chain, GOVDAO, `?page=${i + 2}`))
      );
      for (const md of rest) if (md) proposals.push(...parseProposalList(md).proposals);
      const byId = new Map(proposals.map((p) => [p.id, p]));
      return [...byId.values()].sort((a, b) => b.id - a.id);
    },
    { staleMs: 30 * 60_000 }
  ).catch(() => null);
}

/** One proposal with its description, tally and voters. Null when there is none. */
export function govdaoProposal(chain: ChainConfig, id: number): Promise<GovProposal | null> {
  return cached(
    `govdao-prop:${chain.chainId}:${id}`,
    60_000,
    async () => {
      const [md, votes] = await Promise.all([
        gnoRender(chain, GOVDAO, String(id)),
        gnoRender(chain, GOVDAO, `${id}/votes`),
      ]);
      return md ? parseProposal(id, md, votes) : null;
    },
    { staleMs: 30 * 60_000, group: { name: "govdao-prop", max: 50 } }
  );
}

export function statusLabel(s: GovStatus, text: string): string {
  switch (s) {
    case "accepted":
      return "Passed";
    case "rejected":
      return "Rejected";
    case "executed":
      return "Executed";
    case "active":
      return "Voting";
    default:
      return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : "N/A";
  }
}

export const MEMBERSTORE = "gno.land/r/gov/dao/memberstore/v0";

export interface GovMember {
  address: string;
  tier: string;
  /** The name registered in gno.land/r/sys/users, without "@"; null when none. */
  name: string | null;
}

export interface GovTier {
  tier: string;
  members: number;
  power: number;
}

/** The member list and the tier summary. Exported for tests. */
export function parseMembers(md: string): { address: string; tier: string }[] {
  return [...md.matchAll(/(T\d+) \| (g1[a-z0-9]{38})/g)].map((m) => ({ tier: m[1], address: m[2] }));
}

export function parseTiers(md: string): GovTier[] {
  return [...md.matchAll(/Tier (T\d+) contains (\d+) members? with power: (\d+)/g)].map((m) => ({
    tier: m[1],
    members: Number(m[2]),
    power: Number(m[3]),
  }));
}

/** GovDAO's members with their tier and name, and the power of each tier. */
export function govdaoMembers(chain: ChainConfig): Promise<{ members: GovMember[]; tiers: GovTier[] } | null> {
  return cached(
    `govdao-members:${chain.chainId}`,
    5 * 60_000,
    async () => {
      const [list, summary] = await Promise.all([
        gnoRender(chain, MEMBERSTORE, "members?filter=T1%2CT2%2CT3"),
        gnoRender(chain, MEMBERSTORE, ""),
      ]);
      if (!list) throw new Error("memberstore unavailable");
      const rows = parseMembers(list);
      const names = await gnoNames(chain).catch(() => null);
      return {
        members: rows.map((r) => ({ ...r, name: names?.byAddress.get(r.address) ?? null })),
        tiers: summary ? parseTiers(summary) : [],
      };
    },
    { staleMs: 60 * 60_000 }
  ).catch(() => null);
}

export interface GovMoment {
  height: number;
  /** Uppercase hex. */
  txHash: string;
  time: string | null;
}

export interface GovVote extends GovMoment {
  /** As the call passed it: "YES", "NO" or "ABSTAIN". */
  option: string;
}

export interface GovTimeline {
  created: GovMoment;
  executed: GovMoment | null;
  /**
   * Each vote cast by a MustVoteOnProposalSimple call, by voter address. A
   * vote cast from a script (MsgRun) names no realm in its transaction, so it
   * has none.
   */
  votes: Map<string, GovVote>;
}

type CreatedTx = {
  hash: string;
  block_height: number;
  response: { events: { type?: string; pkg_path?: string; attrs?: { key: string; value: string }[] | null }[] | null } | null;
};

const EXECUTE = new Set(["ExecuteProposal", "ExecuteOrRejectProposal"]);
const VOTE = "MustVoteOnProposalSimple";

/**
 * When each proposal was created, voted on and executed, which the realm's
 * pages do not say: its ProposalCreated events (attr `id`), from the
 * tx-indexer, and the successful MustVoteOnProposalSimple (id, option) and
 * ExecuteProposal / ExecuteOrRejectProposal (id) calls, from our index.
 */
export function govdaoTimeline(chain: ChainConfig): Promise<Map<number, GovTimeline> | null> {
  return cached(
    `govdao-timeline:${chain.chainId}`,
    10 * 60_000,
    async () => {
      const [created, pool] = await Promise.all([
        gql<{ getTransactions: CreatedTx[] | null }>(
          chain,
          `{ getTransactions(where: { success: { eq: true }, response: { events: { GnoEvent: { pkg_path: { eq: "${GOVDAO}" }, type: { eq: "ProposalCreated" } } } } }) {
            hash block_height response { events { ... on GnoEvent { type pkg_path attrs { key value } } } } } }`,
          {},
          30_000
        ),
        gnoIndexed(chain.chainId, "gno_tx_msg"),
      ]);
      const out = new Map<number, GovTimeline>();
      for (const tx of created.getTransactions ?? []) {
        const txHash = gnoHashToHex(tx.hash);
        if (!txHash) continue;
        for (const e of tx.response?.events ?? []) {
          if (e.type !== "ProposalCreated" || e.pkg_path !== GOVDAO) continue;
          const id = Number(e.attrs?.find((a) => a.key === "id")?.value);
          if (Number.isInteger(id) && !out.has(id)) {
            out.set(id, { created: { height: tx.block_height, txHash, time: null }, executed: null, votes: new Map() });
          }
        }
      }
      // Oldest first: the first execution counts, and a voter's last vote.
      const calls = pool ? await indexedCallsTo(pool, chain.chainId, GOVDAO, [...EXECUTE, VOTE]) : [];
      for (const c of calls) {
        const entry = out.get(Number(c.args?.[0]));
        if (!entry) continue;
        const at = { height: c.height, txHash: c.txHash, time: c.time };
        if (c.func === VOTE) entry.votes.set(c.caller, { ...at, option: String(c.args?.[1] ?? "").toUpperCase() });
        else if (!entry.executed) entry.executed = at;
      }
      const moments = [...out.values()].flatMap((t) => [t.created, ...(t.executed ? [t.executed] : []), ...t.votes.values()]);
      const times = await gnoTxTimes(
        chain.chainId,
        moments.filter((m) => m.time === null).map((m) => m.txHash)
      );
      for (const m of moments) m.time ??= times.get(m.txHash) ?? null;
      // Where our index has no time, the tx-indexer's block has one.
      await Promise.all(
        moments
          .filter((m) => m.time === null)
          .map(async (m) => {
            const b = await gql<{ getBlocks: { time: string }[] | null }>(
              chain,
              `query($h: Int!) { getBlocks(where: { height: { eq: $h } }) { time } }`,
              { h: m.height }
            ).catch(() => null);
            m.time = b?.getBlocks?.[0]?.time ?? null;
          })
      );
      return out;
    },
    { staleMs: 6 * 60 * 60_000 }
  ).catch(() => null);
}
