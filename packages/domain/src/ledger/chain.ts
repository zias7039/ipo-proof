/**
 * Hash-chained, append-only event log (design §2.1) and its verification.
 *
 * WHAT THIS IS: tamper evidence. Changing, deleting or reordering a past event, or splicing one
 * in, makes `verifyChain` report the first inconsistent position.
 * WHAT THIS IS NOT: a blockchain, a proof that recorded facts are true (principle B), or a
 * zero-knowledge proof (principle F). It also cannot detect that the END of the chain was cut off
 * or rewritten together with its own hash unless the caller passes a checkpoint it ALREADY trusts
 * (`ChainOptions.checkpoints`, design §2.5).
 * CHECKPOINTS ARE NOT A K-05 MITIGATION (security QA C-1): a checkpoint here is unsigned plain data
 * `{seq, eventHash}`; there is no issuing path, no signature type, and nothing in this module proves who
 * produced it. It only compares a chain against an anchor the caller got from somewhere trustworthy.
 * Truncation is not detected without such an anchor, and events after the last anchor are not protected.
 * Nobody is authenticated or authorized here: callers must go through AuthorizedLedger
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
  /** A trusted checkpoint was given in a malformed shape (not `{seq, eventHash}` with a positive safe integer and 64 lowercase hex). */
  LEDGER_CHECKPOINT_INVALID: "LEDGER_CHECKPOINT_INVALID",
  /** The chain is shorter than a trusted checkpoint: the end was cut off (or the checkpoint is from another ledger). */
  LEDGER_CHECKPOINT_NOT_REACHED: "LEDGER_CHECKPOINT_NOT_REACHED",
  /** The event at the checkpoint's `seq` has a different hash: the history was rewritten. */
  LEDGER_CHECKPOINT_MISMATCH: "LEDGER_CHECKPOINT_MISMATCH",
  /**
   * The newest checkpoint given is older than `minCheckpointSeq` (or none was given): the caller was handed an
   * older anchor than one it already holds (rollback), or no anchor at all. Freshness is pinned by the caller.
   */
  LEDGER_CHECKPOINT_STALE: "LEDGER_CHECKPOINT_STALE",
  /**
   * `recordedAt` is smaller than the previous event's (N-4): the sequencer clock went back, or the
   * chain was rebuilt with a rewound clock. Refused when appending and when verifying.
   */
  LEDGER_CLOCK_REGRESSION: "LEDGER_CLOCK_REGRESSION",
  /** `verifyChain` was called without a `ledgerId` (L-B): a chain is only meaningful as the log of a named ledger. */
  LEDGER_ID_REQUIRED: "LEDGER_ID_REQUIRED",
} as const;
export type ChainRejection = (typeof ChainRejection)[keyof typeof ChainRejection];

export type ChainVerification =
  | {
      readonly ok: true;
      readonly length: number;
      readonly headHash: string;
      /**
       * The highest checkpoint `seq` this chain was matched against, or `null` when no checkpoint was given
       * (C-2): `null` means the result is NOT anchored and a cut-off end is not detected. Events after
       * `anchoredAtSeq` (`length - anchoredAtSeq` of them) are covered by the hash chain only (C-4). Callers that
       * keep this value and pass it back as `minCheckpointSeq` get a monotonic (no rollback) guarantee (C-3).
       */
      readonly anchoredAtSeq: number | null;
    }
  /** `seq` is the 1-based position of the first inconsistent event (the position it should have), not necessarily its own `seq` field. */
  | { readonly ok: false; readonly seq: number; readonly reasonCode: ChainRejection };

/**
 * Pure verification of a full chain: for each position, strict shape -> seq -> prevHash -> hash
 * recomputation -> state rules (the fold). Reports the first problem and nothing after it.
 */
/**
 * A caller-trusted anchor `{seq, eventHash}` for the chain (design section 2.5, issue #37 section 3).
 * It is UNSIGNED plain data and there is no code that issues one: THIS MODULE DOES NOT CHECK WHO ISSUED IT,
 * and a signed `LedgerCheckpoint` type with an issuing path is future work. The caller must obtain it
 * from a source it trusts (e.g. verified an operator signature itself); a checkpoint from an untrusted
 * source gives no protection, so this is NOT a mitigation for operator-key compromise (K-05). A chain passes if it is at least `seq` long and its event
 * at position `seq` has this hash, so a chain that grew after the checkpoint still verifies.
 */
export interface ChainCheckpoint {
  readonly seq: number;
  readonly eventHash: string;
}

const CHECKPOINT_HASH = /^[0-9a-f]{64}$/;

/** Reads one checkpoint exactly once, own data properties only (a getter or proxy is rejected). */
function readCheckpoint(raw: unknown): ChainCheckpoint | undefined {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 2 || !keys.includes("seq") || !keys.includes("eventHash")) return undefined;
    const sd = Object.getOwnPropertyDescriptor(raw, "seq");
    const hd = Object.getOwnPropertyDescriptor(raw, "eventHash");
    // an accessor property has no `value`, so a getter is rejected by the type checks below
    const seq: unknown = sd?.value;
    const eventHash: unknown = hd?.value;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return undefined;
    if (typeof eventHash !== "string" || !CHECKPOINT_HASH.test(eventHash)) return undefined;
    return { seq, eventHash };
  } catch {
    return undefined;
  }
}

