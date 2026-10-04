/**
 * Participation-ledger event envelope (docs/design/participation-ledger-events.md §2).
 *
 * HONESTY NOTES
 *  - A hash chain over these events is TAMPER EVIDENCE only. It is not a blockchain, it does not
 *    prove that the recorded facts are true (principle B), and it is not a zero-knowledge proof
 *    (principle F; ZK STATUS: NOT IMPLEMENTED).
 *  - This module checks STRUCTURE only. `authorization` / `coAuthorizations` are stored and
 *    hashed but their signatures are NOT verified here, and nobody is authorized by this module.
 *    Signature verification (EIP-712 LedgerAction, signing.ts) and the authorization rules live in
 *    AuthorizedLedger (authorized.ts), which is the write entry point for untrusted callers.
 *    HashChainedLedger itself stays low-level and unauthenticated: it is NOT exported from the
 *    package barrel (ledger/index.ts); only AuthorizedLedger is. The parse functions and
 *    verifyChain here are read-only format/chain checks: they authenticate nobody. Still missing: R9 (key revocation), R15 (bid withdrawal, needs a bid store), BIND-1
 *    origins, a registry change log, a persistent nonce store, external checkpoints.
 *  - Events carry no amounts and no capacity (principle E). The payload of every event type is a
 *    closed allowlist: any extra field (for example an amount) makes the event malformed.
 */
import { sha256CanonicalHex } from "../hash.js";
import { isSyntheticId } from "../model.js";
import type { FundId, IpoId } from "../model.js";
import { ParticipationState } from "../participation.js";

/** Label for what the chain is. Deliberately blunt, like PROOF_HASH_KIND in verify.ts. */
export const LEDGER_CHAIN_KIND = "SHA256_HASH_CHAIN_TAMPER_EVIDENCE_ONLY_NOT_A_BLOCKCHAIN_NOT_A_ZK_PROOF";

export const LEDGER_SCHEMA_VERSION = 1;

/** Domain tag mixed into every event hash (design §2.2). */
export const LEDGER_EVENT_HASH_DOMAIN = "ipo-proof/ledger-event/v1";

/**
 * `prevHash` of the event with seq = 1. The design says "fixed genesis value" without naming it
 * (open question); 64 zero hex digits is a placeholder that only has to be a constant.
 */
export const LEDGER_GENESIS_PREV_HASH = "0".repeat(64);

/** Domain tag of the ledger-specific genesis value (M-3). */
export const LEDGER_GENESIS_DOMAIN = "ipo-proof/ledger-genesis/v1";

/**
 * The `prevHash` of seq = 1. Without a `ledgerId` it is the constant placeholder above (the low-level
 * `HashChainedLedger` default, kept as confirmed). With a `ledgerId` it is
 * `sha256(canonicalJson({domain: "ipo-proof/ledger-genesis/v1", ledgerId}))`, so two ledgers
 * (staging / production / per IPO) never share a genesis and a chain cannot be replayed into
 * another ledger. Returns `undefined` for an id that is not a synthetic identifier.
 */
export function ledgerGenesisHash(ledgerId: string | undefined): string | undefined {
  if (ledgerId === undefined) return LEDGER_GENESIS_PREV_HASH;
  if (!isSyntheticId(ledgerId)) return undefined;
  return sha256CanonicalHex({ domain: LEDGER_GENESIS_DOMAIN, ledgerId });
}

export const LedgerEventType = {
  PARTICIPATION_RECORDED: "PARTICIPATION_RECORDED",
  NON_PARTICIPATION_LOCKED_RECORDED: "NON_PARTICIPATION_LOCKED_RECORDED",
  EVENT_ANNULLED: "EVENT_ANNULLED",
  IPO_CLOSED: "IPO_CLOSED",
  // Named in the design but NOT supported yet (rejected, fail closed): later steps own them.
  IPO_FINALIZED: "IPO_FINALIZED",
  FINDING_ANNOTATED: "FINDING_ANNOTATED",
  MANAGER_KEY_REVOKED: "MANAGER_KEY_REVOKED",
} as const;
export type LedgerEventType = (typeof LedgerEventType)[keyof typeof LedgerEventType];

export type SupportedLedgerEventType =
  | typeof LedgerEventType.PARTICIPATION_RECORDED
  | typeof LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED
  | typeof LedgerEventType.EVENT_ANNULLED
  | typeof LedgerEventType.IPO_CLOSED;

export const ParticipationOrigin = { INDEPENDENT: "INDEPENDENT", BIND_1: "BIND_1" } as const;
export type ParticipationOrigin = (typeof ParticipationOrigin)[keyof typeof ParticipationOrigin];

