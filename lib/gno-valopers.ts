import type { ChainConfig } from "@/lib/chains";

/*
 * gno.land has no staking module, so validator identity lives in a realm:
 * gno.land/r/gnops/valopers. It is read with vm/qrender over JSON-RPC and
 * returns markdown, not JSON.
 *
 * The registry is keyed by a validator's *operator* address, while the
 * consensus set (and every block proposer) uses its *signing* address. Only the
 * per-valoper render carries both, so mapping between them means reading every
 * profile once — hence the cached index below.
 */

export interface ValoperProfile {
  moniker: string;
  /** Validator-authored markdown. Rendered as plain text — never as HTML. */
  description: string;
  operatorAddress: string;
  signingAddress: string | null;
  signingPubKey: string | null;
  serverType: string | null;
  profilePath: string | null;
}

const VALOPERS_REALM = "gno.land/r/gnops/valopers";

interface RpcEnvelope {
  result?: { response?: { ResponseBase?: { Data?: string; Error?: unknown } } };
  error?: { data?: string; message?: string };
}

/** Query a realm's Render() over vm/qrender. Returns null on any failure. */
export async function renderRealm(
  chain: ChainConfig,
  fullPath: string,
  timeoutMs = 10_000
): Promise<string | null> {
  const data = Buffer.from(fullPath).toString("base64");

  for (const endpoint of chain.rpcEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "abci_query",
          params: { path: "vm/qrender", data },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;

      const json = (await res.json()) as RpcEnvelope;
      if (json.error) continue;

      const base = json.result?.response?.ResponseBase;
      if (!base || base.Error) continue;

      return Buffer.from(base.Data ?? "", "base64").toString();
    } catch {
      continue;
    }
  }
  return null;
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
  /** Resolved value, once the first build finishes. */
  value: ValoperIndex | null;
  /** In-flight build, if one is running. */
  inflight: Promise<ValoperIndex> | null;
}

const indexCache = new Map<string, CacheEntry>();

const EMPTY_INDEX: ValoperIndex = { bySigning: new Map(), byOperator: new Map() };

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
 * promise. Safe to call repeatedly — concurrent callers share one build.
 */
function ensureIndex(chain: ChainConfig): Promise<ValoperIndex> {
  const entry = indexCache.get(chain.chainId);

  if (entry?.inflight) return entry.inflight;
  if (entry?.value && Date.now() - entry.at < INDEX_TTL_MS) {
    return Promise.resolve(entry.value);
  }

  const inflight = buildIndex(chain)
    .then((index) => {
      indexCache.set(chain.chainId, { at: Date.now(), value: index, inflight: null });
      return index;
    })
    .catch((err) => {
      // Keep any previously good value rather than losing it to a failed refresh.
      const prev = indexCache.get(chain.chainId)?.value ?? null;
      indexCache.set(chain.chainId, { at: 0, value: prev, inflight: null });
      throw err;
    });

  indexCache.set(chain.chainId, {
    at: entry?.at ?? 0,
    value: entry?.value ?? null,
    inflight,
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
 * executions on a cold cache — the node serialises them, so this is ~15s and
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
