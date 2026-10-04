/**
 * Authenticated and authorized entry point to the participation ledger (design §3, §4).
 *
 * `AuthorizedLedger.submit` is the intended way to write events. For every request it checks, in
 * the order the design proposes (authentication -> authorization -> domain), and returns a reason
 * code instead of throwing:
 *
 *  - R2  the actor is a registered principal and the EIP-712 signature recovers to its one key
 *  - R3  the request is not expired (sequencer clock) and not valid for longer than the configured
 *        `maxRequestTtlMs` (no `expiresAt = MAX_SAFE_INTEGER`)
 *  - R4  `(principal, requestNonce)` is new; once a request passed authentication its nonce is
 *        consumed even if the domain rules reject it (a rejected request cannot be replayed after
 *        a correction); an identical signed resend returns the original result
 *  - R1  a fund manager records / corrects only the funds it manages (no proxy recording)
 *  - R5  the fund and the IPO are registered
 *  - R8  IPO_CLOSED only by the single operator, only once the sequencer clock reached the IPO's
 *        closing time, once per IPO (the "once" part lives in the ledger fold)
 *  - R6b recording / correcting is refused with IPO_WINDOW_ELAPSED once the sequencer clock reached
 *        the IPO's closing time (no grace); only IPO_CLOSED is exempt
 *  - R10 a correction needs the fund manager's LedgerAnnulment AND an AnnulmentApproval from a
 *        registry admin over the same digest
 *  - R14 the approver must be independent of the manager and of the operator (I1-I4); if the
 *        configuration cannot provide an independent approver (I5) corrections are disabled
 *  - R6, R7, R11-R13 are enforced by the ledger fold (derive.ts) that this class delegates to
 *
 * NOT implemented here (and therefore not available through this class):
 *  - R9 key revocation / MANAGER_KEY_REVOKED, key rotation, quorum approval (#13)
 *  - R15 bid withdrawal: it needs the bid store (BID_NOT_FOUND, BID_ALREADY_WITHDRAWN, "last active
 *    bid"). BID_WITHDRAWN corrections are rejected, fail closed.
 *  - BIND-1 (`origin = BIND_1`) records: they come from bid intake and the signature does not cover
 *    `origin`, so they are rejected here, fail closed.
 *  - registry change log and REGISTRY_FROZEN_DURING_WINDOW (§4.3), persistence, rate limits
 *    (Q14-N2), IPO_CLOSED delay handling beyond the R6b cutoff (Q14-N3), checkpoints and intake receipts (§2.5).
 *
 * Known trade-offs:
 *  - A relay that holds someone's signed request can submit it at a bad moment; once authenticated
 *    its nonce is consumed whatever the domain result (M-1), so that signature is then unusable and
 *    the signer must sign a new request with a new nonce (availability only, QA N-3).
 *  - The sequencer clock is a trusted component, but a clock that goes back is refused
 *    (LEDGER_CLOCK_REGRESSION, N-4) instead of re-opening an elapsed window. The high-water mark is
 *    in memory, like the nonce table.
 *    A single clock reading far in the future therefore blocks every later request until the real time
 *    catches up (L-C): that is availability only and intentionally has NO bypass in code (a bypass would be
 *    the rewind attack). Recovery is operational (wait, or replace the ledger under a new `ledgerId`);
 *    the procedure is in docs/ARCHITECTURE.md ("원장 운영 메모").
 *  - Every method other than the documented public ones is an ES `#private` method (N-1): the
 *    prototype carries `submit` and the read accessors only.
 *
 * What the checks establish: who asked (provenance of the request) and that the request fits the
 * registered roles. They do NOT establish that the recorded fact is true (principle B), they are
 * not zero-knowledge (principle F), and independence is only as good as the registered ids, keys and
 * self-reported controller labels (T-16, Q14-N6).
 *
 * The inner HashChainedLedger is not exposed: there is no way to append through this object
 * without passing the gate. All state is in ES `#private` fields and the instance is frozen, so a
 * caller cannot replace the configuration, the domain separator or the annulment switch (B-1).
 * `ledgerId` is a required setting and is part of the genesis hash and of the signing domain, so a
 * signature or a chain from another ledger instance is rejected. (HashChainedLedger itself stays a
 * low-level, UNAUTHENTICATED structure and is not exported from the package barrel.)
 */
