import { cached } from "@/lib/cache";

/**
 * The newest published release of a chain's node software.
 *
 * `node_info` reports the version of whichever public node answered, which is
 * not the same thing as the current release — AtomOne's public endpoints ran
 * v4.0.1 for weeks after v4.1.0 shipped, because it needed no coordinated
 * upgrade. Showing only the node's version quietly understates the chain.
 *
 * Cached for six hours: releases are rare, and the unauthenticated GitHub API
 * allows only 60 requests an hour per IP.
 */

export interface Release {
  /** Tag as published, e.g. "v4.1.0". */
  tag: string;
  publishedAt: string | null;
  url: string;
}

/** "https://github.com/atomone-hub/atomone" -> "atomone-hub/atomone". */
function repoPath(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

export async function getLatestRelease(
  repoUrl: string | undefined
): Promise<Release | null> {
  if (!repoUrl) return null;
  const path = repoPath(repoUrl);
  if (!path) return null;

  // Throws inside the cache callback so a failure is not stored as a good
  // value — the same trap that blanked the price for five minutes.
  try {
    return await cached(`release:${path}`, 21_600_000, async () => {
      const res = await fetch(
        `https://api.github.com/repos/${path}/releases?per_page=10`,
        {
          cache: "no-store",
          headers: { accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) throw new Error(`github responded ${res.status}`);

      const list = (await res.json()) as {
        tag_name?: string;
        published_at?: string;
        html_url?: string;
        prerelease?: boolean;
        draft?: boolean;
      }[];

      // Release candidates and testnet builds are not what a chain runs.
      const stable = list.find((r) => !r.prerelease && !r.draft && r.tag_name);
      if (!stable?.tag_name) throw new Error("no stable release");

      return {
        tag: stable.tag_name,
        publishedAt: stable.published_at ?? null,
        url: stable.html_url ?? `${repoUrl}/releases`,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Whether the running version differs from the latest release.
 *
 * A plain string comparison on purpose: semver ordering would invite guessing
 * at tag formats that vary between chains, and "differs" is all the UI claims.
 */
export function isBehind(
  running: string | null,
  latest: string | null
): boolean {
  if (!running || !latest) return false;
  const norm = (v: string) => v.trim().replace(/^v/, "");
  return norm(running) !== norm(latest);
}
