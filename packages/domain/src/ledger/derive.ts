/**
 * State derivation (fold) over ledger events (design §2.4, §5).
 *
 * The effective state of a (fund, IPO) pair is computed ONLY by folding events in `seq` order;
 * there is no separately mutable state map. "No event" is UNKNOWN, never "non-participating"
 * (principle C). Every participation state change goes through the existing `transition()`
 * (principle D): UNKNOWN -> PARTICIPATING / NON_PARTICIPATION_LOCKED only. Going back to UNKNOWN
 * happens only through an EVENT_ANNULLED event, which does not delete or edit its target.
 *
 * This is the STRUCTURAL/STATE part of the rules (R6, R7, R11-R13 and the structural side of R12/R15).
 * It does NOT authenticate or authorize anybody (R1-R5, R8's operator and clock conditions, R9,
 * R10's and R14's signature and independence checks, R15's bid store lookups): see events.ts.
 */
import type { FundId, IpoId } from "../model.js";
import { ParticipationState, TransitionRejection, transition } from "../participation.js";
import type { ParticipationLookup } from "../participation.js";
import { AnnulmentReason, LedgerEventType, ParticipationOrigin } from "./events.js";
import type { LedgerEvent, RecordedState } from "./events.js";

export const LedgerRejection = {
  ...TransitionRejection,
  /** A state event or correction for an IPO that already has IPO_CLOSED, or a second IPO_CLOSED (R6, R8, R13). */
  IPO_ALREADY_CLOSED: "IPO_ALREADY_CLOSED",
  /** payload.from does not match the derived state. */
  LEDGER_PAYLOAD_STATE_MISMATCH: "LEDGER_PAYLOAD_STATE_MISMATCH",
  /** IPO_CLOSED.payload.ledgerSeqAtClose is not seq - 1. */
  LEDGER_CLOSE_SEQ_MISMATCH: "LEDGER_CLOSE_SEQ_MISMATCH",
  /** Wrong target for EVENT_ANNULLED (R11); also a bid-withdrawal on something that is not a BIND-1 record (R15). */
  LEDGER_ANNUL_TARGET_INVALID: "LEDGER_ANNUL_TARGET_INVALID",
  /** A BIND-1 PARTICIPATING record may only be resolved by a bid withdrawal (R12). */
  LEDGER_ANNUL_BOUND_TO_BID: "LEDGER_ANNUL_BOUND_TO_BID",
  /** IPO_FINALIZED for an IPO without IPO_CLOSED (R19). */
  IPO_NOT_CLOSED: "IPO_NOT_CLOSED",
  /** IPO_FINALIZED whose ledgerSeqAtClose / ledgerHeadHashAtClose differ from the IPO's IPO_CLOSED (R19). */
  LEDGER_FINALIZATION_CUTOFF_MISMATCH: "LEDGER_FINALIZATION_CUTOFF_MISMATCH",
  /** A second IPO_FINALIZED for the same IPO, whatever its digest (R19). */
  IPO_ALREADY_FINALIZED: "IPO_ALREADY_FINALIZED",
  /** FINDING_ANNOTATED whose target is missing, not earlier, hash-mismatched, of another IPO, or itself an annotation (R17). */
  LEDGER_FINDING_TARGET_INVALID: "LEDGER_FINDING_TARGET_INVALID",
  /** MANAGER_KEY_REVOKED for a key that is already revoked (R18). */
  LEDGER_KEY_ALREADY_REVOKED: "LEDGER_KEY_ALREADY_REVOKED",
  /** A correction promised an atomic replacement event that did not directly follow it, or is missing. */
  LEDGER_ANNUL_REPLACEMENT_MISSING: "LEDGER_ANNUL_REPLACEMENT_MISSING",
} as const;
export type LedgerRejection = (typeof LedgerRejection)[keyof typeof LedgerRejection];

export type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly reasonCode: LedgerRejection };

