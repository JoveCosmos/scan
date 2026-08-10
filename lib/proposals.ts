import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import type { Coin } from "@/lib/accounts";
import { accountFromOperator } from "@/lib/bech32";
import { votesFromIndexer, coverage, covers } from "@/lib/indexer-db";

export interface Tally {
  yes: string;
  abstain: string;
  no: string;
  /** AtomOne removed NoWithVeto from its gov module, so this can be absent. */
  veto: string | null;
  total: string;
}

export interface ProposalSummary {
  id: string;
  title: string;
  summary: string;
  status: string;
  submitTime: string | null;
  depositEndTime: string | null;
  votingStartTime: string | null;
  votingEndTime: string | null;
  totalDeposit: Coin[];
  proposer: string | null;
  messageTypes: string[];
  tally: Tally;
  /** True when the tally came from the live endpoint rather than the record. */
  liveTally: boolean;
  expedited: boolean;
  failedReason: string | null;
}

export interface GovParams {
  quorum: number | null;
  threshold: number | null;
  vetoThreshold: number | null;
  votingPeriod: string | null;
  minDeposit: Coin[];
}

interface RawTally {
  yes_count?: string;
  abstain_count?: string;
  no_count?: string;
  no_with_veto_count?: string;
}

interface RawProposal {
  id: string;
  status: string;
  title?: string;
  summary?: string;
  metadata?: string;
  submit_time?: string;
  deposit_end_time?: string;
  voting_start_time?: string;
  voting_end_time?: string;
  total_deposit?: Coin[];
  proposer?: string;
  expedited?: boolean;
  failed_reason?: string;
  final_tally_result?: RawTally;
  messages?: { "@type": string; content?: { title?: string; description?: string } }[];
}

interface ProposalsResponse {
  proposals?: RawProposal[];
  pagination?: { total?: string };
}

const STATUS_LABEL: Record<string, string> = {
  PROPOSAL_STATUS_DEPOSIT_PERIOD: "Deposit",
  PROPOSAL_STATUS_VOTING_PERIOD: "Voting",
  PROPOSAL_STATUS_PASSED: "Passed",
  PROPOSAL_STATUS_REJECTED: "Rejected",
  PROPOSAL_STATUS_FAILED: "Failed",
};

export function proposalStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/^PROPOSAL_STATUS_/, "");
}

export function isVoting(status: string): boolean {
  return status === "PROPOSAL_STATUS_VOTING_PERIOD";
}

function toTally(raw: RawTally | undefined): Tally {
  const yes = raw?.yes_count ?? "0";
  const abstain = raw?.abstain_count ?? "0";
  const no = raw?.no_count ?? "0";
  // Absent (not zero) on chains whose gov module has no veto option.
  const veto = raw?.no_with_veto_count ?? null;

  const total =
    BigInt(yes || 0) +
    BigInt(abstain || 0) +
    BigInt(no || 0) +
    BigInt(veto ?? 0);

  return { yes, abstain, no, veto, total: total.toString() };
}

function toSummary(raw: RawProposal): ProposalSummary {
  // Legacy v1beta1 proposals surface their text inside the message content.
  const legacy = raw.messages?.find((m) => m.content?.title)?.content;

  return {
    id: raw.id,
    title: raw.title?.trim() || legacy?.title?.trim() || `Proposal #${raw.id}`,
    summary: raw.summary?.trim() || legacy?.description?.trim() || "",
    status: raw.status,
    submitTime: raw.submit_time ?? null,
    depositEndTime: raw.deposit_end_time ?? null,
    votingStartTime: raw.voting_start_time ?? null,
    votingEndTime: raw.voting_end_time ?? null,
    totalDeposit: raw.total_deposit ?? [],
    proposer: raw.proposer ?? null,
    messageTypes: (raw.messages ?? []).map((m) => m["@type"]),
    tally: toTally(raw.final_tally_result),
    liveTally: false,
    expedited: raw.expedited ?? false,
    failedReason: raw.failed_reason?.trim() || null,
  };
}

