import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getChain, symbolFor, accentFor, chainDenoms } from "@/lib/chains";
import { findValidator, getValidator, keybaseUsername, statusLabel } from "@/lib/validators";
import { formatToken } from "@/lib/overview";
import { shortDenom } from "@/lib/coin";
import { decodeParam, formatDate, truncateMiddle } from "@/lib/format";
import { accountFromOperator, convertAddress, decodePrefix, linkedAddresses } from "@/lib/bech32";
import { resolveGnoValidatorAddress } from "@/lib/gno";
import { emptyUptime, consensusIdsFromPubkey, jailedNow, longestMissStreak, missBudget } from "@/lib/uptime";
import { commissionHistory, indexBehind } from "@/lib/indexer-validator";
import { getSelfBond } from "@/lib/staking";
import { getChainAprCached } from "@/lib/params";
import { withinBudget } from "@/lib/cache";
import { validatorLogoMap } from "@/lib/validator-logos";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { SectionTabs } from "@/components/section-tabs";
import { CopyButton } from "@/components/copy-button";
import { AddressLink } from "@/components/address-link";
import { GnoValidatorDetail } from "@/components/gno-validator-detail";
import { LinkedAddresses } from "@/components/linked-addresses";
import { LoadingPanel } from "@/components/loading-panel";
import { ValidatorAvatar } from "@/components/validator-avatar";
import { ValidatorDelegators } from "@/components/validator-delegators";
import { ValidatorElsewhere } from "@/components/validator-elsewhere";
import { ValidatorStatus } from "@/components/validator-status";
import {
  BrickLoading,
  EventsTab,
  getAprModelCached,
  EarnedBrick,
  GovernanceBrick,
  ProposedBrick,
  JailingsTab,
  kept,
  loadUptime,
  pct,
  PowerEventsTab,
  PowerTab,
  ProposedTab,
  SigningTab,
  TabLoading,
  VotesTab,
  type ValidatorKeys,
} from "./sections";

export const dynamic = "force-dynamic";

/** How long the page waits on any one figure from the chain before drawing without it. */
const BUDGET = 1500;

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

const TABS = ["overview", "delegators", "signing", "proposed", "votes", "power", "stake", "events", "jailings"];