interface Pending {
  readonly fundId: FundId;
  readonly ipoId: IpoId;
  readonly state: RecordedState;
}
interface StateEventInfo {
  readonly eventHash: string;
  readonly ipoId: IpoId;
  readonly fundId: FundId;
  readonly origin: ParticipationOrigin;
  readonly bidId: string | undefined;
  annulled: boolean;
}
/** What FINDING_ANNOTATED needs to know about every earlier event. */
interface EventInfo {
  readonly eventHash: string;
  readonly ipoId: IpoId | null;
  readonly eventType: LedgerEventType;
}
interface KeyState {
  effective: ParticipationState;
  /** seq of the event that created the current effective state (null if UNKNOWN). */
  currentEventSeq: number | null;
  /** (seq at which the state took effect, state), ascending. */
  history: { readonly seq: number; readonly state: ParticipationState }[];
}

const key = (fundId: FundId, ipoId: IpoId): string => JSON.stringify([fundId, ipoId]);
const reject = (reasonCode: LedgerRejection): ApplyResult => ({ ok: false, reasonCode });
const OK: ApplyResult = { ok: true };

/**
 * Incremental fold. `apply` is all-or-nothing: a rejected event changes nothing.
 * Events must be given in `seq` order; seq/prevHash/hash consistency is the chain's job (chain.ts).
 */
export class LedgerProjection implements ParticipationLookup {
  private readonly keys = new Map<string, KeyState>();
  private readonly stateEvents = new Map<number, StateEventInfo>();
  private readonly closed = new Map<IpoId, { readonly closedAtSeq: number; readonly ledgerSeqAtClose: number; readonly ledgerHeadHashAtClose: string }>();
  private readonly finalized = new Set<IpoId>();
  private readonly revokedKeys = new Set<string>();
  private readonly allEvents = new Map<number, EventInfo>();
  private pending: Pending | null = null;

  /** Current effective state. UNKNOWN for any pair without a (non-annulled) record. */
  getState(fundId: FundId, ipoId: IpoId): ParticipationState {
    return this.keys.get(key(fundId, ipoId))?.effective ?? ParticipationState.UNKNOWN;
  }

  /**
   * Effective state as of `atSeq` (events with seq <= atSeq; later events, including later
   * corrections, are ignored). Invalid `atSeq` gives UNKNOWN (fail closed).
   */
  getStateAt(fundId: FundId, ipoId: IpoId, atSeq: number): ParticipationState {
    if (!Number.isSafeInteger(atSeq)) return ParticipationState.UNKNOWN;
    const history = this.keys.get(key(fundId, ipoId))?.history ?? [];
    let state: ParticipationState = ParticipationState.UNKNOWN;
    for (const h of history) {
      if (h.seq > atSeq) break;
      state = h.state;
    }
    return state;
  }

  isClosed(ipoId: IpoId): boolean {
    return this.closed.has(ipoId);
  }

  /** `ledgerSeqAtClose` of the IPO, or undefined if it is not closed. */
  cutoffSeq(ipoId: IpoId): number | undefined {
    return this.closed.get(ipoId)?.ledgerSeqAtClose;
  }

  isFinalized(ipoId: IpoId): boolean {
    return this.finalized.has(ipoId);
  }

  /** True once a MANAGER_KEY_REVOKED event for exactly this manager and key id is in the log (R9). */
  isKeyRevoked(managerId: string, keyId: string): boolean {
    return this.revokedKeys.has(JSON.stringify([managerId, keyId]));
  }

  /** True while a correction's atomic replacement event is still owed. A committed ledger never has this. */
  hasPendingReplacement(): boolean {
    return this.pending !== null;
  }

  clone(): LedgerProjection {
    const c = new LedgerProjection();
    for (const [k, v] of this.keys) c.keys.set(k, { effective: v.effective, currentEventSeq: v.currentEventSeq, history: [...v.history] });
    for (const [k, v] of this.stateEvents) c.stateEvents.set(k, { ...v });
    for (const [k, v] of this.closed) c.closed.set(k, v);
    for (const v of this.finalized) c.finalized.add(v);
    for (const v of this.revokedKeys) c.revokedKeys.add(v);
    for (const [k, v] of this.allEvents) c.allEvents.set(k, v);
    c.pending = this.pending;
    return c;
  }

