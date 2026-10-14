"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";

/**
 * A package's files: a file strip (a column beside the code from lg up), and
 * the chosen file with line numbers. Only the code scrolls.
 */
export function SourceView({
  files,
  initial,
}: {
  files: { name: string; source: string | null }[];
  initial?: string;
}) {
  const [name, setName] = useState(
    files.find((f) => f.name === initial)?.name ?? files[0]?.name ?? ""
  );
  const file = files.find((f) => f.name === name);
  if (!file) return <p className="text-sm text-muted-foreground">N/A</p>;
  const lines = (file.source ?? "").replace(/\n$/, "").split("\n");

  return (
    <div className="gata-surface flex h-full min-h-0 flex-col overflow-hidden lg:flex-row">
      <nav
        aria-label="Files"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-1.5 lg:w-56 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0"
      >
        {files.map((f) => (
          <button
            key={f.name}
            type="button"
            onClick={() => setName(f.name)}
            aria-current={f.name === name ? "true" : undefined}
            className={`shrink-0 truncate rounded-md px-2 py-1 text-left font-mono text-[11.5px] transition-colors ${
              f.name === name
                ? "bg-[var(--gata-card-hi)] text-foreground shadow-[inset_0_0_0_1px_var(--gata-border-hi)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.name}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[11.5px] text-muted-foreground">
          <span className="truncate font-mono">{file.name}</span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="font-mono tabular-nums">{file.source === null ? "N/A" : `${lines.length} lines`}</span>
            {file.source ? <CopyButton value={file.source} label="file" /> : null}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {file.source === null ? (
            <p className="p-3 text-sm text-muted-foreground">N/A</p>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td className="sticky left-0 w-[1%] select-none bg-[var(--gata-card)] pr-3 pl-3 text-right align-top text-muted-foreground/60 tabular-nums">
                      {i + 1}
                    </td>
                    <td className="pr-4 align-top whitespace-pre text-foreground/90">{line || " "}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
