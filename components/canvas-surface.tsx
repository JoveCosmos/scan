"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Graph, GraphNode } from "@/lib/graph-types";
import { COL_GAP, NODE_H, NODE_W, layout } from "@/lib/graph-layout";

/**
 * The canvas presentation: the chain drawn rather than listed.
 *
 * Two decisions carry this view. First, the layout is *deterministic* — a node's
 * column comes from its kind and its row from the average position of what it
 * connects to, resolved by pushing down. No force simulation, so nothing drifts,
 * nothing settles, and a node you have already read never moves under you.
 * Second, it only ever draws what you asked for: the canvas opens on the head of
 * the chain and grows one expansion at a time.
 *
 * Drawn as SVG rather than canvas because the nodes are mostly text, and text in
 * a `<canvas>` is neither selectable nor legible to a screen reader.
 */

function toneOf(node: GraphNode, accent: string): string {
  if (node.tone === "bad") return "var(--destructive)";
  if (node.kind === "block") return accent;
  if (node.kind === "validator") return "var(--gata-cyan)";
  if (node.kind === "tx") return "var(--gata-green)";
  return "var(--gata-sub)";
}

export function CanvasSurface({
  chainId,
  prettyName,
  accent,
}: {
  chainId: string;
  prettyName: string;
  accent: string;
}) {
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [], seed: "head" });
  const [selected, setSelected] = useState<string | null>(null);
  const [expanding, setExpanding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [live, setLive] = useState(true);
  // Dragging is state as well as a ref: the ref carries the gesture's origin
  // across pointer events, but the cursor only changes if a render follows.
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  // A pan that happens to finish over a node must not also expand it. Set once
  // the pointer travels past a threshold, and read by the node's click handler.
  const panned = useRef(false);
  const fitted = useRef(false);

  /** Merge a fetched sub-graph into what is already drawn. */
  const merge = useCallback((incoming: Graph) => {
    if (incoming.error) {
      setError(incoming.error);
      return;
    }
    setError(null);
    setGraph((current) => {
      const nodes = new Map(current.nodes.map((n) => [n.id, n]));
      for (const n of incoming.nodes) {
        const existing = nodes.get(n.id);
        // A richer version of a node replaces a stub, never the other way.
        nodes.set(
          n.id,
          existing && (existing.fields?.length ?? 0) > (n.fields?.length ?? 0)
            ? existing
            : { ...existing, ...n }
        );
      }
      const seen = new Set(current.edges.map((e) => `${e.from}→${e.to}`));
      const edges = [...current.edges];
      for (const e of incoming.edges) {
        const key = `${e.from}→${e.to}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(e);
        }
      }
      return { nodes: [...nodes.values()], edges, seed: current.seed };
    });
  }, []);

  const fetchSeed = useCallback(
    async (seed: string) => {
      const res = await fetch(
        `/api/chains/${chainId}/graph?seed=${encodeURIComponent(seed)}`
      );
      return (await res.json()) as Graph;
    },
    [chainId]
  );

  // Opening view.
  useEffect(() => {
    let cancelled = false;
    void fetchSeed("head:10").then((g) => {
      if (!cancelled) merge(g);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSeed, merge]);

  // Live head. New blocks join the spine; everything already drawn stays put.
  useQuery({
    queryKey: ["canvas-head", chainId, live],
    queryFn: async () => {
      if (!live) return null;
      merge(await fetchSeed("head:6"));
      return Date.now();
    },
    refetchInterval: live ? 5000 : false,
    refetchIntervalInBackground: false,
    enabled: live,
  });

  const expand = useCallback(
    async (node: GraphNode) => {
      if (!node.seed) return;
      setExpanding(node.id);
      try {
        merge(await fetchSeed(node.seed));
      } catch {
        setError("Could not expand that node.");
      } finally {
        setExpanding(null);
      }
    },
    [fetchSeed, merge]
  );

  const placed = useMemo(() => layout(graph.nodes, graph.edges), [graph]);

  const bounds = useMemo(() => {
    const all = [...placed.values()];
    if (all.length === 0) return { w: 0, h: 0 };
    return {
      w: Math.max(...all.map((p) => p.x)) + NODE_W,
      h: Math.max(...all.map((p) => p.y)) + NODE_H,
    };
  }, [placed]);

  // Centre once, on the first graph that arrives. Never again — the canvas must
  // not move itself while you are reading it.
  useEffect(() => {
    if (fitted.current || placed.size === 0 || !svgRef.current) return;
    fitted.current = true;
    const rect = svgRef.current.getBoundingClientRect();
    setView({ x: 48, y: Math.max(24, rect.height / 2 - bounds.h / 2), k: 1 });
  }, [placed, bounds]);

  function onWheel(e: React.WheelEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const k = Math.max(0.3, Math.min(2.2, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      // Keep the point under the cursor fixed while the scale changes.
      return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    panned.current = false;
    setDragging(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // A few pixels of travel is a click with an unsteady hand, not a pan.
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) panned.current = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  }

  function onPointerUp(e: React.PointerEvent) {
    drag.current = null;
    setDragging(false);
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") setSelected(null);
      if (e.key === "0") {
        fitted.current = false;
        setView({ x: 48, y: 40, k: 1 });
      }
      if (e.key === "+" || e.key === "=") setView((v) => ({ ...v, k: Math.min(2.2, v.k * 1.15) }));
      if (e.key === "-") setView((v) => ({ ...v, k: Math.max(0.3, v.k / 1.15) }));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const selectedNode = selected ? placed.get(selected)?.node ?? null : null;

  return (
    <div className="relative flex h-[calc(100dvh-11rem)] min-h-[30rem] flex-col border border-border bg-[var(--gata-card)]">
      {/* Status strip. */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-3 py-1.5 font-mono text-[12px]">
        <span className="truncate">
          <span style={{ color: accent }}>{prettyName}</span>
          <span className="text-muted-foreground">
            {" "}
            · {graph.nodes.length} nodes · {graph.edges.length} edges
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className="flex items-center gap-1.5 transition-colors hover:text-foreground"
            aria-pressed={live}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${live ? "gata-live-dot" : ""}`}
              style={{ background: live ? "var(--gata-green)" : "var(--gata-faint)" }}
            />
            {live ? "live" : "paused"}
          </button>
          <span className="hidden sm:inline">{Math.round(view.k * 100)}%</span>
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <svg
          ref={svgRef}
          className="h-full w-full touch-none select-none"
          style={{ cursor: dragging ? "grabbing" : "grab" }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="application"
          aria-label={`${prettyName} activity graph`}
        >
          <defs>
            <marker
              id="canvas-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="var(--gata-border-hi)" />
            </marker>
          </defs>

          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {graph.edges.map((e, i) => {
              const a = placed.get(e.from);
              const b = placed.get(e.to);
              if (!a || !b) return null;

              // Geometry runs left to right by column; the arrowhead marks the
              // semantic target, so a sender still reads as pointing at its tx.
              const forward = a.x <= b.x;
              const [l, r] = forward ? [a, b] : [b, a];
              const sameColumn = a.x === b.x;

              const x1 = sameColumn ? l.x + NODE_W / 2 : l.x + NODE_W;
              const y1 = sameColumn ? l.y + NODE_H : l.y + NODE_H / 2;
              const x2 = sameColumn ? r.x + NODE_W / 2 : r.x;
              const y2 = sameColumn ? r.y : r.y + NODE_H / 2;
              const d = sameColumn
                ? `M${x1},${y1} L${x2},${y2}`
                : `M${x1},${y1} C${x1 + COL_GAP / 2},${y1} ${x2 - COL_GAP / 2},${y2} ${x2},${y2}`;

              const lit = selected === e.from || selected === e.to;
              return (
                <g key={`${e.from}-${e.to}-${i}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke={lit ? accent : "var(--gata-border)"}
                    strokeWidth={lit ? 1.6 : 1}
                    markerEnd={forward ? "url(#canvas-arrow)" : undefined}
                    markerStart={forward ? undefined : "url(#canvas-arrow)"}
                  />
                  {e.label && lit ? (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 5}
                      textAnchor="middle"
                      className="fill-muted-foreground font-mono"
                      fontSize={10}
                    >
                      {e.label}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {[...placed.values()].map(({ node, x, y }) => {
              const isSelected = selected === node.id;
              const colour = toneOf(node, accent);
              return (
                <g
                  key={node.id}
                  transform={`translate(${x},${y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (panned.current) return;
                    setSelected(node.id);
                    void expand(node);
                  }}
                  className="cursor-pointer"
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={2}
                    fill="var(--gata-bg2)"
                    stroke={isSelected ? colour : "var(--gata-border)"}
                    strokeWidth={isSelected ? 1.5 : 1}
                  />
                  {/* Kind stripe: the node's identity before any text is read. */}
                  <rect width={2} height={NODE_H} fill={colour} />
                  <text
                    x={10}
                    y={19}
                    className="font-mono"
                    fontSize={12}
                    fill="var(--gata-text)"
                  >
                    {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
                  </text>
                  {node.sub ? (
                    <text
                      x={10}
                      y={34}
                      className="font-mono"
                      fontSize={10}
                      fill="var(--gata-sub)"
                    >
                      {node.sub.length > 24 ? `${node.sub.slice(0, 23)}…` : node.sub}
                    </text>
                  ) : null}
                  {expanding === node.id ? (
                    <circle cx={NODE_W - 10} cy={10} r={3} fill={colour}>
                      <animate
                        attributeName="opacity"
                        values="1;0.2;1"
                        dur="0.9s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Inspector. Sits over the canvas rather than beside it, so the graph
            keeps the full width when nothing is selected. */}
        {selectedNode ? (
          <div className="absolute bottom-3 right-3 max-h-[70%] w-[min(22rem,calc(100%-1.5rem))] overflow-y-auto border border-border bg-[color-mix(in_srgb,var(--gata-card)_94%,transparent)] p-3 font-mono text-[12px] backdrop-blur-sm">
            <div className="mb-2 flex items-start justify-between gap-3">
              <span style={{ color: toneOf(selectedNode, accent) }}>
                {selectedNode.kind}
              </span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Close inspector"
              >
                esc
              </button>
            </div>
            <dl className="grid grid-cols-[minmax(4.5rem,auto)_1fr] gap-x-3 gap-y-1">
              {(selectedNode.fields ?? []).map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className="min-w-0 break-all">{f.value}</dd>
                </div>
              ))}
            </dl>
            {selectedNode.href ? (
              <Link
                href={selectedNode.href}
                className="mt-3 inline-block underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
                style={{ color: accent }}
              >
                open page ↗
              </Link>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div
            className="absolute left-3 top-3 border border-border px-3 py-2 font-mono text-[12px]"
            style={{ color: "var(--destructive)", background: "var(--gata-card)" }}
          >
            {error}
          </div>
        ) : null}

        {graph.nodes.length === 0 && !error ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-[12px] text-muted-foreground">
            reading the head of the chain…
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        drag to pan · scroll to zoom · click a node to expand it · 0 resets · esc closes
      </div>
    </div>
  );
}
