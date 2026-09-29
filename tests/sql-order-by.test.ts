import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Postgres resolves a bare ORDER BY name to an output column before an input
 * one. `SELECT height::text … ORDER BY height DESC` therefore sorts the text,
 * where "9999879" comes after "10575328": past block 10,000,000 every such
 * list returned its oldest rows first and, under a LIMIT, the wrong rows
 * entirely. Found on AtomOne, whose proposed-block list stopped at #9,999,879.
 *
 * Sorting on the table's column (`ORDER BY block.height`) avoids it. This
 * reads every query in lib/ and fails on a bare ORDER BY name that the same
 * SELECT also outputs through a cast.
 */

// Only a text cast changes the order; a numeric cast sorts the same as its input.
const CAST = "text";

function queries(): { file: string; line: number; sql: string }[] {
  const dir = join(__dirname, "..", "lib");
  const out: { file: string; line: number; sql: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, name), "utf8");
    for (const m of src.matchAll(/`(\s*(?:WITH|SELECT|\()[\s\S]*?)`/g)) {
      if (!/\bORDER BY\b/.test(m[1])) continue;
      out.push({ file: name, line: src.slice(0, m.index).split("\n").length, sql: m[1] });
    }
  }
  return out;
}

/** Bare names that a SELECT outputs through a cast: `col::text` or `… ::text AS name`. */
function castOutputs(sql: string): Set<string> {
  const names = new Set<string>();
  for (const m of sql.matchAll(new RegExp(`(?:^|[\\s,(])(?:\\w+\\.)?(\\w+)::${CAST}\\b(?!\\s+AS)`, "g"))) {
    names.add(m[1]);
  }
  for (const m of sql.matchAll(new RegExp(`::${CAST}\\s+AS\\s+(\\w+)`, "g"))) names.add(m[1]);
  return names;
}

/** Bare (unqualified) names in each top-level ORDER BY, skipping aggregate ones. */
function orderByNames(sql: string): string[] {
  const names: string[] = [];
  for (const m of sql.matchAll(/ORDER BY\s+([^\n`)]*)/g)) {
    // `WITHIN GROUP (ORDER BY …)` and window `OVER (ORDER BY …)` read inputs.
    const before = sql.slice(Math.max(0, (m.index ?? 0) - 16), m.index);
    if (/(WITHIN GROUP|OVER)\s*\($/.test(before)) continue;
    for (const part of m[1].split(",")) {
      const bare = part.trim().match(/^(\w+)(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?(?:\s+LIMIT\b.*)?$/i);
      if (bare) names.push(bare[1]);
    }
  }
  return names;
}

describe("indexer SQL", () => {
  it("never sorts on a column the same SELECT casts to text", () => {
    const offenders = queries().flatMap(({ file, line, sql }) => {
      const cast = castOutputs(sql);
      return orderByNames(sql)
        .filter((n) => cast.has(n))
        .map((n) => `${file}:${line} ORDER BY ${n}`);
    });
    expect(offenders).toEqual([]);
  });

  it("catches the pattern it guards against", () => {
    const sql = "SELECT height::text, time::text FROM block WHERE chain_id = $1 ORDER BY height DESC LIMIT 5";
    expect(orderByNames(sql).filter((n) => castOutputs(sql).has(n))).toEqual(["height"]);
    const fixed = sql.replace("ORDER BY height", "ORDER BY block.height");
    expect(orderByNames(fixed).filter((n) => castOutputs(fixed).has(n))).toEqual([]);
  });
});