/** Newest proposals first. */
export async function getProposals(
  chain: ChainConfig,
  limit = 30
): Promise<{ proposals: ProposalSummary[]; total: number | null }> {
  const res = await fetchLcd<ProposalsResponse>(chain, "/cosmos/gov/v1/proposals", {
    cache: "no-store",
    timeoutMs: 12_000,
    searchParams: {
      "pagination.limit": limit,
      "pagination.reverse": true,
      "pagination.count_total": true,
    },
  });

  return {
    proposals: (res.proposals ?? []).map(toSummary),
    total: res.pagination?.total ? Number(res.pagination.total) : null,
  };
}

export async function getProposal(
  chain: ChainConfig,
  id: string
): Promise<ProposalSummary | null> {
  let proposal: ProposalSummary;
  try {
    const res = await fetchLcd<{ proposal?: RawProposal }>(
      chain,
      `/cosmos/gov/v1/proposals/${id}`,
      { cache: "no-store", timeoutMs: 12_000 }
    );
    if (!res.proposal) return null;
    proposal = toSummary(res.proposal);
  } catch {
    return null;
  }

  // While voting is open final_tally_result is all zeros — the running count
  // lives on a separate endpoint.
  if (isVoting(proposal.status)) {
    try {
      const live = await fetchLcd<{ tally?: RawTally }>(
        chain,
        `/cosmos/gov/v1/proposals/${id}/tally`,
        { cache: "no-store", timeoutMs: 10_000 }
      );
      if (live.tally) {
        proposal = { ...proposal, tally: toTally(live.tally), liveTally: true };
      }
    } catch {
      // Keep the recorded tally.
    }
  }

  return proposal;
}

export interface VoteOption {
  option: string;
  /** 0–1. Only meaningful for split (weighted) votes. */
  weight: number;
}

export interface ProposalVote {
  voter: string;
  options: VoteOption[];
  /** Convenience: the heaviest option, which is the whole vote for most voters. */
  primary: string;
  weighted: boolean;
}

export interface ProposalVotes {
  votes: ProposalVote[];
  total: number | null;
  /** Counts per option, by voter head-count rather than by stake. */
  byOption: Record<string, number>;
  /**
   * "state" — live votes still held by the gov module.
   * "history" — reconstructed from MsgVote transactions after the gov module
   *   deleted the votes on tally. Only the most recent vote per address, since
   *   voters can change their mind while voting is open.
   * "indexer" — read from our own index, which stores the latest vote per
   *   voter as the chain emitted it. Same answer as "history", without the
   *   tens of paged requests.
   */
  source: "state" | "history" | "indexer";
  /** True when more votes exist than were fetched. */
  truncated: boolean;
  /**
   * Both reads failed. Distinguishes "could not load" from "nobody voted" —
   * without it a transient endpoint failure asserts that no votes exist.
   */
  failed: boolean;
}

const VOTE_LABEL: Record<string, string> = {
  VOTE_OPTION_YES: "Yes",
  VOTE_OPTION_NO: "No",
  VOTE_OPTION_NO_WITH_VETO: "No with Veto",
  VOTE_OPTION_ABSTAIN: "Abstain",
  VOTE_OPTION_UNSPECIFIED: "Unspecified",
};

export function voteOptionLabel(option: string): string {
  return VOTE_LABEL[option] ?? option.replace(/^VOTE_OPTION_/, "");
}

interface RawVote {
  voter: string;
  options?: { option: string; weight: string }[];
}

/**
 * Index the validator set by the account each one votes from.
 *
 * A validator casts its vote from its own account, never from the operator
 * address, so the two are joined through the bech32 payload they share.
 */
export function indexValidatorAccounts(
  validators: { operatorAddress: string; moniker: string }[],
  bech32Prefix: string
): Map<string, { moniker: string; operatorAddress: string }> {
  const byAccount = new Map<string, { moniker: string; operatorAddress: string }>();
  for (const v of validators) {
    const account = accountFromOperator(v.operatorAddress, bech32Prefix);
    if (account) {
      byAccount.set(account, {
        moniker: v.moniker,
        operatorAddress: v.operatorAddress,
      });
    }
  }
  return byAccount;
}

