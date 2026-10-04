/** Synthetic fixtures for the ledger tests. Signatures are placeholder bytes: this layer does not verify them. */
import { HashChainedLedger } from "../src/ledger/chain.js";
import type { LedgerEvent } from "../src/ledger/events.js";

export const SIG = `0x${"ab".repeat(65)}`;
export const HASH_A = "a".repeat(64);

export const auth = (nonce = "nonce_1", scheme = "EIP712_LEDGER_ACTION_V1") => ({ scheme, requestNonce: nonce, expiresAt: 2_000_000_000_000, signature: SIG });
export const coAuth = (nonce = "approval_1") => ({ approverId: "approver_1", ...auth(nonce, "EIP712_LEDGER_ANNULMENT_APPROVAL_V1") });


const base = (ipoId: string, actorId: string) => ({ ipoId, actorId, authorization: auth(), registrySeq: 1, requestedAt: 1_800_000_000_000 });

export const participate = (fundId = "fund_x", ipoId = "ipo_1", extra: Record<string, unknown> = {}) => ({
  ...base(ipoId, "manager_x"),
  eventType: "PARTICIPATION_RECORDED",
  subjectFundId: fundId,
  coAuthorizations: [],
  payload: { from: "UNKNOWN", to: "PARTICIPATING", origin: "INDEPENDENT" },
  ...extra,
});

export const participateBound = (fundId = "fund_x", ipoId = "ipo_1", bidId = "bid_1") =>
  participate(fundId, ipoId, { payload: { from: "UNKNOWN", to: "PARTICIPATING", origin: "BIND_1", bidId } });

export const lock = (fundId = "fund_x", ipoId = "ipo_1", extra: Record<string, unknown> = {}) => ({
  ...base(ipoId, "manager_x"),
  eventType: "NON_PARTICIPATION_LOCKED_RECORDED",
  subjectFundId: fundId,
  coAuthorizations: [],
  payload: { from: "UNKNOWN", to: "NON_PARTICIPATION_LOCKED", origin: "INDEPENDENT" },
  ...extra,
});

export const close = (ledgerSeqAtClose: number, ipoId = "ipo_1") => ({
  ...base(ipoId, "operator_1"),
  eventType: "IPO_CLOSED",
  subjectFundId: null,
  coAuthorizations: [],
  payload: { closesAt: 1_800_000_000_000, ledgerSeqAtClose },
});

export const annul = (
  target: Pick<LedgerEvent, "seq" | "eventHash">,
  o: { fundId?: string; ipoId?: string; reason?: string; replacement?: string | null; bidId?: string; co?: unknown[] } = {},
) => {
  const reason = o.reason ?? "MISTAKEN_ENTRY";
  return {
    ...base(o.ipoId ?? "ipo_1", "manager_x"),
    eventType: "EVENT_ANNULLED",
    subjectFundId: o.fundId ?? "fund_x",
    coAuthorizations: o.co ?? (reason === "BID_WITHDRAWN" ? [] : [coAuth()]),
    payload: {
      targetSeq: target.seq,
      targetEventHash: target.eventHash,
      reason,
      replacement: o.replacement ?? null,
      ...(o.bidId === undefined ? {} : { bidId: o.bidId }),
    },
  };
};

/** Ledger with a deterministic clock that ticks 1 ms per event. */
/** Ledger id of the low-level chain tests (a chain is always the log of a named ledger, L-B). */
export const TEST_CHAIN_ID = "ledger_chain_test";

export function newLedger(start = 1_800_000_000_000): { ledger: HashChainedLedger; clock: { t: number } } {
  const clock = { t: start };
  return { ledger: new HashChainedLedger(() => clock.t++, { ledgerId: TEST_CHAIN_ID }), clock };
}

export function must(r: { ok: boolean; events?: readonly LedgerEvent[] }): readonly LedgerEvent[] {
  if (!r.ok || r.events === undefined) throw new Error(`fixture append rejected: ${JSON.stringify(r)}`);
  return r.events;
}

/** A mutable deep copy of events, as a storage layer would hand back. */
export const plain = (events: readonly LedgerEvent[]): Record<string, unknown>[] => JSON.parse(JSON.stringify(events)) as Record<string, unknown>[];

/** Non-null access for tests (the lint rules forbid `!`). */
export function def<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected a value");
  return v;
}

/** The event without its eventHash, as the hash input. */
export function withoutHash(e: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...e };
  delete copy["eventHash"];
  return copy;
}
