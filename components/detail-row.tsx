import { CopyButton } from "@/components/copy-button";

/** One label and value of a detail panel, with a copy button for the full value. */
export function DetailRow({ label, copy, children }: { label: string; copy: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 py-1.5 text-[12px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{children}</span>
        <CopyButton value={copy} label={label.toLowerCase()} />
      </span>
    </div>
  );
}
