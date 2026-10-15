import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor, symbolFor } from "@/lib/chains";
import {
  getGovernor,
  getGovernorDelegators,
  getGovernorPower,
  getGovernorTable,
  governorOpenVotes,
} from "@/lib/governors";
import { validatorVotes } from "@/lib/indexer-validator";
import { voteOptionLabel } from "@/lib/proposals";
import { keybasePicture, validatorLogoMap } from "@/lib/validator-logos";
import { withinBudget } from "@/lib/cache";
import { formatToken } from "@/lib/overview";
import { decodeParam, formatDate, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck, type DeckRow } from "@/components/row-deck";
import { ValidatorAvatar } from "@/components/validator-avatar";
import { CopyButton } from "@/components/copy-button";
import { AddressLink } from "@/components/address-link";

export const dynamic = "force-dynamic";

const BUDGET = 1500;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}): Promise<Metadata> {
  const { chain: chainId, addr } = await params;
  const chain = getChain(chainId);
  if (!chain?.governors) return { title: "Governor" };
  const g = await getGovernor(chain, decodeParam(addr).trim().toLowerCase()).catch(() => null);
  return { title: g ? g.moniker : "Governor" };
}

const day = formatDate;

const TABS = ["overview", "power", "delegators", "votes"];

/**
 * One AtomOne governor: who it is, the stake behind it and where that stake
 * sits, who delegated to it, and how it voted.
 */
