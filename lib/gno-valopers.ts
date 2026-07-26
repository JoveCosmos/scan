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
const indexCache = new Map<string, { at: number; index: Promise<ValoperIndex> }>();

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
 * Cached signing/operator index. Building it costs ~95 realm reads, so it is
 * memoised per chain for ten minutes; valoper registrations change rarely.
 */
export function getValoperIndex(chain: ChainConfig): Promise<ValoperIndex> {
  const cached = indexCache.get(chain.chainId);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;

  const index = buildIndex(chain).catch((err) => {
    // Never cache a failed build.
    indexCache.delete(chain.chainId);
    throw err;
  });
  indexCache.set(chain.chainId, { at: Date.now(), index });
  return index;
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

  try {
    const index = await getValoperIndex(chain);
    return index.bySigning.get(address) ?? index.byOperator.get(address) ?? null;
  } catch {
    return null;
  }
}
