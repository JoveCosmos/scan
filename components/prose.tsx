"use client";

import { Fragment } from "react";
import Link from "next/link";
import { AddressLink } from "@/components/address-link";

/**
 * Markdown the way proposals and validator descriptions use it, rendered
 * safely: headings, paragraphs, ordered and unordered lists, bold, italic,
 * inline code, code blocks, rules, links and bare URLs. No HTML is ever
 * interpreted. On-chain addresses in the text become address links, so a
 * proposal naming an account leads to it.
 */

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[]; start?: number }
  | { kind: "code"; text: string }
  | { kind: "hr" };

function parse(src: string): Block[] {
  // Some chains store "\n" as two literal characters.
  const lines = src.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[]; start?: number } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  let fence: string[] | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (fence) {
      if (/^\s*(```|~~~)/.test(line)) {
        blocks.push({ kind: "code", text: fence.join("\n") });
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flushPara();
      flushList();
      fence = [];
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      flushList();
      blocks.push({ kind: "hr" });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
    } else if (bullet || ordered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flushList();
        // A numbered list keeps its own first number: "4." after a paragraph
        // continues the count rather than restarting at 1.
        list = ordered ? { kind, items: [], start: Number(ordered[1]) } : { kind, items: [] };
      }
      list.items.push(bullet ? bullet[1] : ordered![2]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // A continuation line of the previous item.
      list.items[list.items.length - 1] += " " + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  if (fence) blocks.push({ kind: "code", text: fence.join("\n") });
  flushPara();
  flushList();
  return blocks;
}

const INLINE =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^)\s]*\)|https?:\/\/[^\s)<>]+|\b[a-z]{1,15}1[02-9ac-hj-np-z]{38,90}\b)/g;

const LINK =
  "text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current";

/**
 * Where a gno.land realm's relative link goes: "/r/…" and "/p/…" to that
 * package's page here (a Render path after ":" as the render argument);
 * anything else stays text.
 */
function gnoHref(chainId: string, target: string): string | null {
  const m = target.match(/^\/([rp]\/[A-Za-z0-9_./-]+?)(?::([^?#]*))?(?:[?#].*)?$/);
  if (!m) return null;
  const base = `/${chainId}/packages/${m[1].replace(/\/$/, "")}`;
  return m[2] ? `${base}?tab=render&render=${encodeURIComponent(m[2])}` : base;
}

function Inline({ text, gnoChain }: { text: string; gnoChain?: string }) {
  const parts = text.split(INLINE);
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
        if (/^(\*\*|__)/.test(part))
          return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
        if (/^[*_]/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
        if (part.startsWith("`"))
          return (
            <code key={i} className="rounded bg-[var(--gata-card-hi)] px-1 font-mono text-[0.92em]">
              {part.slice(1, -1)}
            </code>
          );
        const md = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (md && md[2].startsWith("/")) {
          const href = gnoChain ? gnoHref(gnoChain, md[2]) : null;
          return href ? (
            <Link key={i} href={href} className={LINK}>
              {md[1]}
            </Link>
          ) : (
            <Fragment key={i}>{md[1]}</Fragment>
          );
        }
        if (md)
          return (
            <a key={i} href={md[2]} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
              {md[1]}
            </a>
          );
        if (/^https?:\/\//.test(part))
          return (
            <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className={`${LINK} break-all`}>
              {part}
            </a>
          );
        return <AddressLink key={i} address={part} className="break-all" />;
      })}
    </>
  );
}

/**
 * `gnoChain`: the text is a gno.land realm's Render output on that chain, so
 * its relative links lead to the packages they name.
 */
export function Prose({ text, gnoChain }: { text: string; gnoChain?: string }) {
  const blocks = parse(text);
  return (
    <div className="flex flex-col gap-2.5 text-sm leading-relaxed text-foreground/90">
      {blocks.map((b, i) => {
        if (b.kind === "h") {
          const cls =
            b.level <= 2
              ? "font-display mt-2 text-[15px] font-semibold text-foreground"
              : "mt-1 text-[13.5px] font-semibold text-foreground";
          return (
            <p key={i} className={cls} role="heading" aria-level={Math.min(6, b.level + 2)}>
              <Inline text={b.text} gnoChain={gnoChain} />
            </p>
          );
        }
        if (b.kind === "hr") return <hr key={i} className="border-border" />;
        if (b.kind === "code")
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-md bg-[var(--gata-card-hi)] px-3 py-2 font-mono text-[12px] leading-relaxed"
            >
              {b.text}
            </pre>
          );
        if (b.kind === "p")
          return (
            <p key={i} className="break-words">
              <Inline text={b.text} gnoChain={gnoChain} />
            </p>
          );
        const List = b.kind === "ol" ? "ol" : "ul";
        return (
          <List
            key={i}
            start={b.kind === "ol" ? b.start : undefined}
            className={`flex flex-col gap-1 pl-5 ${b.kind === "ol" ? "list-decimal" : "list-disc"} marker:text-muted-foreground`}
          >
            {b.items.map((item, j) => (
              <li key={j} className="break-words">
                <Inline text={item} gnoChain={gnoChain} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
