import type { ChainConfig } from "@/lib/chains";
import { chainDenoms, getAllChains, symbolFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { policyFor } from "@/lib/tiers";
import { formatCoin, formatCoins } from "@/lib/coin";
import { formatToken } from "@/lib/overview";
import { proposerIndex } from "@/lib/uptime";
import { timeAgo, truncateMiddle } from "@/lib/format";
import type { ChainAdapter } from "@/lib/adapter";

/**
 * The console's query layer.
 *
 * A line of text in, a rendered result out. Parsing and execution both live on
 * the server for one reason: the set of commands a chain answers depends on its
 * capabilities and its tier policy, and neither belongs in a client bundle —
 * `lib/tiers.ts` is policy we do not publish, and the adapter reaches `node:fs`.
 * The client posts a string and renders whatever comes back, so it stays a
 * dumb terminal in the literal sense.
 *
 * Results are a *list* of blocks rather than one, because the useful answers are
 * compound: `tx <hash>` is a field list and a message table, and splitting that
 * into two commands would be worse than the page it replaces.
 */

export interface Cell {
  v: string;
  /** Makes the cell a link. Relative to the site root. */
  href?: string;
  mono?: boolean;
  dim?: boolean;
  align?: "right";
  /** Semantic tint, resolved to a colour by the renderer. */
  tone?: "ok" | "bad" | "accent";
}

export interface Column {
  label: string;
  align?: "right";
  /** Dropped first when the viewport is narrow. */
  optional?: boolean;
}

export type ResultBlock =
  | { kind: "table"; title?: string; columns: Column[]; rows: Cell[][]; note?: string }
  | { kind: "fields"; title?: string; fields: { label: string; value: Cell }[] }
  | { kind: "text"; lines: string[]; title?: string }
  | { kind: "error"; message: string; hint?: string };

export interface ConsoleResult {
  blocks: ResultBlock[];
  /** Set when the command asks the client to navigate instead of print. */
  nav?: string;
}

const text = (v: string, extra: Partial<Cell> = {}): Cell => ({ v, ...extra });
const mono = (v: string, extra: Partial<Cell> = {}): Cell => ({ v, mono: true, ...extra });
const dim = (v: string): Cell => ({ v, dim: true });
const err = (message: string, hint?: string): ConsoleResult => ({
  blocks: [{ kind: "error", message, hint }],
});

/** Commands, their arguments, and one line of help each. */
const HELP: { name: string; args: string; help: string }[] = [
  { name: "help", args: "", help: "this list" },
  { name: "head", args: "", help: "chain head — height, block time, validators" },
  { name: "blocks", args: "[n]", help: "most recent blocks" },
  { name: "block", args: "<height>", help: "one block and the transactions in it" },
  { name: "txs", args: "[n]", help: "most recent transactions" },
  { name: "tx", args: "<hash>", help: "one transaction and its messages" },
  { name: "validators", args: "[n] [find=str]", help: "the active set, ranked" },
  { name: "validator", args: "<address|moniker>", help: "one validator" },
  { name: "account", args: "<address>", help: "balances and staking for an address" },
  { name: "proposals", args: "[n]", help: "governance proposals" },
  { name: "proposal", args: "<id>", help: "one proposal and its tally" },
  { name: "params", args: "", help: "chain parameters" },
  { name: "chains", args: "", help: "every chain this explorer carries" },
  { name: "open", args: "<path>", help: "leave the console for a normal page" },
  { name: "clear", args: "", help: "empty the scrollback" },
];

export const COMMAND_NAMES = HELP.map((h) => h.name);

/**
 * Split a line into a command, positional arguments and `key=value` flags.
 * Quotes are honoured so a moniker with a space survives as one argument.
 *
 * Exported for tests: everything else in this module needs a live chain, and
 * the parsing is the part that has to hold for input nobody anticipated.
 */
export function parseCommand(line: string): {
  cmd: string;
  args: string[];
  flags: Map<string, string>;
} {
  const tokens = line.match(/"[^"]*"|\S+/g) ?? [];
  const bare = tokens.map((t) => t.replace(/^"|"$/g, ""));
  const cmd = (bare.shift() ?? "").toLowerCase();
  const args: string[] = [];
  const flags = new Map<string, string>();
  for (const token of bare) {
    const eq = token.indexOf("=");
    if (eq > 0) flags.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1));
    else args.push(token);
  }
  return { cmd, args, flags };
}

