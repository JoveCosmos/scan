/**
 * Which message each of a transaction's events belongs to.
 *
 * A transaction's ABCI events are one flat list: the ante handler's (fee
 * deduction, sequence, signature) first, then each message's in order. Since
 * AtomOne's SDK upgrade at ~9,550,000 every message event carries `msg_index`
 * (and `authz_msg_index` inside a MsgExec), so the grouping is on the wire.
 * Before it there was no `msg_index` at all, and reading "no index" as "outside
 * any message" is how every pre-upgrade transfer came to be stored as a fee.
 *
 * For those transactions the grouping is recovered from the result's `log`,
 * which lists each message's events - exactly the flat list's tail, in the same
 * order, without the ante handler's prefix. The alignment is checked event by
 * event (type and attributes) before it is trusted; when it does not hold, the
 * boundaries fall back to the `message` events that carry an `action`, which the
 * SDK emits once at the start of every top-level message.
 *
 * `seq` is the event's ordinal in the transaction - the one key that is unique
 * however many same-type events a message emits (a MultiSend's outputs, an authz
 * batch's inner withdrawals), which is why rows derived from events are keyed on
 * it rather than on (message, type).
 */
import type { Event, TxResult } from "./extract";

export interface Placed {
  type: string;
  /** Attributes as a plain object; later keys of the same name win. */
  a: Record<string, string>;
  /** Every attribute, in order, for the few readers that need repeats. */
  list: { key: string; value: string }[];
  /** Ordinal of this event within the transaction's events. */
  seq: number;
  /** -1 for the ante handler (fee, sequence, signature), else the message index. */
  msgIndex: number;
  /** Index of the inner message inside an authz MsgExec, when it is one. */
  authzIndex: number | null;
}

/** How the grouping was established, for tests and for the extractor's own checks. */
export type Grouping = "attribute" | "log" | "action" | "none";

function attrList(ev: Event): { key: string; value: string }[] {
  return (ev.attributes ?? [])
    .filter((x) => x.key)
    .map((x) => ({ key: x.key, value: x.value ?? "" }));
}

function toObject(list: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const x of list) out[x.key] = x.value;
  return out;
}

interface LogMsg {
  msg_index?: number | string;
  events?: { type?: string; attributes?: { key?: string; value?: string }[] }[];
}

function parseLog(log: string | undefined): LogMsg[] | null {
  if (!log || log[0] !== "[") return null;
  try {
    const v = JSON.parse(log);
    return Array.isArray(v) ? (v as LogMsg[]) : null;
  } catch {
    return null;
  }
}

/** Same event: same type and the same attributes, keys and values, in order. */
function sameEvent(
  flat: { type: string; list: { key: string; value: string }[] },
  logged: { type?: string; attributes?: { key?: string; value?: string }[] }
): boolean {
  if (flat.type !== logged.type) return false;
  // Attributes the flat list adds for grouping are not in the log.
  const f = flat.list.filter((x) => x.key !== "msg_index" && x.key !== "authz_msg_index");
  const l = (logged.attributes ?? []).filter(
    (x) => x.key !== "msg_index" && x.key !== "authz_msg_index"
  );
  if (f.length !== l.length) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i].key !== l[i].key || f[i].value !== (l[i].value ?? "")) return false;
  }
  return true;
}

export function placeEvents(result: TxResult): { events: Placed[]; grouping: Grouping } {
  const raw = result.events ?? [];
  const base = raw.map((ev, seq) => {
    const list = attrList(ev);
    return { type: ev.type, list, a: toObject(list), seq };
  });

  const authzOf = (a: Record<string, string>) =>
    a.authz_msg_index === undefined || a.authz_msg_index === ""
      ? null
      : Number(a.authz_msg_index);

  // Post-upgrade: the grouping is an attribute on every message event.
  if (base.some((e) => e.a.msg_index !== undefined)) {
    return {
      grouping: "attribute",
      events: base.map((e) => ({
        ...e,
        msgIndex: e.a.msg_index === undefined ? -1 : Number(e.a.msg_index),
        authzIndex: authzOf(e.a),
      })),
    };
  }

  const none = (): Placed[] =>
    base.map((e) => ({ ...e, msgIndex: -1, authzIndex: authzOf(e.a) }));

  // A failed transaction ran no messages: its log is an error string and every
  // event it has is the ante handler's.
  if ((result.code ?? 0) !== 0) return { grouping: "none", events: none() };

  // Pre-upgrade: align the log's per-message events with the flat list's tail.
  const log = parseLog(result.log);
  if (log && log.length > 0) {
    const expected: { msg: number; ev: NonNullable<LogMsg["events"]>[number] }[] = [];
    log.forEach((m, k) => {
      const idx = m.msg_index === undefined ? k : Number(m.msg_index);
      for (const ev of m.events ?? []) expected.push({ msg: idx, ev });
    });
    const start = base.length - expected.length;
    if (start >= 0 && expected.every((x, i) => sameEvent(base[start + i], x.ev))) {
      return {
        grouping: "log",
        events: base.map((e) => ({
          ...e,
          msgIndex: e.seq < start ? -1 : expected[e.seq - start].msg,
          authzIndex: authzOf(e.a),
        })),
      };
    }
  }

  // Fallback: each top-level message starts with a `message` event carrying its
  // action (inner authz messages never do); everything before the first is ante.
  let msg = -1;
  let found = false;
  const placed = base.map((e) => {
    if (e.type === "message" && e.a.action) {
      msg += 1;
      found = true;
    }
    return { ...e, msgIndex: msg, authzIndex: authzOf(e.a) };
  });
  return found ? { grouping: "action", events: placed } : { grouping: "none", events: none() };
}
