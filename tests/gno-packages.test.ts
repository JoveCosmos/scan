import { describe, expect, test } from "vitest";
import { isPackagePath, packageHref, realmAddress, shortPath } from "@/lib/gno-packages";
import { classifySearch } from "@/lib/search";

describe("gno.land package paths", () => {
  test("realms and packages only", () => {
    expect(isPackagePath("gno.land/r/gov/dao")).toBe(true);
    expect(isPackagePath("gno.land/p/nt/ufmt/v0")).toBe(true);
    expect(isPackagePath("gno.land/x/gov")).toBe(false);
    expect(isPackagePath("gno.land/r")).toBe(false);
    expect(isPackagePath("strings")).toBe(false);
  });

  test("shortened for lists and linked without the domain", () => {
    expect(shortPath("gno.land/r/g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt/gnocial")).toBe("r/g1n4pl…rhmt/gnocial");
    expect(shortPath("gno.land/r/gov/dao")).toBe("r/gov/dao");
    expect(packageHref("gnoland-1", "gno.land/r/gov/dao")).toBe("/gnoland-1/packages/r/gov/dao");
  });

  test("a realm's account address is derived from its path", () => {
    // Gnoswap's pool and launchpad, as they hold tokens on gnoland-1.
    expect(realmAddress("gno.land/r/gnoswap/pool")).toBe("g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v");
    expect(realmAddress("gno.land/r/gnoswap/launchpad")).toBe("g1x6r75sxlkp9zfqufew0vcuq9sfclsq8uaqkru9");
  });

  test("search reads paths, gno.land links and render paths", () => {
    expect(classifySearch("gno.land/r/gov/dao")).toEqual({ kind: "gnoPath", value: "gno.land/r/gov/dao", render: undefined });
    expect(classifySearch("https://gno.land/r/gov/dao/")).toEqual({ kind: "gnoPath", value: "gno.land/r/gov/dao", render: undefined });
    expect(classifySearch("gno.land/r/gov/dao:13")).toEqual({ kind: "gnoPath", value: "gno.land/r/gov/dao", render: "13" });
  });
});
