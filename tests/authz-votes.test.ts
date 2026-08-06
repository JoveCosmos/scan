import { describe, expect, it } from "vitest";
import { flattenVoteMessages } from "@/lib/proposals";

// Shape taken verbatim from a real AtomOne transaction: GATA HUB's vote on
// proposal 21, cast by a hot key holding an authz grant.
const AUTHZ_VOTE = {
  "@type": "/cosmos.authz.v1beta1.MsgExec",
  grantee: "atone1whjay3z7ww5zzhydxpt8xffu587jh9906fz463",
  msgs: [
    {
      "@type": "/atomone.gov.v1.MsgVote",
      proposal_id: "21",
      voter: "atone10unx6s0cdqntvrumd5hs07rgd5ytcztqun3e53",
      option: "VOTE_OPTION_YES",
    },
  ],
};

const PLAIN_VOTE = {
  "@type": "/cosmos.gov.v1.MsgVote",
  proposal_id: "21",
  voter: "atone1plain",
  option: "VOTE_OPTION_NO",
};

describe("flattenVoteMessages", () => {
  it("unwraps a vote nested in an authz MsgExec", () => {
    const flat = flattenVoteMessages([AUTHZ_VOTE]);
    expect(flat).toHaveLength(1);
    expect(flat[0].proposal_id).toBe("21");
    // The granter is the voter; the grantee is only the key that broadcast it.
    expect(flat[0].voter).toBe("atone10unx6s0cdqntvrumd5hs07rgd5ytcztqun3e53");
  });

  it("leaves a plain top-level vote untouched", () => {
    expect(flattenVoteMessages([PLAIN_VOTE])[0].voter).toBe("atone1plain");
  });

  it("handles a mix of wrapped and unwrapped votes", () => {
    const flat = flattenVoteMessages([AUTHZ_VOTE, PLAIN_VOTE]);
    expect(flat.map((m) => m.voter)).toEqual([
      "atone10unx6s0cdqntvrumd5hs07rgd5ytcztqun3e53",
      "atone1plain",
    ]);
  });

  it("unwraps more than one vote from a single MsgExec", () => {
    const batch = {
      "@type": "/cosmos.authz.v1beta1.MsgExec",
      grantee: "atone1grantee",
      msgs: [PLAIN_VOTE, { ...PLAIN_VOTE, voter: "atone1second" }],
    };
    expect(flattenVoteMessages([batch])).toHaveLength(2);
  });

  it("survives a MsgExec with no inner messages", () => {
    const empty = { "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: "x" };
    expect(flattenVoteMessages([empty])).toEqual([]);
  });

  it("stops recursing on pathological nesting rather than hanging", () => {
    // Deliberately deeper than the cap.
    let nested: Record<string, unknown> = PLAIN_VOTE;
    for (let i = 0; i < 12; i++) {
      nested = { "@type": "/cosmos.authz.v1beta1.MsgExec", msgs: [nested] };
    }
    expect(() => flattenVoteMessages([nested as never])).not.toThrow();
    expect(flattenVoteMessages([nested as never])).toEqual([]);
  });

  it("returns nothing for undefined input", () => {
    expect(flattenVoteMessages(undefined)).toEqual([]);
  });
});
