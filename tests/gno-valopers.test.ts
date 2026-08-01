import { describe, it, expect } from "vitest";
import { parseValoperList, parseValoperDetail } from "@/lib/gno-valopers";
import { txHashFromBase64, labelForType } from "@/lib/txs";

const LIST = `
# Welcome to the **Valopers** realm

 * [Kleomedes](/r/gnops/valopers:g1c5z9tqmcjendp46l8v6c2lu8xmrdyrk0tp5vn3) - [profile](/r/demo/profile:u/g1c5z9tqmcjendp46l8v6c2lu8xmrdyrk0tp5vn3)
 * [gno-core-val-01](/r/gnops/valopers:g18x425qmujg99cfz3q97y4uep5pxjq3z8lmpt25) - [profile](/r/demo/profile:u/g18x425qmujg99cfz3q97y4uep5pxjq3z8lmpt25)

**1** | [2](?page=2)
`;

const DETAIL = `Valoper's details:
## Kleomedes
# Validator Profile: Kleomedes

Some validator-authored prose with a [link](https://example.com).

- Operator Address: g1c5z9tqmcjendp46l8v6c2lu8xmrdyrk0tp5vn3
- Signing Address: g18rrrqz8tuls2m9lh06y3luw3r2epvwy8mezvqw
- Signing PubKey: gpub1pggj7ard9eg82cjtv4u52epjx56nzwgjyg9zpzup6c6xcdwygcz736fwv3z355c99q9pyx5vkk8m39g397z4kc23urdeal
- Server Type: on-prem

[Profile link](/r/demo/profile:u/g1c5z9tqmcjendp46l8v6c2lu8xmrdyrk0tp5vn3)
`;

describe("parseValoperList", () => {
  it("extracts moniker and operator address per row", () => {
    const rows = parseValoperList(LIST);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      moniker: "Kleomedes",
      operatorAddress: "g1c5z9tqmcjendp46l8v6c2lu8xmrdyrk0tp5vn3",
    });
  });

  it("ignores the pager and prose, not just the bullets", () => {
    expect(parseValoperList(LIST).some((r) => r.moniker.includes("Welcome"))).toBe(false);
  });

  it("returns nothing for an empty page rather than throwing", () => {
    expect(parseValoperList("")).toEqual([]);
  });
});

describe("parseValoperDetail", () => {
  const op = "g1c5z9tqmcjendp46l8v6c2lu8xmrdyrk0tp5vn3";

  it("reads the trailing metadata block", () => {
    const p = parseValoperDetail(DETAIL, op)!;
    expect(p.moniker).toBe("Kleomedes");
    expect(p.operatorAddress).toBe(op);
    expect(p.signingAddress).toBe("g18rrrqz8tuls2m9lh06y3luw3r2epvwy8mezvqw");
    expect(p.serverType).toBe("on-prem");
    expect(p.signingPubKey?.startsWith("gpub1")).toBe(true);
  });

  it("keeps the description but strips the preamble and duplicate heading", () => {
    const p = parseValoperDetail(DETAIL, op)!;
    expect(p.description).toContain("validator-authored prose");
    expect(p.description).not.toContain("Valoper's details:");
    // The trailing metadata belongs in fields, not in the prose.
    expect(p.description).not.toContain("Signing PubKey");
  });

  it("returns null for the realm's unknown-address response", () => {
    expect(parseValoperDetail("unknown address g1nope", op)).toBeNull();
    expect(parseValoperDetail("", op)).toBeNull();
  });

  it("falls back to the operator address when there is no heading", () => {
    const noHeading = "- Operator Address: " + op + "\n- Signing Address: g1abc\n";
    expect(parseValoperDetail(noHeading, op)!.moniker).toBe(op);
  });
});

describe("txHashFromBase64", () => {
  it("derives the hash the node reports for the same bytes", () => {
    // sha256 of the empty payload, upper-cased hex — a fixed, checkable vector.
    expect(txHashFromBase64("")).toBe(
      "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"
    );
  });

  it("is stable and upper case", () => {
    const h = txHashFromBase64("CgoKCHNvbWV0aGluZw==");
    expect(h).toMatch(/^[0-9A-F]{64}$/);
    expect(txHashFromBase64("CgoKCHNvbWV0aGluZw==")).toBe(h);
  });
});

describe("labelForType", () => {
  it("maps known message types to readable labels", () => {
    expect(labelForType("/cosmos.bank.v1beta1.MsgSend")).toBe("Send");
    expect(labelForType("/ibc.core.client.v1.MsgUpdateClient")).toBe("IBC Update Client");
  });

  it("derives something readable for an unmapped type", () => {
    expect(labelForType("/cosmos.foo.v1.MsgDoSomethingNew")).toBe("Do Something New");
  });
});
