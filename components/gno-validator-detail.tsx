import { Suspense } from "react";
import type { ChainConfig } from "@/lib/chains";
import { accentFor } from "@/lib/chains";
import { gnoValidatorDetail } from "@/lib/gno";
import { getValoper } from "@/lib/gno-valopers";
import { truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { CopyButton } from "@/components/copy-button";
import { Skeleton } from "@/components/ui/skeleton";

const REGISTRY = "gno.land/r/gnops/valopers";

/**
 * The valopers realm read can require building a signing/operator index across
 * ~95 realm calls on a cold cache, so it streams in separately rather than
 * holding up the consensus-side facts. It is the one thing on the page that
 * cannot be laid out with the rest of the board — a brick has to be there when
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
    return (
      <p className="text-sm text-muted-foreground">
        N/A
      </p>
    );
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
      ? [{ label: "Signing address", value: profile.signingAddress, mono: true }]
      : []),
    ...(profile.signingPubKey
      ? [{ label: "Signing pubkey", value: profile.signingPubKey, mono: true }]
      : []),
    ...(profile.serverType ? [{ label: "Server type", value: profile.serverType }] : []),
    ...(profile.profilePath
      ? [{ label: "Realm profile", value: profile.profilePath, mono: true }]
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

  return <BrickBoard chainId={chain.chainId} accent={accent} bricks={bricks} />;
}

function ProfileSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      <Skeleton className="h-[5.5rem] rounded-none sm:h-24" />
      <Skeleton className="h-[5.5rem] rounded-none sm:h-24" />
    </div>
  );
}

/**
 * A gno.land validator: consensus weight now, and whatever it registered.
 *
 * There is no staking module, so nothing here is denominated in tokens — the
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
  const consensus = await gnoValidatorDetail(chain, address);

  const active = consensus?.status === "ACTIVE";

  const bricks: BrickSpec[] = [
    {
      key: "power",
      label: "Voting power",
      value: consensus?.votingPower ?? "—",
      sub:
        consensus?.sharePercent != null
          ? `${consensus.sharePercent.toFixed(2)}% of the set`
          : "consensus weight",
      lead: true,
      rows: [
        { label: "Voting power", value: consensus?.votingPower ?? "—", mono: true },
        {
          label: "Share",
          value:
            consensus?.sharePercent != null
              ? `${consensus.sharePercent.toFixed(2)}%`
              : "—",
          mono: true,
        },
        { label: "Rank", value: consensus?.rank ? `#${consensus.rank}` : "—", mono: true },
        { label: "Status", value: consensus?.status ?? "—" },
      ],
    },
    {
      key: "first",
      label: "First committed",
      value: consensus?.firstCommittedHeight
        ? `#${consensus.firstCommittedHeight.toLocaleString()}`
        : "—",
      sub: consensus?.firstCommittedTime
        ? new Date(consensus.firstCommittedTime).toLocaleDateString()
        : "since genesis or unknown",
      rows: [
        {
          label: "Height",
          value: consensus?.firstCommittedHeight
            ? consensus.firstCommittedHeight.toLocaleString()
            : "—",
          mono: true,
        },
        {
          label: "Time",
          value: consensus?.firstCommittedTime
            ? new Date(consensus.firstCommittedTime).toLocaleString()
            : "—",
        },
      ],
    },
    {
      key: "consensus-address",
      label: "Consensus address",
      value: truncateMiddle(address, 10, 6),
      sub: "signing identity",
      rows: [
        {
          label: "Address",
          value: address,
          mono: true,
          href: `/${chain.chainId}/accounts/${address}`,
        },
        { label: "Registry", value: REGISTRY, href: `https://${REGISTRY}` },
      ],
    },
  ];

  return (
    <PageFrame
      title={consensus?.moniker ?? truncateMiddle(address, 14, 8)}
      sub={`${consensus?.rank ? `Rank #${consensus.rank} · ` : ""}${chain.prettyName}`}
      accent={accent}
      actions={
        <>
          <CopyButton value={address} label="consensus address" />
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
        <div className="shrink-0">
          <BrickBoard chainId={chain.chainId} accent={accent} bricks={bricks} />
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<ProfileSkeleton />}>
            <ValoperProfileBoard chain={chain} address={address} accent={accent} />
          </Suspense>
        </div>
      </div>
    </PageFrame>
  );
}
