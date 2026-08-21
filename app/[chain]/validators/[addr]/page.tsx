import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getChain, symbolFor, accentFor, chainDenoms } from "@/lib/chains";
import { getValidator } from "@/lib/validators";
import { formatToken } from "@/lib/overview";
import { shortDenom } from "@/lib/coin";
import { decodeParam, timeAgo, truncateMiddle } from "@/lib/format";
import { accountFromOperator, linkedAddresses } from "@/lib/bech32";
import { getAdapter } from "@/lib/adapter";
import { emptyUptime, consensusIdsFromPubkey, DETAIL_BAR_COUNT } from "@/lib/uptime";
import {
  commissionEarned,
  governanceParticipation,
  proposerStats,
  slashHistory,
  stakeHistory,
  type SlashKind,
} from "@/lib/indexer-db";
import { voteOptionLabel } from "@/lib/proposals";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec, type DetailRow } from "@/components/brick-board";
import { RowDeck, type DeckRow } from "@/components/row-deck";
import { SectionTabs } from "@/components/section-tabs";
import { CopyButton } from "@/components/copy-button";
import { GnoValidatorDetail } from "@/components/gno-validator-detail";
import { LinkedAddresses } from "@/components/linked-addresses";
import { LoadingPanel } from "@/components/loading-panel";
import { UptimeBars } from "@/components/uptime-bars";
import { ValidatorDelegators } from "@/components/validator-delegators";
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

/** How a proposed-blocks share compares to the share of stake it was owed. */
function verdict(ratio: number): string {
  if (ratio >= 0.95) return "in line with stake";
  if (ratio >= 0.85) return "slightly under";
  return "well under — missing turns";
}

