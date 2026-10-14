import Link from "next/link";
import type { ChainConfig } from "@/lib/chains";
import { accentFor } from "@/lib/chains";
import {
  govdaoMembers,
  govdaoProposal,
  govdaoProposals,
  statusLabel,
  type GovMember,
  type GovProposal,
  type GovProposalSummary,
  type GovStatus,
} from "@/lib/gno-govdao";
import { packageHref, shortPath } from "@/lib/gno-packages";
import { withinBudget } from "@/lib/cache";
import { truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck, type DeckCell, type DeckRow } from "@/components/row-deck";
import { Prose } from "@/components/prose";
import { GovernanceSwitch } from "@/components/governance-switch";

/**
 * gno.land's Governance tab: GovDAO's proposals, read from the realm itself.
 * The same list and detail layout as a Cosmos chain's proposals, with what
 * GovDAO has instead of deposits and a validator tally: member tiers, the
 * executor that runs on passing, and each member's vote.
 */

const tone = (s: GovStatus): DeckCell["tone"] =>
  s === "accepted" || s === "executed" ? "ok" : s === "rejected" ? "bad" : s === "active" ? "accent" : undefined;

/** What a proposal does, from the realm that built its executor. */
function executorLabel(path: string | null): string {
  if (!path) return "Text";
  const parts = path.replace(/^gno\.land\//, "").split("/").filter((p) => !/^v\d+$/.test(p));
  const last = parts[parts.length - 1] ?? path;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** "@moul" as text; a g1 address as a link to its account. */
function authorCell(author: string): DeckCell {
  return /^g1[a-z0-9]{38}$/.test(author)
    ? { v: truncateMiddle(author, 8, 5), mono: true, address: author }
    : { v: author || "-", dim: !author };
}

export async function GovdaoList({ chain }: { chain: ChainConfig }) {
  const accent = accentFor(chain);
  const list = await withinBudget(govdaoProposals(chain), 8000, null);
  // Each proposal's page holds its executor and tally; read for the newest 60.
  const details = new Map(
    (
      await Promise.all(
        (list ?? []).slice(0, 60).map((p) => withinBudget(govdaoProposal(chain, p.id).catch(() => null), 4000, null))
      )
    ).flatMap((d) => (d ? [[d.id, d] as const] : []))
  );

  const rows: DeckRow[] = (list ?? []).map((p: GovProposalSummary) => {
    const d = details.get(p.id);
    const href = `/${chain.chainId}/proposals/${p.id}`;
    return {
      key: String(p.id),
      search: `${p.id} ${p.title} ${p.author} ${d?.executor ?? ""}`,
      cells: [
        { v: `#${p.id}`, mono: true, tone: "accent", href },
        { v: p.title || `Proposal ${p.id}` },
        { v: d ? executorLabel(d.executor) : "-", dim: true },
        { v: statusLabel(p.status, p.statusText), tone: tone(p.status) },
        { v: p.tiers.join(", ") || "-", mono: true, dim: true },
        { v: d?.yes != null ? `${d.yes.toFixed(1)}%` : "-", mono: true, align: "right", dim: d?.yes == null },
        authorCell(p.author),
      ],
      detail: { title: `#${p.id}`, rows: [], action: { label: "Proposal", href } },
    };
  });

  const voting = (list ?? []).filter((p) => p.status === "active").length;
  const facts = list ? [`${list.length} total`, `${voting} in voting`] : ["N/A"];

  return (
    <PageFrame
      title="Proposals"
      sub={facts.join(" · ")}
      accent={accent}
      actions={
        <GovernanceSwitch chainId={chain.chainId} current="proposals" second="members" counts={{ proposals: list?.length ?? null }} />
      }
    >
      <RowDeck
        accent={accent}
        columns={[
          { label: "#", width: "4.5rem" },
          { label: "Title" },
          { label: "Type", width: "12%", phoneHide: true },
          { label: "Status", width: "7rem" },
          { label: "Tiers", width: "8rem", optional: true },
          { label: "Yes", align: "right", width: "5rem", optional: true },
          { label: "Author", width: "12%", optional: true },
        ]}
        rows={rows}
        filter={{ placeholder: "Filter by number, title or author…" }}
        empty={list ? "No proposals" : "N/A"}
      />
    </PageFrame>
  );
}

export async function GovdaoProposalView({
  chain,
  proposal: p,
  tab,
}: {
  chain: ChainConfig;
  proposal: GovProposal;
  tab?: string;
}) {
  const accent = accentFor(chain);
  const pct = (v: number | null) => (v == null ? "N/A" : `${v.toFixed(2)}%`);
  const voters = p.voters ?? [];

  const bricks: BrickSpec[] = [
    {
      key: "status",
      label: "Status",
      value: statusLabel(p.status, p.statusText),
      tone: p.status === "accepted" || p.status === "executed" ? "ok" : p.status === "rejected" ? "bad" : undefined,
      sub: p.tiers.length ? `tiers ${p.tiers.join(", ")}` : undefined,
      lead: true,
    },
    { key: "yes", label: "Yes", value: pct(p.yes), sub: "of voting power" },
    { key: "no", label: "No", value: pct(p.no), sub: "of voting power" },
    { key: "abstain", label: "Abstain", value: pct(p.abstain), sub: "of voting power" },
    { key: "voters", label: "Voters", value: p.voters ? voters.length.toLocaleString() : "N/A", sub: "members" },
    {
      key: "type",
      label: "Type",
      value: executorLabel(p.executor),
      sub: p.executor ? shortPath(p.executor) : undefined,
      href: p.executor ? packageHref(chain.chainId, p.executor) : undefined,
    },
  ];

  const author = /^g1[a-z0-9]{38}$/.test(p.author) ? (
    <Link href={`/${chain.chainId}/accounts/${p.author}`} className="font-mono text-primary hover:underline">
      {p.author}
    </Link>
  ) : (
    <span>{p.author || "-"}</span>
  );

  const voterRows: DeckRow[] = voters.map((v, i) => ({
    key: `${v.voter}-${i}`,
    search: `${v.voter} ${v.option} ${v.tier}`,
    cells: [
      { v: v.option === "YES" ? "Yes" : v.option === "NO" ? "No" : "Abstain", tone: v.option === "YES" ? "ok" : v.option === "NO" ? "bad" : undefined },
      { v: v.tier, mono: true, dim: true },
      authorCell(v.voter),
    ],
    detail: { title: v.voter, rows: [{ label: "Vote", value: v.option }, { label: "Tier", value: v.tier }] },
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
          <div className="gata-surface flex shrink-0 flex-col gap-3 px-4 py-3.5">
            <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="text-muted-foreground">Author</span>
              {author}
            </div>
            {p.body ? <Prose text={p.body} gnoChain={chain.chainId} /> : null}
          </div>
        </div>
      ),
    },
    {
      key: "votes",
      label: `Votes${p.voters ? ` (${voters.length})` : ""}`,
      content: (
        <RowDeck
          accent={accent}
          columns={[
            { label: "Vote", width: "18%" },
            { label: "Tier", width: "14%" },
            { label: "Member" },
          ]}
          rows={voterRows}
          empty={p.voters ? "None" : "N/A"}
        />
      ),
    },
  ];

  return (
    <PageFrame
      title={`#${p.id} ${p.title}`}
      sub={`GovDAO · ${chain.prettyName}`}
      accent={accent}
      actions={
        <span className="rounded-full bg-[var(--gata-faint)]/15 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {statusLabel(p.status, p.statusText)}
        </span>
      }
    >
      <SectionTabs sections={sections} initial={tab === "votes" ? "votes" : undefined} param="tab" />
    </PageFrame>
  );
}

export async function GovdaoMembers({ chain }: { chain: ChainConfig }) {
  const accent = accentFor(chain);
  const [data, list] = await Promise.all([
    withinBudget(govdaoMembers(chain), 8000, null),
    withinBudget(govdaoProposals(chain), 4000, null),
  ]);
  // Votes each member cast, from every proposal's voter list (cached by the
  // proposals page). A voter is listed by name where it has one.
  const details = (
    await Promise.all(
      (list ?? []).slice(0, 60).map((p) => withinBudget(govdaoProposal(chain, p.id).catch(() => null), 3000, null))
    )
  ).filter((d): d is GovProposal => d !== null);
  const votesOf = (m: GovMember) =>
    details.filter((d) => d.voters?.some((v) => v.voter === m.address || (m.name && v.voter === `@${m.name}`))).length;
  const powerOf = new Map((data?.tiers ?? []).map((t) => [t.tier, t.members > 0 ? t.power / t.members : null]));

  const rows: DeckRow[] = (data?.members ?? []).map((m, i) => {
    const votes = votesOf(m);
    const each = powerOf.get(m.tier);
    return {
      key: m.address,
      search: `${m.name ?? ""} ${m.address} ${m.tier}`,
      cells: [
        { v: String(i + 1), mono: true, dim: true, align: "right" },
        m.name ? { v: `@${m.name}`, href: `/${chain.chainId}/accounts/${m.address}` } : { v: "-", dim: true },
        { v: truncateMiddle(m.address, 10, 6), mono: true, address: m.address },
        { v: m.tier, mono: true, tone: "accent" },
        { v: each != null ? String(each) : "-", mono: true, align: "right", dim: each == null },
        { v: details.length ? `${votes} of ${details.length}` : "-", mono: true, align: "right" },
      ],
      detail: {
        title: m.name ? `@${m.name}` : truncateMiddle(m.address, 14, 8),
        rows: [{ label: "Tier", value: m.tier }],
        action: { label: "Account", href: `/${chain.chainId}/accounts/${m.address}` },
      },
    };
  });

  const facts = data
    ? [
        `${data.members.length} member${data.members.length === 1 ? "" : "s"}`,
        ...data.tiers.filter((t) => t.members > 0).map((t) => `${t.tier} power ${t.power}`),
      ]
    : ["N/A"];

  return (
    <PageFrame
      title="Members"
      sub={facts.join(" · ")}
      accent={accent}
      actions={
        <GovernanceSwitch
          chainId={chain.chainId}
          current="members"
          second="members"
          counts={{ members: data?.members.length ?? null }}
        />
      }
    >
      <RowDeck
        accent={accent}
        columns={[
          { label: "#", align: "right", width: "3rem", phoneHide: true },
          { label: "Name", width: "18%", phoneWidth: "30%" },
          { label: "Address" },
          { label: "Tier", width: "8%", phoneWidth: "16%" },
          { label: "Power", align: "right", width: "9%", optional: true },
          { label: "Votes", align: "right", width: "12%", phoneHide: true },
        ]}
        rows={rows}
        filter={{ placeholder: "Filter by name or address…" }}
        empty={data ? "None" : "N/A"}
      />
    </PageFrame>
  );
}
