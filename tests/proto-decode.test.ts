import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/proto-msgs.json";
import { decodeRawMessage } from "@/lib/proto-decode";
import { decodeMessage } from "@/lib/msg-decode";

/**
 * Real AtomOne messages, raw protobuf value as tx_msg.raw holds it. The recent
 * ones carry the REST API's own JSON for the same message (captured
 * 2026-10-13), so the decoder is held to exactly what lib/msg-decode already
 * reads from the node. Fields the API prints but Scan never reads (keys,
 * proofs, client headers) are left out of the comparison.
 */

const SKIP = new Set(["pubkey", "proof_height", "proof_commitment", "proof_acked", "proof_unreceived", "client_message"]);
const norm = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(norm)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as object).filter(([k]) => !SKIP.has(k)).map(([k, x]) => [k, norm(x)]))
      : v;

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

describe("decodeRawMessage", () => {
  for (const f of fixtures.filter((x) => x.exact)) {
    it(`matches the REST API for ${f.typeUrl}`, () => {
      expect(norm(decodeRawMessage(f.typeUrl, bytes(f.value)))).toEqual(norm(f.expected));
    });
  }

  it("leaves an unchanged commission out of an edit, rather than reading it as 0%", () => {
    const f = fixtures.find((x) => x.typeUrl === "/cosmos.staking.v1beta1.MsgEditValidator")!;
    const m = decodeRawMessage(f.typeUrl, bytes(f.value))!;
    expect(m.commission_rate).toBeNull();
    const fields = decodeMessage("atomone-1", f.typeUrl, m).fields.map((x) => x.label);
    expect(fields).not.toContain("Commission");
  });

  it("decodes a legacy proposal's content, so its title shows", () => {
    const f = fixtures.find((x) => x.typeUrl === "/atomone.gov.v1beta1.MsgSubmitProposal")!;
    const m = decodeRawMessage(f.typeUrl, bytes(f.value))!;
    expect((m.content as { title: string }).title).toBe("IBC Transfers Enablement Proposal");
    const title = decodeMessage("atomone-1", f.typeUrl, m).fields.find((x) => x.label === "Title");
    expect(title?.value).toMatchObject({ text: "IBC Transfers Enablement Proposal" });
  });

  it("returns null for a type without a layout, and for bytes that do not parse", () => {
    expect(decodeRawMessage("/some.unknown.v1.MsgThing", bytes("CgVoZWxsbw=="))).toBeNull();
    expect(decodeRawMessage("/cosmos.bank.v1beta1.MsgSend", Uint8Array.from([0x0a, 0xff]))).toBeNull();
  });
});