/**
 * One validator: who it is on the left, its figures and records on the right.
 *
 * Only the chain's own figures are awaited, each within a budget. Everything
 * read from the index streams in behind a placeholder of the same size (see
 * ./sections), so the page draws at once however slow the index is.
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

  // gno.land has no staking module - identity comes from the valopers realm
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

  if (!validator) notFound();

  const account = accountFromOperator(addr, chain.bech32Prefix);
  // Derived from the self-delegation account, never from the operator address:
  // re-encoding a …valoper1… under another prefix is a different entity.
  const links = account ? linkedAddresses(account) : [];
  // Slashing and block production are recorded against the consensus address.
  const ids = validator.consensusPubkey
    ? consensusIdsFromPubkey(validator.consensusPubkey, chain.bech32Prefix)
    : null;
  const keys: ValidatorKeys = { chain, accent, addr, account, ids };

  const [uptime, selfBond, chainApr, aprModel, keybase, logos, commissions] = await Promise.all([
    withinBudget(loadUptime(chainId, addr), BUDGET, emptyUptime()),
    withinBudget(getSelfBond(chain, addr, validator.tokens).catch(() => null), BUDGET, null),
    withinBudget(getChainAprCached(chain).catch(() => null), BUDGET, null),
    withinBudget(getAprModelCached(chain).catch(() => null), BUDGET, null),
    validator.identity
      ? withinBudget(keybaseUsername(validator.identity).catch(() => null), BUDGET, null)
      : null,
    withinBudget(validatorLogoMap(chain, [validator]), BUDGET, new Map<string, string[]>()),
    withinBudget(commissionHistory(chainId, addr, account).catch(() => null), BUDGET, null),
  ]);

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
  const website = validator.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  // Operators often write a bare domain; linked as-is it would resolve on this site.
  const websiteHref = /^https?:\/\//i.test(validator.website)
    ? validator.website
    : website && !/\s/.test(website)
      ? `https://${website}`
      : null;
  const status = validator.jailed ? "Jailed" : statusLabel(validator.status);
  // Its own stake decides its APR where the chain pays a per-validator bonus.
  const grossApr = aprModel?.at(validator.tokens) ?? chainApr?.stakingApr ?? null;
  const netApr = grossApr !== null ? grossApr * (1 - validator.commissionRate) : null;

  const bricks: BrickSpec[] = [
    {
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
        { label: "Rank", value: validator.rank ? `#${validator.rank}` : "-", mono: true },
        { label: "Status", value: status },
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
    },
    {
      key: "selfbond",
      label: "Self bond",
      value: selfBond ? formatToken(selfBond.amount, chain.exponent) : "N/A",
      sub: selfBond?.share != null ? `${pct(selfBond.share)} of its stake` : symbol,
    },
    uptime.window !== null || uptime.bars.length > 0
      ? {
          key: "signing",
          label: "Signing",
          // Jailed, the window is reset and stops counting; its percentage would
          // be a clean record the validator did not earn.
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
              value: !jailed && signed !== null ? signed.toLocaleString() : "-",
              mono: true,
            },
            {
              label: "Missed",
              value: !jailed && uptime.missed !== null ? uptime.missed.toLocaleString() : "-",
              mono: true,
            },
            {
              label: "Window",
              value: uptime.window !== null ? `${uptime.window.toLocaleString()} blocks` : "-",
              mono: true,
            },
            {
              label: "Miss budget",
              value: !jailed && budget !== null ? `${budget.toLocaleString()} blocks` : "-",
              mono: true,
            },
            {
              label: `Longest miss streak, last ${uptime.bars.length} blocks`,
              value: streak !== null ? String(streak) : "-",
              mono: true,
            },
            {
              label: "Jailed until",
              value: uptime.jailedUntil ? new Date(uptime.jailedUntil).toLocaleString() : "Never",
            },
            { label: "Tombstoned", value: uptime.tombstoned ? "Yes" : "No" },
          ]),
        }
      : { key: "signing", label: "Signing", value: "N/A", sub: "slashing window" },
    {
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
            : "-",
        },
        {
          label: "Outstanding",
          value:
            validator.outstandingCommission.length > 0
              ? validator.outstandingCommission.map((c) => coin(c, 4)).join(", ")
              : "-",
          mono: true,
        },
        // Every rate it set, newest first, from the messages themselves.
        ...(commissions?.changes ?? []).map((c) => ({
          label: `${c.kind === "create" ? "Created" : "Changed"} ${formatDate(c.time)}`,
          value: pct(c.rate),
          mono: true,
          href: `/${chainId}/txs/${c.txHash}`,
        })),
        ...(commissions && commissions.from > 1
          ? [{ label: "History since", value: `block ${commissions.from.toLocaleString()}`, mono: true }]
          : []),
      ]),
    },
    {
      key: "apr",
      label: "Delegator APR",
      value: netApr !== null ? pct(netApr) : "N/A",
      sub: "after commission",
      rows: kept([
        { label: "Before commission", value: pct(grossApr), mono: true },
        { label: "Commission", value: pct(validator.commissionRate), mono: true },
        { label: "After commission", value: pct(netApr), mono: true },
      ]),
    },
  ];

  // Who the validator is: a column of its own from lg, below the figures in
  // the Overview tab on narrower screens.
  const profile = (
    <>
      {validator.details ? (
        <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-foreground/85">
          {validator.details}
        </p>
      ) : null}

      {website || keybase || validator.identity ? (
        <div className="flex flex-wrap gap-1.5 text-[12px]">
          {websiteHref ? (
            <ExternalChip href={websiteHref} label={website} />
          ) : website ? (
            <span className="rounded-md border border-border px-2 py-0.5 text-muted-foreground">
              {website}
            </span>
          ) : null}
          {keybase ? (
            <ExternalChip href={`https://keybase.io/${keybase}`} label={`Keybase ${keybase}`} />
          ) : validator.identity ? (
            <span className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {validator.identity}
            </span>
          ) : null}
        </div>
      ) : null}

      <Group label="Addresses">
        <AddressRow label="Operator" copy={validator.operatorAddress}>
          <span className="font-mono">{truncateMiddle(validator.operatorAddress, 16, 8)}</span>
        </AddressRow>
        {account ? (
          <AddressRow label="Account" copy={account}>
            <AddressLink address={account} head={12} tail={8} />
          </AddressRow>
        ) : null}
        {ids ? (
          <>
            <AddressRow label="Consensus" copy={ids.valcons}>
              <span className="font-mono">{truncateMiddle(ids.valcons, 16, 8)}</span>
            </AddressRow>
            <AddressRow label="Hex" copy={ids.hex}>
              <span className="font-mono">{truncateMiddle(ids.hex, 12, 8)}</span>
            </AddressRow>
          </>
        ) : null}
      </Group>

      <Group label="Terms">
        <TermRow label="Max commission" value={pct(validator.maxRate, 0)} />
        <TermRow label="Max change" value={`${pct(validator.maxChangeRate)}/day`} />
        <TermRow
          label="Min self delegation"
          value={`${formatToken(validator.minSelfDelegation, chain.exponent, 6)} ${symbol}`}
        />
        {validator.securityContact ? (
          <TermRow label="Security" value={validator.securityContact} />
        ) : null}
      </Group>

      <Suspense fallback={null}>
        <ValidatorElsewhere chain={chain} account={account} identity={validator.identity} />
      </Suspense>
    </>
  );

  const allSections = [
    {
      // The validator's figures, in a tab of their own so every list tab gets
      // the full height. Below lg the profile follows them here, since it has
      // no column of its own there.
      key: "overview",
      label: "Overview",
      content: (
        <div className="flex h-full flex-col gap-3 overflow-y-auto">
          <div
            className={`brick-fill grid shrink-0 grid-cols-3 gap-1.5 sm:gap-2 ${
              // Eight tiles with the index's three, five without: one full row.
              chain.indexed ? "sm:grid-cols-4 2xl:grid-cols-8" : "sm:grid-cols-5"
            }`}
          >
            <BrickBoard accent={accent} bricks={bricks} bare />
            {chain.indexed ? (
              <>
                <Suspense fallback={<BrickLoading count={1} />}>
                  <EarnedBrick {...keys} />
                </Suspense>
                <Suspense fallback={<BrickLoading count={1} />}>
                  <ProposedBrick {...keys} />
                </Suspense>
                <Suspense fallback={<BrickLoading count={1} />}>
                  <GovernanceBrick {...keys} />
                </Suspense>
              </>
            ) : null}
          </div>
          <div className="gata-surface flex shrink-0 flex-col gap-4 px-4 py-3.5 lg:hidden">{profile}</div>
        </div>
      ),
    },
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
    {
      key: "signing",
      label: "Signing",
      content: (
        <Suspense fallback={<TabLoading />}>
          <SigningTab {...keys} jailedOnChain={validator.jailed} />
        </Suspense>
      ),
    },
    {
      key: "proposed",
      label: "Proposed",
      content: (
        <Suspense fallback={<TabLoading />}>
          <ProposedTab {...keys} />
        </Suspense>
      ),
    },
    {
      key: "votes",
      label: "Votes",
      content: (
        <Suspense fallback={<TabLoading />}>
          <VotesTab {...keys} />
        </Suspense>
      ),
    },
    {
      key: "power",
      label: "Power events",
      content: (
        <Suspense fallback={<TabLoading />}>
          <PowerEventsTab {...keys} />
        </Suspense>
      ),
    },
    {
      key: "stake",
      label: "Power",
      content: (
        <Suspense fallback={<TabLoading />}>
          <PowerTab {...keys} symbol={symbol} />
        </Suspense>
      ),
    },
    {
      key: "events",
      label: "Events",
      content: (
        <Suspense fallback={<TabLoading />}>
          <EventsTab {...keys} />
        </Suspense>
      ),
    },
    {
      key: "jailings",
      label: "Jailings",
      content: (
        <Suspense fallback={<TabLoading />}>
          <JailingsTab {...keys} jailedOnChain={validator.jailed} />
        </Suspense>
      ),
    },
  ];

  // Without our index a chain's nodes only answer for now: its history tabs
  // (proposed blocks, votes, power, events, jailings) would all read N/A.
  const sections = chain.indexed
    ? allSections
    : allSections.filter((sec) => ["overview", "delegators", "signing"].includes(sec.key));

  const initialTab = tab && TABS.includes(tab) ? tab : undefined;

  return (
    <PageFrame
      title={validator.moniker}
      emblem={
        <ValidatorAvatar
          name={validator.moniker}
          logos={logos.get(validator.operatorAddress) ?? []}
          size={30}
        />
      }
      sub={`${validator.rank ? `Rank #${validator.rank}` : "Unranked"} · ${chain.prettyName}`}
      accent={accent}
      actions={
        <>
          <Suspense fallback={null}>
            <IndexBehind chainId={chainId} />
          </Suspense>
          {links.length > 0 ? <LinkedAddresses links={links} currentChainId={chainId} /> : null}
          <ValidatorStatus
            jailed={validator.jailed}
            status={validator.status}
            tombstoned={uptime.tombstoned}
          />
        </>
      }
    >
      {/* The tabs fill the frame; from lg the profile takes a column of its own. */}
      <div className="flex h-full min-h-0 flex-col gap-2.5 lg:grid lg:grid-cols-[18.5rem_minmax(0,1fr)] lg:gap-3">
        <aside className="gata-surface hidden flex-col gap-4 px-4 py-3.5 lg:flex lg:min-h-0 lg:overflow-y-auto">
          {profile}
        </aside>

        <div className="min-h-0 flex-1">
          <SectionTabs sections={sections} initial={initialTab} param="tab" />
        </div>
      </div>
    </PageFrame>
  );
}

async function IndexBehind({ chainId }: { chainId: string }) {
  const behind = await indexBehind(chainId).catch(() => false);
  if (!behind) return null;
  return (
    <span className="rounded-full bg-[var(--gata-amber)]/12 px-2 py-0.5 text-[11px] font-medium text-[var(--gata-amber)]">
      Index behind
    </span>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </h2>
      <div className="flex flex-col divide-y divide-border/50">{children}</div>
    </section>
  );
}

function AddressRow({
  label,
  copy,
  children,
}: {
  label: string;
  copy: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 py-1.5 text-[12px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{children}</span>
        <CopyButton value={copy} label={label.toLowerCase()} />
      </span>
    </div>
  );
}

function TermRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1.5 text-[12px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right font-mono" title={value}>
        {value}
      </span>
    </div>
  );
}

function ExternalChip({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="max-w-full truncate rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5 text-primary transition-colors hover:border-[var(--gata-border-hi)]"
    >
      {label} ↗
    </a>
  );
}
