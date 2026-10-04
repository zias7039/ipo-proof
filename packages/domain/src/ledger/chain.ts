/**
 * Hash-chained, append-only event log (design §2.1) and its verification.
 *
 * WHAT THIS IS: tamper evidence. Changing, deleting or reordering a past event, or splicing one
 * in, makes `verifyChain` report the first inconsistent position.
 * WHAT THIS IS NOT: a blockchain, a proof that recorded facts are true (principle B), or a
 * zero-knowledge proof (principle F). It also cannot detect that the END of the chain was cut off
 * or rewritten together with its own hash: that needs an external checkpoint (design §2.5, not
 * implemented). Nobody is authenticated or authorized here: callers must go through AuthorizedLedger
 * (authorized.ts); this class is the low-level, unauthenticated store (see events.ts).
 */
import { ParticipationState } from "../participation.js";
import type { ParticipationLookup } from "../participation.js";
import type { FundId, IpoId } from "../model.js";
import { LedgerProjection, LedgerRejection } from "./derive.js";
import {
  LEDGER_SCHEMA_VERSION,
  ParseRejection,
  computeEventHash,
  ledgerGenesisHash,
  parseLedgerEvent,
  parseLedgerEventDraft,
} from "./events.js";
import type { LedgerEvent, LedgerEventUnhashed } from "./events.js";

export const ChainRejection = {
  ...ParseRejection,
  ...LedgerRejection,
  /** The event's `seq` is not its position in the chain (1, 2, 3, ...). */
  LEDGER_SEQ_MISMATCH: "LEDGER_SEQ_MISMATCH",
  /** The event's `prevHash` is not the previous event's `eventHash` (or the genesis value). */
  LEDGER_PREV_HASH_MISMATCH: "LEDGER_PREV_HASH_MISMATCH",
  /** The stored `eventHash` is not the hash of the event's content. */
  LEDGER_EVENT_HASH_MISMATCH: "LEDGER_EVENT_HASH_MISMATCH",
  /** The injected clock did not return a non-negative safe integer. */
  LEDGER_CLOCK_INVALID: "LEDGER_CLOCK_INVALID",
  /**
   * `recordedAt` is smaller than the previous event's (N-4): the sequencer clock went back, or the
   * chain was rebuilt with a rewound clock. Refused when appending and when verifying.
   */
  LEDGER_CLOCK_REGRESSION: "LEDGER_CLOCK_REGRESSION",
} as const;
export type ChainRejection = (typeof ChainRejection)[keyof typeof ChainRejection];

export type ChainVerification =
  | {
      readonly ok: true;
      readonly length: number;
      readonly headHash: string;
      /**
       * True only if the chain was verified against a `ledgerId` (its genesis hash). False means it was
       * checked against the placeholder genesis only (N-5): internally consistent, but not shown to
       * belong to any particular ledger instance, so do not treat it as the verified log of a ledger.
       */
      readonly ledgerBound: boolean;
    }
  /** `seq` is the 1-based position of the first inconsistent event (the position it should have), not necessarily its own `seq` field. */
  | { readonly ok: false; readonly seq: number; readonly reasonCode: ChainRejection };

/**
 * Pure verification of a full chain: for each position, strict shape -> seq -> prevHash -> hash
 * recomputation -> state rules (the fold). Reports the first problem and nothing after it.
 */
export interface ChainOptions {
  /**
   * Identifier of the ledger the chain belongs to (M-3). It selects the genesis `prevHash`
   * (`ledgerGenesisHash`); a chain built for another ledger id fails at position 1 with
   * LEDGER_PREV_HASH_MISMATCH. Omitted: the constant placeholder genesis (low-level default).
   */
  readonly ledgerId?: string;
}

export function verifyChain(events: readonly unknown[], options: ChainOptions = {}): ChainVerification {
  const genesis = ledgerGenesisHash(options.ledgerId);
  if (genesis === undefined) return { ok: false, seq: 1, reasonCode: ChainRejection.LEDGER_PREV_HASH_MISMATCH };
  const projection = new LedgerProjection();
  let prevHash = genesis;
  let prevRecordedAt = 0;
  for (let i = 0; i < events.length; i++) {
    const position = i + 1;
    const parsed = parseLedgerEvent(events[i]);
    if (!parsed.ok) return { ok: false, seq: position, reasonCode: parsed.reasonCode };
    const event = parsed.value;
    if (event.seq !== position) return { ok: false, seq: position, reasonCode: ChainRejection.LEDGER_SEQ_MISMATCH };
    if (event.prevHash !== prevHash) return { ok: false, seq: position, reasonCode: ChainRejection.LEDGER_PREV_HASH_MISMATCH };
    const { eventHash, ...unhashed } = event;
    if (computeEventHash(unhashed as LedgerEventUnhashed) !== eventHash) {
      return { ok: false, seq: position, reasonCode: ChainRejection.LEDGER_EVENT_HASH_MISMATCH };
    }
    if (event.recordedAt < prevRecordedAt) return { ok: false, seq: position, reasonCode: ChainRejection.LEDGER_CLOCK_REGRESSION };
    const applied = projection.apply(event);
    if (!applied.ok) return { ok: false, seq: position, reasonCode: applied.reasonCode };
    prevHash = eventHash;
    prevRecordedAt = event.recordedAt;
  }
  if (projection.hasPendingReplacement()) {
    return { ok: false, seq: events.length, reasonCode: ChainRejection.LEDGER_ANNUL_REPLACEMENT_MISSING };
  }
  return { ok: true, length: events.length, headHash: prevHash, ledgerBound: options.ledgerId !== undefined };
}

