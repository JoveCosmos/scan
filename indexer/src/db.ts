import { Pool, type PoolClient } from "pg";
import type { ExtractedBlock } from "./extract";

/**
 * Postgres writes.
 *
 * One height is written inside a single transaction that also advances the
 * cursor, so the cursor can never claim a height whose rows are missing. Every
 * statement upserts on its primary key, which makes replaying a height
 * harmless — the property the whole crash-recovery story rests on.
 */

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // The worker is one process doing one height at a time; a large pool would
    // only mask a bug.
    max: 4,
    application_name: "gata-indexer",
  });
}

async function writeBlock(
  client: PoolClient,
  chainId: string,
  data: ExtractedBlock
): Promise<void> {
  const { block, txs, transfers } = data;

  await client.query(
    `INSERT INTO block (chain_id, height, time, proposer_cons, hash, tx_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chain_id, height) DO UPDATE SET
       time = EXCLUDED.time,
       proposer_cons = EXCLUDED.proposer_cons,
       hash = EXCLUDED.hash,
       tx_count = EXCLUDED.tx_count`,
    [
      chainId,
      block.height,
      block.time,
      block.proposerCons,
      block.hash,
      block.txCount,
    ]
  );

  for (const tx of txs) {
    await client.query(
      `INSERT INTO tx (chain_id, hash, height, tx_index, time, code,
                       fee_denom, fee_amount, gas_used, gas_wanted, signer, msg_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (chain_id, hash) DO UPDATE SET
         height = EXCLUDED.height,
         tx_index = EXCLUDED.tx_index,
         time = EXCLUDED.time,
         code = EXCLUDED.code,
         fee_denom = EXCLUDED.fee_denom,
         fee_amount = EXCLUDED.fee_amount,
         gas_used = EXCLUDED.gas_used,
         gas_wanted = EXCLUDED.gas_wanted,
         signer = EXCLUDED.signer,
         msg_types = EXCLUDED.msg_types`,
      [
        chainId,
        tx.hash,
        tx.height,
        tx.txIndex,
        tx.time,
        tx.code,
        tx.feeDenom,
        tx.feeAmount,
        tx.gasUsed,
        tx.gasWanted,
        tx.signer,
        tx.msgTypes,
      ]
    );
  }

  for (const t of transfers) {
    await client.query(
      `INSERT INTO transfer (chain_id, tx_hash, msg_index, coin_index, height,
                             time, kind, from_addr, to_addr, denom, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (chain_id, tx_hash, msg_index, coin_index, kind) DO UPDATE SET
         height = EXCLUDED.height,
         time = EXCLUDED.time,
         from_addr = EXCLUDED.from_addr,
         to_addr = EXCLUDED.to_addr,
         denom = EXCLUDED.denom,
         amount = EXCLUDED.amount`,
      [
        chainId,
        t.txHash,
        t.msgIndex,
        t.coinIndex,
        t.height,
        t.time,
        t.kind,
        t.fromAddr,
        t.toAddr,
        t.denom,
        t.amount,
      ]
    );
  }
}

/**
 * Write a run of consecutive heights and advance the cursor, atomically.
 *
 * The cursor moves to the last height in the batch only if every row committed;
 * a failure rolls the whole batch back and the worker retries from the old
 * cursor.
 */
export async function commitBatch(
  pool: Pool,
  chainId: string,
  blocks: ExtractedBlock[]
): Promise<void> {
  if (blocks.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const b of blocks) await writeBlock(client, chainId, b);

    const last = blocks[blocks.length - 1].block.height;
    await client.query(
      `INSERT INTO indexer_cursor (chain_id, last_height, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (chain_id) DO UPDATE SET
         last_height = GREATEST(indexer_cursor.last_height, EXCLUDED.last_height),
         updated_at = now()`,
      [chainId, last]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Where to resume, or null when this chain has never been indexed. */
export async function readCursor(
  pool: Pool,
  chainId: string
): Promise<number | null> {
  const res = await pool.query<{ last_height: string }>(
    "SELECT last_height FROM indexer_cursor WHERE chain_id = $1",
    [chainId]
  );
  const raw = res.rows[0]?.last_height;
  return raw === undefined ? null : Number(raw);
}