  apply(event: LedgerEvent): ApplyResult {
    // An owed replacement must be the very next event, nothing else.
    if (this.pending !== null && !this.isOwedReplacement(event, this.pending)) {
      return reject(LedgerRejection.LEDGER_ANNUL_REPLACEMENT_MISSING);
    }
    const result = this.applyChecked(event);
    // Only an accepted event is remembered, so a rejected one cannot become an annotation target.
    if (result.ok) this.allEvents.set(event.seq, { eventHash: event.eventHash, ipoId: event.ipoId, eventType: event.eventType });
    return result;
  }

  private applyChecked(event: LedgerEvent): ApplyResult {
    switch (event.eventType) {
      case LedgerEventType.IPO_FINALIZED: {
        const closed = this.closed.get(event.ipoId);
        if (closed === undefined) return reject(LedgerRejection.IPO_NOT_CLOSED);
        if (
          event.payload.ledgerSeqAtClose !== closed.ledgerSeqAtClose ||
          event.payload.ledgerHeadHashAtClose !== closed.ledgerHeadHashAtClose
        ) {
          return reject(LedgerRejection.LEDGER_FINALIZATION_CUTOFF_MISMATCH);
        }
        if (this.finalized.has(event.ipoId)) return reject(LedgerRejection.IPO_ALREADY_FINALIZED);
        this.finalized.add(event.ipoId);
        return OK;
      }
      case LedgerEventType.FINDING_ANNOTATED: {
        const target = this.allEvents.get(event.payload.targetSeq);
        if (
          target === undefined ||
          event.payload.targetSeq >= event.seq ||
          target.eventHash !== event.payload.targetEventHash ||
          target.ipoId !== event.ipoId ||
          target.eventType === LedgerEventType.FINDING_ANNOTATED
        ) {
          return reject(LedgerRejection.LEDGER_FINDING_TARGET_INVALID);
        }
        return OK; // an annotation never changes any participation state
      }
      case LedgerEventType.MANAGER_KEY_REVOKED: {
        const k = JSON.stringify([event.payload.managerId, event.payload.revokedKeyId]);
        if (this.revokedKeys.has(k)) return reject(LedgerRejection.LEDGER_KEY_ALREADY_REVOKED);
        this.revokedKeys.add(k);
        return OK; // earlier events and states are not touched
      }
      case LedgerEventType.IPO_CLOSED: {
        if (this.closed.has(event.ipoId)) return reject(LedgerRejection.IPO_ALREADY_CLOSED);
        if (event.payload.ledgerSeqAtClose !== event.seq - 1) return reject(LedgerRejection.LEDGER_CLOSE_SEQ_MISMATCH);
        this.closed.set(event.ipoId, { closedAtSeq: event.seq, ledgerSeqAtClose: event.payload.ledgerSeqAtClose, ledgerHeadHashAtClose: event.prevHash });
        return OK;
      }
      case LedgerEventType.PARTICIPATION_RECORDED:
      case LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED: {
        if (this.closed.has(event.ipoId)) return reject(LedgerRejection.IPO_ALREADY_CLOSED);
        const existing = this.keys.get(key(event.subjectFundId, event.ipoId));
        const current = existing?.effective ?? ParticipationState.UNKNOWN;
        const t = transition(current, event.payload.to);
        if (!t.ok) return reject(t.reasonCode);
        if (event.payload.from !== current) return reject(LedgerRejection.LEDGER_PAYLOAD_STATE_MISMATCH);
        const ks = this.keyState(event.subjectFundId, event.ipoId);
        ks.effective = t.to;
        ks.currentEventSeq = event.seq;
        ks.history.push({ seq: event.seq, state: t.to });
        this.stateEvents.set(event.seq, {
          eventHash: event.eventHash,
          ipoId: event.ipoId,
          fundId: event.subjectFundId,
          origin: event.payload.origin,
          bidId: event.eventType === LedgerEventType.PARTICIPATION_RECORDED ? event.payload.bidId : undefined,
          annulled: false,
        });
        if (this.pending !== null) this.pending = null;
        return OK;
      }
      case LedgerEventType.EVENT_ANNULLED: {
        if (this.closed.has(event.ipoId)) return reject(LedgerRejection.IPO_ALREADY_CLOSED);
        const p = event.payload;
        const target = this.stateEvents.get(p.targetSeq);
        const ks = this.keys.get(key(event.subjectFundId, event.ipoId));
        if (
          target === undefined ||
          ks === undefined ||
          p.targetSeq >= event.seq ||
          target.eventHash !== p.targetEventHash ||
          target.ipoId !== event.ipoId ||
          target.fundId !== event.subjectFundId ||
          target.annulled ||
          ks.currentEventSeq !== p.targetSeq // only the event that made the current effective state
        ) {
          return reject(LedgerRejection.LEDGER_ANNUL_TARGET_INVALID);
        }
        if (p.reason === AnnulmentReason.BID_WITHDRAWN) {
          // R15: only a BIND-1 record of the same bid is resolved by a bid withdrawal.
          if (target.origin !== ParticipationOrigin.BIND_1 || target.bidId !== p.bidId) {
            return reject(LedgerRejection.LEDGER_ANNUL_TARGET_INVALID);
          }
        } else if (target.origin === ParticipationOrigin.BIND_1) {
          // R12: a BIND-1 record cannot be corrected around the bid.
          return reject(LedgerRejection.LEDGER_ANNUL_BOUND_TO_BID);
        }
        target.annulled = true;
        ks.effective = ParticipationState.UNKNOWN;
        ks.currentEventSeq = null;
        ks.history.push({ seq: event.seq, state: ParticipationState.UNKNOWN });
        this.pending = p.replacement === null ? null : { fundId: event.subjectFundId, ipoId: event.ipoId, state: p.replacement };
        return OK;
      }
    }
  }