export interface ChainOptions {
  /**
   * Identifier of the ledger the chain belongs to (M-3). It selects the genesis `prevHash`
   * (`ledgerGenesisHash`); a chain built for another ledger id fails at position 1 with
   * LEDGER_PREV_HASH_MISMATCH. REQUIRED (L-B): there is no placeholder genesis, so a verified chain is
   * always shown to belong to the ledger the caller named. A missing id is LEDGER_ID_REQUIRED.
   */
  readonly ledgerId: string;
  /**
   * Trusted anchors (issue #37 section 3). Each is checked against the chain: shorter than the
   * checkpoint -> LEDGER_CHECKPOINT_NOT_REACHED (truncation), other hash at that position ->
   * LEDGER_CHECKPOINT_MISMATCH (rewrite), malformed -> LEDGER_CHECKPOINT_INVALID. Omitted or empty:
   * no anchor, the result has `anchoredAtSeq: null`, and a cut-off end is NOT detected (see the module comment).
   * An anchor is only meaningful for a named ledger; `ledgerId` is required for every verification (L-B, C-5).
   */
  readonly checkpoints?: readonly ChainCheckpoint[];
  /**
   * Freshness pin (C-3): the highest anchor `seq` the caller has already accepted (typically the
   * `anchoredAtSeq` of its previous verification). The newest checkpoint given must be at least this
   * high, otherwise LEDGER_CHECKPOINT_STALE (also when no checkpoint is given). Must be a positive safe
   * integer, else LEDGER_CHECKPOINT_INVALID.
   */
  readonly minCheckpointSeq?: number;
}

export function verifyChain(events: readonly unknown[], options: ChainOptions): ChainVerification {
  // The options object is read once into locals; untyped callers may pass anything.
  let ledgerId: unknown;
  let rawCheckpoints: unknown;
  let minCheckpointSeq: unknown;
  try {
    ({ ledgerId, checkpoints: rawCheckpoints, minCheckpointSeq } = options);
  } catch {
    // a missing / unreadable ledgerId is LEDGER_ID_REQUIRED; a failure on a later option is a malformed checkpoint option
    return { ok: false, seq: 1, reasonCode: ledgerId === undefined ? ChainRejection.LEDGER_ID_REQUIRED : ChainRejection.LEDGER_CHECKPOINT_INVALID };
  }
  if (ledgerId === undefined) return { ok: false, seq: 1, reasonCode: ChainRejection.LEDGER_ID_REQUIRED };
  const genesis = ledgerGenesisHash(ledgerId as string);
  if (genesis === undefined) return { ok: false, seq: 1, reasonCode: ChainRejection.LEDGER_PREV_HASH_MISMATCH };
  // Checkpoints are shape-checked before the (expensive) chain walk.
  const anchors = new Map<number, string>();
  let pin: number | undefined;
  if (minCheckpointSeq !== undefined) {
    if (typeof minCheckpointSeq !== "number" || !Number.isSafeInteger(minCheckpointSeq) || minCheckpointSeq < 1) {
      return { ok: false, seq: 1, reasonCode: ChainRejection.LEDGER_CHECKPOINT_INVALID };
    }
    pin = minCheckpointSeq;
  }
  if (rawCheckpoints !== undefined) {
    let list: unknown[];
    try {
      if (!Array.isArray(rawCheckpoints)) throw new TypeError("checkpoints must be an array");
      list = Array.from(rawCheckpoints as unknown[]);
    } catch {
      return { ok: false, seq: 1, reasonCode: ChainRejection.LEDGER_CHECKPOINT_INVALID };
    }
    for (const raw of list) {
      const cp = readCheckpoint(raw);
      if (cp === undefined) return { ok: false, seq: 1, reasonCode: ChainRejection.LEDGER_CHECKPOINT_INVALID };
      const known = anchors.get(cp.seq);
      // two different trusted hashes for one position cannot both hold: fail closed
      if (known !== undefined && known !== cp.eventHash) return { ok: false, seq: cp.seq, reasonCode: ChainRejection.LEDGER_CHECKPOINT_MISMATCH };
      anchors.set(cp.seq, cp.eventHash);
    }
  }
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
    const anchor = anchors.get(position);
    if (anchor !== undefined && anchor !== eventHash) {
      return { ok: false, seq: position, reasonCode: ChainRejection.LEDGER_CHECKPOINT_MISMATCH };
    }
    prevHash = eventHash;
    prevRecordedAt = event.recordedAt;
  }
  for (const seq of anchors.keys()) {
    if (seq > events.length) return { ok: false, seq: events.length + 1, reasonCode: ChainRejection.LEDGER_CHECKPOINT_NOT_REACHED };
  }
  if (projection.hasPendingReplacement()) {
    return { ok: false, seq: events.length, reasonCode: ChainRejection.LEDGER_ANNUL_REPLACEMENT_MISSING };
  }
  const anchoredAtSeq = anchors.size === 0 ? null : Math.max(...anchors.keys());
  // C-3: the caller's pin; an older (or missing) anchor than one it already holds is a rollback.
  if (pin !== undefined && (anchoredAtSeq === null || anchoredAtSeq < pin)) {
    return { ok: false, seq: events.length + 1, reasonCode: ChainRejection.LEDGER_CHECKPOINT_STALE };
  }
  return { ok: true, length: events.length, headHash: prevHash, anchoredAtSeq };
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

  /** Throws `TypeError` for a missing or invalid `ledgerId` (deployment configuration, not attacker input). */
  constructor(now: () => number, options: ChainOptions) {
    const genesis = ledgerGenesisHash(options.ledgerId);
    if (genesis === undefined) throw new TypeError("ledgerId must be a synthetic identifier");
    this.#now = now;
    this.#genesis = genesis;
  }

  /** Rebuilds a ledger from stored events after a full `verifyChain`. */
  static fromEvents(
    events: readonly unknown[],
    now: () => number,
    options: ChainOptions,
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

// L-A: same hardening as AuthorizedLedger (the low-level chain is not exported from the barrel).
Object.freeze(HashChainedLedger.prototype);
Object.freeze(HashChainedLedger);
