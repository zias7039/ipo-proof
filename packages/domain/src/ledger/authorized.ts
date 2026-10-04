/**
 * Authenticated and authorized entry point to the participation ledger (design §3, §4).
 *
 * `AuthorizedLedger.submit` is the intended way to write events. For every request it checks, in
 * the order the design proposes (authentication -> authorization -> domain), and returns a reason
 * code instead of throwing:
 *
 *  - R2  the actor is a registered principal and the EIP-712 signature recovers to its one key
 *  - R3  the request is not expired (sequencer clock)
 *  - R4  `(principal, requestNonce)` is new; an identical signed resend returns the original result
 *  - R1  a fund manager records / corrects only the funds it manages (no proxy recording)
 *  - R5  the fund and the IPO are registered
 *  - R8  IPO_CLOSED only by the single operator, only once the sequencer clock reached the IPO's
 *        closing time, once per IPO (the "once" part lives in the ledger fold)
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
 *    (Q14-N2), IPO_CLOSED delay handling (Q14-N3), checkpoints and intake receipts (§2.5).
 *
 * What the checks establish: who asked (provenance of the request) and that the request fits the
 * registered roles. They do NOT establish that the recorded fact is true (principle B), they are
 * not zero-knowledge (principle F), and independence is only as good as the registered ids, keys and
 * self-reported controller labels (T-16, Q14-N6).
 *
 * The inner HashChainedLedger is not exposed: there is no way to append through this object
 * without passing the gate. (HashChainedLedger itself stays a low-level, UNAUTHENTICATED structure.)
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
} from "./signing.js";

export const AuthRejection = {
  ...ChainRejection,
  // R2 / R3 / R4
  LEDGER_ACTOR_UNKNOWN: "LEDGER_ACTOR_UNKNOWN",
  LEDGER_SIGNATURE_INVALID: "LEDGER_SIGNATURE_INVALID",
  LEDGER_REQUEST_EXPIRED: "LEDGER_REQUEST_EXPIRED",
  LEDGER_NONCE_REPLAY: "LEDGER_NONCE_REPLAY",
  // R1 / R5 / R8
  LEDGER_ACTOR_NOT_FUND_MANAGER: "LEDGER_ACTOR_NOT_FUND_MANAGER",
  FUND_NOT_REGISTERED: "FUND_NOT_REGISTERED",
  IPO_NOT_FOUND: "IPO_NOT_FOUND",
  LEDGER_OPERATOR_REQUIRED: "LEDGER_OPERATOR_REQUIRED",
  IPO_NOT_YET_CLOSABLE: "IPO_NOT_YET_CLOSABLE",
  // R10 / R14
  LEDGER_ANNUL_COSIGN_REQUIRED: "LEDGER_ANNUL_COSIGN_REQUIRED",
  LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT: "LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT",
  LEDGER_ANNUL_DISABLED: "LEDGER_ANNUL_DISABLED",
  // Provisional names: the design names no code for these cases (open questions in the PR).
  LEDGER_ANNUL_APPROVER_NOT_AUTHORIZED: "LEDGER_ANNUL_APPROVER_NOT_AUTHORIZED",
  LEDGER_AUTH_SCHEME_MISMATCH: "LEDGER_AUTH_SCHEME_MISMATCH",
  LEDGER_REGISTRY_SEQ_MISMATCH: "LEDGER_REGISTRY_SEQ_MISMATCH",
  LEDGER_CLOSE_TIME_MISMATCH: "LEDGER_CLOSE_TIME_MISMATCH",
  // Out of scope of this PR, rejected fail closed.
  LEDGER_BID_WITHDRAWAL_NOT_SUPPORTED: "LEDGER_BID_WITHDRAWAL_NOT_SUPPORTED",
  LEDGER_BIND_ORIGIN_NOT_SUPPORTED: "LEDGER_BIND_ORIGIN_NOT_SUPPORTED",
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
}

const fail = (reasonCode: AuthRejection): SubmitResult => ({ ok: false, reasonCode });
const key = (principalId: string, nonce: string): string => JSON.stringify([principalId, nonce]);
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

interface Consumed {
  readonly fingerprint: string;
  readonly events: readonly LedgerEvent[];
}

export class AuthorizedLedger implements ParticipationLookup {
  // ECMAScript private fields: the inner ledger and the nonce table are unreachable even from untyped code.
  #clockValue = 0;
  readonly #ledger = new HashChainedLedger(() => this.#clockValue);
  private readonly domainSeparator: Uint8Array;
  private readonly annulmentEnabled: boolean;
  readonly #consumed = new Map<string, Consumed>();

  /** Throws `TypeError` on invalid deployment configuration (not attacker input), like `Eip712AttestationVerifier`. */
  constructor(private readonly config: AuthorizedLedgerConfig) {
    const d = config.domain;
    if (d.name !== LEDGER_DOMAIN_NAME || d.version !== LEDGER_DOMAIN_VERSION) {
      throw new TypeError("ledger domain must use the ledger's own name and version");
    }
    if (d.chainId === 0n) throw new TypeError("domain.chainId must not be 0");
    if (typeof d.verifyingContract === "string" && /^0x0{40}$/i.test(d.verifyingContract)) {
      throw new TypeError("domain.verifyingContract must not be the zero address");
    }
    if (!isUint(config.registrySeq)) throw new TypeError("registrySeq must be a non-negative safe integer");
    this.domainSeparator = ledgerDomainSeparator(d);
    this.annulmentEnabled = annulmentConfigured(config.principals);
  }

  /** False when the principal configuration cannot provide an independent approver (I5): all corrections are rejected. */
  get annulmentAvailable(): boolean {
    return this.annulmentEnabled;
  }

  /** Validates and applies one signed request. Never throws; every failure is a reason code and changes nothing. */
  submit(request: unknown): SubmitResult {
    try {
      return this.submitUnchecked(request);
    } catch {
      return fail(AuthRejection.EVENT_MALFORMED); // a surprising throw (e.g. a hostile registry) is a rejection, never a pass
    }
  }

  private submitUnchecked(request: unknown): SubmitResult {
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

    const now = this.config.now();
    if (!isUint(now)) return fail(AuthRejection.LEDGER_CLOCK_INVALID);
    if (draft.registrySeq !== this.config.registrySeq) return fail(AuthRejection.LEDGER_REGISTRY_SEQ_MISMATCH);

    // 1. Authentication (R2, R3, R4): who signed, is it fresh, is it new.
    const auth = this.authenticate(draft);
    if (!auth.ok) return fail(auth.reasonCode);
    const { actor, digest, recoveredActor } = auth;
    if (draft.authorization.expiresAt <= now) return fail(AuthRejection.LEDGER_REQUEST_EXPIRED);

    const approval = draft.coAuthorizations[0];
    const fingerprint = sha256CanonicalHex({
      digest: digestToHex(digest),
      signature: draft.authorization.signature.toLowerCase(),
      approval: approval === undefined ? null : { approverId: approval.approverId, nonce: approval.requestNonce, expiresAt: approval.expiresAt, signature: approval.signature.toLowerCase() },
      replacement: draft.eventType === LedgerEventType.EVENT_ANNULLED ? draft.payload.replacement : null,
    });
    const earlier = this.#consumed.get(key(actor.principalId, draft.authorization.requestNonce));
    if (earlier !== undefined) {
      return earlier.fingerprint === fingerprint ? { ok: true, events: earlier.events, replayed: true } : fail(AuthRejection.LEDGER_NONCE_REPLAY);
    }

    // 2. Authorization by role (R1, R5, R8) and, for corrections, the approver (R10, R14).
    let approver: { readonly principal: Principal; readonly recovered: string } | undefined;
    switch (draft.eventType) {
      case LedgerEventType.IPO_CLOSED: {
        if (actor.role !== PrincipalRole.LEDGER_OPERATOR) return fail(AuthRejection.LEDGER_OPERATOR_REQUIRED);
        const ipo = this.config.ipos.getIpo(draft.ipoId);
        if (ipo === undefined) return fail(AuthRejection.IPO_NOT_FOUND);
        if (draft.payload.closesAt !== ipo.subscriptionClosesAt) return fail(AuthRejection.LEDGER_CLOSE_TIME_MISMATCH);
        if (now < ipo.subscriptionClosesAt) return fail(AuthRejection.IPO_NOT_YET_CLOSABLE);
        break;
      }
      case LedgerEventType.PARTICIPATION_RECORDED:
      case LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED:
      case LedgerEventType.EVENT_ANNULLED: {
        const r = this.authorizeManager(actor, draft.subjectFundId, draft.ipoId);
        if (r !== undefined) return fail(r);
        if (draft.eventType === LedgerEventType.EVENT_ANNULLED) {
          const a = this.authorizeApproval(draft, actor, recoveredActor, digest, now);
          if (!a.ok) return fail(a.reasonCode);
          approver = a;
        }
        break;
      }
    }

    // 3. Domain rules (R6, R7, R8 once, R11-R13) are enforced by the ledger fold. A correction that
    //    carries a replacement appends it in the same atomic step, derived from the signed request.
    const drafts: unknown[] = [draft];
    if (draft.eventType === LedgerEventType.EVENT_ANNULLED && draft.payload.replacement !== null) {
      drafts.push(this.replacementDraft(draft, draft.payload.replacement));
    }
    this.#clockValue = now;
    const appended: AppendResult = this.#ledger.appendAtomic(drafts);
    if (!appended.ok) return fail(appended.reasonCode);

    const record: Consumed = { fingerprint, events: appended.events };
    this.#consumed.set(key(actor.principalId, draft.authorization.requestNonce), record);
    if (approver !== undefined && approval !== undefined) this.#consumed.set(key(approval.approverId, approval.requestNonce), record);
    return { ok: true, events: appended.events, replayed: false };
  }

  /** R2: registered actor, expected scheme, and a canonical signature by the actor's one key over the right typed data. */
  private authenticate(
    draft: LedgerEventDraft,
  ):
    | { readonly ok: true; readonly actor: Principal; readonly digest: Uint8Array; readonly recoveredActor: string }
    | { readonly ok: false; readonly reasonCode: AuthRejection } {
    const actor = this.config.principals.get(draft.actorId);
    if (actor === undefined) return { ok: false, reasonCode: AuthRejection.LEDGER_ACTOR_UNKNOWN };
    const { authorization } = draft;
    let structHash: Uint8Array;
    try {
      switch (draft.eventType) {
        case LedgerEventType.PARTICIPATION_RECORDED:
        case LedgerEventType.NON_PARTICIPATION_LOCKED_RECORDED:
          if (authorization.scheme !== LedgerScheme.LEDGER_ACTION) return { ok: false, reasonCode: AuthRejection.LEDGER_AUTH_SCHEME_MISMATCH };
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
          if (authorization.scheme !== LedgerScheme.LEDGER_ANNULMENT) return { ok: false, reasonCode: AuthRejection.LEDGER_AUTH_SCHEME_MISMATCH };
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
          if (authorization.scheme !== LedgerScheme.OPERATOR_ACTION) return { ok: false, reasonCode: AuthRejection.LEDGER_AUTH_SCHEME_MISMATCH };
          structHash = hashOperatorAction({
            action: OPERATOR_ACTION_IPO_CLOSED,
            ipoId: draft.ipoId,
            requestNonce: authorization.requestNonce,
            expiresAt: authorization.expiresAt,
          });
          break;
      }
    } catch (e) {
      if (e instanceof Eip712EncodingError) return { ok: false, reasonCode: AuthRejection.LEDGER_SIGNATURE_INVALID };
      throw e;
    }
    const digest = ledgerDigest(this.domainSeparator, structHash);
    const recovered = recoverAttestationSigner(digest, authorization.signature);
    if (recovered === undefined || recovered !== actor.address) return { ok: false, reasonCode: AuthRejection.LEDGER_SIGNATURE_INVALID };
    return { ok: true, actor, digest, recoveredActor: recovered };
  }

  /** R1 + R5 for a fund manager acting on one fund. Returns a rejection or undefined. */
  private authorizeManager(actor: Principal, fundId: FundId, ipoId: IpoId): AuthRejection | undefined {
    const fund = this.config.funds.getFund(fundId);
    if (fund === undefined) return AuthRejection.FUND_NOT_REGISTERED;
    if (this.config.ipos.getIpo(ipoId) === undefined) return AuthRejection.IPO_NOT_FOUND;
    if (actor.role !== PrincipalRole.FUND_MANAGER || fund.managerId !== actor.principalId) return AuthRejection.LEDGER_ACTOR_NOT_FUND_MANAGER;
    return undefined;
  }

  /**
   * R10 / R14 for a correction: the approval must exist, be signed by a registered REGISTRY_ADMIN's
   * key over the digest of THIS annulment, be fresh and new, and the approver must be independent.
   */
  private authorizeApproval(
    draft: Extract<LedgerEventDraft, { eventType: "EVENT_ANNULLED" }>,
    actor: Principal,
    recoveredActor: string,
    annulmentDigest: Uint8Array,
    now: number,
  ):
    | { readonly ok: true; readonly principal: Principal; readonly recovered: string }
    | { readonly ok: false; readonly reasonCode: AuthRejection } {
    const no = (reasonCode: AuthRejection) => ({ ok: false, reasonCode }) as const;
    if (!this.annulmentEnabled) return no(AuthRejection.LEDGER_ANNUL_DISABLED);
    const co: LedgerCoAuthorization | undefined = draft.coAuthorizations[0];
    if (co === undefined) return no(AuthRejection.LEDGER_ANNUL_COSIGN_REQUIRED);
    if (co.scheme !== LedgerScheme.ANNULMENT_APPROVAL) return no(AuthRejection.LEDGER_AUTH_SCHEME_MISMATCH);
    const approver = this.config.principals.get(co.approverId);
    if (approver === undefined) return no(AuthRejection.LEDGER_ACTOR_UNKNOWN);
    let digest: Uint8Array;
    try {
      digest = ledgerDigest(
        this.domainSeparator,
        hashAnnulmentApproval({ approverId: co.approverId, annulmentDigest: digestToHex(annulmentDigest), requestNonce: co.requestNonce, expiresAt: co.expiresAt }),
      );
    } catch (e) {
      if (e instanceof Eip712EncodingError) return no(AuthRejection.LEDGER_SIGNATURE_INVALID);
      throw e;
    }
    const recovered = recoverAttestationSigner(digest, co.signature);
    if (recovered === undefined || recovered !== approver.address) return no(AuthRejection.LEDGER_SIGNATURE_INVALID);
    if (co.expiresAt <= now) return no(AuthRejection.LEDGER_REQUEST_EXPIRED);
    if (this.#consumed.has(key(approver.principalId, co.requestNonce))) return no(AuthRejection.LEDGER_NONCE_REPLAY);
    const independent = approverIsIndependent({
      actor,
      approver,
      operator: this.config.principals.operator(),
      recoveredActor,
      recoveredApprover: recovered,
    });
    if (!independent) return no(AuthRejection.LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT);
    if (approver.role !== PrincipalRole.REGISTRY_ADMIN) return no(AuthRejection.LEDGER_ANNUL_APPROVER_NOT_AUTHORIZED);
    return { ok: true, principal: approver, recovered };
  }

  /** The state event a correction with `replacement` appends right after itself (design §2.3), derived from the signed request. */
  private replacementDraft(annul: Extract<LedgerEventDraft, { eventType: "EVENT_ANNULLED" }>, state: "PARTICIPATING" | "NON_PARTICIPATION_LOCKED"): unknown {
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