function tallyByOption(votes: ProposalVote[]): Record<string, number> {
  const byOption: Record<string, number> = {};
  for (const vote of votes) {
    byOption[vote.primary] = (byOption[vote.primary] ?? 0) + 1;
  }
  return byOption;
}

function toVote(voter: string, rawOptions: { option: string; weight: string }[]) {
  const options: VoteOption[] = rawOptions.map((o) => ({
    option: o.option,
    weight: Number(o.weight) || 0,
  }));
  const primary =
    [...options].sort((a, b) => b.weight - a.weight)[0]?.option ??
    "VOTE_OPTION_UNSPECIFIED";
  return { voter, options, primary, weighted: options.length > 1 };
}

interface VoteMessage {
  "@type": string;
  proposal_id?: string;
  voter?: string;
  option?: string;
  options?: { option: string; weight: string }[];
  /** Present on authz MsgExec: the messages it executes on the granter's behalf. */
  msgs?: VoteMessage[];
}

/** Deepest authz nesting we will unwrap. MsgExec inside MsgExec is legal but
 *  vanishingly rare; the cap stops a malformed tx from recursing forever. */
const MAX_AUTHZ_DEPTH = 4;

/**
 * Flatten authz wrappers so nested votes are visible.
 *
 * Validators very commonly vote from a hot key holding an authz grant, which
 * puts the real MsgVote inside `MsgExec.msgs` rather than at the top level.
 * Reading only top-level messages silently drops those votes — GATA HUB's vote
 * on AtomOne proposal 21 was cast exactly this way and did not appear.
 *
 * The voter recorded inside the nested message is the granter, which is the
 * identity we want; the grantee is only the key that broadcast it.
 */
export function flattenVoteMessages(
  messages: VoteMessage[] | undefined,
  depth = 0
): VoteMessage[] {
  if (!messages || depth > MAX_AUTHZ_DEPTH) return [];
  const out: VoteMessage[] = [];
  for (const msg of messages) {
    if (/MsgExec$/.test(msg["@type"])) {
      out.push(...flattenVoteMessages(msg.msgs, depth + 1));
    } else {
      out.push(msg);
    }
  }
  return out;
}

/**
 * Rebuild the vote list from MsgVote transactions.
 *
 * The gov module deletes votes from state as it tallies them, so a finished
 * proposal has none left — but the transactions that cast them are still in
 * block history. Fetched newest-first and deduplicated by voter, because a
 * voter may recast while voting is open and only their last vote counted.
 */
/** Votes per gov-state request. Large pages are almost free here. */
const STATE_VOTE_PAGE = 5000;
/** 20,000 votes, well past the largest turnout seen on these chains. */
const STATE_VOTE_MAX_PAGES = 4;

/** Tx search caps a page at 100 server-side regardless of the limit asked for. */
const TX_PAGE = 100;
/** 60 pages = 6,000 vote transactions. */
const TX_MAX_PAGES = 60;
/** Pages are independent, so they are fetched concurrently. Kept low enough not
 *  to hammer a public endpoint. */
const TX_CONCURRENCY = 8;

interface VoteTxPage {
  txs?: { body?: { messages?: VoteMessage[] } }[];
  tx_responses?: { code?: number }[];
  /** Tx search reports its count here, not under pagination. */
  total?: string;
}

/**
 * One page of vote transactions. `page` is 1-indexed.
 *
 * Note the parameter: tx search **silently ignores `pagination.offset`** and
 * returns the first page for every value, so paging by offset yields the same
 * 100 transactions over and over. Only `page` advances the cursor.
 */
