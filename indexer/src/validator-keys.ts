import type { Pool } from "pg";
import { consAddressOf, valconsOf } from "./extract";

/**
 * Operator <-> consensus address for every validator the staking API knows.
 *
 * validator_key is filled from MsgCreateValidator as blocks are extracted, but a
 * validator created at genesis never sends one, and a descending refill meets a
 * validator's unjails long before its creation. The staking API lists every
 * validator still in state, bonded or not, with its consensus key: one read
 * seeds the table before a refill, so unjails resolve as they are written.
 */

interface LcdValidator {
  operator_address?: string;
  consensus_pubkey?: { "@type"?: string; key?: string };
}

export async function bootstrapKeys(pool: Pool, chainId: string, lcdUrl: string): Promise<number> {
  const rows: { operator: string; hex: string; valcons: string }[] = [];
  let key: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ "pagination.limit": "500" });
    if (key) q.set("pagination.key", key);
    const res = await fetch(`${lcdUrl.replace(/\/$/, "")}/cosmos/staking/v1beta1/validators?${q}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`validators responded ${res.status}`);
    const body = (await res.json()) as { validators?: LcdValidator[]; pagination?: { next_key?: string | null } };
    for (const v of body.validators ?? []) {
      const pk = v.consensus_pubkey;
      if (!v.operator_address || !pk?.key || !/ed25519/i.test(pk["@type"] ?? "")) continue;
      const hex = consAddressOf(Buffer.from(pk.key, "base64"));
      const valcons = valconsOf(hex, v.operator_address);
      if (valcons) rows.push({ operator: v.operator_address, hex, valcons });
    }
    key = body.pagination?.next_key ?? undefined;
    if (!key) break;
  }
  if (rows.length === 0) return 0;
  await pool.query(
    `INSERT INTO validator_key (chain_id, operator, cons_hex, cons_valcons, first_height)
     SELECT $1::text, t.operator, t.hex, t.valcons, NULL
       FROM unnest($2::text[], $3::text[], $4::text[]) AS t(operator, hex, valcons)
     ON CONFLICT (chain_id, operator) DO UPDATE SET
       cons_hex = EXCLUDED.cons_hex, cons_valcons = EXCLUDED.cons_valcons`,
    [chainId, rows.map((r) => r.operator), rows.map((r) => r.hex), rows.map((r) => r.valcons)]
  );
  return rows.length;
}
