import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, limitFrom, parseCommand } from "@/lib/console";

describe("parseCommand", () => {
  it("splits a bare command", () => {
    expect(parseCommand("head")).toEqual({
      cmd: "head",
      args: [],
      flags: new Map(),
    });
  });

  it("lowercases the command but not its arguments", () => {
    // Addresses and hashes are case-sensitive; the command name is not.
    const { cmd, args } = parseCommand("TX 4E3305A2");
    expect(cmd).toBe("tx");
    expect(args).toEqual(["4E3305A2"]);
  });

  it("separates key=value flags from positional arguments", () => {
    const { args, flags } = parseCommand("validators 10 find=gata");
    expect(args).toEqual(["10"]);
    expect(flags.get("find")).toBe("gata");
  });

  it("keeps a quoted argument whole", () => {
    // Monikers routinely contain spaces — "Cosmostation Node" is one argument.
    expect(parseCommand('validator "Cosmostation Node"').args).toEqual([
      "Cosmostation Node",
    ]);
  });

  it("does not treat a leading = as a flag", () => {
    // `=foo` has no key, so it is a value; splitting it would produce an
    // unnamed flag that no command could ever read.
    const { args, flags } = parseCommand("account =foo");
    expect(args).toEqual(["=foo"]);
    expect(flags.size).toBe(0);
  });

  it("keeps everything after the first = in the value", () => {
    // gno tx hashes are base64 and end in padding.
    expect(parseCommand("tx find=aGVsbG8=").flags.get("find")).toBe("aGVsbG8=");
  });

  it("collapses runs of whitespace", () => {
    expect(parseCommand("  blocks    5  ").args).toEqual(["5"]);
  });

  it("returns an empty command for an empty line", () => {
    expect(parseCommand("").cmd).toBe("");
    expect(parseCommand("   ").cmd).toBe("");
  });
});

describe("limitFrom", () => {
  it("falls back when no count is given", () => {
    expect(limitFrom([], 12, 50)).toBe(12);
  });

  it("takes the first numeric argument", () => {
    expect(limitFrom(["5"], 12, 50)).toBe(5);
    expect(limitFrom(["gata", "7"], 12, 50)).toBe(7);
  });

  it("clamps to the maximum", () => {
    // One typo must not turn into a 10,000-row read against a public endpoint.
    expect(limitFrom(["100000"], 12, 50)).toBe(50);
  });

  it("clamps zero and refuses to return an empty page", () => {
    expect(limitFrom(["0"], 12, 50)).toBe(1);
  });

  it("ignores a negative, which is not a count", () => {
    // "-5" fails the digit test, so the fallback stands rather than clamping to 1.
    expect(limitFrom(["-5"], 12, 50)).toBe(12);
  });
});

describe("COMMAND_NAMES", () => {
  it("is what Tab completion offers, so it must have no duplicates", () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  });

  it("names only lowercase commands, since the parser lowercases input", () => {
    for (const name of COMMAND_NAMES) expect(name).toBe(name.toLowerCase());
  });
});