const SLASH_LABEL: Record<SlashKind, string> = {
  jailed: "Jailed",
  unjailed: "Unjailed",
  slashed: "Slashed",
  tombstoned: "Tombstoned",
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

/**
 * One validator: what it is worth, how it behaves, and who backs it.
 *
 * This page used to be nine stacked sections — a profile table, four stat rails
 * and three tables — and everything below the second of them was off the screen
 * on any laptop. The sections are all still here. Each of the rails is now the
 * single brick it was always summarising, with the rest of its figures a click
 * away, and the three lists take turns in one full-height deck instead of
 * queueing up.
 *
 * The indexer-backed bricks stay absent rather than zero when the index cannot
 * answer. That distinction is the point of them: nobody can tell "this
 * validator has never been jailed" from "we have no jailing data" once a zero
 * has been printed, and only one of those is a fact about the validator.
 *
 * Everything except the delegator list is awaited together up front. Bricks
 * have to be laid out at once, so a section arriving late cannot slot into the
 * board — and each of these reads is a bounded, indexed query. Delegators is
 * the exception in both respects: it pages every delegation off the LCD, takes
 * seconds on a large validator, and owns a whole tab that can carry a spinner.
 */
export default async function ValidatorDetailPage({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}) {
  const { chain: chainId, addr: rawAddr } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const addr = decodeParam(rawAddr);

  // gno.land has no staking module — identity comes from the valopers realm
  // instead, so it gets an entirely different detail view.
  if (chain.kind === "gno") {
    return <GnoValidatorDetail chain={chain} address={addr} />;
  }

  const validator = await getValidator(chain, addr);
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);

  if (!validator) {
    return (
      <PageFrame title="Validator not found" sub={chain.prettyName} accent={accent}>
        <p className="text-sm text-muted-foreground">
          No validator with operator address{" "}
          <span className="font-mono">{truncateMiddle(addr, 12, 8)}</span> on{" "}
          {chain.prettyName}.{" "}
          <Link href={`/${chainId}/validators`} className="text-primary hover:underline">
            Back to validators
          </Link>
          .
        </p>
      </PageFrame>
    );
  }

  const selfDelegation = accountFromOperator(addr, chain.bech32Prefix);
  // Derived from the self-delegation account, never from the operator address:
  // re-encoding a …valoper1… under another chain's prefix yields a valid-looking
  // address that is a different entity. linkedAddresses refuses one anyway, so
  // passing the operator here would silently render nothing.
  const links = selfDelegation ? linkedAddresses(selfDelegation) : [];
  // Slashing and block production are recorded against the consensus address —
  // neither ever mentions the operator — so both reads are keyed on it.
  const ids = validator.consensusPubkey
    ? consensusIdsFromPubkey(validator.consensusPubkey, chain.bech32Prefix)
    : null;
  const adapter = getAdapter(chain);

  const [uptime, earned, governance, proposer, slashes, stake] = await Promise.all([
    // Shares the validators-page cache key, so opening a validator right after
    // the list costs nothing extra. A longer strip than the list shows: the
    // block reads are per chain, not per validator, so one page can afford more
    // history than 100 rows can.
    adapter
      .getUptime([validator], DETAIL_BAR_COUNT)
      .then((m) => m.get(addr) ?? emptyUptime())
      .catch(() => emptyUptime()),
    // Keyed on the account, not the operator: commission is attributed through
    // the signer of the withdrawal — see commissionEarned.
    selfDelegation ? commissionEarned(chain.chainId, selfDelegation).catch(() => null) : null,
    selfDelegation
      ? governanceParticipation(chain.chainId, selfDelegation).catch(() => null)
      : null,
    ids ? proposerStats(chain.chainId, ids.hex).catch(() => null) : null,
    ids ? slashHistory(chain.chainId, ids.valcons).catch(() => null) : null,
    // Logged rather than swallowed. A failing query and a validator with no
    // snapshots both render nothing, and the last feature that hid a SQL error
    // this way shipped broken — the log is the only thing that tells them apart.
    stakeHistory(chain.chainId, addr).catch((err) => {
      console.error(`stakeHistory failed for ${addr}:`, err);
      return null;
    }),
  ]);

  // The chain's own denoms carry a symbol and an exponent; anything else (an
  // IBC hash) is shown as-is rather than scaled by a guess.
  const known = new Map(chainDenoms(chain).map((d) => [d.denom, d]));
  const coin = (c: { denom: string; amount: string }, frac = 2) => {
    const info = known.get(c.denom);
    return info
      ? `${formatToken(c.amount, info.exponent, frac)} ${info.symbol}`
      : `${c.amount} ${shortDenom(c.denom)}`;
  };

  const signed =
    uptime.window !== null && uptime.missed !== null ? uptime.window - uptime.missed : null;
  const website = validator.website.replace(/^https?:\/\//, "");

  const bricks: BrickSpec[] = [];

  // Stake and voting power were kept off this page while it scrolled, because
  // they are columns on the list you arrived from and repeating them pushed
  // everything that is *only* here below the fold. A brick costs no such thing,
  // and the size of a validator is the first thing its page should say.
  bricks.push({
    key: "stake",
    label: "Bonded",
    value: formatToken(validator.tokens, chain.exponent),
    sub:
      validator.votingPower !== null
        ? `${pct(validator.votingPower)} of the set`
        : symbol,
    lead: true,
    rows: kept([
      {
        label: "Bonded",
        value: `${formatToken(validator.tokens, chain.exponent, 4)} ${symbol}`,
        mono: true,
      },
      { label: "Voting power", value: pct(validator.votingPower), mono: true },
      { label: "Rank", value: validator.rank ? `#${validator.rank}` : "—", mono: true },
      { label: "Status", value: validator.jailed ? "Jailed" : validator.status },
      {
        label: "Min self delegation",
        value: `${formatToken(validator.minSelfDelegation, chain.exponent, 6)} ${symbol}`,
        mono: true,
      },
      {
        label: "Unbonding since",
        value: validator.unbondingHeight
          ? `height ${Number(validator.unbondingHeight).toLocaleString()}`
          : "—",
        mono: true,
      },
    ]),
  });

  if (uptime.window !== null || uptime.bars.length > 0) {
    bricks.push({
      key: "signing",
      label: "Signing",
      value: pct(uptime.ratio),
      sub:
        uptime.missed !== null && uptime.window !== null
          ? `${uptime.missed.toLocaleString()} missed of ${uptime.window.toLocaleString()}`
          : "slashing window",
      // Same thresholds the bar strip uses: 99% is healthy, under 95% is the
      // neighbourhood of the slashing floor on most chains.
      tone:
        uptime.ratio === null
          ? undefined
          : uptime.ratio >= 0.99
            ? "ok"
            : uptime.ratio < 0.95
              ? "bad"
              : undefined,
      rows: kept([
        { label: "Signed", value: signed !== null ? signed.toLocaleString() : "—", mono: true },
        {
          label: "Missed",
          value: uptime.missed !== null ? uptime.missed.toLocaleString() : "—",
          mono: true,
        },
        {
          label: "Window",
          value: uptime.window !== null ? `${uptime.window.toLocaleString()} blocks` : "—",
          mono: true,
        },
        { label: "Uptime", value: pct(uptime.ratio), mono: true },
        // A date in the past means jailed and since released; a future one
        // means jailed right now. The slashing module keeps no count, only this.
        {
          label: "Jailed until",
          value: uptime.jailedUntil ? new Date(uptime.jailedUntil).toLocaleString() : "—",
        },
        {
          label: "Tombstoned",
          value: uptime.tombstoned ? "Yes — permanently removed" : "—",
        },
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

  /**
   * What the commission rate actually produced. Every explorer shows the rate;
   * none show the outcome, because the chain does not keep it — once commission
   * is withdrawn the amount survives nowhere but in the block events. Read
   * beside self bond it says something a rate cannot.
   */
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
        { label: "Last", value: earned.last ? timeAgo(earned.last) : "—" },
      ]),
    });
  }

  /**
   * How much of the chain's block production this validator actually did —
   * distinct from the signing percentage, which measures whether it signed
   * *other* proposers' blocks. A validator can sign reliably and still fail to
   * produce its own when its turn comes, and only the proposed share shows it.
   * Selection is weighted by voting power, so the gap between the two shares is
   * the interesting number.
   */
  if (proposer && proposer.totalBlocks > 0) {
    const share = proposer.proposed / proposer.totalBlocks;
    // Expected turns, from voting power. Null when we cannot say, rather than
    // assuming the current power held across the whole window — it did not.
    const expected = validator.votingPower;
    const ratio = expected && expected > 0 ? share / expected : null;
    bricks.push({
      key: "proposed",
      label: "Blocks proposed",
      value: proposer.proposed.toLocaleString(),
      sub: `${pct(share)} of the chain's`,
      rows: kept([
        { label: "Proposed", value: proposer.proposed.toLocaleString(), mono: true },
        { label: "Share of blocks", value: pct(share), mono: true },
        { label: "Share of stake", value: pct(expected), mono: true },
        {
          label: "Versus stake",
          value: ratio !== null ? `${ratio.toFixed(2)}x — ${verdict(ratio)}` : "—",
        },
        {
          label: "Last proposed",
          value: proposer.lastTime
            ? `${timeAgo(proposer.lastTime)}${
                proposer.lastHeight ? ` at ${proposer.lastHeight.toLocaleString()}` : ""
              }`
            : "Never",
        },
        // Stated only when the index does not reach the first block. Once the
        // backfill lands on genesis, "since <genesis date>" is the chain's own
        // age dressed as a caveat.
        {
          label: "Measured over",
          value: proposer.fromGenesis
            ? `${proposer.totalBlocks.toLocaleString()} blocks, all of them`
            : `${proposer.totalBlocks.toLocaleString()} blocks since ${day(proposer.since)}`,
        },
      ]),
    });
  }

  /**
   * Whether the operator turns up. A validator carries its delegators' voting
   * power by default, so one that never votes is deciding by absence. The gov
   * module deletes votes once a proposal tallies, so for anything decided this
   * index is the only lasting record — hence absent, not empty, where we do not
   * index the chain.
   */
  if (governance && governance.total > 0) {
    bricks.push({
      key: "governance",
      label: "Governance",
      value: pct(governance.voted / governance.total, 0),
      sub: `voted on ${governance.voted} of ${governance.total}`,
      rows: kept([
        {
          label: "Participation",
          value: `${governance.voted} of ${governance.total} proposals`,
          mono: true,
        },
        ...governance.byOption.map((o) => ({
          label: voteOptionLabel(o.option),
          value: String(o.count),
          mono: true,
        })),
        { label: "Last voted", value: governance.lastVote ? timeAgo(governance.lastVote) : "—" },
      ]),
    });
  }

  const identityRows = kept([
    { label: "Operator", value: validator.operatorAddress, mono: true },
    ...(selfDelegation
      ? [
          {
            label: "Account",
            value: selfDelegation,
            mono: true,
            // Same key as the operator address, under the account prefix. Links
            // onward to its balances, history and the address switcher.
            href: `/${chainId}/accounts/${selfDelegation}`,
          },
        ]
      : []),
    ...(validator.website ? [{ label: "Website", value: website, href: validator.website }] : []),
    { label: "Security contact", value: validator.securityContact },
    { label: "Identity", value: validator.identity, mono: true },
    { label: "Details", value: validator.details },
  ]);
  bricks.push({
    key: "identity",
    label: "Identity",
    // Prose rather than a figure: what a validator says about itself is a
    // sentence, and there is no number here that would be worth the tile.
    value: validator.details || website || validator.moniker,
    text: true,
    sub: validator.details && website ? website : "operator & account",
    count: identityRows.length,
    rows: identityRows,
  });

  const jailings = slashes?.events.filter((e) => e.kind === "jailed").length ?? 0;
  const tombstoned = slashes?.events.some((e) => e.kind === "tombstoned") ?? false;
  // "since <genesis>" is not a qualification, it is the chain's whole life — so
  // once the index reaches the first block the sentence drops the clause.
  const over = slashes && !slashes.fromGenesis ? ` since ${day(slashes.since)}` : "";

  const slashRows: DeckRow[] = (slashes?.events ?? []).map((e) => ({
    key: `${e.height}-${e.kind}`,
    cells: [
      { v: SLASH_LABEL[e.kind], tone: e.kind === "unjailed" ? "ok" : "bad" },
      { v: reasonLabel(e.reason), dim: true },
      {
        v: e.burned ? coin({ denom: chain.denom, amount: e.burned }) : "—",
        mono: true,
        align: "right",
        dim: !e.burned,
      },
      { v: e.height.toLocaleString(), mono: true, align: "right", dim: true },
      { v: day(e.time), dim: true, align: "right" },
    ],
    detail: {
      title: SLASH_LABEL[e.kind],
      sub: day(e.time),
      rows: [
        { label: "Event", value: SLASH_LABEL[e.kind] },
        { label: "Reason", value: reasonLabel(e.reason) },
        {
          label: "Burned",
          value: e.burned ? coin({ denom: chain.denom, amount: e.burned }, 6) : "—",
          mono: true,
        },
        { label: "Height", value: e.height.toLocaleString(), mono: true },
        { label: "Time", value: new Date(e.time).toLocaleString() },
      ],
      action: { label: "Block", href: `/${chainId}/blocks/${e.height}` },
    },
  }));

  const sections = [
    {
      key: "delegators",
      label: "Delegators",
      content: (
        <Suspense
          fallback={
            <LoadingPanel
              label="Loading delegators…"
              hint="Reading every delegation so the largest are ranked correctly."
              rows={5}
            />
          }
        >
          <ValidatorDelegators chain={chain} operatorAddress={addr} />
        </Suspense>
      ),
    },
    ...(uptime.bars.length > 0
      ? [
          {
            key: "signing",
            label: "Signing",
            content: (
              <div className="flex h-full flex-col gap-2 border border-border bg-[var(--gata-card)] px-4 py-3">
                <p className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  Last {uptime.bars.length} blocks, newest right
                </p>
                <UptimeBars uptime={uptime} slashingWindow expand />
              </div>
            ),
          },
        ]
      : []),
    ...(stake && stake.length >= 2
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
    // Absent entirely without the indexer. No node can answer this: the staking
    // module keeps only the current jailed flag, so a validator jailed three
    // times and one jailed once are indistinguishable through the API.
    ...(slashes
      ? [
          {
            key: "jailings",
            label: jailings > 0 ? `Jailings · ${jailings}` : "Jailings",
            content: (
              <RowDeck
                accent={accent}
                columns={[
                  { label: "Event", width: "18%" },
                  { label: "Reason" },
                  { label: "Burned", align: "right", width: "20%", phoneHide: true },
                  { label: "Height", align: "right", width: "18%", optional: true },
                  { label: "Date", align: "right", width: "22%" },
                ]}
                rows={slashRows}
                toolbar={
                  slashRows.length > 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      {tombstoned ? (
                        <span className="text-[var(--gata-burn)]">
                          Tombstoned — permanently removed from the validator set.
                        </span>
                      ) : (
                        <>
                          Jailed {jailings === 1 ? "once" : `${jailings} times`}
                          {over || " in the chain's history"}.
                        </>
                      )}
                    </p>
                  ) : undefined
                }
                empty={`Never jailed or slashed${over}.`}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <PageFrame
      title={validator.moniker}
      sub={`${validator.rank ? `Rank #${validator.rank}` : "Unranked"} · ${chain.prettyName}`}
      accent={accent}
      actions={
        <>
          <CopyButton value={validator.operatorAddress} label="operator address" />
          {links.length > 0 ? (
            <LinkedAddresses links={links} currentChainId={chainId} />
          ) : null}
          <ValidatorStatus
            jailed={validator.jailed}
            status={validator.status}
            tombstoned={uptime.tombstoned}
          />
        </>
      }
    >
      <div className="flex h-full flex-col gap-3">
        <div className="shrink-0">
          <BrickBoard chainId={chainId} accent={accent} bricks={bricks} />
        </div>
        <div className="min-h-0 flex-1">
          <SectionTabs sections={sections} />
        </div>
      </div>
    </PageFrame>
  );
}
