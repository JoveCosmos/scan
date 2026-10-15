import { Suspense } from "react";
import type { ChainConfig } from "@/lib/chains";
import type { ValidatorUptime } from "@/lib/uptime";
import { accentFor } from "@/lib/chains";
import { gnoValidatorDetail, gnoUptime } from "@/lib/gno";
import { packageHref } from "@/lib/address-route";

/** "gno.land/r/gnops/valopers:g1…": the realm's page here, rendered at that path. */
function profileHref(chainId: string, path: string): string | null {
  const m = path.match(/^(gno\.land\/[rp]\/[\w\-./]+?)(?::(.*))?$/);
  if (!m) return null;
  return m[2] ? `${packageHref(chainId, m[1])}?tab=render&render=${encodeURIComponent(m[2])}` : packageHref(chainId, m[1]);
}
import { cached } from "@/lib/cache";
import { UptimeBars } from "@/components/uptime-bars";
import { ValidatorSigningHistory } from "@/components/validator-signing-history";
import { signingHistory } from "@/lib/indexer-validator";
import { getValoper } from "@/lib/gno-valopers";
import { truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { CopyButton } from "@/components/copy-button";
import { BrickLoading } from "@/components/brick-loading";

const REGISTRY = "gno.land/r/gnops/valopers";

/**
 * The valopers realm read can require building a signing/operator index across
 * ~95 realm calls on a cold cache, so it streams in separately rather than
 * holding up the consensus-side facts. It is the one thing on the page that
 * cannot be laid out with the rest of the board - a brick has to be there when
 * the board is drawn, so the profile gets a board of its own underneath.
 */
async function ValoperProfileBoard({
  chain,
  address,
  accent,
}: {
  chain: ChainConfig;
  address: string;
  accent: string;
}) {
  const profile = await getValoper(chain, address);

  if (!profile) {
    return <BrickBoard accent={accent} bricks={[{ key: "operator", label: "Operator", value: "N/A" }]} bare />;
  }

  const keyRows = [
    {
      label: "Operator",
      value: profile.operatorAddress,
      mono: true,
      // On gno this is already a plain account address, so it links straight to
      // balances, history and the address switcher.
      href: `/${chain.chainId}/accounts/${profile.operatorAddress}`,
    },
    ...(profile.signingAddress
      ? [
          {
            label: "Signing address",
            value: profile.signingAddress,
            mono: true,
            href: `/${chain.chainId}/validators/${profile.signingAddress}`,
          },
        ]
      : []),
    ...(profile.signingPubKey
      ? [{ label: "Signing pubkey", value: profile.signingPubKey, mono: true }]
      : []),
    ...(profile.serverType ? [{ label: "Server type", value: profile.serverType }] : []),
    ...(profile.profilePath
      ? [
          {
            label: "Realm profile",
            value: profile.profilePath,
            mono: true,
            ...(profileHref(chain.chainId, profile.profilePath) ? { href: profileHref(chain.chainId, profile.profilePath)! } : {}),
          },
        ]
      : []),
  ];

  const bricks: BrickSpec[] = [
    {
      key: "operator",
      label: "Operator",
      value: truncateMiddle(profile.operatorAddress, 10, 6),
      sub: profile.serverType ?? "registered operator",
      count: keyRows.length,
      rows: keyRows,
    },
    ...(profile.description
      ? [
          {
            key: "profile",
            label: "Profile",
            // Validator-authored content: it reaches the page as text, never as
            // markup, both on the tile and in the popup.
            value: profile.description,
            text: true,
            sub: profile.moniker,
            rows: [{ label: "Description", value: profile.description }],
          },
        ]
      : []),
  ];

  return <BrickBoard accent={accent} bricks={bricks} bare />;
}

/**
 * A gno.land validator: consensus weight now, and whatever it registered.
 *
 * There is no staking module, so nothing here is denominated in tokens - the
 * voting power is assigned, and the profile is a realm entry the operator wrote
 * itself. Both halves are bricks for the same reason the Cosmos page is: the
 * addresses and the signing key are the longest values on the page and the
 * least often wanted, so they belong one click deep.
 */
export async function GnoValidatorDetail({
  chain,
  address,
}: {
  chain: ChainConfig;
  address: string;
}) {
  const accent = accentFor(chain);
  const [consensus, uptimes] = await Promise.all([
    gnoValidatorDetail(chain, address),
    // Same cache key as the adapter's, so the list and this page share one read.
    cached(`uptime:${chain.chainId}`, 15_000, () => gnoUptime(chain)).catch(
      () => new Map<string, ValidatorUptime>()
    ),
  ]);
  // An operator-address URL resolves to the signing address, the page's real id.
  const signing = consensus?.address ?? address;
  const uptime = uptimes.get(signing) ?? null;

  const active = consensus?.status === "ACTIVE";

  const bricks: BrickSpec[] = [
    {
      key: "power",
      label: "Voting power",
      value: consensus?.votingPower ?? "-",
      sub:
        consensus?.sharePercent != null
          ? `${consensus.sharePercent.toFixed(2)}% of the set`
          : "consensus weight",
      lead: true,
      rows: [
        { label: "Voting power", value: consensus?.votingPower ?? "-", mono: true },
        {
          label: "Share",
          value:
            consensus?.sharePercent != null
              ? `${consensus.sharePercent.toFixed(2)}%`
              : "-",
          mono: true,
        },
        { label: "Rank", value: consensus?.rank ? `#${consensus.rank}` : "-", mono: true },
        { label: "Status", value: consensus?.status ?? "-" },
      ],
    },
    {
      key: "signing",
      label: "Signing",
      value: uptime?.ratio != null ? `${(uptime.ratio * 100).toFixed(2)}%` : "N/A",
      sub:
        uptime?.window != null
          ? `${uptime.missed ?? 0} missed of the last ${uptime.window} blocks`
          : "inactive",
      tone: uptime?.missed ? "bad" : uptime?.ratio != null ? "ok" : undefined,
      rows: [
        {
          label: "Signed",
          value: uptime?.window != null ? String(uptime.window - (uptime.missed ?? 0)) : "N/A",
          mono: true,
        },
        { label: "Missed", value: uptime?.missed != null ? String(uptime.missed) : "N/A", mono: true },
        { label: "Window", value: uptime?.window != null ? `last ${uptime.window} blocks` : "N/A" },
      ],
    },
    {
      key: "consensus-address",
      label: "Consensus address",
      short: "Consensus",
      value: truncateMiddle(signing, 10, 6),
      sub: "signing identity",
      rows: [
        { label: "Address", value: signing, mono: true },
        { label: "Registry", value: REGISTRY, href: `https://${REGISTRY}` },
      ],
    },
  ];

  return (
    <PageFrame
      title={consensus?.moniker ?? truncateMiddle(signing, 14, 8)}
      sub={`${consensus?.rank ? `Rank #${consensus.rank} · ` : ""}${chain.prettyName}`}
      accent={accent}
      actions={
        <>
          <CopyButton value={signing} label="consensus address" />
          {consensus?.status ? (
            <span
              className={
                active
                  ? "rounded-full bg-[var(--gata-green)]/12 px-2 py-0.5 text-xs whitespace-nowrap text-[var(--gata-green)]"
                  : "rounded-full bg-secondary px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground"
              }
            >
              {active ? "Active" : consensus.status}
            </span>
          ) : null}
        </>
      }
    >
      <div className="flex h-full flex-col gap-3">
        {/* One grid for the consensus figures and the registered profile, so the
            profile's tiles continue the row rather than start a new one. */}
        <div className="brick-fill grid shrink-0 grid-cols-3 gap-1.5 sm:gap-2 lg:grid-cols-5">
          <BrickBoard accent={accent} bricks={bricks} bare />
          <Suspense fallback={<BrickLoading count={2} />}>
            <ValoperProfileBoard chain={chain} address={address} accent={accent} />
          </Suspense>
        </div>
        {uptime && uptime.bars.length > 0 ? (
          <div className="gata-surface shrink-0 px-4 py-3">
            <UptimeBars uptime={uptime} slashingWindow={false} />
          </div>
        ) : null}
        <Suspense fallback={null}>
          <GnoSigningHistory chainId={chain.chainId} address={address} />
        </Suspense>
      </div>
    </PageFrame>
  );
}

/**
 * The validator's signing record back to genesis, from the index: the chain's
 * own RPC answers only for the last few blocks. missed_signature files gno.land
 * validators under their g1… signing address. Absent when the index has none.
 */
async function GnoSigningHistory({ chainId, address }: { chainId: string; address: string }) {
  const history = await signingHistory(chainId, address).catch(() => null);
  if (!history) return null;
  return (
    <div className="gata-surface min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <ValidatorSigningHistory history={history} chainId={chainId} />
    </div>
  );
}
