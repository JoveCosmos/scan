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
 * Blocks, transactions, transfers, governance votes and slashing events all come
 * out of block contents. Validator stake snapshots do not — bonded stake is
 * module state that never appears in a block — so they are read from the staking
 * API, and only for chains given an LCD alongside their RPC:
 *
 *   INDEXER_CHAINS  atomone-1=http://127.0.0.1:23957|http://127.0.0.1:1317
 *
 * The suffix is optional; without it a chain is indexed exactly as before and
 * simply has no snapshots.
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
      // "chainId=rpc", or "chainId=rpc" plus a pipe and an LCD URL. The pipe
      // is optional, so existing configuration keeps working untouched.
      const urls = entry.slice(at + 1).trim();
      const pipe = urls.indexOf("|");
      return {
        chainId: entry.slice(0, at).trim(),
        rpcUrl: (pipe === -1 ? urls : urls.slice(0, pipe)).trim(),
        lcdUrl: pipe === -1 ? undefined : urls.slice(pipe + 1).trim() || undefined,
        startHeight: Number.isFinite(start) && start > 0 ? start : undefined,
      };
    });
}

function log(msg: string) {
  // Plain stdout: systemd captures it into the journal, same as the app.
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