async function voteTxPage(
  chain: ChainConfig,
  id: string,
  page: number
): Promise<VoteTxPage> {
  const fetchPage = () =>
    fetchLcd<VoteTxPage>(chain, "/cosmos/tx/v1beta1/txs", {
      cache: "no-store",
      // Deliberately short. A healthy page answers in ~1s; a node that has not
      // replied in 8s is wedged, and waiting out a long timeout on each of tens
      // of pages is what turns one bad node into a 45s page load. The retry
      // below lands on a different node instead.
      timeoutMs: 8_000,
      searchParams: {
        query: `proposal_vote.proposal_id='${id}'`,
        order_by: "ORDER_BY_DESC",
        "pagination.limit": TX_PAGE,
        page,
      },
    });

  const res = await fetchPage();
  // Public pools contain nodes without a full tx index; those answer 200 with
  // zero results instead of erroring, which would silently punch a hole in the
  // vote list. One retry usually lands on an indexed node.
  if ((res.txs?.length ?? 0) === 0) {
    try {
      return await fetchPage();
    } catch {
      return res;
    }
  }
  return res;
}

async function votesFromHistory(
  chain: ChainConfig,
  id: string,
  limit: number
): Promise<ProposalVotes | null> {
  {
    const first = await voteTxPage(chain, id, 1);
    if ((first.txs?.length ?? 0) === 0) return null;

    const matchedTxs = Number(first.total);
    const pageCount = Number.isFinite(matchedTxs)
      ? Math.min(Math.ceil(matchedTxs / TX_PAGE), TX_MAX_PAGES)
      : 1;

    const pages: VoteTxPage[] = [first];
    for (let start = 1; start < pageCount; start += TX_CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(TX_CONCURRENCY, pageCount - start) },
        // +1 because page 1 is the one already fetched above.
        (_, k) => voteTxPage(chain, id, start + k + 1)
      );
      // One dead page must not discard the pages that did arrive.
      for (const settled of await Promise.allSettled(batch)) {
        if (settled.status === "fulfilled") pages.push(settled.value);
      }
    }

    const res: VoteTxPage = {
      total: first.total,
      txs: pages.flatMap((p) => p.txs ?? []),
      tx_responses: pages.flatMap((p) => p.tx_responses ?? []),
    };

    const txs = res.txs ?? [];
    if (txs.length === 0) return null;

    const seen = new Set<string>();
    const votes: ProposalVote[] = [];

    txs.forEach((tx, i) => {
      // A failed transaction never recorded a vote.
      if ((res.tx_responses?.[i]?.code ?? 0) !== 0) return;

      for (const msg of flattenVoteMessages(tx.body?.messages)) {
        if (!/MsgVote(Weighted)?$/.test(msg["@type"])) continue;
        if (msg.proposal_id !== undefined && msg.proposal_id !== id) continue;

        const voter = msg.voter;
        if (!voter || seen.has(voter)) continue;
        seen.add(voter);

        const rawOptions = msg.options?.length
          ? msg.options
          : msg.option
            ? [{ option: msg.option, weight: "1" }]
            : [];
        if (rawOptions.length === 0) continue;

        votes.push(toVote(voter, rawOptions));
      }
    });

    if (votes.length === 0) return null;

    // `res.total` counts vote *transactions*, not voters — a voter who recast
    // appears more than once and was deduplicated above. So once every page has
    // been read, the voter count is what we resolved, not what tx search
    // reported. Only a capped read leaves voters genuinely unseen.
    const truncated = Number.isFinite(matchedTxs)
      ? Math.ceil(matchedTxs / TX_PAGE) > TX_MAX_PAGES
      : false;

    return {
      votes: votes.slice(0, limit),
      total: votes.length,
      byOption: tallyByOption(votes),
      source: "history",
      truncated: truncated || votes.length > limit,
      failed: false,
    };
  }
}

/**
 * Individual votes, preferring live state and falling back to transaction
 * history once the gov module has deleted them at tally time.
 */
