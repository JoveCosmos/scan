import { describe, expect, test } from "vitest";
import { applyUsers, atName, type GnoNames } from "@/lib/gno-users";

const ev = (type: string, attrs: Record<string, string>) => ({
  type,
  pkg_path: "gno.land/r/sys/users",
  attrs: Object.entries(attrs).map(([key, value]) => ({ key, value })),
});
const tx = (height: number, ...events: ReturnType<typeof ev>[]) => ({ hash: "x", block_height: height, response: { events } });

describe("gno.land names from r/sys/users events", () => {
  test("register, rename (old name still resolves) and delete", () => {
    const names: GnoNames = { byAddress: new Map(), byName: new Map() };
    applyUsers(names, [
      tx(0, ev("Registered", { name: "moul", address: "g1m" })),
      tx(5, ev("Registered", { name: "aeddi", address: "g1a" })),
      tx(9, ev("Updated", { alias: "manfred", address: "g1m" })),
    ]);
    expect(atName(names, "g1m")).toBe("@manfred");
    expect(names.byName.get("moul")).toBe("g1m");
    applyUsers(names, [tx(12, ev("Deleted", { address: "g1a" }))]);
    expect(atName(names, "g1a")).toBeNull();
    expect(names.byName.has("aeddi")).toBe(false);
    expect(atName(names, "g1nobody")).toBeNull();
  });
});