  private isOwedReplacement(event: LedgerEvent, p: Pending): boolean {
    if (event.eventType === LedgerEventType.PARTICIPATION_RECORDED) {
      return (
        p.state === ParticipationState.PARTICIPATING &&
        event.subjectFundId === p.fundId &&
        event.ipoId === p.ipoId &&
        event.payload.origin === ParticipationOrigin.INDEPENDENT
      );
    }
    if (event.eventType === LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED) {
      return p.state === ParticipationState.NON_PARTICIPATION_LOCKED && event.subjectFundId === p.fundId && event.ipoId === p.ipoId;
    }
    return false;
  }

  private keyState(fundId: FundId, ipoId: IpoId): KeyState {
    const k = key(fundId, ipoId);
    let ks = this.keys.get(k);
    if (ks === undefined) {
      ks = { effective: ParticipationState.UNKNOWN, currentEventSeq: null, history: [] };
      this.keys.set(k, ks);
    }
    return ks;
  }
}

/** Folds a list of already-parsed events. Stops at the first rejected event. */
export function deriveState(events: readonly LedgerEvent[]): { readonly ok: true; readonly projection: LedgerProjection } | { readonly ok: false; readonly seq: number; readonly reasonCode: LedgerRejection } {
  const projection = new LedgerProjection();
  for (const e of events) {
    const r = projection.apply(e);
    if (!r.ok) return { ok: false, seq: e.seq, reasonCode: r.reasonCode };
  }
  if (projection.hasPendingReplacement()) {
    return { ok: false, seq: events.length === 0 ? 0 : (events[events.length - 1] as LedgerEvent).seq, reasonCode: LedgerRejection.LEDGER_ANNUL_REPLACEMENT_MISSING };
  }
  return { ok: true, projection };
}
