import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getChain, symbolFor, accentFor, chainDenoms } from "@/lib/chains";
import {
  findValidator,
  getValidator,
  keybaseUsername,
  statusLabel,
} from "@/lib/validators";
import { formatToken } from "@/lib/overview";
import { shortDenom } from "@/lib/coin";
import { decodeParam, timeAgo, truncateMiddle } from "@/lib/format";
import { accountFromOperator, convertAddress, decodePrefix, linkedAddresses } from "@/lib/bech32";
import { getAdapter } from "@/lib/adapter";
import { resolveGnoValidatorAddress } from "@/lib/gno";
import {
  emptyUptime,
  consensusIdsFromPubkey,
  DETAIL_BAR_COUNT,
  jailedNow,
  longestMissStreak,
  missBudget,
} from "@/lib/uptime";
import {
  commissionEarned,
  proposerStats,
  slashHistory,
  stakeHistory,
  type SlashKind,
} from "@/lib/indexer-db";
import {
  consHexOf,
  indexBehind,
  powerEvents,
  powerHistory,
  proposedBlocks,
  proposerFairness,
  signingHistory,
  validatorEvents,
  validatorVotes,
  voterRecasts,
  type ValidatorEventKind,
} from "@/lib/indexer-validator";
import { formatDuration, jailSpells } from "@/lib/signing-stats";
import { ValidatorSigningHistory } from "@/components/validator-signing-history";
import { ValidatorPowerHistory } from "@/components/validator-power-history";
import { getSelfBond } from "@/lib/staking";
import { getChainAprCached } from "@/lib/params";
import { voteOptionLabel } from "@/lib/proposals";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec, type DetailRow } from "@/components/brick-board";
import { RowDeck, type DeckRow } from "@/components/row-deck";
import { SectionTabs } from "@/components/section-tabs";
import { CopyButton } from "@/components/copy-button";
import { AddressLink } from "@/components/address-link";
import { GnoValidatorDetail } from "@/components/gno-validator-detail";
import { LinkedAddresses } from "@/components/linked-addresses";
import { LoadingPanel } from "@/components/loading-panel";
import { UptimeBars } from "@/components/uptime-bars";
import { ValidatorDelegators } from "@/components/validator-delegators";
import { ValidatorElsewhere } from "@/components/validator-elsewhere";
import { ValidatorStakeChart } from "@/components/validator-stake-history";
import { ValidatorStatus } from "@/components/validator-status";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}): Promise<Metadata> {
  const { chain: chainId, addr: rawAddr } = await params;
  const chain = getChain(chainId);
  if (!chain) return { title: "Validator" };

  const addr = decodeParam(rawAddr);
  // Avoid the Cosmos staking lookup for chains that have no staking module.
  if (chain.kind === "gno") return { title: `Validator ${addr.slice(0, 12)}…` };

  const validator = await getValidator(chain, addr);
  return { title: validator ? validator.moniker : "Validator" };
}

const pct = (value: number | null, decimals = 2) =>
  value === null ? "—" : `${(value * 100).toFixed(decimals)}%`;

/** Drops rows whose value is a dash, so a popup never lists absent facts. */
const kept = (rows: DetailRow[]) => rows.filter((r) => r.value !== "—" && r.value !== "");

/** Blocks proposed against blocks owed by stake. */
function verdict(ratio: number): string {
  if (ratio >= 0.95) return "in line";
  if (ratio >= 0.85) return "slightly under";
  return "under";
}

const SLASH_LABEL: Record<SlashKind, string> = {
  jailed: "Jailed",
  unjailed: "Unjailed",
  slashed: "Slashed",
  tombstoned: "Tombstoned",
};

const EVENT_LABEL: Record<ValidatorEventKind, string> = {
  create: "Created",
  edit: "Edited",
  unjail: "Unjailed",
  commission: "Commission withdrawn",
};

