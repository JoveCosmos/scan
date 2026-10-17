import { bech32 } from "bech32";
import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";
import { hashedAddress } from "@/lib/hashed-address";

/**
 * What an address is, beyond "an account".
 *
 * A module account, an IBC escrow, a CosmWasm contract and a vesting account
 * all render as the same bare page otherwise - the distribution module read as
 * someone's wallet, an escrow holding a hundred denoms read as an airdrop
 * farmer. The auth record says most of it; the rest is derived.
 */

export interface Coin {
  denom: string;
  amount: string;
}

export type AddressKind =
  | { kind: "user" }
  | { kind: "module"; name: string; permissions: string[] }
  | {
      kind: "vesting";
      /** "Continuous", "Delayed", "Periodic", "Permanent locked". */
      schedule: string;
      original: Coin[];
      delegatedVesting: Coin[];
      startTime: string | null;
      endTime: string | null;
      periods: { seconds: number; amount: Coin[] }[];
    }
  | { kind: "escrow"; channel: string }
  | {
      kind: "contract";
      codeId: string | null;
      creator: string | null;
      admin: string | null;
      label: string | null;
      cw20: { name: string; symbol: string; decimals: number; totalSupply: string } | null;
    }
  | { kind: "ica"; owner: string | null };

/** The fields every auth record variant nests somewhere different. */
export interface AuthFacts {
  type: string | null;
  accountNumber: string | null;
  sequence: string | null;
  hasPubKey: boolean;
  kind: AddressKind | null;
}

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const asStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const asCoins = (v: unknown): Coin[] =>
  Array.isArray(v)
    ? v.flatMap((c) => {
        const o = asObj(c);
        const denom = asStr(o?.denom);
        const amount = asStr(o?.amount);
        return denom && amount ? [{ denom, amount }] : [];
      })
    : [];

const unixToIso = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/**
 * Account number and sequence live on `base_account` for a module account,
 * on `base_vesting_account.base_account` for vesting, and at the top for a
 * plain one. Reading only the top level showed "-" for every module.
 */
export function parseAuthAccount(account: unknown): AuthFacts {
  const top = asObj(account);
  if (!top) return { type: null, accountNumber: null, sequence: null, hasPubKey: false, kind: null };

  const type = asStr(top["@type"]);
  const vesting = asObj(top.base_vesting_account);
  const base = asObj(top.base_account) ?? asObj(vesting?.base_account) ?? top;

  let kind: AddressKind | null = null;
  if (type?.endsWith("ModuleAccount")) {
    kind = {
      kind: "module",
      name: asStr(top.name) ?? "module",
      permissions: Array.isArray(top.permissions)
        ? top.permissions.filter((p): p is string => typeof p === "string")
        : [],
    };
  } else if (vesting) {
    const schedule = type?.match(/(Continuous|Delayed|Periodic|PermanentLocked)VestingAccount|PermanentLockedAccount/)?.[0] ?? "";
    const periods = Array.isArray(top.vesting_periods)
      ? top.vesting_periods.map((p) => {
          const o = asObj(p);
          return { seconds: Number(o?.length ?? 0), amount: asCoins(o?.amount) };
        })
      : [];
    kind = {
      kind: "vesting",
      schedule: schedule.startsWith("Continuous")
        ? "Continuous"
        : schedule.startsWith("Delayed")
          ? "Delayed"
          : schedule.startsWith("Periodic")
            ? "Periodic"
            : schedule
              ? "Permanent locked"
              : "Vesting",
      original: asCoins(vesting.original_vesting),
      delegatedVesting: asCoins(vesting.delegated_vesting),
      startTime: unixToIso(top.start_time),
      endTime: unixToIso(vesting.end_time),
      periods,
    };
  } else if (type?.includes("InterchainAccount")) {
    kind = { kind: "ica", owner: asStr(top.account_owner) };
  }

  return {
    type,
    accountNumber: asStr(base.account_number),
    sequence: asStr(base.sequence),
    hasPubKey: !!base.pub_key,
    kind,
  };
}