/** A positional count argument, clamped so one typo cannot ask for 10,000 rows. */
export function limitFrom(args: string[], fallback: number, max: number): number {
  const raw = args.find((a) => /^\d+$/.test(a));
  if (!raw) return fallback;
  return Math.max(1, Math.min(max, Number(raw)));
}

/**
 * Proposer names for a page of blocks, from the adapter's 30s-cached validator
 * set. Empty when that set is unreachable — naming proposers is a nicety, and
 * the block list is still the answer without it.
 */
async function proposerNames(chain: ChainConfig, adapter: ChainAdapter) {
  try {
    return proposerIndex(await adapter.getValidators(), chain.bech32Prefix);
  } catch {
    return new Map<string, { moniker: string; operator: string }>();
  }
}

function statusCell(code: number | null): Cell {
  if (code === null) return dim("—");
  return code === 0
    ? { v: "ok", tone: "ok", mono: true }
    : { v: `fail ${code}`, tone: "bad", mono: true };
}

export async function runCommand(
  chain: ChainConfig,
  line: string
): Promise<ConsoleResult> {
  const { cmd, args, flags } = parseCommand(line.trim());
  if (!cmd) return { blocks: [] };

  const adapter = getAdapter(chain);
  const caps = adapter.capabilities;
  const policy = policyFor(chain);
  const denoms = chainDenoms(chain);
  const base = `/${chain.chainId}`;

  switch (cmd) {
    case "help":
    case "?":
      return {
        blocks: [
          {
            kind: "table",
            title: "Commands",
            columns: [{ label: "" }, { label: "" }, { label: "" }],
            rows: HELP.map((h) => [
              mono(h.name, { tone: "accent" }),
              mono(h.args || "", { dim: true }),
              text(h.help),
            ]),
            note: "↑ ↓ history · Tab completes · Ctrl+L clears · Esc leaves the input",
          },
        ],
      };

    case "clear":
      // Handled entirely by the client; the server answers so the parser has
      // one place that knows every command name.
      return { blocks: [] };

    case "open": {
      const path = args[0];
      if (!path) return err("open needs a path", "try: open /validators");
      return { blocks: [], nav: path.startsWith("/") ? path : `${base}/${path}` };
    }

    case "chains": {
      const all = getAllChains();
      return {
        blocks: [
          {
            kind: "table",
            title: `${all.length} chains`,
            columns: [
              { label: "Chain" },
              { label: "Network ID" },
              { label: "Token" },
              { label: "Type", optional: true },
            ],
            rows: all.map((c) => [
              { v: c.prettyName, href: `/${c.chainId}/console`, tone: "accent" },
              mono(c.chainId, { dim: true }),
              mono(symbolFor(c)),
              dim(c.network),
            ]),
          },
        ],
      };
    }

    case "head":
    case "status": {
      const o = await adapter.getOverview();
      return {
        blocks: [
          {
            kind: "fields",
            title: chain.prettyName,
            fields: [
              { label: "Network ID", value: mono(chain.chainId) },
              {
                label: "Height",
                value: mono(o.height ? Number(o.height).toLocaleString() : "—", {
                  tone: "accent",
                  href: o.height ? `${base}/blocks/${o.height}` : undefined,
                }),
              },
              { label: "Block time", value: mono(o.blockTime ?? "—") },
              { label: "Txs in block", value: mono(String(o.txCount ?? "—")) },
              {
                label: "Active validators",
                value: mono(String(o.activeValidators ?? "—")),
              },
              {
                label: "Bonded",
                value: mono(
                  o.bondedRatio === null ? "—" : `${(o.bondedRatio * 100).toFixed(2)}%`
                ),
              },
              {
                label: "Supply",
                value: mono(
                  o.supply
                    ? `${formatToken(o.supply, chain.exponent, 2)} ${symbolFor(chain)}`
                    : "—"
                ),
              },
            ],
          },
        ],
      };
    }

    case "blocks": {
      const n = limitFrom(args, 12, 50);
      const [fetched, proposers] = await Promise.all([
        adapter.getRecentBlocks(n),
        proposerNames(chain, adapter),
      ]);
      // Sliced rather than trusted: the count is a hint to the adapter, and
      // gno's indexing API returns one more than asked for.
      const blocks = fetched.slice(0, n);
      return {
        blocks: [
          {
            kind: "table",
            title: `Latest ${blocks.length} blocks`,
            columns: [
              { label: "Height", align: "right" },
              { label: "Age", align: "right" },
              { label: "Txs", align: "right" },
              { label: "Proposer", optional: true },
              { label: "Hash", optional: true },
            ],
            rows: blocks.map((b) => [
              mono(Number(b.height).toLocaleString(), {
                href: `${base}/blocks/${b.height}`,
                tone: "accent",
                align: "right",
              }),
              { ...dim(timeAgo(b.time)), align: "right" as const },
              {
                ...mono(String(b.txCount)),
                align: "right" as const,
                ...(b.txCount === 0 ? { dim: true } : {}),
              },
              (() => {
                const hit = proposers.get(b.proposer);
                return hit
                  ? {
                      v: hit.moniker,
                      href: `${base}/validators/${hit.operator}`,
                      tone: "accent" as const,
                    }
                  : mono(truncateMiddle(b.proposer || "—", 8, 6), { dim: true });
              })(),
              mono(b.hash ? truncateMiddle(b.hash, 8, 6) : "—", { dim: true }),
            ]),
          },
        ],
      };
    }

    case "block": {
      const height = args[0];
      if (!height) return err("block needs a height", "try: block 9842113");
      const detail = await adapter.getBlockDetail(height);
      if (!detail) return err(`No block at height ${height}.`);

      const out: ResultBlock[] = [
        {
          kind: "fields",
          title: `Block ${Number(detail.height).toLocaleString()}`,
          fields: [
            { label: "Time", value: mono(`${detail.time} · ${timeAgo(detail.time)}`) },
            { label: "Hash", value: mono(detail.hash ?? "—", { dim: true }) },
            {
              label: "Proposer",
              value: detail.proposerOperator
                ? {
                    v: detail.proposerMoniker ?? detail.proposer,
                    href: `${base}/validators/${detail.proposerOperator}`,
                    tone: "accent",
                  }
                : text(detail.proposerMoniker ?? detail.proposerLabel ?? detail.proposer),
            },
            { label: "Transactions", value: mono(String(detail.txCount)) },
            ...(detail.signatureCount !== null && detail.signatureCount !== undefined
              ? [{ label: "Signatures", value: mono(String(detail.signatureCount)) }]
              : []),
            ...(detail.totalFees
              ? [{ label: "Total fees", value: mono(detail.totalFees) }]
              : []),
          ],
        },
      ];

      const txs = detail.txCount > 0 ? await adapter.getBlockTxs(detail) : [];
      if (txs.length > 0) {
        out.push({
          kind: "table",
          title: `Transactions (${txs.length})`,
          columns: [
            { label: "Hash" },
            { label: "Type" },
            { label: "Status" },
            { label: "Fee", align: "right", optional: true },
          ],
          rows: txs.map((t) => [
            mono(truncateMiddle(t.hash, 10, 6), {
              href: `${base}/txs/${encodeURIComponent(t.hash)}`,
              tone: "accent",
            }),
            text(t.messages[0]?.label ?? "—"),
            statusCell(t.code),
            { ...mono(formatCoins(t.fee, denoms)), align: "right" as const, dim: true },
          ]),
        });
      }
      return { blocks: out };
    }

    case "txs": {
      if (!policy.txs) return err("Transactions are not available for this chain.");
      const n = limitFrom(args, 12, 50);
      const recent = await adapter.getRecentTxs();
      const rows = recent.txs.slice(0, n);
      return {
        blocks: [
          {
            kind: "table",
            title: `Latest ${rows.length} transactions`,
            columns: [
              { label: "Hash" },
              { label: "Type" },
              { label: "Amount", align: "right" },
              { label: "Status" },
              { label: "Height", align: "right", optional: true },
              { label: "Age", align: "right", optional: true },
            ],
            rows: rows.map((t) => [
              mono(truncateMiddle(t.hash, 10, 6), {
                href: `${base}/txs/${encodeURIComponent(t.hash)}`,
                tone: "accent",
              }),
              text(
                t.messages[0]?.label ??
                  (t.messageCount > 1 ? `${t.messageCount} messages` : "—")
              ),
              {
                ...mono(
                  t.transfer && t.transfer.amount.length > 0
                    ? formatCoins(t.transfer.amount, denoms, 2)
                    : "—"
                ),
                align: "right" as const,
              },
              statusCell(t.code),
              {
                ...mono(Number(t.height).toLocaleString(), {
                  href: `${base}/blocks/${t.height}`,
                }),
                align: "right" as const,
                dim: true,
              },
              { ...dim(timeAgo(t.time)), align: "right" as const },
            ]),
            note:
              recent.scannedBlocks > 0
                ? `scanned the last ${recent.scannedBlocks} blocks to ${
                    recent.headHeight ? Number(recent.headHeight).toLocaleString() : "head"
                  }`
                : undefined,
          },
        ],
      };
    }

    case "tx": {
      const hash = args[0];
      if (!hash) return err("tx needs a hash", "try: tx 4F2A…");
      const t = await adapter.getTx(hash);
      if (!t) return err(`No transaction ${truncateMiddle(hash, 10, 6)}.`);

      const out: ResultBlock[] = [
        {
          kind: "fields",
          title: "Transaction",
          fields: [
            { label: "Hash", value: mono(t.hash) },
            { label: "Status", value: statusCell(t.code) },
            {
              label: "Height",
              value: mono(Number(t.height).toLocaleString(), {
                href: `${base}/blocks/${t.height}`,
                tone: "accent",
              }),
            },
            { label: "Time", value: mono(t.time ? `${t.time} · ${timeAgo(t.time)}` : "—") },
            { label: "Fee", value: mono(formatCoins(t.fee, denoms)) },
            ...(caps.gas
              ? [
                  {
                    label: "Gas",
                    value: mono(
                      t.gasUsed && t.gasWanted
                        ? `${Number(t.gasUsed).toLocaleString()} / ${Number(
                            t.gasWanted
                          ).toLocaleString()}`
                        : "—"
                    ),
                  },
                ]
              : []),
            ...(t.memo ? [{ label: "Memo", value: text(t.memo) }] : []),
          ],
        },
      ];

      if (t.messages.length > 0) {
        out.push({
          kind: "table",
          title: `Messages (${t.messageCount})`,
          columns: [
            { label: "#", align: "right" },
            { label: "Type" },
            { label: "From", optional: true },
            { label: "To", optional: true },
            { label: "Amount", align: "right" },
          ],
          rows: t.messages.map((m, i) => [
            { ...dim(String(i + 1)), align: "right" as const },
            text(m.label),
            m.transfer?.from
              ? mono(truncateMiddle(m.transfer.from, 12, 6), {
                  href: `${base}/accounts/${m.transfer.from}`,
                  tone: "accent",
                })
              : dim("—"),
            m.transfer?.to
              ? mono(truncateMiddle(m.transfer.to, 12, 6), {
                  href: m.transfer.to.includes("valoper")
                    ? `${base}/validators/${m.transfer.to}`
                    : `${base}/accounts/${m.transfer.to}`,
                  tone: "accent",
                })
              : dim("—"),
            {
              ...mono(
                m.transfer && m.transfer.amount.length > 0
                  ? formatCoins(m.transfer.amount, denoms, 2)
                  : "—"
              ),
              align: "right" as const,
            },
          ]),
        });
      }

      if (t.rawLog && t.code !== 0) {
        out.push({ kind: "text", title: "Error log", lines: [t.rawLog] });
      }
      return { blocks: out };
    }

    case "validators": {
      const all = await adapter.getValidators();
      const find = (flags.get("find") ?? "").toLowerCase();
      const matched = find
        ? all.filter(
            (v) =>
              v.moniker.toLowerCase().includes(find) ||
              v.operatorAddress.toLowerCase().includes(find)
          )
        : all;
      const n = limitFrom(args, 20, 200);
      const rows = matched.slice(0, n);
      const powerLabel = caps.stakeWeighted ? "Staked" : "Power";

      return {
        blocks: [
          {
            kind: "table",
            title: find
              ? `${matched.length} of ${all.length} validators matching "${find}"`
              : `${all.length} validators`,
            columns: [
              { label: "#", align: "right" },
              { label: "Validator" },
              { label: powerLabel, align: "right" },
              { label: "Share", align: "right" },
              ...(caps.staking
                ? [{ label: "Comm", align: "right" as const, optional: true }]
                : []),
              { label: "Status", optional: true },
            ],
            rows: rows.map((v) => [
              { ...dim(String(v.rank)), align: "right" as const },
              {
                v: v.moniker,
                href: `${base}/validators/${v.operatorAddress}`,
                tone: "accent" as const,
              },
              {
                ...mono(formatToken(v.tokens, chain.exponent, 2)),
                align: "right" as const,
              },
              {
                ...mono(`${(v.votingPower * 100).toFixed(2)}%`),
                align: "right" as const,
                dim: true,
              },
              ...(caps.staking
                ? [
                    {
                      ...mono(`${(v.commissionRate * 100).toFixed(1)}%`),
                      align: "right" as const,
                      dim: true,
                    },
                  ]
                : []),
              v.jailed
                ? { v: "jailed", tone: "bad" as const, mono: true }
                : { v: "active", tone: "ok" as const, mono: true },
            ]),
            note:
              rows.length < matched.length
                ? `showing ${rows.length} of ${matched.length} — pass a count, e.g. validators ${matched.length}`
                : undefined,
          },
        ],
      };
    }

    case "validator": {
      const needle = args.join(" ").toLowerCase();
      if (!needle) return err("validator needs an address or a moniker");
      const all = await adapter.getValidators();
      const v =
        all.find((x) => x.operatorAddress.toLowerCase() === needle) ??
        all.find((x) => x.moniker.toLowerCase() === needle) ??
        all.find((x) => x.moniker.toLowerCase().includes(needle));
      if (!v) return err(`No validator matching "${needle}".`, "try: validators find=gata");

      return {
        blocks: [
          {
            kind: "fields",
            title: v.moniker,
            fields: [
              { label: "Rank", value: mono(`#${v.rank}`) },
              {
                label: "Operator",
                value: mono(v.operatorAddress, {
                  href: `${base}/validators/${v.operatorAddress}`,
                  tone: "accent",
                }),
              },
              {
                label: caps.stakeWeighted ? "Staked" : "Power",
                value: mono(
                  `${formatToken(v.tokens, chain.exponent, 2)} ${symbolFor(chain)}`
                ),
              },
              {
                label: "Share",
                value: mono(`${(v.votingPower * 100).toFixed(2)}%`),
              },
              ...(caps.staking
                ? [
                    {
                      label: "Commission",
                      value: mono(`${(v.commissionRate * 100).toFixed(2)}%`),
                    },
                  ]
                : []),
              {
                label: "Status",
                value: v.jailed
                  ? { v: "jailed", tone: "bad" as const, mono: true }
                  : { v: v.status.replace("BOND_STATUS_", "").toLowerCase(), tone: "ok" as const, mono: true },
              },
              ...(v.website ? [{ label: "Website", value: text(v.website) }] : []),
            ],
          },
        ],
      };
    }

    case "account": {
      const address = args[0];
      if (!address) return err("account needs an address");
      const acct = await adapter.getAccount(address);
      if (!acct.exists) {
        return err(
          `${truncateMiddle(address, 14, 8)} has no record on ${chain.prettyName}.`
        );
      }

      const out: ResultBlock[] = [
        {
          kind: "fields",
          title: "Account",
          fields: [
            {
              label: "Address",
              value: mono(acct.address, {
                href: `${base}/accounts/${acct.address}`,
                tone: "accent",
              }),
            },
            ...(acct.delegatedTotal
              ? [
                  {
                    label: "Delegated",
                    value: mono(
                      `${formatToken(acct.delegatedTotal, chain.exponent, 2)} ${symbolFor(
                        chain
                      )}`
                    ),
                  },
                ]
              : []),
            ...(acct.delegationCount !== null
              ? [{ label: "Delegations", value: mono(String(acct.delegationCount)) }]
              : []),
            ...(acct.accountNumber
              ? [{ label: "Account number", value: mono(acct.accountNumber) }]
              : []),
            ...(acct.sequence ? [{ label: "Sequence", value: mono(acct.sequence) }] : []),
          ],
        },
      ];

      if (acct.balances.length > 0) {
        out.push({
          kind: "table",
          title: `Balances (${acct.balances.length})`,
          columns: [{ label: "Denom" }, { label: "Amount", align: "right" }],
          rows: acct.balances.map((c) => [
            mono(c.denom, { dim: true }),
            { ...mono(formatCoin(c, denoms, 4)), align: "right" as const },
          ]),
        });
      }
      return { blocks: out };
    }

    case "proposals": {
      if (!caps.governance) {
        return err(`${chain.prettyName} has no on-chain governance module.`);
      }
      if (!policy.proposals) {
        return err("Proposals are not available for this chain.");
      }
      const n = limitFrom(args, 15, 100);
      const { proposals } = await adapter.getProposals(n);
      return {
        blocks: [
          {
            kind: "table",
            title: `${proposals.length} proposals`,
            columns: [
              { label: "#", align: "right" },
              { label: "Title" },
              { label: "Status" },
              { label: "Submitted", align: "right", optional: true },
            ],
            rows: proposals.map((p) => [
              { ...mono(p.id), align: "right" as const, dim: true },
              {
                v: p.title || `Proposal ${p.id}`,
                href: `${base}/proposals/${p.id}`,
                tone: "accent" as const,
              },
              {
                v: p.status.replace("PROPOSAL_STATUS_", "").toLowerCase(),
                mono: true,
                tone: p.status.includes("PASSED")
                  ? ("ok" as const)
                  : p.status.includes("REJECTED") || p.status.includes("FAILED")
                    ? ("bad" as const)
                    : undefined,
              },
              { ...dim(timeAgo(p.submitTime)), align: "right" as const },
            ]),
          },
        ],
      };
    }

    case "proposal": {
      if (!caps.governance) {
        return err(`${chain.prettyName} has no on-chain governance module.`);
      }
      const id = args[0];
      if (!id) return err("proposal needs an id", "try: proposal 1");
      const p = await adapter.getProposal(id);
      if (!p) return err(`No proposal ${id}.`);

      // The tally carries its own total; summing the options would disagree with
      // it on chains that drop an option (AtomOne has no NoWithVeto).
      const total = Number(p.tally.total);
      const pct = (v: string | null) =>
        v !== null && total > 0 ? `${((Number(v) / total) * 100).toFixed(2)}%` : "—";

      return {
        blocks: [
          {
            kind: "fields",
            title: `#${p.id} · ${p.title || "Proposal"}`,
            fields: [
              {
                label: "Status",
                value: {
                  v: p.status.replace("PROPOSAL_STATUS_", "").toLowerCase(),
                  mono: true,
                  tone: p.status.includes("PASSED") ? "ok" : undefined,
                },
              },
              { label: "Submitted", value: mono(p.submitTime ?? "—") },
              { label: "Voting ends", value: mono(p.votingEndTime ?? "—") },
              {
                label: "Deposit",
                value: mono(formatCoins(p.totalDeposit, denoms, 2)),
              },
              ...(p.proposer
                ? [
                    {
                      label: "Proposer",
                      value: mono(truncateMiddle(p.proposer, 14, 8), {
                        href: `${base}/accounts/${p.proposer}`,
                        tone: "accent",
                      }),
                    },
                  ]
                : []),
            ],
          },
          {
            kind: "table",
            title: p.liveTally ? "Current votes" : "Final tally",
            columns: [
              { label: "Option" },
              { label: "Share", align: "right" },
            ],
            rows: [
              [{ v: "yes", mono: true, tone: "ok" as const }, { ...mono(pct(p.tally.yes)), align: "right" as const }],
              [{ v: "no", mono: true, tone: "bad" as const }, { ...mono(pct(p.tally.no)), align: "right" as const }],
              [mono("abstain"), { ...mono(pct(p.tally.abstain)), align: "right" as const }],
              // Absent rather than zero on chains without the option.
              ...(p.tally.veto !== null
                ? [[mono("veto"), { ...mono(pct(p.tally.veto)), align: "right" as const }]]
                : []),
            ],
          },
        ],
      };
    }

    case "params": {
      const gov = caps.governance ? await adapter.getGovParams() : null;
      return {
        blocks: [
          {
            kind: "fields",
            title: `${chain.prettyName} parameters`,
            fields: [
              { label: "Network ID", value: mono(chain.chainId) },
              { label: "Base denom", value: mono(chain.denom) },
              { label: "Symbol", value: mono(symbolFor(chain)) },
              { label: "Exponent", value: mono(String(chain.exponent)) },
              { label: "Address prefix", value: mono(chain.bech32Prefix) },
              ...(chain.feeDenom && chain.feeDenom !== chain.denom
                ? [{ label: "Fee denom", value: mono(chain.feeDenom) }]
                : []),
              ...(gov?.quorum != null
                ? [{ label: "Quorum", value: mono(`${(gov.quorum * 100).toFixed(1)}%`) }]
                : []),
              ...(gov?.threshold != null
                ? [
                    {
                      label: "Threshold",
                      value: mono(`${(gov.threshold * 100).toFixed(1)}%`),
                    },
                  ]
                : []),
              ...(chain.website ? [{ label: "Website", value: text(chain.website) }] : []),
            ],
          },
        ],
      };
    }

    default:
      return err(
        `Unknown command "${cmd}".`,
        // `help` is offered on its own at the end, so it is dropped from the
        // sample rather than named twice in one line.
        `try: ${COMMAND_NAMES.filter((n) => n !== "help")
          .slice(0, 6)
          .join(", ")} — or help`
      );
  }
}
