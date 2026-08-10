import type { ChainServices } from "@/lib/services";
import { CopyButton } from "@/components/copy-button";

/**
 * Snapshot details, and the commands to restore from one.
 *
 * The commands are the substance. Anyone can host a tarball; what makes a
 * snapshot usable is knowing the exact sequence around it — and one step in
 * particular, preserving priv_validator_state.json, is the difference between
 * a restored node and a double-signed validator. It is generated here rather
 * than left to a linked guide so it is correct for this chain's binary and
 * home directory.
 */
export function SnapshotPanel({
  services,
  accent,
  chainName,
}: {
  services: ChainServices;
  accent: string;
  chainName: string;
}) {
  const { snapshot, daemon, home } = services;
  if (!snapshot) return null;

  const live = snapshot.status === "live";
  const script = daemon && home ? restoreScript(snapshot.url, daemon, home) : null;

  return (
    <div
      className="gata-panel"
      style={{ ["--panel-accent" as string]: accent }}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium">Snapshot</h3>
        {live ? null : (
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Coming soon
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-4">
        <Detail label="Height" value={snapshot.height?.toLocaleString()} />
        <Detail label="Size" value={snapshot.size} />
        <Detail
          label="Taken"
          value={
            snapshot.takenAt
              ? new Date(snapshot.takenAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : undefined
          }
        />
        <Detail label="Pruning" value={snapshot.pruning} />
      </dl>

      <div className="border-t border-border px-4 py-3">
        <div className="text-xs text-muted-foreground">Download</div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <code
            className={`min-w-0 flex-1 truncate font-mono text-sm ${
              live ? "" : "text-muted-foreground line-through"
            }`}
          >
            {snapshot.url}
          </code>
          {live ? (
            <CopyButton value={snapshot.url} label="snapshot URL" />
          ) : null}
        </div>
        {snapshot.schedule ? (
          <div className="mt-1 text-xs text-muted-foreground">
            Taken {snapshot.schedule}
            {snapshot.version ? ` · ${chainName} ${snapshot.version}` : ""}
          </div>
        ) : null}
      </div>

      {script ? (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">Restore</div>
            <CopyButton value={script} label="restore commands" />
          </div>
          <pre className="mt-2 overflow-x-auto rounded border border-border bg-secondary/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
            {script}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            The backup and restore of{" "}
            <code className="font-mono">priv_validator_state.json</code> is not
            optional on a validator. Wiping it and starting from the
            snapshot&apos;s copy can double-sign a block you already signed,
            which is slashed and tombstoned - permanently.
          </p>
        </div>
      ) : null}

      {snapshot.note ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          {snapshot.note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The standard restore sequence. Order matters: state is preserved before the
 * data directory goes, and put back before the node is allowed to start.
 */
function restoreScript(url: string, daemon: string, home: string): string {
  return [
    `sudo systemctl stop ${daemon}`,
    ``,
    `# Keep the signing state — this is the step that prevents double-signing.`,
    `cp ${home}/data/priv_validator_state.json ${home}/priv_validator_state.json.backup`,
    ``,
    `rm -rf ${home}/data`,
    `curl -o - -L ${url} | lz4 -dc - | tar -xf - -C ${home}`,
    ``,
    `mv ${home}/priv_validator_state.json.backup ${home}/data/priv_validator_state.json`,
    `sudo systemctl start ${daemon}`,
  ].join("\n");
}

function Detail({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{value ?? "-"}</dd>
    </div>
  );
}
