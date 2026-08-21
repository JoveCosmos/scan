/**
 * Live snapshot index.
 *
 * Heights, sizes, filenames and checksums change every night when the snapshot
 * timers run. Baking them into config/services.json guarantees the panel is
 * wrong within a day and stays wrong until someone edits it by hand — which is
 * exactly what happened: the committed entries advertised a host that does not
 * resolve, an .lz4 extension we never produced, and a height from a snapshot
 * that was never taken.
 *
 * So config/services.json now carries only what is genuinely static (which
 * binary, which home directory, which key in the index), and everything that
 * moves is read from the manifest the publisher regenerates on every run.
 */

const DEFAULT_MANIFEST =
  "https://explorer.gatahub.zone/snapshots/manifest.json";

/** One published archive, as the publisher describes it. */
export type SnapshotEntry = {
  file: string;
  url: string;
  height: string;
  bytes: number;
  size: string;
  sha256: string;
  modified: string;
};

export type SnapshotIndex = Map<string, SnapshotEntry>;

type ManifestShape = {
  generated?: string;
  chains?: Record<string, SnapshotEntry[]>;
};

let cache: { at: number; index: SnapshotIndex } | null = null;

/**
 * Newest entry per chain key.
 *
 * Cached for a minute. The underlying file changes once a day, so this is about
 * not hammering nginx on every render rather than freshness.
 *
 * On any failure this returns an EMPTY index, never a stale one. A panel that
 * says "no snapshot published" is recoverable; a panel confidently showing last
 * week's height sends someone to a URL that 404s after they have already
 * stopped their node.
 */
export async function getSnapshotIndex(): Promise<SnapshotIndex> {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache.index;

  const url = process.env.SNAPSHOT_MANIFEST_URL || DEFAULT_MANIFEST;
  const index: SnapshotIndex = new Map();

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);

    const data = (await res.json()) as ManifestShape;
    for (const [key, entries] of Object.entries(data.chains ?? {})) {
      // The publisher writes newest first, but sort rather than trust it: a
      // wrong "latest" here is a wrong height on the page.
      const newest = [...(entries ?? [])].sort((a, b) =>
        (b.modified ?? "").localeCompare(a.modified ?? "")
      )[0];
      if (newest?.url) index.set(key, newest);
    }
  } catch (err) {
    console.error("snapshot manifest unavailable:", err);
    return index;
  }

  cache = { at: now, index };
  return index;
}