/** Bytes behind a bech32 address: 20 for a key, 32 for a contract or ICA. */
export function payloadLength(address: string): number | null {
  try {
    return bech32.fromWords(bech32.decode(address.toLowerCase(), 128).words).length;
  } catch {
    return null;
  }
}

/**
 * Whether the same key means the same owner on other chains. True only for a
 * 20-byte payload: contracts, modules and escrows are chain-local, and their
 * "counterparts" elsewhere belong to nobody.
 */
export function isUserKey(address: string, kind: AddressKind | null): boolean {
  if (kind && kind.kind !== "user" && kind.kind !== "vesting") return false;
  return payloadLength(address) === 20;
}

const ESCROW_CHANNELS = 5000;
const escrowIndex = new Map<string, Map<string, string>>();

/**
 * ICS-20 escrow address for transfer/channel-N: the first 20 bytes of
 * sha256("ics20-1" ‖ 0x00 ‖ "transfer/channel-N"). Not reversible, so the
 * first few thousand channel ids are hashed once per prefix and looked up.
 */
export function escrowAddress(prefix: string, channel: string): string {
  return hashedAddress(prefix, Buffer.concat([Buffer.from("ics20-1"), Buffer.from([0]), Buffer.from(`transfer/${channel}`)]));
}

export function escrowChannel(address: string, prefix: string): string | null {
  let index = escrowIndex.get(prefix);
  if (!index) {
    index = new Map();
    for (let n = 0; n < ESCROW_CHANNELS; n++) {
      const channel = `channel-${n}`;
      index.set(escrowAddress(prefix, channel), channel);
    }
    escrowIndex.set(prefix, index);
  }
  return index.get(address.toLowerCase()) ?? null;
}

interface ContractInfoResponse {
  contract_info?: { code_id?: string; creator?: string; admin?: string; label?: string };
}
interface SmartResponse {
  data?: { name?: string; symbol?: string; decimals?: number; total_supply?: string };
}

/** CosmWasm contract info plus CW20 token info where the contract is one. */
async function contractKind(
  chain: ChainConfig,
  address: string
): Promise<AddressKind | null> {
  return cached(`contract:${chain.chainId}:${address}`, 3_600_000, async () => {
    let info: ContractInfoResponse;
    try {
      info = await fetchLcd<ContractInfoResponse>(chain, `/cosmwasm/wasm/v1/contract/${address}`, {
        cache: "no-store",
        timeoutMs: 6000,
        deadlineMs: 9000,
      });
    } catch {
      return null;
    }
    if (!info.contract_info) return null;

    let cw20: Extract<AddressKind, { kind: "contract" }>["cw20"] = null;
    try {
      const query = Buffer.from(JSON.stringify({ token_info: {} })).toString("base64");
      const res = await fetchLcd<SmartResponse>(
        chain,
        `/cosmwasm/wasm/v1/contract/${address}/smart/${query}`,
        { cache: "no-store", timeoutMs: 5000, deadlineMs: 7000 }
      );
      const d = res.data;
      if (d?.symbol && typeof d.decimals === "number") {
        cw20 = {
          name: d.name ?? d.symbol,
          symbol: d.symbol,
          decimals: d.decimals,
          totalSupply: d.total_supply ?? "0",
        };
      }
    } catch {
      // Not a CW20, or the query is disabled: the contract panel stands alone.
    }

    return {
      kind: "contract",
      codeId: info.contract_info.code_id ?? null,
      creator: info.contract_info.creator ?? null,
      admin: info.contract_info.admin || null,
      label: info.contract_info.label || null,
      cw20,
    };
  });
}

/**
 * The kind of an address, from its auth record and its bytes. Escrows are
 * plain base accounts with no key; contracts have a 32-byte payload.
 */
export async function resolveAddressKind(
  chain: ChainConfig,
  address: string,
  auth: AuthFacts | null
): Promise<AddressKind> {
  if (auth?.kind) return auth.kind;

  const length = payloadLength(address);
  if (length === 32) {
    const contract = await contractKind(chain, address);
    if (contract) return contract;
  }
  if (length === 20 && !auth?.hasPubKey) {
    const channel = escrowChannel(address, chain.bech32Prefix);
    if (channel) return { kind: "escrow", channel };
  }
  return { kind: "user" };
}
