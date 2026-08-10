import { describe, expect, it } from "vitest";
import { RELAYER_MSG_TYPES } from "@/lib/relayers";
import { routeIsLive } from "@/lib/ibc-routes";
import type { RouteHealth, SideHealth } from "@/lib/ibc-routes";

function side(over: Partial<SideHealth> = {}): SideHealth {
  return {
    chainId: "atomone-1",
    channelId: "channel-2",
    portId: "transfer",
    clientId: "07-tendermint-2",
    connectionId: "connection-2",
    prettyName: "AtomOne",
    accent: "#F5C66B",
    clientStatus: "Active",
    channelState: "open",
    pendingPackets: 0,
    ...over,
  };
}

const route = (a: Partial<SideHealth>, b: Partial<SideHealth> = {}): RouteHealth => ({
  a: side(a),
  b: side(b),
});

describe("routeIsLive", () => {
  it("is live when both clients are active and both channels open", () => {
    expect(routeIsLive(route({}, {}))).toBe(true);
  });

  it("is not live when the far client has expired", () => {
    // The case this exists for: a channel reads OPEN on both sides while the
    // counterparty's light client has lapsed, and nothing can pass until
    // someone recovers it. Judging by channel state alone calls this healthy.
    expect(routeIsLive(route({}, { clientStatus: "Expired" }))).toBe(false);
  });

  it("is not live when the near client has expired", () => {
    expect(routeIsLive(route({ clientStatus: "Expired" }))).toBe(false);
  });

  it("treats a frozen client as not live", () => {
    // Frozen means misbehaviour was proven against it. Never usable again.
    expect(routeIsLive(route({ clientStatus: "Frozen" }))).toBe(false);
  });

  it("is not live when a channel has closed", () => {
    expect(routeIsLive(route({}, { channelState: "closed" }))).toBe(false);
  });

  it("refuses to call a route live when a probe failed", () => {
    // Null means the endpoint did not answer. Absence of a problem is not
    // evidence of health.
    expect(routeIsLive(route({ clientStatus: null }))).toBe(false);
    expect(routeIsLive(route({ channelState: null }))).toBe(false);
  });
});

describe("RELAYER_MSG_TYPES", () => {
  it("excludes MsgTransfer", () => {
    // A transfer's signer is a user moving their own funds. Counting it would
    // rank ordinary traffic as relayer infrastructure.
    expect(RELAYER_MSG_TYPES).not.toContain(
      "/ibc.applications.transfer.v1.MsgTransfer"
    );
  });

  it("covers the messages that actually deliver a packet", () => {
    expect(RELAYER_MSG_TYPES).toContain("/ibc.core.channel.v1.MsgRecvPacket");
    expect(RELAYER_MSG_TYPES).toContain(
      "/ibc.core.channel.v1.MsgAcknowledgement"
    );
  });
});
