import fs from "node:fs/promises";
import path from "node:path";
import type { ChainConfig } from "@/lib/chains";
import { abciQuery } from "@/lib/gno-abci";

/*
 * gno.land has no staking module, so validator identity lives in a realm:
 * gno.land/r/gnops/valopers. It is read with vm/qrender over JSON-RPC and
 * returns markdown, not JSON.
 *
 * The registry is keyed by a validator's *operator* address, while the
 * consensus set (and every block proposer) uses its *signing* address. Only the
 * per-valoper render carries both, so mapping between them means reading every
 * profile once - hence the cached index below.
 */

export interface ValoperProfile {
  moniker: string;
  /** Validator-authored markdown. Rendered as plain text - never as HTML. */
  description: string;
  operatorAddress: string;
  signingAddress: string | null;
  signingPubKey: string | null;
  serverType: string | null;
  profilePath: string | null;
}

const VALOPERS_REALM = "gno.land/r/gnops/valopers";

/** Query a realm's Render() over vm/qrender. Returns null on any failure. */
export async function renderRealm(
  chain: ChainConfig,
  fullPath: string,
  timeoutMs = 10_000
): Promise<string | null> {
  const res = await abciQuery(chain, "vm/qrender", fullPath, timeoutMs);
  return res.ok ? res.data : null;
}

/** The realm answers with this literal string rather than an error. */
function isUnknownAddress(text: string): boolean {
  return /^\s*unknown address\b/i.test(text);
}

export function parseValoperList(
  markdown: string
): { moniker: string; operatorAddress: string }[] {
  const rows = [
    ...markdown.matchAll(
      /^\s*\*\s*\[([^\]]+)\]\(\/r\/gnops\/valopers:(g1[a-z0-9]+)\)/gm
    ),
  ];
  return rows.map((m) => ({ moniker: m[1].trim(), operatorAddress: m[2] }));
}

/**
 * Individual renders end with a fixed "- Key: value" trailer after the
 * validator's free-form markdown, which is what we read the addresses from.
 */