export const AnnulmentReason = {
  MISTAKEN_ENTRY: "MISTAKEN_ENTRY",
  KEY_COMPROMISE: "KEY_COMPROMISE",
  BID_WITHDRAWN: "BID_WITHDRAWN",
} as const;
export type AnnulmentReason = (typeof AnnulmentReason)[keyof typeof AnnulmentReason];

export type RecordedState = typeof ParticipationState.PARTICIPATING | typeof ParticipationState.NON_PARTICIPATION_LOCKED;

/** Opaque, unverified authorization data (format-checked only). See the header. */
export interface LedgerAuthorization {
  readonly scheme: string;
  readonly requestNonce: string;
  readonly expiresAt: number;
  readonly signature: string;
}
/** Co-signature of a correction approver. `approverId` is this PR's reading of the design (open question). */
export interface LedgerCoAuthorization extends LedgerAuthorization {
  readonly approverId: string;
}

export interface ParticipationRecordedPayload {
  readonly from: ParticipationState;
  readonly to: typeof ParticipationState.PARTICIPATING;
  readonly origin: ParticipationOrigin;
  /** Required iff origin = BIND_1, absent otherwise. */
  readonly bidId?: string;
}
export interface NonParticipationLockedRecordedPayload {
  readonly from: ParticipationState;
  readonly to: typeof ParticipationState.NON_PARTICIPATION_LOCKED;
  /** Always INDEPENDENT: BIND-1 records PARTICIPATING only. */
  readonly origin: typeof ParticipationOrigin.INDEPENDENT;
}
export interface EventAnnulledPayload {
  readonly targetSeq: number;
  readonly targetEventHash: string;
  readonly reason: AnnulmentReason;
  readonly replacement: RecordedState | null;
  /** Required iff reason = BID_WITHDRAWN, absent otherwise. */
  readonly bidId?: string;
}
export interface IpoClosedPayload {
  readonly closesAt: number;
  /** Must equal this event's seq - 1. */
  readonly ledgerSeqAtClose: number;
}

interface EnvelopeCommon {
  readonly ipoId: IpoId;
  readonly actorId: string;
  readonly authorization: LedgerAuthorization;
  readonly coAuthorizations: readonly LedgerCoAuthorization[];
  readonly registrySeq: number;
  /** Requester-claimed time. Never trusted and never used for ordering or cut-off decisions. */
  readonly requestedAt: number;
}

export type LedgerEventBody =
  | (EnvelopeCommon & { readonly eventType: "PARTICIPATION_RECORDED"; readonly subjectFundId: FundId; readonly payload: ParticipationRecordedPayload })
  | (EnvelopeCommon & { readonly eventType: "NON_PARTICIPATION_LOCKED_RECORDED"; readonly subjectFundId: FundId; readonly payload: NonParticipationLockedRecordedPayload })
  | (EnvelopeCommon & { readonly eventType: "EVENT_ANNULLED"; readonly subjectFundId: FundId; readonly payload: EventAnnulledPayload })
  | (EnvelopeCommon & { readonly eventType: "IPO_CLOSED"; readonly subjectFundId: null; readonly payload: IpoClosedPayload });

/** What a caller proposes. The ledger assigns seq, prevHash, recordedAt, schemaVersion and eventHash. */
export type LedgerEventDraft = LedgerEventBody;

export type LedgerEventUnhashed = LedgerEventBody & {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly seq: number;
  readonly prevHash: string;
  /** Sequencer clock; reference only (the order is `seq`). */
  readonly recordedAt: number;
};
export type LedgerEvent = LedgerEventUnhashed & { readonly eventHash: string };

/**
 * Hash of an event: sha256(canonicalJson({domain, event})) over every field except `eventHash`.
 * The `{domain, event}` wrapping is this implementation's reading of "domain tag included"
 * (open question in the PR). Signatures are part of the event and therefore of the hash.
 */
export function computeEventHash(event: LedgerEventUnhashed): string {
  return sha256CanonicalHex({ domain: LEDGER_EVENT_HASH_DOMAIN, event });
}

/* ------------------------------------------------------------------------------------------
 * Strict parsing. Input is `unknown`; the result is a fresh, deeply frozen copy built from
 * values read exactly once, so later mutation of the caller's object cannot change an event.
 * ---------------------------------------------------------------------------------------- */

export const ParseRejection = {
  /** Wrong shape, extra/missing field, bad id/hash/signature format, or inconsistent combination. */
  EVENT_MALFORMED: "EVENT_MALFORMED",
  /** A known name from the design whose handling is not implemented yet. Rejected, fail closed. */
  EVENT_TYPE_NOT_SUPPORTED: "EVENT_TYPE_NOT_SUPPORTED",
} as const;
export type ParseRejection = (typeof ParseRejection)[keyof typeof ParseRejection];

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reasonCode: ParseRejection };

