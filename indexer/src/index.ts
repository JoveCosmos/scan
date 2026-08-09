import { createPool } from "./db";
import { runChain, type ChainTarget } from "./worker";

/**
 * Indexer entry point.
 *
 * Configured entirely by environment so the same binary serves every chain and
 * nothing secret lands in the repo:
 *
 *   DATABASE_URL       postgres://user:pass@127.0.0.1:5432/gata_indexer
 *   INDEXER_CHAINS     atomone-1=http://127.0.0.1:26657,cosmoshub-4=http://…
 *   INDEXER_START      optional height to start from on a fresh cursor
 *
 * Phase 1 indexes blocks, transactions and transfers. Votes, slash events and
 * validator snapshots follow in later phases — see docs/INDEXER.md.
 */

function parseTargets(raw: string | undefined): ChainTarget[] {
  if (!raw) return [];
  const start = Number(process.env.INDEXER_START);

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("=");
      if (at === -1) {
        throw new Error(`INDEXER_CHAINS entry needs chainId=url: "${entry}"`);
      }
      return {
        chainId: entry.slice(0, at).trim(),
        rpcUrl: entry.slice(at + 1).trim(),
        startHeight: Number.isFinite(start) && start > 0 ? start : undefined,
      };
    });
}

function log(msg: string) {
  // Plain stdout: systemd captures it into the journal, same as the explorer.
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const targets = parseTargets(process.env.INDEXER_CHAINS);
  if (targets.length === 0) throw new Error("INDEXER_CHAINS is required");

  const pool = createPool(url);
  const controller = new AbortController();

  // Finish the height in flight, then exit — the cursor only advances on a
  // committed batch, so an interrupted run resumes cleanly either way.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received, stopping`);
      controller.abort();
    });
  }

  log(`indexing ${targets.map((t) => t.chainId).join(", ")}`);

  await Promise.all(
    targets.map((t) => runChain(pool, t, { log }, controller.signal))
  );

  await pool.end();
  log("stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