export type AppendResult =
  | { readonly ok: true; readonly events: readonly LedgerEvent[] }
  | { readonly ok: false; readonly reasonCode: ChainRejection };

/**
 * In-memory append-only ledger over the hash chain. Pure domain object: no I/O, time comes from
 * the injected clock (the sequencer clock, design D14-Q4). Implements `ParticipationLookup`, so it
 * can be handed to the rule engine and `verifyBid`; no record is UNKNOWN, never "non-participating".
 *
 * Callers must already have authenticated and authorized a draft (not done here); not exported from the package barrel.
 */
export class HashChainedLedger implements ParticipationLookup {
  // ECMAScript private fields (not just TS `private`): not enumerable, not reachable by untyped code.
  // `#chain` is replaced by a NEW frozen array on every commit, so an array handed out earlier is a
  // stable snapshot and can never be used to alter the log (#37 section 2).
  #chain: readonly LedgerEvent[] = Object.freeze([]);
  #projection = new LedgerProjection();
  readonly #now: () => number;
  readonly #genesis: string;

  /** Throws `TypeError` for an invalid `ledgerId` (deployment configuration, not attacker input). */
  constructor(now: () => number, options: ChainOptions = {}) {
    const genesis = ledgerGenesisHash(options.ledgerId);
    if (genesis === undefined) throw new TypeError("ledgerId must be a synthetic identifier");
    this.#now = now;
    this.#genesis = genesis;
  }

  /** Rebuilds a ledger from stored events after a full `verifyChain`. */
  static fromEvents(
    events: readonly unknown[],
    now: () => number,
    options: ChainOptions = {},
  ): { readonly ok: true; readonly ledger: HashChainedLedger } | { readonly ok: false; readonly seq: number; readonly reasonCode: ChainRejection } {
    const verified = verifyChain(events, options);
    if (!verified.ok) return verified;
    const ledger = new HashChainedLedger(now, options);
    const rebuilt: LedgerEvent[] = [];
    for (const raw of events) {
      const parsed = parseLedgerEvent(raw);
      if (!parsed.ok) return { ok: false, seq: rebuilt.length + 1, reasonCode: parsed.reasonCode };
      rebuilt.push(parsed.value);
      const applied = ledger.#projection.apply(parsed.value);
      if (!applied.ok) return { ok: false, seq: parsed.value.seq, reasonCode: applied.reasonCode };
    }
    ledger.#chain = Object.freeze(rebuilt);
    return { ok: true, ledger };
  }

  /** Appends one draft. A correction that owes a replacement event must use `appendAtomic`. */
  append(draft: unknown): AppendResult {
    return this.appendAtomic([draft]);
  }

  /**
   * Appends drafts in order with consecutive seq numbers, all or nothing: if any draft is
   * rejected, or a correction's owed replacement is missing, nothing is added (design R11 atomicity).
   */
  appendAtomic(drafts: readonly unknown[]): AppendResult {
    if (drafts.length === 0) return { ok: false, reasonCode: ChainRejection.EVENT_MALFORMED };
    const scratch = this.#projection.clone();
    const added: LedgerEvent[] = [];
    let prev = this.#chain[this.#chain.length - 1];
    for (const raw of drafts) {
      const parsed = parseLedgerEventDraft(raw);
      if (!parsed.ok) return { ok: false, reasonCode: parsed.reasonCode };
      const recordedAt = this.#now();
      if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) return { ok: false, reasonCode: ChainRejection.LEDGER_CLOCK_INVALID };
      if (prev !== undefined && recordedAt < prev.recordedAt) return { ok: false, reasonCode: ChainRejection.LEDGER_CLOCK_REGRESSION };
      const unhashed = {
        ...parsed.value,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        seq: (prev?.seq ?? 0) + 1,
        prevHash: prev?.eventHash ?? this.#genesis,
        recordedAt,
      } as LedgerEventUnhashed;
      const event = Object.freeze({ ...unhashed, eventHash: computeEventHash(unhashed) }) as LedgerEvent;
      const applied = scratch.apply(event);
      if (!applied.ok) return { ok: false, reasonCode: applied.reasonCode };
      added.push(event);
      prev = event;
    }
    if (scratch.hasPendingReplacement()) return { ok: false, reasonCode: ChainRejection.LEDGER_ANNUL_REPLACEMENT_MISSING };
    this.#chain = Object.freeze([...this.#chain, ...added]);
    this.#projection = scratch;
    return { ok: true, events: Object.freeze(added) };
  }

  getState(fundId: FundId, ipoId: IpoId): ParticipationState {
    return this.#projection.getState(fundId, ipoId);
  }

  getStateAt(fundId: FundId, ipoId: IpoId, atSeq: number): ParticipationState {
    return this.#projection.getStateAt(fundId, ipoId, atSeq);
  }

  isClosed(ipoId: IpoId): boolean {
    return this.#projection.isClosed(ipoId);
  }

  /** `ledgerSeqAtClose` of a closed IPO, else undefined. */
  cutoffSeq(ipoId: IpoId): number | undefined {
    return this.#projection.cutoffSeq(ipoId);
  }

  /**
   * The committed events (frozen objects), oldest first, as a FROZEN array. Modifying it throws
   * and never changes the ledger; a later commit produces a new array and leaves this one as it was.
   */
  events(): readonly LedgerEvent[] {
    return this.#chain;
  }

  /** Hash of the last event, or the genesis value of this ledger for an empty chain. */
  headHash(): string {
    return this.#chain[this.#chain.length - 1]?.eventHash ?? this.#genesis;
  }
}