function reasonLabel(reason: string | null): string {
  if (reason === "downtime") return "Missed blocks";
  if (reason === "double_sign") return "Double signing";
  return "—";
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const TABS = ["delegators", "signing", "proposed", "votes", "events", "power", "stake", "jailings"];

/**
 * One validator: what it is worth, how it behaves, and who backs it.
 *
 * The header carries identity (operator, account, consensus address, Keybase,
 * the same operator on other networks); the bricks carry the figures; the tabs
 * carry the lists — delegators, signing, proposed blocks, votes, events, stake
 * and jailings — each addressable by `?tab=`.
 *
 * Indexed sections stay absent rather than zero when the index cannot answer:
 * nobody can tell "never jailed" from "no data" once a zero has been printed.
 */
export default async function ValidatorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string; addr: string }>;
  searchParams: Promise<{ tab?: string; dp?: string }>;
}) {
  const { chain: chainId, addr: rawAddr } = await params;
  const { tab, dp } = await searchParams;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const addr = decodeParam(rawAddr).trim().toLowerCase();

  // gno.land has no staking module — identity comes from the valopers realm
  // instead, so it gets an entirely different detail view.
  if (chain.kind === "gno") {
    const raw = decodeParam(rawAddr);
    // A gno operator address and its signing address are two names for one
    // validator; the signing address is the page.
    const page = await resolveGnoValidatorAddress(chain, raw);
    if (page && page !== raw) redirect(`/${chainId}/validators/${page}`);
    return <GnoValidatorDetail chain={chain} address={raw} />;
  }

  // Any of a validator's three addresses lands on its page: the operator
  // address is the page, a consensus address or the operator's own account
  // redirect to it.
  const prefix = decodePrefix(addr);
  if (prefix === `${chain.bech32Prefix}valcons`) {
    const hit = await findValidator(
      chain,
      { valcons: addr },
      (pubkey) => consensusIdsFromPubkey(pubkey, chain.bech32Prefix)?.valcons ?? null
    );
    if (hit) redirect(`/${chainId}/validators/${hit.operatorAddress}`);
  } else if (prefix === chain.bech32Prefix) {
    const operator = convertAddress(addr, `${chain.bech32Prefix}valoper`);
    if (operator && (await getValidator(chain, operator))) {
      redirect(`/${chainId}/validators/${operator}`);
    }
  }

  const validator = await getValidator(chain, addr);
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);

  if (!validator) {
    return (
      <PageFrame title="Validator not found" sub={chain.prettyName} accent={accent}>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{truncateMiddle(addr, 12, 8)}</span>: N/A.{" "}
          <Link href={`/${chainId}/validators`} className="text-primary hover:underline">
            Validators
          </Link>
        </p>
      </PageFrame>
    );
  }

  const selfDelegation = accountFromOperator(addr, chain.bech32Prefix);
  // Derived from the self-delegation account, never from the operator address:
  // re-encoding a …valoper1… under another prefix is a different entity.
  const links = selfDelegation ? linkedAddresses(selfDelegation) : [];
  // Slashing and block production are recorded against the consensus address.
  const ids = validator.consensusPubkey
    ? consensusIdsFromPubkey(validator.consensusPubkey, chain.bech32Prefix)
    : null;
  const adapter = getAdapter(chain);

  const [
    uptime,
    earned,
    proposer,
    fairness,
    proposedList,
    slashes,
    stake,
    events,
    selfBond,
    apr,
    keybase,
    signingHist,
    powerEv,
    powerHist,
    behind,
  ] = await Promise.all([
    adapter
      .getUptime([validator], DETAIL_BAR_COUNT)
      .then((m) => m.get(addr) ?? emptyUptime())
      .catch(() => emptyUptime()),
    // Keyed on the account: commission is attributed through the signer.
    selfDelegation ? commissionEarned(chain.chainId, selfDelegation).catch(() => null) : null,
    ids ? proposerStats(chain.chainId, ids.hex).catch(() => null) : null,
    ids ? proposerFairness(chain.chainId, addr, ids.hex).catch(() => null) : null,
    ids ? proposedBlocks(chain.chainId, ids.hex).catch(() => null) : null,
    ids ? slashHistory(chain.chainId, ids.valcons, addr).catch(() => null) : null,
    stakeHistory(chain.chainId, addr).catch((err) => {
      console.error(`stakeHistory failed for ${addr}:`, err);
      return null;
    }),
    selfDelegation ? validatorEvents(chain.chainId, selfDelegation).catch(() => null) : null,
    getSelfBond(chain, addr, validator.tokens).catch(() => null),
    getChainAprCached(chain).catch(() => null),
    validator.identity ? keybaseUsername(validator.identity) : null,
    // Signing record from the index: the key the index files it under, or the
    // one derived from the validator's consensus pubkey.
    (async () => {
      const hex = ids?.hex ?? (await consHexOf(chain.chainId, addr));
      return hex ? signingHistory(chain.chainId, hex) : null;
    })().catch(() => null),
    powerEvents(chain.chainId, addr).catch(() => null),
    (async () => {
      const hex = ids?.hex ?? (await consHexOf(chain.chainId, addr));
      return hex ? powerHistory(chain.chainId, hex) : null;
    })().catch(() => null),
    indexBehind(chain.chainId).catch(() => false),
  ]);

  // The validator's own creation, where the index holds it, bounds what it can
  // be counted absent from in governance.
  const created = events?.filter((e) => e.kind === "create").at(-1)?.time ?? null;
  const [votes, recasts] = selfDelegation
    ? await Promise.all([
        validatorVotes(chain.chainId, selfDelegation, created).catch(() => null),
        voterRecasts(chain.chainId, selfDelegation).catch(() => null),
      ])
    : [null, null];

  // The chain's own denoms carry a symbol and an exponent; anything else (an
  // IBC hash) is shown as-is rather than scaled by a guess.
  const known = new Map(chainDenoms(chain).map((d) => [d.denom, d]));
  const coin = (c: { denom: string; amount: string }, frac = 2) => {
    const info = known.get(c.denom);
    return info
      ? `${formatToken(c.amount, info.exponent, frac)} ${info.symbol}`
      : `${c.amount} ${shortDenom(c.denom)}`;
  };

  const jailed = jailedNow(uptime, validator.jailed);
  const signed =
    uptime.window !== null && uptime.missed !== null ? uptime.window - uptime.missed : null;
  const budget = missBudget(uptime.window, uptime.minSigned, uptime.missed);
  const streak = uptime.bars.length > 0 ? longestMissStreak(uptime.bars) : null;
  const website = validator.website.replace(/^https?:\/\//, "");
  const status = validator.jailed ? "Jailed" : statusLabel(validator.status);
  const expectedApr =
    apr?.stakingApr != null ? apr.stakingApr * (1 - validator.commissionRate) : null;

  const bricks: BrickSpec[] = [];

  bricks.push({
    key: "stake",
    label: "Bonded",
    value: formatToken(validator.tokens, chain.exponent),
    sub: validator.votingPower !== null ? `${pct(validator.votingPower)} of the set` : symbol,
    lead: true,
    rows: kept([
      {
        label: "Bonded",
        value: `${formatToken(validator.tokens, chain.exponent, 4)} ${symbol}`,
        mono: true,
      },
      { label: "Voting power", value: pct(validator.votingPower), mono: true },
      { label: "Rank", value: validator.rank ? `#${validator.rank}` : "—", mono: true },
      { label: "Status", value: status },
      {
        label: "Min self delegation",
        value: `${formatToken(validator.minSelfDelegation, chain.exponent, 6)} ${symbol}`,
        mono: true,
      },
      // Only while it is actually unbonding: the field keeps the height of the
      // last unbonding forever, and on a bonded validator it read as a status.
      ...(validator.status === "BOND_STATUS_UNBONDING" && validator.unbondingHeight
        ? [
            {
              label: "Unbonding since",
              value: `#${Number(validator.unbondingHeight).toLocaleString()}`,
              mono: true,
              href: `/${chainId}/blocks/${validator.unbondingHeight}`,
            },
          ]
        : []),
    ]),
  });

  bricks.push({
    key: "selfbond",
    label: "Self bond",
    value: selfBond ? formatToken(selfBond.amount, chain.exponent) : "N/A",
    sub: selfBond?.share != null ? `${pct(selfBond.share)} of its stake` : symbol,
  });

  if (uptime.window !== null || uptime.bars.length > 0) {
    bricks.push({
      key: "signing",
      label: "Signing",
      // Jailed, the window is reset and stops counting; its percentage would be
      // a clean record the validator did not earn.
      value: jailed ? "N/A" : pct(uptime.ratio),
      sub: jailed
        ? "jailed"
        : uptime.missed !== null && uptime.window !== null
          ? `${uptime.missed.toLocaleString()} missed of ${uptime.window.toLocaleString()}`
          : "slashing window",
      tone: jailed
        ? "bad"
        : uptime.ratio === null
          ? undefined
          : uptime.ratio >= 0.99
            ? "ok"
            : uptime.ratio < 0.95
              ? "bad"
              : undefined,
      rows: kept([
        {
          label: "Signed",
          value: !jailed && signed !== null ? signed.toLocaleString() : "—",
          mono: true,
        },
        {
          label: "Missed",
          value: !jailed && uptime.missed !== null ? uptime.missed.toLocaleString() : "—",
          mono: true,
        },
        {
          label: "Window",
          value: uptime.window !== null ? `${uptime.window.toLocaleString()} blocks` : "—",
          mono: true,
        },
        {
          label: "Miss budget",
          value: !jailed && budget !== null ? `${budget.toLocaleString()} blocks` : "—",
          mono: true,
        },
        {
          label: `Longest miss streak · last ${uptime.bars.length}`,
          value: streak !== null ? String(streak) : "—",
          mono: true,
        },
        {
          label: "Jailed until",
          value: uptime.jailedUntil ? new Date(uptime.jailedUntil).toLocaleString() : "Never",
        },
        { label: "Tombstoned", value: uptime.tombstoned ? "Yes" : "No" },
      ]),
    });
  }

  bricks.push({
    key: "commission",
    label: "Commission",
    value: pct(validator.commissionRate),
    sub: `max ${pct(validator.maxRate, 0)}`,
    rows: kept([
      { label: "Current rate", value: pct(validator.commissionRate), mono: true },
      { label: "Max rate", value: pct(validator.maxRate, 0), mono: true },
      { label: "Max change", value: `${pct(validator.maxChangeRate)}/day`, mono: true },
      {
        label: "Updated",
        value: validator.commissionUpdatedAt
          ? new Date(validator.commissionUpdatedAt).toLocaleString()
          : "—",
      },
      {
        label: "Outstanding",
        value:
          validator.outstandingCommission.length > 0
            ? validator.outstandingCommission.map((c) => coin(c, 4)).join(", ")
            : "—",
        mono: true,
      },
    ]),
  });

  bricks.push({
    key: "apr",
    label: "Expected APR",
    value: expectedApr !== null ? pct(expectedApr) : "N/A",
    sub: "after commission",
    rows: kept([
      { label: "Chain APR", value: pct(apr?.stakingApr ?? null), mono: true },
      { label: "Commission", value: pct(validator.commissionRate), mono: true },
      { label: "Expected APR", value: pct(expectedApr), mono: true },
    ]),
  });

  if (earned) {
    bricks.push({
      key: "earned",
      label: "Commission taken",
      value: coin(earned.byDenom[0]),
      sub: `${earned.withdrawals.toLocaleString()} withdrawals`,
      rows: kept([
        ...earned.byDenom.map((d) => ({
          label: known.get(d.denom)?.symbol ?? shortDenom(d.denom),
          value: coin(d, 4),
          mono: true,
        })),
        { label: "Withdrawals", value: earned.withdrawals.toLocaleString(), mono: true },
        { label: "First", value: earned.first ? day(earned.first) : "—" },
        { label: "Last", value: earned.last ? timeAgo(earned.last) : "—" },
      ]),
    });
  }

  if (proposer && proposer.totalBlocks > 0) {
    const share = proposer.proposed / proposer.totalBlocks;
    bricks.push({
      key: "proposed",
      label: "Blocks proposed",
      value: proposer.proposed.toLocaleString(),
      sub: fairness
        ? `${fairness.ratio.toFixed(2)}× expected · ${verdict(fairness.ratio)}`
        : `${pct(share)} of the chain's`,
      tone: fairness ? (fairness.ratio >= 0.95 ? "ok" : fairness.ratio < 0.85 ? "bad" : undefined) : undefined,
      rows: kept([
        { label: "Proposed", value: proposer.proposed.toLocaleString(), mono: true },
        { label: "Share of blocks", value: pct(share), mono: true },
        ...(fairness
          ? [
              {
                label: "Expected from stake",
                value: Math.round(fairness.expected).toLocaleString(),
                mono: true,
              },
              {
                label: "Proposed in that window",
                value: fairness.proposed.toLocaleString(),
                mono: true,
              },
              {
                label: "Versus stake",
                value: `${fairness.ratio.toFixed(2)}× · ${verdict(fairness.ratio)}`,
              },
              {
                label: "Window",
                value: `#${fairness.fromHeight.toLocaleString()} – #${fairness.toHeight.toLocaleString()}`,
                mono: true,
              },
            ]
          : []),
        {
          label: "Last proposed",
          value: proposer.lastHeight
            ? `#${proposer.lastHeight.toLocaleString()}${proposer.lastTime ? ` · ${timeAgo(proposer.lastTime)}` : ""}`
            : "Never",
          mono: true,
          ...(proposer.lastHeight ? { href: `/${chainId}/blocks/${proposer.lastHeight}` } : {}),
        },
        {
          label: "Measured over",
          value: proposer.fromGenesis
            ? `${proposer.totalBlocks.toLocaleString()} blocks`
            : `${proposer.totalBlocks.toLocaleString()} blocks since ${day(proposer.since)}`,
        },
      ]),
    });
  }

  if (votes && votes.total > 0) {
    const byOption = new Map<string, number>();
    for (const v of votes.votes) byOption.set(v.option, (byOption.get(v.option) ?? 0) + 1);
    bricks.push({
      key: "governance",
      label: "Governance",
      value: pct(votes.voted / votes.total, 0),
      sub: `voted on ${votes.voted} of ${votes.total}`,
      rows: kept([
        { label: "Participation", value: `${votes.voted} of ${votes.total} proposals`, mono: true },
        { label: "Skipped", value: String(votes.skipped.length), mono: true },
        ...[...byOption.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([option, n]) => ({ label: voteOptionLabel(option), value: String(n), mono: true })),
        { label: "Counted since", value: day(votes.since) },
        {
          label: "Last voted",
          value: votes.votes[0] ? timeAgo(votes.votes.reduce((m, v) => (v.time > m ? v.time : m), votes.votes[0].time)) : "—",
        },
      ]),
    });
  }

  if (validator.details) {
    bricks.push({
      key: "identity",
      label: "About",
      value: validator.details,
      text: true,
      sub: website || validator.moniker,
      body: validator.details,
      rows: kept([
        ...(validator.website ? [{ label: "Website", value: website, href: validator.website }] : []),
        { label: "Security contact", value: validator.securityContact },
      ]),
    });
  }

  // ── Lists ────────────────────────────────────────────────────────────────

  const unjails = (events ?? []).filter((e) => e.kind === "unjail");
  type JailRow = { height: number; time: string; label: string; reason: string; burned: string | null; tx: string | null; bad: boolean };
  const jailRows: JailRow[] = [
    ...(slashes?.events ?? []).map((e) => ({
      height: e.height,
      time: e.time,
      label: SLASH_LABEL[e.kind],
      reason: reasonLabel(e.reason),
      burned: e.burned,
      tx: null,
      bad: e.kind !== "unjailed",
    })),
    // Before extract version 4 the index kept no unjail; the MsgUnjail
    // transaction stands in, unless the index already has that unjail.
    ...unjails
      .filter(
        (u) =>
          !(slashes?.events ?? []).some((e) => e.kind === "unjailed" && e.height === u.height)
      )
      .map((e) => ({
      height: e.height,
      time: e.time,
      label: "Unjailed",
      reason: "—",
      burned: null,
      tx: e.txHash,
      bad: false,
    })),
  ].sort((a, b) => b.height - a.height);

  // Each jailing paired with the unjail that ended it: how long it was down.
  const downtimeAt = new Map(
    jailSpells(
      jailRows
        .filter((r) => r.label === "Jailed" || r.label === "Unjailed")
        .map((r) => ({ kind: r.label === "Jailed" ? "jailed" : "unjailed", height: r.height, time: r.time }))
    ).map((spell) => [spell.jailedAt.height, spell])
  );

  const jailDeck: DeckRow[] = jailRows.map((e) => ({
    key: `${e.height}-${e.label}`,
    cells: [
      { v: e.label, tone: e.bad ? "bad" : "ok" },
      { v: e.reason, dim: true },
      (() => {
        const spell = e.label === "Jailed" ? downtimeAt.get(e.height) : undefined;
        if (!spell) return { v: "—", dim: true, align: "right" as const };
        return spell.unjailedAt
          ? { v: formatDuration(spell.downtimeMs), mono: true, align: "right" as const }
          : // Open only while the chain still says jailed; otherwise the unjail
            // predates what the index holds.
            validator.jailed
            ? { v: "ongoing", tone: "bad" as const, align: "right" as const }
            : { v: "—", dim: true, align: "right" as const };
      })(),
      {
        v: e.burned ? coin({ denom: chain.denom, amount: e.burned }) : "—",
        mono: true,
        align: "right",
        dim: !e.burned,
      },
      {
        v: `#${e.height.toLocaleString()}`,
        mono: true,
        align: "right",
        href: `/${chainId}/blocks/${e.height}`,
      },
      { v: day(e.time), dim: true, align: "right" },
    ],
    detail: {
      title: e.label,
      sub: day(e.time),
      rows: [],
      action: e.tx
        ? { label: "Transaction", href: `/${chainId}/txs/${e.tx}` }
        : { label: "Block", href: `/${chainId}/blocks/${e.height}` },
    },
  }));

  const jailings = slashes?.events.filter((e) => e.kind === "jailed").length ?? 0;

  const proposedDeck: DeckRow[] = (proposedList?.blocks ?? []).map((b) => ({
    key: String(b.height),
    cells: [
      { v: `#${b.height.toLocaleString()}`, mono: true, tone: "accent" },
      { v: timeAgo(b.time), dim: true, align: "right" },
      { v: String(b.txCount), mono: true, align: "right" },
    ],
    detail: { title: `Block ${b.height}`, rows: [], action: { label: "Block", href: `/${chainId}/blocks/${b.height}` } },
  }));

  const skipped = new Set(votes?.skipped ?? []);
  const voteDeck: DeckRow[] = votes
    ? [
        ...votes.votes.map((v) => ({
          id: v.proposalId,
          row: {
            key: `v-${v.proposalId}`,
            cells: [
              { v: `#${v.proposalId}`, mono: true, tone: "accent" as const },
              {
                v: `${voteOptionLabel(v.option)}${v.weighted ? " · split" : ""}${
                  recasts?.get(v.proposalId)
                    ? ` · was ${recasts.get(v.proposalId)!.map(voteOptionLabel).join(", ")}`
                    : ""
                }`,
              },
              {
                v: truncateMiddle(v.txHash, 6, 4),
                mono: true,
                dim: true,
                href: `/${chainId}/txs/${v.txHash}`,
              },
              { v: day(v.time), dim: true, align: "right" as const },
            ],
            detail: {
              title: `Proposal #${v.proposalId}`,
              rows: [],
              action: { label: "Proposal", href: `/${chainId}/proposals/${v.proposalId}` },
            },
          } satisfies DeckRow,
        })),
        ...[...skipped].map((id) => ({
          id,
          row: {
            key: `s-${id}`,
            cells: [
              { v: `#${id}`, mono: true, tone: "accent" as const },
              { v: "Did not vote", tone: "bad" as const },
              { v: "—", dim: true },
              { v: "—", dim: true, align: "right" as const },
            ],
            detail: {
              title: `Proposal #${id}`,
              rows: [],
              action: { label: "Proposal", href: `/${chainId}/proposals/${id}` },
            },
          } satisfies DeckRow,
        })),
      ]
        .sort((a, b) => b.id - a.id)
        .map((x) => x.row)
    : [];

  const eventDeck: DeckRow[] = (events ?? []).map((e) => ({
    key: e.txHash,
    cells: [
      { v: EVENT_LABEL[e.kind], tone: e.ok ? undefined : "bad" },
      {
        v: e.amounts.length > 0 ? e.amounts.map((a) => coin(a)).join(", ") : "—",
        mono: true,
        align: "right",
        dim: e.amounts.length === 0,
      },
      {
        v: `#${e.height.toLocaleString()}`,
        mono: true,
        align: "right",
        href: `/${chainId}/blocks/${e.height}`,
      },
      { v: day(e.time), dim: true, align: "right" },
    ],
    detail: {
      title: EVENT_LABEL[e.kind],
      rows: [],
      action: { label: "Transaction", href: `/${chainId}/txs/${e.txHash}` },
    },
  }));

  // Power events: stake moving in and out, signed from this validator's side.
  const powerKind = (e: { kind: string; validator: string | null; validatorDst: string | null }) => {
    switch (e.kind) {
      case "delegate":
        return { label: "Delegate", sign: 1 };
      case "undelegate":
        return { label: "Undelegate", sign: -1 };
      case "redelegate":
        return e.validatorDst === addr
          ? { label: "Redelegate in", sign: 1 }
          : { label: "Redelegate out", sign: -1 };
      case "cancel_unbonding":
        return { label: "Cancel unbonding", sign: 1 };
      case "create_validator":
        return { label: "Create", sign: 1 };
      case "edit_validator":
        return { label: "Edit", sign: 0 };
      default:
        return { label: e.kind, sign: 0 };
    }
  };
  const signedAmount = (amount: string | null, sign: number) => {
    if (!amount || sign === 0) return "—";
    return `${sign > 0 ? "+" : "−"}${coin({ denom: chain.denom, amount })}`;
  };
  const flow = (net: string | null) => {
    if (net === null) return null;
    const neg = net.startsWith("-");
    const abs = neg ? net.slice(1) : net;
    return `${neg ? "−" : abs === "0" ? "" : "+"}${coin({ denom: chain.denom, amount: abs })}`;
  };
  const powerDeck: DeckRow[] = (powerEv?.events ?? []).map((e) => {
    const k = powerKind(e);
    return {
      key: `${e.txHash}-${e.height}-${e.kind}-${e.delegator ?? ""}`,
      cells: [
        { v: k.label, tone: k.sign > 0 ? "ok" : k.sign < 0 ? "bad" : undefined },
        e.delegator
          ? { v: truncateMiddle(e.delegator, 10, 6), address: e.delegator, mono: true }
          : { v: "—", dim: true },
        { v: signedAmount(e.amount, k.sign), mono: true, align: "right", dim: k.sign === 0 },
        {
          v: `#${e.height.toLocaleString()}`,
          mono: true,
          align: "right",
          href: `/${chainId}/blocks/${e.height}`,
        },
        { v: day(e.time), dim: true, align: "right" },
      ],
      detail: {
        title: k.label,
        rows: [],
        action: e.txHash
          ? { label: "Transaction", href: `/${chainId}/txs/${e.txHash}` }
          : { label: "Block", href: `/${chainId}/blocks/${e.height}` },
      },
    };
  });
  const flow7 = flow(powerEv?.flow7 ?? null);
  const flow30 = flow(powerEv?.flow30 ?? null);

  const sections = [
    {
      key: "delegators",
      label: "Delegators",
      content: (
        <Suspense fallback={<LoadingPanel label="Loading delegators…" rows={5} />}>
          <ValidatorDelegators
            chain={chain}
            operatorAddress={addr}
            page={Math.max(0, (Number(dp) || 1) - 1)}
          />
        </Suspense>
      ),
    },
    ...(uptime.bars.length > 0 || signingHist
      ? [
          {
            key: "signing",
            label: "Signing",
            content: (
              <div className="gata-surface flex h-full flex-col gap-2 overflow-y-auto px-4 py-3">
                {uptime.bars.length > 0 ? (
                <>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11.5px]">
                  <Fact label={`last ${uptime.bars.length} blocks`} />
                  <Fact
                    value={String(uptime.bars.filter((b) => !b).length)}
                    label="missed"
                  />
                  {streak !== null ? <Fact label="longest streak" value={String(streak)} /> : null}
                  {!jailed && budget !== null ? (
                    <Fact label="miss budget" value={budget.toLocaleString()} />
                  ) : null}
                  {jailed ? <Fact label="jailed" /> : null}
                </div>
                <UptimeBars
                  // Jailed, the window is reset: show the strip, not its percentage.
                  uptime={jailed ? { ...uptime, ratio: null, missed: null } : uptime}
                  slashingWindow
                  expand
                  chainId={chainId}
                />
                </>
                ) : null}
                {signingHist ? (
                  <div className={uptime.bars.length > 0 ? "mt-2 border-t border-border/60 pt-3" : undefined}>
                    <ValidatorSigningHistory history={signingHist} chainId={chainId} />
                  </div>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
    ...(proposedList
      ? [
          {
            key: "proposed",
            label: "Proposed",
            content: (
              <RowDeck
                accent={accent}
                columns={[
                  { label: "Block" },
                  { label: "Age", align: "right", width: "30%" },
                  { label: "Txs", align: "right", width: "18%" },
                ]}
                rows={proposedDeck}
                empty="None"
              />
            ),
          },
        ]
      : []),
    ...(votes
      ? [
          {
            key: "votes",
            label: skipped.size > 0 ? `Votes · ${skipped.size} skipped` : "Votes",
            content: (
              <RowDeck
                accent={accent}
                columns={[
                  { label: "Proposal", width: "16%" },
                  { label: "Vote" },
                  { label: "Tx", width: "22%", phoneHide: true },
                  { label: "Date", align: "right", width: "22%" },
                ]}
                rows={voteDeck}
                empty="None"
              />
            ),
          },
        ]
      : []),
    ...(events
      ? [
          {
            key: "events",
            label: "Events",
            content: (
              <RowDeck
                accent={accent}
                columns={[
                  { label: "Event" },
                  { label: "Amount", align: "right", width: "26%", phoneHide: true },
                  { label: "Block", align: "right", width: "20%" },
                  { label: "Date", align: "right", width: "20%" },
                ]}
                rows={eventDeck}
                empty="None"
              />
            ),
          },
        ]
      : []),
    ...(powerEv
      ? [
          {
            key: "power",
            label: "Power events",
            content: (
              <RowDeck
                accent={accent}
                columns={[
                  { label: "Event", width: "18%" },
                  { label: "Delegator", phoneHide: true },
                  { label: "Amount", align: "right", width: "22%" },
                  { label: "Block", align: "right", width: "15%", optional: true },
                  { label: "Date", align: "right", width: "16%" },
                ]}
                rows={powerDeck}
                toolbar={
                  flow7 || flow30 ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                      {flow7 ? <Fact label="net 7d" value={flow7} /> : null}
                      {flow30 ? <Fact label="net 30d" value={flow30} /> : null}
                    </div>
                  ) : undefined
                }
                empty="None"
              />
            ),
          },
        ]
      : []),
    ...(powerHist && powerHist.length >= 1
      ? [
          {
            key: "stake",
            label: "Power",
            content: <ValidatorPowerHistory points={powerHist} accent={accent} />,
          },
        ]
      : stake && stake.length >= 2
      ? [
          {
            key: "stake",
            label: "Stake",
            content: (
              <ValidatorStakeChart
                points={stake}
                exponent={chain.exponent}
                symbol={symbol}
                accent={accent}
              />
            ),
          },
        ]
      : []),
    ...(slashes
      ? [
          {
            key: "jailings",
            label: jailings > 0 ? `Jailings · ${jailings}` : "Jailings",
            content: (
              <RowDeck
                accent={accent}
                columns={[
                  { label: "Event", width: "16%" },
                  { label: "Reason" },
                  { label: "Down", align: "right", width: "13%" },
                  { label: "Burned", align: "right", width: "17%", phoneHide: true },
                  { label: "Block", align: "right", width: "18%", optional: true },
                  { label: "Date", align: "right", width: "22%" },
                ]}
                rows={jailDeck}
                empty="Never"
              />
            ),
          },
        ]
      : []),
  ];

  const initialTab = tab && TABS.includes(tab) ? tab : undefined;

  return (
    <PageFrame
      title={validator.moniker}
      sub={`${validator.rank ? `Rank #${validator.rank}` : "Unranked"} · ${chain.prettyName}`}
      accent={accent}
      actions={
        <>
          {behind ? (
            <span className="rounded-full bg-[var(--gata-amber)]/12 px-2 py-0.5 text-[11px] font-medium text-[var(--gata-amber)]">
              Index behind
            </span>
          ) : null}
          {links.length > 0 ? <LinkedAddresses links={links} currentChainId={chainId} /> : null}
          <ValidatorStatus
            jailed={validator.jailed}
            status={validator.status}
            tombstoned={uptime.tombstoned}
          />
        </>
      }
    >
      <div className="flex h-full flex-col gap-3">
        {/* Identity: every address this validator goes by, each linked or copyable. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
          <IdentityItem label="Operator" copy={validator.operatorAddress}>
            <span className="font-mono">{truncateMiddle(validator.operatorAddress, 14, 6)}</span>
          </IdentityItem>
          {selfDelegation ? (
            <IdentityItem label="Account" copy={selfDelegation}>
              <AddressLink address={selfDelegation} head={10} tail={6} />
            </IdentityItem>
          ) : null}
          {ids ? (
            <>
              <IdentityItem label="Consensus" copy={ids.valcons}>
                <span className="font-mono">{truncateMiddle(ids.valcons, 14, 6)}</span>
              </IdentityItem>
              <IdentityItem label="Hex" copy={ids.hex}>
                <span className="font-mono">{truncateMiddle(ids.hex, 8, 6)}</span>
              </IdentityItem>
            </>
          ) : null}
          {validator.identity ? (
            <IdentityItem label="Keybase">
              {keybase ? (
                <a
                  href={`https://keybase.io/${keybase}`}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-primary hover:underline"
                >
                  {keybase}
                </a>
              ) : (
                <span className="font-mono">{validator.identity}</span>
              )}
            </IdentityItem>
          ) : null}
          {validator.website ? (
            <IdentityItem label="Website">
              <a
                href={validator.website}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary hover:underline"
              >
                {website}
              </a>
            </IdentityItem>
          ) : null}
          <Suspense fallback={null}>
            <ValidatorElsewhere
              chain={chain}
              account={selfDelegation}
              identity={validator.identity}
            />
          </Suspense>
        </div>
        <div className="shrink-0">
          <BrickBoard chainId={chainId} accent={accent} bricks={bricks} />
        </div>
        <div className="min-h-0 flex-1">
          <SectionTabs sections={sections} initial={initialTab} param="tab" />
        </div>
      </div>
    </PageFrame>
  );
}

function IdentityItem({
  label,
  copy,
  children,
}: {
  label: string;
  copy?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      {children}
      {copy ? <CopyButton value={copy} label={label.toLowerCase()} /> : null}
    </span>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5">
      {value !== undefined ? (
        <span className="font-mono font-semibold text-foreground">{value}</span>
      ) : null}
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
