import { createHash } from "node:crypto";
import { bech32 } from "bech32";
import type { ChainConfig } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { fetchLcd } from "@/lib/lcd";
import { coverage, poolFor } from "@/lib/indexer-db";

/**
 * AtomOne's PHOTON: the fee token, minted only by burning ATONE (x/photon,
 * MsgMintPhoton) at a rate that falls as PHOTON's supply nears its cap:
 * rate = (cap - PHOTON supply) / ATONE supply.
 *
 * A mint is two transfers in the index: the ATONE from the minter to the
 * photon module account (which burns it), and the PHOTON from that account
 * back. So everything burned and minted is a transfer to or from that one
 * address, and `transfers` covers it from genesis.
 */

export const PHOTON_DENOM = "uphoton";

/**
 * The photon module account: like every module account, the first 20 bytes of
 * sha256 of its name (atone1mdzd4uhfvherp7tf8zqwusfetd6txaseqzfssq on AtomOne).
 */
export function photonModule(chain: ChainConfig): string | null {
  if (!chain.photon) return null;
  const bytes = createHash("sha256").update("photon").digest().subarray(0, 20);
  return bech32.encode(chain.bech32Prefix, bech32.toWords(bytes));
}

export interface PhotonState {
  /** PHOTON per ATONE now. */
  rate: number | null;
  mintDisabled: boolean | null;
  /** Base units. */
  photonSupply: string | null;
  atoneSupply: string | null;
}

export function getPhotonState(chain: ChainConfig): Promise<PhotonState> {
  return cached(
    `photon-state:${chain.chainId}`,
    60_000,
    async () => {
      const [rate, params, photon, atone] = await Promise.allSettled([
        fetchLcd<{ conversion_rate?: string }>(chain, "/atomone/photon/v1/conversion_rate", { cache: "no-store" }),
        fetchLcd<{ params?: { mint_disabled?: boolean } }>(chain, "/atomone/photon/v1/params", { cache: "no-store" }),
        fetchLcd<{ amount?: { amount?: string } }>(chain, "/cosmos/bank/v1beta1/supply/by_denom", {
          cache: "no-store",
          searchParams: { denom: PHOTON_DENOM },
        }),
        fetchLcd<{ amount?: { amount?: string } }>(chain, "/cosmos/bank/v1beta1/supply/by_denom", {
          cache: "no-store",
          searchParams: { denom: chain.denom },
        }),
      ]);
      const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
      const r = Number(ok(rate)?.conversion_rate ?? NaN);
      return {
        rate: Number.isFinite(r) ? r : null,
        mintDisabled: ok(params)?.params?.mint_disabled ?? null,
        photonSupply: ok(photon)?.amount?.amount ?? null,
        atoneSupply: ok(atone)?.amount?.amount ?? null,
      };
    },
    { staleMs: 10 * 60_000 }
  );
}

export interface PhotonMint {
  txHash: string;
  height: number;
  time: string;
  minter: string;
  /** ATONE burned, base units. */
  burned: string;
  /** PHOTON received, base units; null when the index has no matching row. */
  minted: string | null;
}

export interface PhotonHistory {
  /** ATONE burned, all time, base units. */
  burned: string;
  /** PHOTON minted, all time, base units. */
  minted: string;
  mints: number;
  minters: number;
  /** ATONE burned per UTC day, last 90 days, oldest first. */
  daily: { day: string; burned: string; mints: number }[];
  top: { minter: string; burned: string; mints: number }[];
  recent: PhotonMint[];
  /** Covered from this block; 1 means all of history. */
  from: number;
}

export function getPhotonHistory(chain: ChainConfig): Promise<PhotonHistory | null> {
  const pool = poolFor(chain.chainId);
  const moduleAddr = photonModule(chain);
  if (!pool || !moduleAddr) return Promise.resolve(null);
  const chainId = chain.chainId;
  return cached(
    `photon-history:${chainId}`,
    10 * 60_000,
    async () => {
      const c = await coverage(chainId, "transfers");
      if (!c) return null;
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const [burned, minted, daily, top, recent] = await Promise.all([
        pool.query<{ burned: string | null; mints: string; minters: string }>(
          `SELECT sum(amount)::text AS burned, count(*)::text AS mints, count(DISTINCT from_addr)::text AS minters
             FROM transfer
            WHERE chain_id = $1 AND to_addr = $2 AND denom = $3 AND kind = 'transfer'`,
          [chainId, moduleAddr, chain.denom]
        ),
        pool.query<{ minted: string | null }>(
          `SELECT sum(amount)::text AS minted FROM transfer
            WHERE chain_id = $1 AND from_addr = $2 AND denom = $3 AND kind = 'transfer'`,
          [chainId, moduleAddr, PHOTON_DENOM]
        ),
        pool.query<{ day: string; burned: string; mints: string }>(
          `SELECT to_char(date_trunc('day', time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                  sum(amount)::text AS burned, count(*)::text AS mints
             FROM transfer
            WHERE chain_id = $1 AND to_addr = $2 AND denom = $3 AND kind = 'transfer' AND time >= $4
            GROUP BY 1 ORDER BY 1`,
          [chainId, moduleAddr, chain.denom, since]
        ),
        pool.query<{ minter: string; burned: string; mints: string }>(
          `SELECT from_addr AS minter, sum(amount)::text AS burned, count(*)::text AS mints
             FROM transfer
            WHERE chain_id = $1 AND to_addr = $2 AND denom = $3 AND kind = 'transfer' AND from_addr IS NOT NULL
            GROUP BY from_addr
            ORDER BY sum(amount) DESC
            LIMIT 25`,
          [chainId, moduleAddr, chain.denom]
        ),
        pool.query<{ tx_hash: string; height: string; time: string; minter: string; burned: string }>(
          `SELECT tx_hash, height::text, time::text, from_addr AS minter, amount::text AS burned
             FROM transfer
            WHERE chain_id = $1 AND to_addr = $2 AND denom = $3 AND kind = 'transfer'
            ORDER BY transfer.height DESC
            LIMIT 100`,
          [chainId, moduleAddr, chain.denom]
        ),
      ]);
      const hashes = recent.rows.map((r) => r.tx_hash);
      const received = hashes.length
        ? await pool.query<{ tx_hash: string; minted: string }>(
            `SELECT tx_hash, sum(amount)::text AS minted FROM transfer
              WHERE chain_id = $1 AND from_addr = $2 AND denom = $3 AND tx_hash = ANY($4::text[])
              GROUP BY tx_hash`,
            [chainId, moduleAddr, PHOTON_DENOM, hashes]
          )
        : { rows: [] };
      const mintedBy = new Map(received.rows.map((r) => [r.tx_hash, r.minted]));
      const b = burned.rows[0];
      return {
        burned: b?.burned ?? "0",
        minted: minted.rows[0]?.minted ?? "0",
        mints: Number(b?.mints ?? 0),
        minters: Number(b?.minters ?? 0),
        daily: daily.rows.map((r) => ({ day: r.day, burned: r.burned, mints: Number(r.mints) })),
        top: top.rows.map((r) => ({ minter: r.minter, burned: r.burned, mints: Number(r.mints) })),
        recent: recent.rows.map((r) => ({
          txHash: r.tx_hash,
          height: Number(r.height),
          time: r.time,
          minter: r.minter,
          burned: r.burned,
          minted: mintedBy.get(r.tx_hash) ?? null,
        })),
        from: c.lowest,
      };
    },
    { staleMs: 60 * 60_000 }
  ).catch(() => null);
}