const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/; // 65 bytes, LOWERCASE hex only (design #38 §2.2.1): one encoding per signature, so one eventHash
const SCHEME = /^[A-Z][A-Z0-9_]{0,63}$/;
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;
const MALFORMED = { ok: false, reasonCode: ParseRejection.EVENT_MALFORMED } as const;

class Malformed extends Error {}
const bad = (): never => {
  throw new Malformed();
};

/** Reads own enumerable data properties exactly once; rejects accessors, symbols, odd prototypes and unexpected/missing keys. */
function record(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad();
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return bad();
  if (Object.getOwnPropertySymbols(v).length > 0) return bad();
  const descriptors = Object.getOwnPropertyDescriptors(v);
  const out: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(descriptors)) {
    if (!d.enumerable || !("value" in d)) return bad();
    if (!required.includes(key) && !optional.includes(key)) return bad();
    out[key] = d.value;
  }
  for (const key of required) if (!(key in out)) return bad();
  return out;
}

function array(v: unknown): readonly unknown[] {
  if (!Array.isArray(v)) return bad();
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Array.prototype) return bad();
  const out: unknown[] = [];
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, i);
    if (d === undefined || !("value" in d)) return bad(); // holes and accessors
    out.push(d.value);
  }
  if (Object.getOwnPropertyNames(v).length !== v.length + 1) return bad(); // extra own props
  return out;
}

const id = (v: unknown): string => (isSyntheticId(v) ? v : bad());
const uint = (v: unknown, min = 0): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : bad());
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T => (allowed.includes(v as T) ? (v as T) : bad());
const hex64 = (v: unknown): string => (typeof v === "string" && HEX64.test(v) ? v : bad());

function authorization(v: unknown): LedgerAuthorization {
  const r = record(v, ["scheme", "requestNonce", "expiresAt", "signature"]);
  const scheme = r["scheme"];
  const nonce = r["requestNonce"];
  const sig = r["signature"];
  if (typeof scheme !== "string" || !SCHEME.test(scheme)) return bad();
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return bad();
  if (typeof sig !== "string" || !SIGNATURE.test(sig)) return bad();
  return Object.freeze({ scheme, requestNonce: nonce, expiresAt: uint(r["expiresAt"]), signature: sig });
}

function coAuthorization(v: unknown): LedgerCoAuthorization {
  const r = record(v, ["approverId", "scheme", "requestNonce", "expiresAt", "signature"]);
  const { approverId, ...rest } = r;
  return Object.freeze({ approverId: id(approverId), ...authorization(rest) });
}

const STATES = [ParticipationState.UNKNOWN, ParticipationState.PARTICIPATING, ParticipationState.NON_PARTICIPATION_LOCKED] as const;
const RECORDED = [ParticipationState.PARTICIPATING, ParticipationState.NON_PARTICIPATION_LOCKED] as const;
const ORIGINS = [ParticipationOrigin.INDEPENDENT, ParticipationOrigin.BIND_1] as const;
const REASONS = [AnnulmentReason.MISTAKEN_ENTRY, AnnulmentReason.KEY_COMPROMISE, AnnulmentReason.BID_WITHDRAWN] as const;

function participationPayload(v: unknown): ParticipationRecordedPayload {
  const r = record(v, ["from", "to", "origin"], ["bidId"]);
  const origin = oneOf(r["origin"], ORIGINS);
  const from = oneOf(r["from"], STATES);
  if (r["to"] !== ParticipationState.PARTICIPATING) return bad();
  if (origin === ParticipationOrigin.BIND_1) {
    return Object.freeze({ from, to: ParticipationState.PARTICIPATING, origin, bidId: id(r["bidId"]) });
  }
  if ("bidId" in r) return bad();
  return Object.freeze({ from, to: ParticipationState.PARTICIPATING, origin });
}

function lockedPayload(v: unknown): NonParticipationLockedRecordedPayload {
  const r = record(v, ["from", "to", "origin"]);
  if (r["to"] !== ParticipationState.NON_PARTICIPATION_LOCKED) return bad();
  if (r["origin"] !== ParticipationOrigin.INDEPENDENT) return bad();
  return Object.freeze({
    from: oneOf(r["from"], STATES),
    to: ParticipationState.NON_PARTICIPATION_LOCKED,
    origin: ParticipationOrigin.INDEPENDENT,
  });
}

function annulledPayload(v: unknown): EventAnnulledPayload {
  const r = record(v, ["targetSeq", "targetEventHash", "reason", "replacement"], ["bidId"]);
  const reason = oneOf(r["reason"], REASONS);
  const replacement = r["replacement"] === null ? null : oneOf(r["replacement"], RECORDED);
  const base = { targetSeq: uint(r["targetSeq"], 1), targetEventHash: hex64(r["targetEventHash"]), reason, replacement };
  if (reason === AnnulmentReason.BID_WITHDRAWN) return Object.freeze({ ...base, bidId: id(r["bidId"]) });
  if ("bidId" in r) return bad();
  return Object.freeze(base);
}