import { sha256CanonicalHex } from "../hash.js";
import type { FundId, IpoId } from "../model.js";
import { ParticipationState } from "../participation.js";
import type { ParticipationLookup } from "../participation.js";
import type { FundRegistry, IpoRegistry } from "../registry.js";
import { recoverAttestationSigner } from "../eip712.js";
import type { Eip712Domain } from "../eip712.js";
import { Eip712EncodingError } from "../eip712-encoding.js";
import { ChainRejection, HashChainedLedger } from "./chain.js";
import type { AppendResult } from "./chain.js";
import {
  AnnulmentReason,
  LedgerEventType,
  ParseRejection,
  ParticipationOrigin,
  parseLedgerEventDraft,
} from "./events.js";
import type { LedgerCoAuthorization, LedgerEvent, LedgerEventDraft } from "./events.js";
import {
  PrincipalRole,
  annulmentConfigured,
  approverIsIndependent,
} from "./principals.js";
import type { Principal, PrincipalRegistry } from "./principals.js";
import {
  LEDGER_DOMAIN_NAME,
  LEDGER_DOMAIN_VERSION,
  LedgerScheme,
  OPERATOR_ACTION_IPO_CLOSED,
  digestToHex,
  hashAnnulmentApproval,
  hashLedgerAction,
  hashLedgerAnnulment,
  hashOperatorAction,
  ledgerDigest,
  ledgerDomainSeparator,
  operatorPayloadDigest,
} from "./signing.js";

export const AuthRejection = {
  ...ChainRejection,
  // R2 / R3 / R4
  LEDGER_ACTOR_UNKNOWN: "LEDGER_ACTOR_UNKNOWN",
  LEDGER_SIGNATURE_INVALID: "LEDGER_SIGNATURE_INVALID",
  LEDGER_REQUEST_EXPIRED: "LEDGER_REQUEST_EXPIRED",
  /** `expiresAt - now` is larger than the configured maximum request lifetime (M-1). */
  LEDGER_REQUEST_TTL_EXCEEDED: "LEDGER_REQUEST_TTL_EXCEEDED",
  LEDGER_NONCE_REPLAY: "LEDGER_NONCE_REPLAY",
  // R1 / R5 / R8
  LEDGER_ACTOR_NOT_FUND_MANAGER: "LEDGER_ACTOR_NOT_FUND_MANAGER",
  FUND_NOT_REGISTERED: "FUND_NOT_REGISTERED",
  IPO_NOT_FOUND: "IPO_NOT_FOUND",
  LEDGER_OPERATOR_REQUIRED: "LEDGER_OPERATOR_REQUIRED",
  IPO_NOT_YET_CLOSABLE: "IPO_NOT_YET_CLOSABLE",
  /** R6b (M-2): the sequencer clock reached the IPO's closing time; no state event is accepted any more, `IPO_CLOSED` or not. */
  IPO_WINDOW_ELAPSED: "IPO_WINDOW_ELAPSED",
  // R10 / R14
  LEDGER_ANNUL_COSIGN_REQUIRED: "LEDGER_ANNUL_COSIGN_REQUIRED",
  LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT: "LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT",
  LEDGER_ANNUL_DISABLED: "LEDGER_ANNUL_DISABLED",
  // Provisional names: the design names no code for these cases (open questions in the PR).
  LEDGER_ANNUL_APPROVER_NOT_AUTHORIZED: "LEDGER_ANNUL_APPROVER_NOT_AUTHORIZED",
  /** R16 name as in design PR #38. */
  LEDGER_SCHEME_MISMATCH: "LEDGER_SCHEME_MISMATCH",
  LEDGER_REGISTRY_SEQ_MISMATCH: "LEDGER_REGISTRY_SEQ_MISMATCH",
  LEDGER_CLOSE_TIME_MISMATCH: "LEDGER_CLOSE_TIME_MISMATCH",
  // Out of scope of this PR, rejected fail closed.
  LEDGER_BID_WITHDRAWAL_NOT_SUPPORTED: "LEDGER_BID_WITHDRAWAL_NOT_SUPPORTED",
  LEDGER_BIND_ORIGIN_NOT_SUPPORTED: "LEDGER_BIND_ORIGIN_NOT_SUPPORTED",
  /** An unexpected internal error (for example a registry that threw). Fail closed; nothing was appended. */
  LEDGER_INTERNAL_ERROR: "LEDGER_INTERNAL_ERROR",
} as const;
export type AuthRejection = (typeof AuthRejection)[keyof typeof AuthRejection];

