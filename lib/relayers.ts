/**
 * Which messages count as relaying.
 *
 * Used to attribute relay work to operators from indexed transaction history.
 * Relaying leaves no trace in module state — a delivered packet looks the same
 * whoever delivered it — so the transaction is the only durable record, and the
 * fee payer is the only identity in it.
 */
export const RELAYER_MSG_TYPES = [
  "/ibc.core.channel.v1.MsgRecvPacket",
  "/ibc.core.channel.v1.MsgAcknowledgement",
  "/ibc.core.channel.v1.MsgTimeout",
  "/ibc.core.channel.v1.MsgTimeoutOnClose",
  "/ibc.core.client.v1.MsgUpdateClient",
];