export default async function GovernorPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string; addr: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { chain: chainId, addr: rawAddr } = await params;
  const { tab } = await searchParams;
  const chain = getChain(chainId);
  if (!chain || !chain.governors) notFound();
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);
  const addr = decodeParam(rawAddr).trim().toLowerCase();

  const governor = await getGovernor(chain, addr);
  if (!governor) notFound();

  const account = governor.account;
  const [power, delegators, table, picture, record, open] = await Promise.all([
    withinBudget(getGovernorPower(chain, addr), BUDGET * 3, null),
    withinBudget(getGovernorDelegators(chain, addr), BUDGET * 3, null),
    withinBudget(getGovernorTable(chain), BUDGET, null),
    withinBudget(keybasePicture(governor.identity), BUDGET, null),
    // The index holds every vote back to genesis where it covers the chain;
    // counted from when the governor last became active.
    account ? withinBudget(validatorVotes(chainId, account, governor.statusSince), BUDGET * 2, null) : null,
    account ? withinBudget(governorOpenVotes(chain, account), BUDGET * 2, null) : null,
  ]);

  const governed = (table ?? []).filter((g) => g.active).reduce((s, g) => s + g.tokens, BigInt(0));
  const rank = table ? table.findIndex((g) => g.address === addr) + 1 : 0;
  const pct = (part: bigint, whole: bigint) =>
    whole > BigInt(0) ? `${(Number((part * BigInt(1_000_000)) / whole) / 10_000).toFixed(2)}%` : "-";
  const valLogos = power
    ? await withinBudget(
        validatorLogoMap(
          chain,
          power.byValidator.flatMap((s) => (s.validator ? [s.validator] : []))
        ),
        BUDGET,
        new Map<string, string[]>()
      )
    : new Map<string, string[]>();

  const bricks: BrickSpec[] = [
    {
      key: "power",
      label: "Voting power",
      value: power ? formatToken(power.tokens.toString(), chain.exponent) : "N/A",
      sub: power && governed > BigInt(0) && governor.active ? `${pct(power.tokens, governed)} of governed` : symbol,
      lead: true,
    },
    {
      key: "delegators",
      label: "Delegators",
      value: delegators ? delegators.length.toLocaleString() : "N/A",
      sub: "delegated their vote",
    },
    {
      key: "validators",
      label: "Validators",
      value: power ? power.byValidator.length.toLocaleString() : "N/A",
      sub: "holding that stake",
    },
    {
      key: "status",
      label: "Status",
      value: governor.active ? "Active" : "Inactive",
      tone: governor.active ? "ok" : undefined,
      sub: governor.statusSince ? `since ${day(governor.statusSince)}` : undefined,
    },
    {
      key: "votes",
      label: "Participation",
      value: record && record.total > 0 ? `${Math.round((record.voted / record.total) * 100)}%` : "N/A",
      sub: record && record.total > 0 ? `voted on ${record.voted} of ${record.total}` : undefined,
      tone: record && record.total > 0 && record.voted === record.total ? "ok" : undefined,
    },
    {
      key: "rank",
      label: "Rank",
      value: rank > 0 ? `#${rank}` : "N/A",
      sub: table ? `of ${table.length} governors` : undefined,
    },
  ];

  const website = governor.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const websiteHref = /^https?:\/\//i.test(governor.website)
    ? governor.website
    : website && !/\s/.test(website)
      ? `https://${website}`
      : null;

  const profile = (
    <div className="gata-surface flex shrink-0 flex-col gap-4 px-4 py-3.5">
      {governor.details ? (
        <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-foreground/85">{governor.details}</p>
      ) : null}
      {websiteHref ? (
        <div className="flex flex-wrap gap-1.5 text-[12px]">
          <a
            href={websiteHref}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="max-w-full truncate rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5 text-primary transition-colors hover:border-[var(--gata-border-hi)]"
          >
            {website} ↗
          </a>
        </div>
      ) : null}
      <section className="flex flex-col gap-1.5">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Addresses</h2>
        <div className="flex flex-col divide-y divide-border/50">
          <Row label="Governor" copy={governor.address}>
            <span className="font-mono">{truncateMiddle(governor.address, 16, 8)}</span>
          </Row>
          {account ? (
            <Row label="Account" copy={account}>
              <AddressLink address={account} head={12} tail={8} />
            </Row>
          ) : null}
        </div>
      </section>
      {governor.securityContact ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Security</h2>
          <span className="text-[12px]">{governor.securityContact}</span>
        </section>
      ) : null}
    </div>
  );

  const powerDeck: DeckRow[] = (power?.byValidator ?? []).map((s) => ({
    key: s.operator,
    cells: [
      {
        v: s.validator?.moniker ?? truncateMiddle(s.operator, 14, 6),
        avatar: { name: s.validator?.moniker ?? s.operator, logos: valLogos.get(s.operator) ?? [] },
      },
      {
        v: `${formatToken(s.tokens.toString(), chain.exponent)} ${symbol}`,
        mono: true,
        align: "right",
        bar: power && power.tokens > BigInt(0) ? Number((s.tokens * BigInt(1000)) / power.tokens) / 1000 : 0,
      },
      { v: power ? pct(s.tokens, power.tokens) : "-", mono: true, align: "right" },
    ],
    detail: {
      title: s.validator?.moniker ?? s.operator,
      rows: [],
      action: { label: "Validator", href: `/${chainId}/validators/${s.operator}` },
    },
  }));

  const delegatorDeck: DeckRow[] = (delegators ?? []).map((d, i) => ({
    key: d,
    search: d,
    cells: [
      { v: String(i + 1), mono: true, dim: true, align: "right" },
      { v: truncateMiddle(d, 14, 8), mono: true, address: d },
    ],
    detail: { title: truncateMiddle(d, 16, 10), rows: [], action: { label: "Account", href: `/${chainId}/accounts/${d}` } },
  }));

  // Closed proposals from the index, open ones from the chain, newest first.
  const voteRows: { id: number; vote: string; when: string | null; tx: string | null; bad?: boolean }[] = [];
  const seen = new Set<number>();
  for (const o of open ?? []) {
    const id = Number(o.proposalId);
    seen.add(id);
    voteRows.push({
      id,
      vote: o.options
        ? o.options.length > 1
          ? o.options.map((x) => `${voteOptionLabel(x.option)} ${Math.round(x.weight * 100)}%`).join(", ")
          : voteOptionLabel(o.options[0]?.option ?? "")
        : "Not voted yet",
      when: o.votingEndTime,
      tx: null,
      bad: !o.options,
    });
  }
  for (const v of record?.votes ?? []) {
    if (seen.has(v.proposalId)) continue;
    seen.add(v.proposalId);
    voteRows.push({ id: v.proposalId, vote: `${voteOptionLabel(v.option)}${v.weighted ? ", split" : ""}`, when: v.time, tx: v.txHash });
  }
  for (const id of record?.skipped ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    voteRows.push({ id, vote: "Did not vote", when: null, tx: null, bad: true });
  }
  voteRows.sort((a, b) => b.id - a.id);
  const voteDeck: DeckRow[] = voteRows.map((r) => ({
    key: String(r.id),
    cells: [
      { v: `#${r.id}`, mono: true, tone: "accent" },
      { v: r.vote, tone: r.bad ? "bad" : undefined },
      r.tx
        ? { v: truncateMiddle(r.tx, 6, 4), mono: true, dim: true, href: `/${chainId}/txs/${r.tx}` }
        : { v: "-", dim: true },
      { v: day(r.when), dim: true, align: "right" },
    ],
    detail: { title: `Proposal #${r.id}`, rows: [], action: { label: "Proposal", href: `/${chainId}/proposals/${r.id}` } },
  }));

  const sections = [
    {
      key: "overview",
      label: "Overview",
      content: (
        <div className="flex h-full flex-col gap-3 overflow-y-auto">
          <div className="brick-fill grid shrink-0 grid-cols-3 gap-1.5 sm:gap-2 lg:grid-cols-6">
            <BrickBoard accent={accent} bricks={bricks} bare />
          </div>
          {profile}
        </div>
      ),
    },
    {
      key: "power",
      label: "Voting power",
      content: (
        <RowDeck
          accent={accent}
          columns={[
            { label: "Validator" },
            { label: "Stake", align: "right", width: "28%", phoneWidth: "42%" },
            { label: "Share", align: "right", width: "14%", phoneHide: true },
          ]}
          rows={powerDeck}
          empty={power ? "None" : "N/A"}
        />
      ),
    },
    {
      key: "delegators",
      label: "Delegators",
      content: (
        <RowDeck
          accent={accent}
          columns={[
            { label: "#", align: "right", width: "10%", phoneWidth: "14%" },
            { label: "Delegator" },
          ]}
          rows={delegatorDeck}
          filter={{ placeholder: "Filter by address…" }}
          empty={delegators ? "None" : "N/A"}
        />
      ),
    },
    {
      key: "votes",
      label: "Votes",
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
          empty={record || open ? "None" : "N/A"}
        />
      ),
    },
  ];

  return (
    <PageFrame
      title={governor.moniker}
      emblem={<ValidatorAvatar name={governor.moniker} logos={picture ? [picture] : []} size={30} />}
      sub={`${rank > 0 ? `Rank #${rank}` : "Governor"} · ${chain.prettyName}`}
      accent={accent}
      actions={
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            governor.active
              ? "bg-[var(--gata-green)]/12 text-[var(--gata-green)]"
              : "bg-[var(--gata-faint)]/15 text-muted-foreground"
          }`}
        >
          {governor.active ? "Active" : "Inactive"}
        </span>
      }
    >
      <SectionTabs sections={sections} initial={tab && TABS.includes(tab) ? tab : undefined} param="tab" />
    </PageFrame>
  );
}

function Row({ label, copy, children }: { label: string; copy: string; children: React.ReactNode }) {
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
