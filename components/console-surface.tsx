"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Cell, ConsoleResult, ResultBlock } from "@/lib/console";

/**
 * The console: an explorer you talk to rather than click through.
 *
 * Everything here is presentation. The command set, the parsing and the tier
 * gating live server-side in `lib/console.ts` — this posts a line and renders
 * whatever comes back, which is why adding a command needs no change to this
 * file. The command names arrive as a prop for the same reason the tx label maps
 * are duplicated elsewhere: `lib/console.ts` reaches `node:fs` through the chain
 * registry, and it must not follow us into the client bundle.
 */

interface Entry {
  id: number;
  line: string;
  result: ConsoleResult | null;
  /** Errors from the transport itself, as opposed to a command that failed. */
  failed?: string;
}

const GREETING: ResultBlock[] = [
  {
    kind: "text",
    lines: [
      "Type a command. `help` lists them.",
      "Everything is a query — results are links, so you can leave for a normal page at any point.",
    ],
  },
];

function toneColor(tone: Cell["tone"], accent: string): string | undefined {
  if (tone === "ok") return "var(--gata-green)";
  if (tone === "bad") return "var(--destructive)";
  if (tone === "accent") return accent;
  return undefined;
}

function CellView({ cell, accent }: { cell: Cell; accent: string }) {
  const style = { color: toneColor(cell.tone, accent) };
  const className = [
    cell.mono ? "font-mono" : "",
    cell.dim && !cell.tone ? "text-muted-foreground" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (cell.href) {
    return (
      <Link
        href={cell.href}
        style={style}
        className={`${className} underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current`}
      >
        {cell.v}
      </Link>
    );
  }
  return (
    <span style={style} className={className}>
      {cell.v}
    </span>
  );
}

function BlockView({ block, accent }: { block: ResultBlock; accent: string }) {
  if (block.kind === "error") {
    return (
      <div className="mt-1">
        <div style={{ color: "var(--destructive)" }}>{block.message}</div>
        {block.hint ? (
          <div className="text-muted-foreground">{block.hint}</div>
        ) : null}
      </div>
    );
  }

  if (block.kind === "text") {
    return (
      <div className="mt-1">
        {block.title ? (
          <div className="text-muted-foreground">{block.title}</div>
        ) : null}
        {block.lines.map((l, i) => (
          <pre key={i} className="whitespace-pre-wrap break-words font-mono">
            {l}
          </pre>
        ))}
      </div>
    );
  }

  if (block.kind === "fields") {
    return (
      <div className="mt-1">
        {block.title ? (
          <div className="mb-1" style={{ color: accent }}>
            {block.title}
          </div>
        ) : null}
        <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-0.5">
          {block.fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0 break-all">
                <CellView cell={f.value} accent={accent} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  return (
    <div className="mt-1 min-w-0">
      {block.title ? (
        <div className="mb-1" style={{ color: accent }}>
          {block.title}
        </div>
      ) : null}
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-max border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              {block.columns.map((c, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`px-1 pb-0.5 text-left font-normal ${
                    c.align === "right" ? "text-right" : ""
                  } ${c.optional ? "hidden sm:table-cell" : ""}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`px-1 align-top ${
                      cell.align === "right" ? "text-right" : ""
                    } ${block.columns[ci]?.optional ? "hidden sm:table-cell" : ""}`}
                  >
                    <CellView cell={cell} accent={accent} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.note ? (
        <div className="mt-1 text-muted-foreground">{block.note}</div>
      ) : null}
    </div>
  );
}

export function ConsoleSurface({
  chainId,
  prettyName,
  accent,
  commands,
}: {
  chainId: string;
  prettyName: string;
  accent: string;
  /** Passed in rather than imported: the command table lives server-side. */
  commands: string[];
}) {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A live head line, so the surface is not inert between commands.
  const { data: head } = useQuery({
    queryKey: ["console-head", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/chains/${chainId}/head`);
      if (!res.ok) throw new Error("head unavailable");
      return (await res.json()) as { height: string | null; blockTime: string | null };
    },
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });

  // Pinned to the bottom, the way a terminal is.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, busy]);

  const run = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      if (!line) return;

      setHistory((h) => (h[h.length - 1] === line ? h : [...h, line]));
      setHistoryAt(null);
      setValue("");

      if (line === "clear") {
        setEntries([]);
        return;
      }

      const id = nextId.current++;
      setEntries((e) => [...e, { id, line, result: null }]);
      setBusy(true);
      try {
        const res = await fetch(`/api/chains/${chainId}/console`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ line }),
        });
        const result = (await res.json()) as ConsoleResult;
        if (result.nav) {
          router.push(result.nav);
          return;
        }
        setEntries((e) => e.map((x) => (x.id === id ? { ...x, result } : x)));
      } catch {
        setEntries((e) =>
          e.map((x) =>
            x.id === id ? { ...x, failed: "Could not reach the explorer." } : x
          )
        );
      } finally {
        setBusy(false);
      }
    },
    [chainId, router]
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void run(value);
      return;
    }

    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const at = historyAt === null ? history.length - 1 : Math.max(0, historyAt - 1);
      setHistoryAt(at);
      setValue(history[at]);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyAt === null) return;
      const at = historyAt + 1;
      if (at >= history.length) {
        setHistoryAt(null);
        setValue("");
      } else {
        setHistoryAt(at);
        setValue(history[at]);
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      // Only the command word completes — arguments are chain data, and a
      // wrong guess at a hash is worse than no guess.
      const [word, ...rest] = value.split(" ");
      if (rest.length > 0) return;
      const hits = commands.filter((c) => c.startsWith(word.toLowerCase()));
      if (hits.length === 1) setValue(`${hits[0]} `);
      else if (hits.length > 1) {
        const id = nextId.current++;
        setEntries((e) => [
          ...e,
          {
            id,
            line: value,
            result: { blocks: [{ kind: "text", lines: [hits.join("  ")] }] },
          },
        ]);
      }
    }
  }

  const prompt = (
    <span className="select-none" style={{ color: accent }}>
      {chainId}
      <span className="text-muted-foreground"> ›</span>
    </span>
  );

  return (
    <div
      className="flex h-[calc(100dvh-11rem)] min-h-[30rem] flex-col border border-border bg-[var(--gata-card)] font-mono text-[13px] leading-relaxed"
      style={{ ["--panel-accent" as string]: accent }}
    >
      {/* Status line. The one piece of chrome, and it is all data. */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-3 py-1.5 text-[12px]">
        <span className="truncate">
          <span style={{ color: accent }}>{prettyName}</span>
          <span className="text-muted-foreground"> · {chainId}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {head?.height ? (
            <>
              <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
              <span>{Number(head.height).toLocaleString()}</span>
              {head.blockTime ? <span>· {head.blockTime}</span> : null}
            </>
          ) : (
            <span>connecting…</span>
          )}
        </span>
      </div>

      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {entries.length === 0
          ? GREETING.map((b, i) => <BlockView key={i} block={b} accent={accent} />)
          : null}

        {entries.map((entry) => (
          <div key={entry.id} className="mb-3">
            <div className="flex gap-2">
              {prompt}
              <span className="min-w-0 break-all">{entry.line}</span>
            </div>
            {entry.failed ? (
              <div style={{ color: "var(--destructive)" }}>{entry.failed}</div>
            ) : entry.result ? (
              entry.result.blocks.map((b, i) => (
                <BlockView key={i} block={b} accent={accent} />
              ))
            ) : (
              <div className="text-muted-foreground">…</div>
            )}
          </div>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
        {prompt}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label={`Command for ${prettyName}`}
          placeholder={busy ? "" : "help"}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-[var(--gata-faint)] disabled:opacity-60"
        />
      </div>
    </div>
  );
}