function closedPayload(v: unknown): IpoClosedPayload {
  const r = record(v, ["closesAt", "ledgerSeqAtClose"]);
  return Object.freeze({ closesAt: uint(r["closesAt"]), ledgerSeqAtClose: uint(r["ledgerSeqAtClose"]) });
}

const BODY_KEYS = ["eventType", "ipoId", "subjectFundId", "actorId", "authorization", "coAuthorizations", "payload", "registrySeq", "requestedAt"];
const CHAIN_KEYS = ["schemaVersion", "seq", "prevHash", "recordedAt"];

function bodyOf(r: Record<string, unknown>, allowMissingApproval = false): LedgerEventBody {
  const eventType = r["eventType"];
  if (typeof eventType !== "string") return bad();
  if (!Object.hasOwn(LedgerEventType, eventType)) return bad();
  const common = {
    ipoId: id(r["ipoId"]),
    actorId: id(r["actorId"]),
    authorization: authorization(r["authorization"]),
    coAuthorizations: Object.freeze(array(r["coAuthorizations"]).map(coAuthorization)),
    registrySeq: uint(r["registrySeq"]),
    requestedAt: uint(r["requestedAt"]),
  };
  const noCoSigners = () => (common.coAuthorizations.length === 0 ? undefined : bad());
  switch (eventType) {
    case LedgerEventType.PARTICIPATION_RECORDED:
      noCoSigners();
      return { ...common, eventType, subjectFundId: id(r["subjectFundId"]), payload: participationPayload(r["payload"]) };
    case LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED:
      noCoSigners();
      return { ...common, eventType, subjectFundId: id(r["subjectFundId"]), payload: lockedPayload(r["payload"]) };
    case LedgerEventType.EVENT_ANNULLED: {
      const payload = annulledPayload(r["payload"]);
      // R10 / R15 shape: a correction needs exactly one approver co-signature; a bid withdrawal needs none.
      const expected = payload.reason === AnnulmentReason.BID_WITHDRAWN ? 0 : 1;
      const missingAllowed = allowMissingApproval && expected === 1 && common.coAuthorizations.length === 0;
      if (common.coAuthorizations.length !== expected && !missingAllowed) return bad();
      return { ...common, eventType, subjectFundId: id(r["subjectFundId"]), payload };
    }
    case LedgerEventType.IPO_CLOSED:
      noCoSigners();
      if (r["subjectFundId"] !== null) return bad();
      return { ...common, eventType, subjectFundId: null, payload: closedPayload(r["payload"]) };
    default:
      // Known name, handling not implemented yet. Shape is not examined further.
      throw new NotSupported();
  }
}
class NotSupported extends Error {}

function parseWith<T>(fn: () => T): ParseResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof NotSupported) return { ok: false, reasonCode: ParseRejection.EVENT_TYPE_NOT_SUPPORTED };
    if (e instanceof Malformed) return MALFORMED;
    return MALFORMED; // any other surprise (e.g. a throwing Proxy trap) is also a rejection, never a pass
  }
}

export interface ParseDraftOptions {
  /**
   * Let a correction (MISTAKEN_ENTRY / KEY_COMPROMISE) arrive WITHOUT its approver co-signature, so
   * the authorization gate can answer LEDGER_ANNUL_COSIGN_REQUIRED instead of EVENT_MALFORMED.
   * Never use the result of such a parse to append: the ledger itself always re-parses strictly.
   */
  readonly allowMissingApproval?: boolean;
}

/** Parses a caller's draft. Chain fields (seq, prevHash, recordedAt, eventHash, schemaVersion) are NOT accepted from callers. */
export function parseLedgerEventDraft(input: unknown, options: ParseDraftOptions = {}): ParseResult<LedgerEventDraft> {
  return parseWith(() => {
    const r = record(input, BODY_KEYS);
    return Object.freeze(bodyOf(r, options.allowMissingApproval === true));
  });
}

/** Parses a stored event (all fields). Does not check the hash or the chain; see chain.ts. */
export function parseLedgerEvent(input: unknown): ParseResult<LedgerEvent> {
  return parseWith(() => {
    const r = record(input, [...BODY_KEYS, ...CHAIN_KEYS, "eventHash"]);
    if (r["schemaVersion"] !== LEDGER_SCHEMA_VERSION) return bad();
    const body = bodyOf(r);
    const unhashed = {
      ...body,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      seq: uint(r["seq"], 1),
      prevHash: hex64(r["prevHash"]),
      recordedAt: uint(r["recordedAt"]),
    } as LedgerEventUnhashed;
    return Object.freeze({ ...unhashed, eventHash: hex64(r["eventHash"]) }) as LedgerEvent;
  });
}
