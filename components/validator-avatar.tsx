"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A validator's logo, walking its candidate images and ending in a monogram
 * tinted from the name, so a missing or broken image never shows as a hole.
 */

const TINTS = ["#3b9eff", "#36d399", "#ffb155", "#a78bfa", "#62d9ff", "#f472b6", "#f5c66b", "#ff7a45"];

function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

function initials(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function ValidatorAvatar({
  name,
  logos = [],
  size = 28,
  className = "",
}: {
  name: string;
  logos?: string[];
  size?: number;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const src = logos[index];
  const imgRef = useRef<HTMLImageElement>(null);

  // An image that failed before hydration never fires onError for React, so
  // check once mounted whether it already finished without any pixels.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setIndex((i) => i + 1);
  }, [src]);
  const style = { width: size, height: size };

  if (!src) {
    const c = tint(name);
    return (
      <span
        aria-hidden="true"
        className={`inline-grid shrink-0 place-items-center rounded-full font-semibold ${className}`}
        style={{
          ...style,
          fontSize: Math.max(9, Math.round(size * 0.36)),
          color: c,
          background: `color-mix(in srgb, ${c} 16%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 35%, transparent)`,
        }}
      >
        {initials(name)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- third-party logos of unknown size; next/image would need every host allow-listed
    <img
      ref={imgRef}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setIndex((i) => i + 1)}
      className={`shrink-0 rounded-full bg-[var(--gata-card-hi)] object-cover ring-1 ring-[var(--gata-border)] ${className}`}
      style={style}
    />
  );
}