export async function getProposalVotes(
  chain: ChainConfig,
  id: string,
  limit = 20_000,
  /**
   * Voting window, used only to decide whether the indexer covers this
   * proposal. Absent means "do not trust the index", which is the safe default.
   */
  window?: { start: string | null; end: string | null }
): Promise<ProposalVotes> {
  const empty: ProposalVotes = {
    votes: [],
    total: null,
    byOption: {},
    source: "state",
    truncated: false,
    failed: false,
  };

  // Tried first, and only when the index demonstrably covers the whole voting
  // period. A partially backfilled proposal would otherwise report a subset of
  // its votes as though that were the complete picture — worse than being slow,
  // because it looks like a fact.
  if (window) {
    const indexed = await votesFromIndexer(chain.chainId, id).catch(() => null);
    if (indexed && indexed.length > 0) {
      const c = await coverage(chain.chainId);
      if (covers(c, window.start, window.end)) {
        const votes: ProposalVote[] = indexed.map((v) =>
          toVote(
            v.voter,
            v.options ?? [{ option: v.option, weight: "1" }]
          )
        );
        return {
          votes: votes.slice(0, limit),
          total: votes.length,
          byOption: tallyByOption(votes),
          source: "indexer",
          truncated: votes.length > limit,
          failed: false,
        };
      }
    }
  }

  let stateFailed = false;

  try {
    // Paged in full. The gov module returns votes in key order, so reading one
    // page and stopping shows an arbitrary subset — and the tally underneath
    // would disagree with the list above it. Measured on a 2,616-vote proposal:
    // the whole set comes back in ~1.2s.
    const raw: RawVote[] = [];
    let nextKey: string | null = null;
    let capped = true;

    for (let page = 0; page < STATE_VOTE_MAX_PAGES; page++) {
      const res: {
        votes?: RawVote[];
        pagination?: { next_key?: string | null };
      } = await fetchLcd(chain, `/cosmos/gov/v1/proposals/${id}/votes`, {
        cache: "no-store",
        timeoutMs: 20_000,
        searchParams: {
          "pagination.limit": STATE_VOTE_PAGE,
          ...(nextKey ? { "pagination.key": nextKey } : {}),
        },
      });

      raw.push(...(res.votes ?? []));
      nextKey = res.pagination?.next_key || null;
      if (!nextKey) {
        capped = false;
        break;
      }
    }

    const votes: ProposalVote[] = raw.map((v) => toVote(v.voter, v.options ?? []));

    if (votes.length > 0) {
      return {
        votes: votes.slice(0, limit),
        total: votes.length,
        byOption: tallyByOption(votes),
        source: "state",
        truncated: capped || votes.length > limit,
        failed: false,
      };
    }
  } catch {
    // Endpoint problem rather than an empty result — remember which, so an
    // empty render can tell the difference.
    stateFailed = true;
  }

  try {
    const fromHistory = await votesFromHistory(chain, id, limit);
    if (fromHistory) return fromHistory;
    // No vote transactions found: a genuine empty result, not a failure.
    return { ...empty, failed: stateFailed };
  } catch {
    return { ...empty, failed: true };
  }
}

export async function getGovParams(chain: ChainConfig): Promise<GovParams> {
  try {
    const res = await fetchLcd<{
      params?: {
        quorum?: string;
        threshold?: string;
        veto_threshold?: string;
        voting_period?: string;
        min_deposit?: Coin[];
      };
    }>(chain, "/cosmos/gov/v1/params/tallying", {
      cache: "no-store",
      timeoutMs: 10_000,
    });

    const p = res.params ?? {};
    const num = (v: string | undefined) =>
      v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

    return {
      quorum: num(p.quorum),
      threshold: num(p.threshold),
      vetoThreshold: num(p.veto_threshold),
      votingPeriod: p.voting_period ?? null,
      minDeposit: p.min_deposit ?? [],
    };
  } catch {
    return {
      quorum: null,
      threshold: null,
      vetoThreshold: null,
      votingPeriod: null,
      minDeposit: [],
    };
  }
}

/** Share of the tally each option holds, 0–1. Empty tallies yield zeros. */
export function tallyShares(tally: Tally): {
  yes: number;
  abstain: number;
  no: number;
  veto: number;
} {
  const total = Number(tally.total);
  if (!Number.isFinite(total) || total <= 0) {
    return { yes: 0, abstain: 0, no: 0, veto: 0 };
  }
  return {
    yes: Number(tally.yes) / total,
    abstain: Number(tally.abstain) / total,
    no: Number(tally.no) / total,
    veto: tally.veto ? Number(tally.veto) / total : 0,
  };
}
