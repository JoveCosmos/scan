import { describe, expect, test } from "vitest";
import { isPackagePath, packageHref, shortPath } from "@/lib/gno-packages";
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

  test("search reads paths, gno.land links and render paths", () => {
    expect(classifySearch("gno.land/r/gov/dao")).toEqual({ kind: "gnoPath", value: "gno.land/r/gov/dao", render: undefined });
    expect(classifySearch("https://gno.land/r/gov/dao/")).toEqual({ kind: "gnoPath", value: "gno.land/r/gov/dao", render: undefined });
    expect(classifySearch("gno.land/r/gov/dao:13")).toEqual({ kind: "gnoPath", value: "gno.land/r/gov/dao", render: "13" });
  });
});
