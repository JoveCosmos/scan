import type { ChainConfig } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { gnoRender } from "@/lib/gno-packages";

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
