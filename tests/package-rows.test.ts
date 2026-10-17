import { describe, expect, test } from "vitest";
import { realmRows } from "@/app/[chain]/packages/rows";

const deploy = { path: "gno.land/r/gnoswap/router", creator: "g1deployer", height: 77000, txHash: "AB", time: "2026-06-01 00:00:00+00" };

describe("the realm list", () => {
  test("calls with a bar against the busiest, the last call's age, and a realm never called", () => {
    const calls = new Map([["gno.land/r/gnoswap/router", { calls: 4000, lastHeight: 857000, lastTime: new Date(Date.now() - 120_000).toISOString() }]]);
    const rows = realmRows(
      "gnoland-1",
      [
        { path: "gno.land/r/gnoswap/router", deploy },
        { path: "gno.land/r/quiet/realm", deploy: null },
      ],
      null,
      calls
    );
    expect(rows[0].cells[2]).toMatchObject({ v: "4,000", bar: 1 });
    expect(rows[0].cells[3].v).toBe("2m ago");
    expect(rows[0].detail.rows.map((r) => r.label)).toEqual(["Deployed in", "Calls", "Last call"]);
    expect(rows[1].cells[2]).toMatchObject({ v: "0", bar: 0, dim: true });
    expect(rows[1].cells[3].v).toBe("Never");
  });

  test("N/A when the index cannot answer", () => {
    const rows = realmRows("gnoland-1", [{ path: "gno.land/r/gnoswap/router", deploy }], null, null);
    expect(rows[0].cells[2].v).toBe("N/A");
    expect(rows[0].cells[3].v).toBe("N/A");
  });
});
