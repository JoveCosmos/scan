import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import type { Coin } from "@/lib/accounts";

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
 * Individual votes. The gov module deletes votes once a proposal is tallied, so
 * this is normally empty for anything past its voting period — that is pruning,
 * not an absence of votes, and the UI says so.
 */
export async function getProposalVotes(
  chain: ChainConfig,
  id: string,
  limit = 300
): Promise<ProposalVotes> {
  try {
    const res = await fetchLcd<{
      votes?: RawVote[];
      pagination?: { total?: string };
    }>(chain, `/cosmos/gov/v1/proposals/${id}/votes`, {
      cache: "no-store",
      timeoutMs: 15_000,
      searchParams: { "pagination.limit": limit, "pagination.count_total": true },
    });

    const byOption: Record<string, number> = {};

    const votes: ProposalVote[] = (res.votes ?? []).map((v) => {
      const options: VoteOption[] = (v.options ?? []).map((o) => ({
        option: o.option,
        weight: Number(o.weight) || 0,
      }));
      const sorted = [...options].sort((a, b) => b.weight - a.weight);
      const primary = sorted[0]?.option ?? "VOTE_OPTION_UNSPECIFIED";
      byOption[primary] = (byOption[primary] ?? 0) + 1;

      return {
        voter: v.voter,
        options,
        primary,
        weighted: options.length > 1,
      };
    });

    return {
      votes,
      total: res.pagination?.total ? Number(res.pagination.total) : votes.length,
      byOption,
    };
  } catch {
    return { votes: [], total: null, byOption: {} };
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
