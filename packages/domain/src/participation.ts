import type { FundId, IpoId } from "./model.js";

/**
 * Per Fund+IPO participation state.
 *
 * UNKNOWN is NOT "non-participation". It means "nothing has been recorded". A fund only
 * becomes exempt from deduction by being explicitly NON_PARTICIPATION_LOCKED.
 */
export const ParticipationState = {
  UNKNOWN: "UNKNOWN",
  PARTICIPATING: "PARTICIPATING",
  NON_PARTICIPATION_LOCKED: "NON_PARTICIPATION_LOCKED",
} as const;
export type ParticipationState = (typeof ParticipationState)[keyof typeof ParticipationState];

export type TargetState = typeof ParticipationState.PARTICIPATING | typeof ParticipationState.NON_PARTICIPATION_LOCKED;

export const TransitionRejection = {
  /** Participation (or a repeat lock) requested for a fund that is already locked. */
  NON_PARTICIPATION_LOCK_ACTIVE: "NON_PARTICIPATION_LOCK_ACTIVE",
  /** Lock (or a repeat participation) requested for a fund that is already participating. */
  PARTICIPATION_ALREADY_RECORDED: "PARTICIPATION_ALREADY_RECORDED",
  /** The requested target is not a valid target state (e.g. UNKNOWN). */
  INVALID_TARGET_STATE: "INVALID_TARGET_STATE",
} as const;
export type TransitionRejection = (typeof TransitionRejection)[keyof typeof TransitionRejection];

export type TransitionResult =
  | { readonly ok: true; readonly from: ParticipationState; readonly to: TargetState }
  | { readonly ok: false; readonly from: ParticipationState; readonly reasonCode: TransitionRejection };

/**
 * Pure transition function. Allowed transitions, and only these:
 *   UNKNOWN -> PARTICIPATING
 *   UNKNOWN -> NON_PARTICIPATION_LOCKED
 * Everything else is rejected, including PARTICIPATING <-> NON_PARTICIPATION_LOCKED,
 * same-state repeats, and any attempt to move back to UNKNOWN.
 */
export function transition(from: ParticipationState, target: unknown): TransitionResult {
  if (target !== ParticipationState.PARTICIPATING && target !== ParticipationState.NON_PARTICIPATION_LOCKED) {
    return { ok: false, from, reasonCode: TransitionRejection.INVALID_TARGET_STATE };
  }
  switch (from) {
    case ParticipationState.UNKNOWN:
      return { ok: true, from, to: target };
    case ParticipationState.NON_PARTICIPATION_LOCKED:
      return { ok: false, from, reasonCode: TransitionRejection.NON_PARTICIPATION_LOCK_ACTIVE };
    case ParticipationState.PARTICIPATING:
      return { ok: false, from, reasonCode: TransitionRejection.PARTICIPATION_ALREADY_RECORDED };
  }
}

/** Read-only lookup used by the rule engine and bid verification. */
export interface ParticipationLookup {
  /** Returns UNKNOWN for any pair that has no recorded state. */
  getState(fundId: FundId, ipoId: IpoId): ParticipationState;
}

export interface LedgerEntry {
  readonly seq: number;
  readonly fundId: FundId;
  readonly ipoId: IpoId;
  readonly from: ParticipationState;
  readonly to: TargetState;
  readonly at: number;
}

/**
 * In-memory, append-only participation ledger. Absence of a record is UNKNOWN.
 * This is a local stand-in for the shared ledger; no persistence and no blockchain yet.
 */
export class InMemoryParticipationLedger implements ParticipationLookup {
  private readonly states = new Map<string, TargetState>();
  private readonly entries: LedgerEntry[] = [];

  constructor(private readonly now: () => number) {}

  getState(fundId: FundId, ipoId: IpoId): ParticipationState {
    return this.states.get(key(fundId, ipoId)) ?? ParticipationState.UNKNOWN;
  }

  requestParticipation(fundId: FundId, ipoId: IpoId): TransitionResult {
    return this.apply(fundId, ipoId, ParticipationState.PARTICIPATING);
  }

  requestNonParticipationLock(fundId: FundId, ipoId: IpoId): TransitionResult {
    return this.apply(fundId, ipoId, ParticipationState.NON_PARTICIPATION_LOCKED);
  }

  /** Applies a target state through the state machine. Rejections leave the ledger untouched. */
  apply(fundId: FundId, ipoId: IpoId, target: unknown): TransitionResult {
    const result = transition(this.getState(fundId, ipoId), target);
    if (result.ok) {
      this.states.set(key(fundId, ipoId), result.to);
      this.entries.push({ seq: this.entries.length + 1, fundId, ipoId, from: result.from, to: result.to, at: this.now() });
    }
    return result;
  }

  history(): readonly LedgerEntry[] {
    return [...this.entries];
  }
}

function key(fundId: FundId, ipoId: IpoId): string {
  return JSON.stringify([fundId, ipoId]);
}