export type SubmitResult =
  | {
      readonly ok: true;
      /** The events this request produced (two for a correction with replacement). */
      readonly events: readonly LedgerEvent[];
      /** True if this identical signed request had already been applied: nothing new was appended (R4). */
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly reasonCode: AuthRejection };

export interface AuthorizedLedgerConfig {
  /** Sequencer clock (design D14-Q4). Read once per request. */
  readonly now: () => number;
  /** EIP-712 domain of the ledger. `name`/`version` must be the ledger's own values (not the attestation domain). */
  readonly domain: Eip712Domain;
  readonly principals: PrincipalRegistry;
  readonly funds: FundRegistry;
  readonly ipos: IpoRegistry;
  /**
   * Version of the registries used for authorization. Stored in each event (`registrySeq`); a
   * request that claims another value is rejected, so the audit field cannot be falsified by callers.
   * There is no registry change log yet (design §4.3).
   */
  readonly registrySeq: number;
  /**
   * Identifier of this ledger instance (M-3), a synthetic identifier such as `ledger_prod`. It selects
   * the genesis `prevHash` of the chain and is the `salt` of the EIP-712 domain, so neither the chain
   * nor a signature can be moved to another ledger instance.
   */
  readonly ledgerId: string;
  /**
   * Longest accepted `expiresAt - now` in milliseconds (M-1). A signed request is therefore valid for a
   * bounded time only. REQUIRED, no default (there is deliberately no code default). RECOMMENDED: 24 hours
   * (86_400_000 ms), see "원장 운영 메모" in docs/ARCHITECTURE.md.
   */
  readonly maxRequestTtlMs: number;
}

type Outcome =
  | { readonly ok: true; readonly events: readonly LedgerEvent[] }
  | { readonly ok: false; readonly reasonCode: AuthRejection };

// Every result handed to a caller is a NEW, frozen object (N-2): a cached rejection can never be
// altered by a caller (`r.ok = true`) and re-read as an acceptance later.
const fail = (reasonCode: AuthRejection): SubmitResult => Object.freeze({ ok: false as const, reasonCode });
const key = (principalId: string, nonce: string): string => JSON.stringify([principalId, nonce]);
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * A signed request whose signature was valid and unexpired is remembered with its OUTCOME, accepted or
 * rejected (M-1): a rejected request can never be re-submitted later when the state has changed.
 */
interface Consumed {
  readonly fingerprint: string;
  readonly outcome: Outcome;
}

export class AuthorizedLedger implements ParticipationLookup {
  // ECMAScript private fields: unreachable and not enumerable even from untyped code (B-1). The
  // configuration is copied and frozen, so replacing `principals` / `domain` later is impossible.
  readonly #config: AuthorizedLedgerConfig;
  readonly #ledger: HashChainedLedger;
  readonly #domainSeparator: Uint8Array;
  readonly #annulmentEnabled: boolean;
  readonly #consumed = new Map<string, Consumed>();
  #clockValue = 0;
  /** Highest sequencer time ever read. A clock that goes back is refused (N-4), so R6b cannot be re-opened by rewinding it. */
  #highWater = 0;

