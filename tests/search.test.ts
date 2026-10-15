import { describe, it, expect } from "vitest";
import { classifySearch, secpKeyToAddress } from "@/lib/search";

describe("classifySearch", () => {
  it("accepts 0x and lower-case hex hashes", () => {
    expect(classifySearch(`0x${"ab".repeat(32)}`)).toEqual({ kind: "txHex", value: "AB".repeat(32) });
  });

  it("lower-cases bech32 and keeps its prefix", () => {
    const s = classifySearch("COSMOS1Q6WMLXMM88WHF2C0MD89236T4N9ZPAQGCREUA4");
    expect(s).toEqual({
      kind: "bech32",
      prefix: "cosmos",
      address: "cosmos1q6wmlxmm88whf2c0md89236t4n9zpaqgcreua4",
    });
  });

  it("recognises consensus addresses, keys and 40-hex consensus ids", () => {
    expect(classifySearch("cosmosvalcons1ge6evc3c9l9503a8hup9tqayzks9zslgjxma8e").kind).toBe("bech32");
    expect(classifySearch("FCTclUMmyeW0/Zi3vhO5b9+O9HKVCps4faHDj5Xx4Lo=").kind).toBe("base64Key32");
    expect(classifySearch("46759662382FCB47C7A7BF025583A415A05143E8")).toEqual({
      kind: "consHex",
      value: "46759662382FCB47C7A7BF025583A415A05143E8",
    });
  });

  it("recognises gno realm paths and names", () => {
    expect(classifySearch("gno.land/r/gnoswap/router").kind).toBe("gnoPath");
    expect(classifySearch("Coinbase01")).toEqual({ kind: "name", value: "Coinbase01" });
  });

  it("derives the account of a secp256k1 key", () => {
    // The well-known test key from the Cosmos SDK docs.
    const key = Buffer.from("02950e1cdfcb133d6024109fd489f734eeb4502418e538c28481f22bce276f248c", "hex");
    const s = classifySearch(key.toString("base64"));
    expect(s.kind).toBe("secpKey");
    expect(secpKeyToAddress(key, "cosmos")).toMatch(/^cosmos1[02-9ac-hj-np-z]{38}$/);
  });
});