export function parseValoperDetail(
  markdown: string,
  operatorAddress: string
): ValoperProfile | null {
  if (!markdown || isUnknownAddress(markdown)) return null;

  const field = (label: string): string | null => {
    const m = markdown.match(
      new RegExp(`^-\\s*${label}:\\s*(.+)$`, "im")
    );
    return m ? m[1].trim() : null;
  };

  const monikerMatch = markdown.match(/^##\s+(.+)$/m);
  const profileMatch = markdown.match(/\[Profile link\]\(([^)]+)\)/);

  // Body is everything before the trailing metadata block, minus the
  // "Valoper's details:" preamble and the duplicated "## Moniker" heading.
  const trailerAt = markdown.search(/^-\s*Operator Address:/im);
  let description = trailerAt > 0 ? markdown.slice(0, trailerAt) : markdown;
  description = description
    .replace(/^Valoper's details:\s*/i, "")
    .replace(/^##\s+.+$/m, "")
    .trim();

  return {
    moniker: monikerMatch ? monikerMatch[1].trim() : operatorAddress,
    description,
    operatorAddress: field("Operator Address") ?? operatorAddress,
    signingAddress: field("Signing Address"),
    signingPubKey: field("Signing PubKey"),
    serverType: field("Server Type"),
    profilePath: profileMatch ? profileMatch[1] : null,
  };
}

export async function getValoperByOperator(
  chain: ChainConfig,
  operatorAddress: string
): Promise<ValoperProfile | null> {
  const text = await renderRealm(chain, `${VALOPERS_REALM}:${operatorAddress}`);
  if (!text) return null;
  return parseValoperDetail(text, operatorAddress);
}

interface ValoperIndex {
  /** signing address -> profile */
  bySigning: Map<string, ValoperProfile>;
  byOperator: Map<string, ValoperProfile>;
}

const INDEX_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  at: number;
  /** Resolved value, once the first build finishes or the disk copy loads. */
  value: ValoperIndex | null;
  /** In-flight build, if one is running. */
  inflight: Promise<ValoperIndex> | null;
  /** Whether the on-disk copy has already been consulted this process. */
  hydrated?: boolean;
}

/*
 * Held on globalThis, not in module scope: instrumentation.ts is bundled
 * separately from route handlers, so a module-level Map would give the startup
 * warm its own copy and every request would still see a cold cache.
 */
const CACHE_KEY = Symbol.for("gata.valoperIndexCache");

const globalCache = globalThis as typeof globalThis & {
  [CACHE_KEY]?: Map<string, CacheEntry>;
};

const indexCache: Map<string, CacheEntry> = (globalCache[CACHE_KEY] ??= new Map());

const EMPTY_INDEX: ValoperIndex = { bySigning: new Map(), byOperator: new Map() };

/*
 * Disk persistence.
 *
 * Rebuilding costs ~25s of serialised realm execution, which the node cannot be
 * made to do faster. Persisting means only the very first run on a machine pays
 * it - every later restart, including a rebuild that wipes .next, starts warm.
 *
 * Registrations change rarely, so a stale file is still far better than falling
 * back to raw addresses; it is served immediately and refreshed in the
 * background. Beyond MAX_DISK_AGE_MS it is ignored entirely.
 */
const CACHE_DIR =
  process.env.VALOPER_CACHE_DIR ?? path.join(process.cwd(), ".cache", "valopers");
const MAX_DISK_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DISK_VERSION = 1;

interface DiskPayload {
  version: number;
  chainId: string;
  at: number;
  profiles: ValoperProfile[];
}

function cacheFile(chainId: string): string {
  // chainIds come from local config, but keep the path from escaping the dir.
  return path.join(CACHE_DIR, `${chainId.replace(/[^\w.-]/g, "_")}.json`);
}

function indexFromProfiles(profiles: ValoperProfile[]): ValoperIndex {
  const bySigning = new Map<string, ValoperProfile>();
  const byOperator = new Map<string, ValoperProfile>();
  for (const profile of profiles) {
    byOperator.set(profile.operatorAddress, profile);
    if (profile.signingAddress) bySigning.set(profile.signingAddress, profile);
  }
  return { bySigning, byOperator };
}

async function readDisk(
  chainId: string
): Promise<{ at: number; index: ValoperIndex } | null> {
  try {
    const raw = await fs.readFile(cacheFile(chainId), "utf-8");
    const payload = JSON.parse(raw) as DiskPayload;

    if (payload.version !== DISK_VERSION) return null;
    if (payload.chainId !== chainId) return null;
    if (!Array.isArray(payload.profiles) || payload.profiles.length === 0) return null;
    if (Date.now() - payload.at > MAX_DISK_AGE_MS) return null;

    return { at: payload.at, index: indexFromProfiles(payload.profiles) };
  } catch {
    // Missing or unreadable cache is normal - just rebuild.
    return null;
  }
}

async function writeDisk(chainId: string, index: ValoperIndex): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const payload: DiskPayload = {
      version: DISK_VERSION,
      chainId,
      at: Date.now(),
      profiles: [...index.byOperator.values()],
    };
    // Write-then-rename so a crash mid-write cannot leave a truncated file that
    // a later boot would read as valid.
    const target = cacheFile(chainId);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(payload), "utf-8");
    await fs.rename(temp, target);
  } catch (err) {
    console.warn(
      `[valopers] could not persist index for ${chainId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/** Populate memory from disk once per process, before deciding to rebuild. */
async function hydrate(chain: ChainConfig): Promise<ValoperIndex | null> {
  const entry = indexCache.get(chain.chainId);
  if (entry?.value) return entry.value;
  if (entry?.hydrated) return null;

  const fromDisk = await readDisk(chain.chainId);
  const current = indexCache.get(chain.chainId);
  if (current?.value) return current.value;

  indexCache.set(chain.chainId, {
    at: fromDisk?.at ?? 0,
    value: fromDisk?.index ?? null,
    inflight: current?.inflight ?? null,
    hydrated: true,
  });

  if (fromDisk) {
    console.log(
      `[valopers] loaded ${fromDisk.index.byOperator.size} profiles for ${chain.chainId} from disk`
    );
  }
  return fromDisk?.index ?? null;
}

async function buildIndex(chain: ChainConfig): Promise<ValoperIndex> {
  const entries: { moniker: string; operatorAddress: string }[] = [];

  // The list is paginated; stop as soon as a page yields nothing.
  for (let page = 1; page <= 20; page++) {
    const suffix = page > 1 ? `?page=${page}` : "";
    const text = await renderRealm(chain, `${VALOPERS_REALM}:${suffix}`);
    if (!text) break;
    const rows = parseValoperList(text);
    if (rows.length === 0) break;
    entries.push(...rows);
  }

  const bySigning = new Map<string, ValoperProfile>();
  const byOperator = new Map<string, ValoperProfile>();

  // Batched rather than all-at-once so a cold build cannot open ~100 sockets
  // against a single public node.
  const BATCH = 20;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const profiles = await Promise.all(
      batch.map((e) => getValoperByOperator(chain, e.operatorAddress))
    );
    for (const profile of profiles) {
      if (!profile) continue;
      byOperator.set(profile.operatorAddress, profile);
      if (profile.signingAddress) bySigning.set(profile.signingAddress, profile);
    }
  }

  return { bySigning, byOperator };
}

/**
 * Kick off a build if none is cached or the cache is stale. Returns the in-flight
 * promise. Safe to call repeatedly - concurrent callers share one build.
 */
async function ensureIndex(chain: ChainConfig): Promise<ValoperIndex> {
  // Consult disk before deciding to rebuild, so a restart does not pay the
  // ~25s cost again.
  await hydrate(chain);

  const entry = indexCache.get(chain.chainId);

  if (entry?.inflight) return entry.inflight;
  if (entry?.value && Date.now() - entry.at < INDEX_TTL_MS) {
    return entry.value;
  }

  const inflight = buildIndex(chain)
    .then(async (index) => {
      indexCache.set(chain.chainId, {
        at: Date.now(),
        value: index,
        inflight: null,
        hydrated: true,
      });
      await writeDisk(chain.chainId, index);
      return index;
    })
    .catch((err) => {
      // Keep any previously good value - including one loaded from disk -
      // rather than losing it to a failed refresh.
      const prev = indexCache.get(chain.chainId);
      indexCache.set(chain.chainId, {
        at: prev?.value ? prev.at : 0,
        value: prev?.value ?? null,
        inflight: null,
        hydrated: true,
      });
      throw err;
    });

  indexCache.set(chain.chainId, {
    at: entry?.at ?? 0,
    value: entry?.value ?? null,
    inflight,
    hydrated: true,
  });
  return inflight;
}

/**
 * Start (or refresh) the index without waiting for it. Called on any gno read so
 * that by the time someone opens the validator list the cache is usually warm.
 */
export function prewarmValoperIndex(chain: ChainConfig): void {
  if (chain.kind !== "gno") return;
  void ensureIndex(chain).catch(() => {});
}

/**
 * The signing/operator index, awaited to completion. Costs ~95 sequential realm
 * executions on a cold cache - the node serialises them, so this is ~15s and
 * cannot be parallelised away. Prefer getValoperIndexNow() on request paths.
 */
export function getValoperIndex(chain: ChainConfig): Promise<ValoperIndex> {
  return ensureIndex(chain);
}

/**
 * Best-effort index for request paths: returns whatever is cached (even if
 * stale) and otherwise waits only a short budget before giving up, leaving the
 * build running for the next request. Never blocks a page for ~15s.
 */
export async function getValoperIndexNow(
  chain: ChainConfig,
  budgetMs = 1500
): Promise<ValoperIndex> {
  // Reading the persisted copy takes milliseconds, so do it before deciding
  // whether to wait on a rebuild.
  await hydrate(chain);
  const entry = indexCache.get(chain.chainId);

  // Serve stale immediately, refreshing in the background.
  if (entry?.value) {
    if (Date.now() - entry.at >= INDEX_TTL_MS) prewarmValoperIndex(chain);
    return entry.value;
  }

  const build = ensureIndex(chain).catch(() => EMPTY_INDEX);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<ValoperIndex>((resolve) => {
    timer = setTimeout(() => resolve(EMPTY_INDEX), budgetMs);
  });

  try {
    return await Promise.race([build, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve a profile from either address form. An operator address hits the
 * realm directly; a signing address needs the index.
 */
export async function getValoper(
  chain: ChainConfig,
  address: string
): Promise<ValoperProfile | null> {
  const direct = await getValoperByOperator(chain, address);
  if (direct) return direct;

  // Only a signing address needs the reverse index. This runs inside a streamed
  // Suspense boundary, so it may wait for a full build.
  try {
    const index = await getValoperIndex(chain);
    return index.bySigning.get(address) ?? index.byOperator.get(address) ?? null;
  } catch {
    return null;
  }
}
