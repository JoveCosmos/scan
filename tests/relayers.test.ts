import { describe, expect, it } from "vitest";
import { sortChannels, RELAYER_MSG_TYPES, type IbcChannel } from "@/lib/relayers";

function channel(over: Partial<IbcChannel> & { channelId: string }): IbcChannel {
  return {
    portId: "transfer",
    state: "open",
    ordering: "unordered",
    counterpartyChannelId: "channel-0",
    counterpartyPortId: "transfer",
    connectionId: "connection-0",
    counterpartyChainId: null,
    counterpartyName: null,
    ...over,
  };
}

const ids = (channels: IbcChannel[]) => channels.map((c) => c.channelId);

describe("sortChannels", () => {
  it("orders by channel number, not by string", () => {
    // The failure this exists to prevent: as strings, channel-100 sorts above
    // channel-9. Correct on a chain with nine channels, wrong on every real one.
    const sorted = sortChannels([
      channel({ channelId: "channel-100" }),
      channel({ channelId: "channel-9" }),
      channel({ channelId: "channel-21" }),
    ]);
    expect(ids(sorted)).toEqual(["channel-9", "channel-21", "channel-100"]);
  });

  it("puts open channels above every other state", () => {
    const sorted = sortChannels([
      channel({ channelId: "channel-1", state: "closed" }),
      channel({ channelId: "channel-2", state: "open" }),
      channel({ channelId: "channel-3", state: "init" }),
    ]);
    expect(ids(sorted)[0]).toBe("channel-2");
  });

  it("keeps open channels ordered among themselves", () => {
    const sorted = sortChannels([
      channel({ channelId: "channel-7" }),
      channel({ channelId: "channel-2", state: "closed" }),
      channel({ channelId: "channel-3" }),
    ]);
    expect(ids(sorted)).toEqual(["channel-3", "channel-7", "channel-2"]);
  });

  it("sinks unparseable ids instead of leaving them unordered", () => {
    // NaN compares false against everything, which leaves sort order undefined.
    const sorted = sortChannels([
      channel({ channelId: "weird" }),
      channel({ channelId: "channel-5" }),
    ]);
    expect(ids(sorted)).toEqual(["channel-5", "weird"]);
  });

  it("does not mutate its input", () => {
    const input = [
      channel({ channelId: "channel-2" }),
      channel({ channelId: "channel-1" }),
    ];
    sortChannels(input);
    expect(ids(input)).toEqual(["channel-2", "channel-1"]);
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
