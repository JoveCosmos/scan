import type { ChainConfig } from "@/lib/chains";
import { accentFor } from "@/lib/chains";
import type { ChainServices } from "@/lib/services";
import { EndpointList } from "@/components/endpoint-list";
import { SnapshotPanel } from "@/components/snapshot-panel";

/**
 * One chain's endpoints and snapshot, as shown inside the dialog.
 *
 * A server component so the endpoint list and snapshot details are built
 * before the dialog opens — the tabs then switch instantly with nothing to
 * fetch. Health is still polled from the browser, since that is the one part
 * that has to be current rather than rendered once.
 */
export function ChainServicesPanel({
  chain,
  services,
}: {
  chain: ChainConfig;
  services: ChainServices;
}) {
  const accent = accentFor(chain);

  return (
    <div className="space-y-4">
      {services.endpoints.length > 0 ? (
        <EndpointList
          chainId={chain.chainId}
          endpoints={services.endpoints}
          accent={accent}
        />
      ) : null}

      <SnapshotPanel
        services={services}
        accent={accent}
        chainName={chain.prettyName}
      />
    </div>
  );
}