  /** Throws `TypeError` on invalid deployment configuration (not attacker input), like `Eip712AttestationVerifier`. */
  constructor(config: AuthorizedLedgerConfig) {
    const d = config.domain;
    if (d.name !== LEDGER_DOMAIN_NAME || d.version !== LEDGER_DOMAIN_VERSION) {
      throw new TypeError("ledger domain must use the ledger's own name and version");
    }
    if (d.chainId === 0n) throw new TypeError("domain.chainId must not be 0");
    if (typeof d.verifyingContract === "string" && /^0x0{40}$/i.test(d.verifyingContract)) {
      throw new TypeError("domain.verifyingContract must not be the zero address");
    }
    if (!isUint(config.registrySeq)) throw new TypeError("registrySeq must be a non-negative safe integer");
    if (!isUint(config.maxRequestTtlMs) || config.maxRequestTtlMs === 0) throw new TypeError("maxRequestTtlMs must be a positive safe integer");
    if (typeof config.now !== "function") throw new TypeError("now must be a function");
    this.#config = Object.freeze({
      now: config.now,
      domain: Object.freeze({ name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract }),
      principals: config.principals,
      funds: config.funds,
      ipos: config.ipos,
      registrySeq: config.registrySeq,
      ledgerId: config.ledgerId,
      maxRequestTtlMs: config.maxRequestTtlMs,
    });
    this.#domainSeparator = ledgerDomainSeparator(this.#config.domain, config.ledgerId); // throws TypeError for a bad ledgerId
    this.#ledger = new HashChainedLedger(() => this.#clockValue, { ledgerId: config.ledgerId });
    this.#annulmentEnabled = annulmentConfigured(config.principals);
    Object.freeze(this);
  }

  /** The identifier of this ledger instance. */
  get ledgerId(): string {
    return this.#config.ledgerId;
  }

  /** False when the principal configuration cannot provide an independent approver (I5): all corrections are rejected. */
  get annulmentAvailable(): boolean {
    return this.#annulmentEnabled;
  }

  /** Validates and applies one signed request. Never throws; every failure is a reason code and changes nothing. */
  submit(request: unknown): SubmitResult {
    try {
      return this.#submitUnchecked(request);
    } catch {
      return fail(AuthRejection.LEDGER_INTERNAL_ERROR); // a surprising throw (e.g. a hostile registry) is a rejection, never a pass
    }
  }

  #submitUnchecked(request: unknown): SubmitResult {
    // 0. Shape. A correction may lack its approver here so that we can answer COSIGN_REQUIRED later.
    const parsed = parseLedgerEventDraft(request, { allowMissingApproval: true });
    if (!parsed.ok) return fail(parsed.reasonCode === ParseRejection.EVENT_TYPE_NOT_SUPPORTED ? AuthRejection.EVENT_TYPE_NOT_SUPPORTED : AuthRejection.EVENT_MALFORMED);
    const draft = parsed.value;

    if (draft.eventType === LedgerEventType.EVENT_ANNULLED && draft.payload.reason === AnnulmentReason.BID_WITHDRAWN) {
      return fail(AuthRejection.LEDGER_BID_WITHDRAWAL_NOT_SUPPORTED);
    }
    if (draft.eventType === LedgerEventType.PARTICIPATION_RECORDED && draft.payload.origin !== ParticipationOrigin.INDEPENDENT) {
      return fail(AuthRejection.LEDGER_BIND_ORIGIN_NOT_SUPPORTED);
    }

    const now = this.#config.now();
    if (!isUint(now)) return fail(AuthRejection.LEDGER_CLOCK_INVALID);
    if (now < this.#highWater) return fail(AuthRejection.LEDGER_CLOCK_REGRESSION);
    this.#highWater = now;
    if (draft.registrySeq !== this.#config.registrySeq) return fail(AuthRejection.LEDGER_REGISTRY_SEQ_MISMATCH);

    // 1. Authentication (R2, R3, R4): who signed, is it fresh and not valid for too long, is it new.
    const auth = this.#authenticate(draft);
    if (!auth.ok) return fail(auth.reasonCode);
    const { actor, digest, recoveredActor } = auth;
    const lifetime = this.#checkLifetime(draft.authorization.expiresAt, now);
    if (lifetime !== undefined) return fail(lifetime);

    const approval = draft.coAuthorizations[0];
    const fingerprint = sha256CanonicalHex({
      digest: digestToHex(digest),
      signature: draft.authorization.signature,
      approval: approval === undefined ? null : { approverId: approval.approverId, nonce: approval.requestNonce, expiresAt: approval.expiresAt, signature: approval.signature },
      replacement: draft.eventType === LedgerEventType.EVENT_ANNULLED ? draft.payload.replacement : null,
    });
    const nonceKey = key(actor.principalId, draft.authorization.requestNonce);
    const earlier = this.#consumed.get(nonceKey);
    if (earlier !== undefined) {
      if (earlier.fingerprint !== fingerprint) return fail(AuthRejection.LEDGER_NONCE_REPLAY);
      // The same signed request again: the original result, accepted or rejected, is returned and nothing is applied twice.
      return earlier.outcome.ok ? Object.freeze({ ok: true as const, events: earlier.outcome.events, replayed: true }) : fail(earlier.outcome.reasonCode);
    }

    // From here the request is authentic and unexpired. Its nonce is consumed whatever the result
    // (M-1): a request that the domain rules rejected now must not be replayable after the state changed.
    const decided = this.#decide(draft, actor, digest, recoveredActor, now);
    const record: Consumed = { fingerprint, outcome: decided.outcome };
    this.#consumed.set(nonceKey, record);
    if (decided.outcome.ok && decided.approverKey !== undefined) this.#consumed.set(decided.approverKey, record);
    return decided.outcome.ok ? Object.freeze({ ok: true as const, events: decided.outcome.events, replayed: false }) : fail(decided.outcome.reasonCode);
  }

  /** R3 (+ M-1): not expired and not valid for longer than the configured maximum lifetime. */
  #checkLifetime(expiresAt: number, now: number): AuthRejection | undefined {
    if (expiresAt <= now) return AuthRejection.LEDGER_REQUEST_EXPIRED;
    if (expiresAt - now > this.#config.maxRequestTtlMs) return AuthRejection.LEDGER_REQUEST_TTL_EXCEEDED;
    return undefined;
  }

  /** Authorization by role (R1, R5, R6b, R8) and, for corrections, the approver (R10, R14); then the ledger fold (R6, R7, R11-R13). */
  #decide(
    draft: LedgerEventDraft,
    actor: Principal,
    digest: Uint8Array,
    recoveredActor: string,
    now: number,
  ): { readonly outcome: Outcome; readonly approverKey?: string } {
    const no = (reasonCode: AuthRejection): { readonly outcome: Outcome } => ({ outcome: { ok: false, reasonCode } });
    const approval = draft.coAuthorizations[0];
    let approverKey: string | undefined;
    switch (draft.eventType) {
      case LedgerEventType.IPO_CLOSED: {
        if (actor.role !== PrincipalRole.LEDGER_OPERATOR) return no(AuthRejection.LEDGER_OPERATOR_REQUIRED);
        const ipo = this.#config.ipos.getIpo(draft.ipoId);
        if (ipo === undefined) return no(AuthRejection.IPO_NOT_FOUND);
        if (draft.payload.closesAt !== ipo.subscriptionClosesAt) return no(AuthRejection.LEDGER_CLOSE_TIME_MISMATCH);
        if (now < ipo.subscriptionClosesAt) return no(AuthRejection.IPO_NOT_YET_CLOSABLE);
        break;
      }
      case LedgerEventType.PARTICIPATION_RECORDED:
      case LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED:
      case LedgerEventType.EVENT_ANNULLED: {
        const r = this.#authorizeManager(actor, draft.subjectFundId, draft.ipoId);
        if (r !== undefined) return no(r);
        // R6b (M-2): once the sequencer clock reached the closing time, no state event or correction is
        // accepted, whether or not IPO_CLOSED was recorded yet. No grace period. An IPO that is already
        // closed keeps the more specific rejection of the ledger fold below.
        if (!this.#ledger.isClosed(draft.ipoId)) {
          const ipo = this.#config.ipos.getIpo(draft.ipoId);
          if (ipo === undefined) return no(AuthRejection.IPO_NOT_FOUND);
          if (now >= ipo.subscriptionClosesAt) return no(AuthRejection.IPO_WINDOW_ELAPSED);
        }
        if (draft.eventType === LedgerEventType.EVENT_ANNULLED) {
          const a = this.#authorizeApproval(draft, actor, recoveredActor, digest, now);
          if (!a.ok) return no(a.reasonCode);
          if (approval !== undefined) approverKey = key(approval.approverId, approval.requestNonce);
        }
        break;
      }
    }

    // Domain rules (R6, R7, R8 once, R11-R13) are enforced by the ledger fold. A correction that
    // carries a replacement appends it in the same atomic step, derived from the signed request.
    const drafts: unknown[] = [draft];
    if (draft.eventType === LedgerEventType.EVENT_ANNULLED && draft.payload.replacement !== null) {
      drafts.push(this.#replacementDraft(draft, draft.payload.replacement));
    }
    this.#clockValue = now;
    const appended: AppendResult = this.#ledger.appendAtomic(drafts);
    if (!appended.ok) return no(appended.reasonCode);
    return approverKey === undefined ? { outcome: { ok: true, events: appended.events } } : { outcome: { ok: true, events: appended.events }, approverKey };
  }

  /** R2: registered actor, expected scheme, and a canonical signature by the actor's one key over the right typed data. */
  #authenticate(
    draft: LedgerEventDraft,
  ):
    | { readonly ok: true; readonly actor: Principal; readonly digest: Uint8Array; readonly recoveredActor: string }
    | { readonly ok: false; readonly reasonCode: AuthRejection } {
    const actor = this.#config.principals.get(draft.actorId);
    if (actor === undefined) return { ok: false, reasonCode: AuthRejection.LEDGER_ACTOR_UNKNOWN };
    const { authorization } = draft;
    let structHash: Uint8Array;
    try {
      switch (draft.eventType) {
        case LedgerEventType.PARTICIPATION_RECORDED:
        case LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED:
          if (authorization.scheme !== LedgerScheme.LEDGER_ACTION) return { ok: false, reasonCode: AuthRejection.LEDGER_SCHEME_MISMATCH };
          structHash = hashLedgerAction({
            actorId: draft.actorId,
            fundId: draft.subjectFundId,
            ipoId: draft.ipoId,
            targetState: draft.payload.to,
            requestNonce: authorization.requestNonce,
            expiresAt: authorization.expiresAt,
          });
          break;
        case LedgerEventType.EVENT_ANNULLED:
          if (authorization.scheme !== LedgerScheme.LEDGER_ANNULMENT) return { ok: false, reasonCode: AuthRejection.LEDGER_SCHEME_MISMATCH };
          structHash = hashLedgerAnnulment({
            actorId: draft.actorId,
            fundId: draft.subjectFundId,
            ipoId: draft.ipoId,
            targetSeq: draft.payload.targetSeq,
            targetEventHash: `0x${draft.payload.targetEventHash}`,
            reason: draft.payload.reason,
            replacementState: draft.payload.replacement ?? "",
            requestNonce: authorization.requestNonce,
            expiresAt: authorization.expiresAt,
          });
          break;
        case LedgerEventType.IPO_CLOSED:
          if (authorization.scheme !== LedgerScheme.OPERATOR_ACTION) return { ok: false, reasonCode: AuthRejection.LEDGER_SCHEME_MISMATCH };
          structHash = hashOperatorAction({
            actorId: draft.actorId,
            action: OPERATOR_ACTION_IPO_CLOSED,
            ipoId: draft.ipoId,
            payloadDigest: operatorPayloadDigest({ closesAt: draft.payload.closesAt }),
            requestNonce: authorization.requestNonce,
            expiresAt: authorization.expiresAt,
          });
          break;
      }
    } catch (e) {
      if (e instanceof Eip712EncodingError) return { ok: false, reasonCode: AuthRejection.LEDGER_SIGNATURE_INVALID };
      throw e;
    }
    const digest = ledgerDigest(this.#domainSeparator, structHash);
    const recovered = recoverAttestationSigner(digest, authorization.signature);
    if (recovered === undefined || recovered !== actor.address) return { ok: false, reasonCode: AuthRejection.LEDGER_SIGNATURE_INVALID };
    return { ok: true, actor, digest, recoveredActor: recovered };
  }

  /** R1 + R5 for a fund manager acting on one fund. Returns a rejection or undefined. */
  #authorizeManager(actor: Principal, fundId: FundId, ipoId: IpoId): AuthRejection | undefined {
    const fund = this.#config.funds.getFund(fundId);
    if (fund === undefined) return AuthRejection.FUND_NOT_REGISTERED;
    if (this.#config.ipos.getIpo(ipoId) === undefined) return AuthRejection.IPO_NOT_FOUND;
    if (actor.role !== PrincipalRole.FUND_MANAGER || fund.managerId !== actor.principalId) return AuthRejection.LEDGER_ACTOR_NOT_FUND_MANAGER;
    return undefined;
  }

  /**
   * R10 / R14 for a correction: the approval must exist, be signed by a registered REGISTRY_ADMIN's
   * key over the digest of THIS annulment, be fresh and new, and the approver must be independent.
   */
  #authorizeApproval(
    draft: Extract<LedgerEventDraft, { eventType: "EVENT_ANNULLED" }>,
    actor: Principal,
    recoveredActor: string,
    annulmentDigest: Uint8Array,
    now: number,
  ):
    | { readonly ok: true; readonly principal: Principal; readonly recovered: string }
    | { readonly ok: false; readonly reasonCode: AuthRejection } {
    const no = (reasonCode: AuthRejection) => ({ ok: false, reasonCode }) as const;
    if (!this.#annulmentEnabled) return no(AuthRejection.LEDGER_ANNUL_DISABLED);
    const co: LedgerCoAuthorization | undefined = draft.coAuthorizations[0];
    if (co === undefined) return no(AuthRejection.LEDGER_ANNUL_COSIGN_REQUIRED);
    if (co.scheme !== LedgerScheme.ANNULMENT_APPROVAL) return no(AuthRejection.LEDGER_SCHEME_MISMATCH);
    const approver = this.#config.principals.get(co.approverId);
    if (approver === undefined) return no(AuthRejection.LEDGER_ACTOR_UNKNOWN);
    let digest: Uint8Array;
    try {
      digest = ledgerDigest(
        this.#domainSeparator,
        hashAnnulmentApproval({ approverId: co.approverId, annulmentDigest: digestToHex(annulmentDigest), requestNonce: co.requestNonce, expiresAt: co.expiresAt }),
      );
    } catch (e) {
      if (e instanceof Eip712EncodingError) return no(AuthRejection.LEDGER_SIGNATURE_INVALID);
      throw e;
    }
    const recovered = recoverAttestationSigner(digest, co.signature);
    if (recovered === undefined || recovered !== approver.address) return no(AuthRejection.LEDGER_SIGNATURE_INVALID);
    const lifetime = this.#checkLifetime(co.expiresAt, now);
    if (lifetime !== undefined) return no(lifetime);
    if (this.#consumed.has(key(approver.principalId, co.requestNonce))) return no(AuthRejection.LEDGER_NONCE_REPLAY);
    const independent = approverIsIndependent({
      actor,
      approver,
      operator: this.#config.principals.operator(),
      recoveredActor,
      recoveredApprover: recovered,
    });
    if (!independent) return no(AuthRejection.LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT);
    if (approver.role !== PrincipalRole.REGISTRY_ADMIN) return no(AuthRejection.LEDGER_ANNUL_APPROVER_NOT_AUTHORIZED);
    return { ok: true, principal: approver, recovered };
  }

  /** The state event a correction with `replacement` appends right after itself (design §2.3), derived from the signed request. */
  #replacementDraft(annul: Extract<LedgerEventDraft, { eventType: "EVENT_ANNULLED" }>, state: "PARTICIPATING" | "NON_PARTICIPATION_LOCKED"): unknown {
    const common = {
      ipoId: annul.ipoId,
      subjectFundId: annul.subjectFundId,
      actorId: annul.actorId,
      // The same signed request covers the replacement state (`replacementState`), so its authorization is carried over.
      authorization: annul.authorization,
      coAuthorizations: [],
      registrySeq: annul.registrySeq,
      requestedAt: annul.requestedAt,
    };
    return state === ParticipationState.PARTICIPATING
      ? { ...common, eventType: LedgerEventType.PARTICIPATION_RECORDED, payload: { from: ParticipationState.UNKNOWN, to: state, origin: ParticipationOrigin.INDEPENDENT } }
      : { ...common, eventType: LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED, payload: { from: ParticipationState.UNKNOWN, to: state, origin: ParticipationOrigin.INDEPENDENT } };
  }

  /* ---- read side (same semantics as HashChainedLedger; no write access) ---- */

  getState(fundId: FundId, ipoId: IpoId): ParticipationState {
    return this.#ledger.getState(fundId, ipoId);
  }
  getStateAt(fundId: FundId, ipoId: IpoId, atSeq: number): ParticipationState {
    return this.#ledger.getStateAt(fundId, ipoId, atSeq);
  }
  isClosed(ipoId: IpoId): boolean {
    return this.#ledger.isClosed(ipoId);
  }
  cutoffSeq(ipoId: IpoId): number | undefined {
    return this.#ledger.cutoffSeq(ipoId);
  }
  events(): readonly LedgerEvent[] {
    return this.#ledger.events();
  }
  headHash(): string {
    return this.#ledger.headHash();
  }
}


// L-A: the class and its prototype are frozen, so other code in the same process cannot replace
// `getState` / `isClosed` / `submit` to make the gate's read results lie. (Arbitrary code execution in
// the process is still outside the threat model; this closes the cheap, silent way.)
Object.freeze(AuthorizedLedger.prototype);
Object.freeze(AuthorizedLedger);
