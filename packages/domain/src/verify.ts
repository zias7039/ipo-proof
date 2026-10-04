import { snapshotAttestation } from "./attestation.js";
import type { AttestationSource, AttestationVerifier, AttesterVerificationResult, NonceLookup, RevocationLookup } from "./attestation.js";
import { sha256CanonicalHex } from "./hash.js";
import type { CapacityAttestation, FundId, IpoId, RuleVersion } from "./model.js";
import { isSyntheticId } from "./model.js";
import { isKrw } from "./money.js";
import type { Krw } from "./money.js";
import { ParticipationState, readParticipationState } from "./participation.js";
import type { ParticipationLookup } from "./participation.js";
import type { FundRegistry, IpoRegistry } from "./registry.js";
import { UndeterminedCause, evaluateRule, getRegisteredRuleVersion } from "./rules.js";
import type { RuleFlag } from "./rules.js";

/**
 * A bid to verify. Note what is NOT here: there is deliberately no capacity field.
 * Capacity comes only from a CapacityAttestation looked up from injected state.
 */
export interface BidRequest {
  readonly fundId: FundId;
  readonly ipoId: IpoId;
  readonly bidAmount: Krw;
}

export const BidReason = {
  ELIGIBLE: "ELIGIBLE",
  INVALID_BID_REQUEST: "INVALID_BID_REQUEST",
  INVALID_BID_AMOUNT: "INVALID_BID_AMOUNT",
  FUND_NOT_REGISTERED: "FUND_NOT_REGISTERED",
  IPO_NOT_FOUND: "IPO_NOT_FOUND",
  IPO_NOT_OPEN: "IPO_NOT_OPEN",
  NON_PARTICIPATION_LOCK_ACTIVE: "NON_PARTICIPATION_LOCK_ACTIVE",
  /**
   * The active rule version is missing, not a registered id, or carries parameters that differ from the
   * registered definition (for example a tampered or non-finite `maxAttestationAgeMs`).
   */
  RULE_VERSION_UNSUPPORTED: "RULE_VERSION_UNSUPPORTED",
  /** The bidding fund's own participation lookup threw or returned something other than the three known states. */
  PARTICIPATION_LOOKUP_INVALID: "PARTICIPATION_LOOKUP_INVALID",
  ATTESTATION_NOT_FOUND: "ATTESTATION_NOT_FOUND",
  ATTESTATION_SUBJECT_MISMATCH: "ATTESTATION_SUBJECT_MISMATCH",
  ATTESTATION_MALFORMED: "ATTESTATION_MALFORMED",
  RULE_VERSION_MISMATCH: "RULE_VERSION_MISMATCH",
  ATTESTER_UNAUTHORIZED: "ATTESTER_UNAUTHORIZED",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  ATTESTATION_REVOKED: "ATTESTATION_REVOKED",
  ATTESTATION_NOT_YET_VALID: "ATTESTATION_NOT_YET_VALID",
  ATTESTATION_EXPIRED: "ATTESTATION_EXPIRED",
  ATTESTATION_STALE: "ATTESTATION_STALE",
  ATTESTATION_NONCE_REPLAY: "ATTESTATION_NONCE_REPLAY",
  UNDERLYING_EXPOSURE_OMITTED: "UNDERLYING_EXPOSURE_OMITTED",
  UNDERLYING_EXPOSURE_NOT_IN_REGISTRY: "UNDERLYING_EXPOSURE_NOT_IN_REGISTRY",
  /** An underlying fund has no recorded participation (UNKNOWN). Not exempt, not assumed: rejected. */
  UNDERLYING_PARTICIPATION_UNKNOWN: "UNDERLYING_PARTICIPATION_UNKNOWN",
  /** DEMO_RULE_V2 only: an UNKNOWN underlying fund has 0 KRW exposure, which cannot exist (data error). Takes precedence over the generic UNKNOWN rejection. */
  UNDERLYING_ZERO_EXPOSURE_UNKNOWN: "UNDERLYING_ZERO_EXPOSURE_UNKNOWN",
  DUPLICATE_UNDERLYING_EXPOSURE: "DUPLICATE_UNDERLYING_EXPOSURE",
  BID_EXCEEDS_ADJUSTED_CAPACITY: "BID_EXCEEDS_ADJUSTED_CAPACITY",
} as const;
export type BidReason = (typeof BidReason)[keyof typeof BidReason];

/**
 * Label for `proofHash`. It is a plain SHA-256 receipt hash. It is NOT a zero-knowledge
 * proof and proves nothing about the correctness of the computation.
 */
export const PROOF_HASH_KIND = "SHA256_RECEIPT_NOT_A_ZK_PROOF";

export interface BidVerification {
  readonly eligible: boolean;
  readonly reasonCode: BidReason;
  readonly ruleVersion: string;
  /** SHA-256 receipt hash (hex). NOT a ZK proof. See PROOF_HASH_KIND and buildReceipt(). */
  readonly proofHash: string;
  readonly proofHashKind: typeof PROOF_HASH_KIND;
  /** Integer epoch milliseconds from the injected clock. */
  readonly verifiedAt: number;
  /** Non-fatal notes from the rule, e.g. DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO. */
  readonly flags: readonly RuleFlag[];
}

export interface Clock {
  now(): number;
}

/** Everything verifyBid reads. All of it is injected; verifyBid itself holds no state. */
export interface VerifyBidDeps {
  readonly clock: Clock;
  readonly activeRuleVersion: RuleVersion;
  readonly funds: FundRegistry;
  readonly ipos: IpoRegistry;
  readonly participation: ParticipationLookup;
  readonly attestations: AttestationSource;
  readonly revocations: RevocationLookup;
  readonly nonces: NonceLookup;
  readonly attesterVerifier: AttestationVerifier;
}

interface ReceiptFields {
  readonly fundId: unknown;
  readonly ipoId: unknown;
  readonly ruleVersion: string;
  readonly attestationId: string | null;
  readonly attesterId: string | null;
  readonly eligible: boolean;
  readonly reasonCode: BidReason;
  readonly flags: readonly RuleFlag[];
  readonly verifiedAt: number;
}

/**
 * Builds the canonical receipt that is hashed into `proofHash`.
 *
 * INCLUDED (non-sensitive): receipt kind/version, fund id, IPO id, rule version, attestation id,
 * attester id, eligibility, reason code, flags, verification time.
 * EXCLUDED (sensitive): bid amount, gross capacity, any exposure amounts, adjusted capacity,
 * underlying-fund identities, signature. Hashing low-entropy amounts would be brute-forceable,
 * so they are left out entirely.
 */
export function buildReceipt(fields: ReceiptFields): Record<string, unknown> {
  return {
    kind: PROOF_HASH_KIND,
    version: 1,
    fundId: typeof fields.fundId === "string" ? fields.fundId : null,
    ipoId: typeof fields.ipoId === "string" ? fields.ipoId : null,
    ruleVersion: fields.ruleVersion,
    attestationId: fields.attestationId,
    attesterId: fields.attesterId,
    eligible: fields.eligible,
    reasonCode: fields.reasonCode,
    flags: [...fields.flags],
    verifiedAt: fields.verifiedAt,
  };
}

const REQUEST_KEYS = ["bidAmount", "fundId", "ipoId"];

/** Receipt placeholder for a missing or non-string active rule id. Not a valid id (see `isSyntheticId`), so it cannot collide with a real rule. */
export const INVALID_RULE_VERSION_ID = "<invalid>";

/** The caller-supplied rule version, read ONCE. Fields are unknown until compared with the registry. */
function readActiveRule(v: unknown): { readonly id: unknown; readonly maxAttestationAgeMs: unknown } {
  try {
    // undefined / null throw on access and a primitive has neither field: all end up in the catch / as undefined.
    const r = v as Record<string, unknown>;
    return { id: r["id"], maxAttestationAgeMs: r["maxAttestationAgeMs"] };
  } catch {
    return { id: undefined, maxAttestationAgeMs: undefined };
  }
}

/**
 * Pure verification of a bid against injected state. First failing check wins; order:
 *  request shape -> bid amount -> fund registered -> IPO exists/open -> rule version supported and its
 *  parameters equal the registered definition (RULE_VERSION_UNSUPPORTED otherwise)
 *  -> subject's own lock (an invalid lookup answer is PARTICIPATION_LOOKUP_INVALID) -> attestation present/subject/shape -> rule version match
 *  -> attester authorization + signature (per injected verifier) -> revoked -> validity window
 *  (not-yet-valid / expired / stale) -> nonce replay -> underlying exposure completeness
 *  -> rule evaluation (rejects if any underlying participation is UNKNOWN; DEMO_RULE_V2: a 0 KRW UNKNOWN is reported first as a data error) -> bid vs adjusted capacity.
 */
export function verifyBid(request: unknown, deps: VerifyBidDeps): BidVerification {
  const verifiedAt = deps.clock.now();
  // The active rule is read once. Only its id is trusted to SELECT a rule; the stale limit comes from
  // the registered definition, and a caller object whose parameters differ from it is refused below.
  const active = readActiveRule(deps.activeRuleVersion);
  const registered = getRegisteredRuleVersion(active.id);
  const ruleVersion = typeof active.id === "string" ? active.id : INVALID_RULE_VERSION_ID;
  // Context accumulated while checking; only non-sensitive parts end up in the receipt.
  const ctx: { attestation: CapacityAttestation | undefined; flags: readonly RuleFlag[] } = {
    attestation: undefined,
    flags: [],
  };

  const finish = (reasonCode: BidReason): BidVerification => {
    const eligible = reasonCode === BidReason.ELIGIBLE;
    const receipt = buildReceipt({
      fundId: isRecord(request) ? request["fundId"] : undefined,
      ipoId: isRecord(request) ? request["ipoId"] : undefined,
      ruleVersion,
      attestationId: typeof ctx.attestation?.attestationId === "string" ? ctx.attestation.attestationId : null,
      attesterId: typeof ctx.attestation?.attesterId === "string" ? ctx.attestation.attesterId : null,
      eligible,
      reasonCode,
      flags: ctx.flags,
      verifiedAt,
    });
    return {
      eligible,
      reasonCode,
      ruleVersion,
      proofHash: sha256CanonicalHex(receipt),
      proofHashKind: PROOF_HASH_KIND,
      verifiedAt,
      flags: ctx.flags,
    };
  };

  // 1. Request shape: exactly {fundId, ipoId, bidAmount}. Extra fields (e.g. a self-declared
  //    capacity) are rejected, never read.
  if (
    !isRecord(request) ||
    Object.keys(request).sort().join(",") !== REQUEST_KEYS.join(",") ||
    !isSyntheticId(request["fundId"]) ||
    !isSyntheticId(request["ipoId"])
  ) {
    return finish(BidReason.INVALID_BID_REQUEST);
  }
  const { fundId, ipoId, bidAmount } = request as { fundId: string; ipoId: string; bidAmount: unknown };
  if (!isKrw(bidAmount) || bidAmount === 0n) {
    return finish(BidReason.INVALID_BID_AMOUNT);
  }

  // 2. Registries.
  const fund = deps.funds.getFund(fundId);
  if (fund === undefined) return finish(BidReason.FUND_NOT_REGISTERED);
  const ipo = deps.ipos.getIpo(ipoId);
  if (ipo === undefined) return finish(BidReason.IPO_NOT_FOUND);
  if (verifiedAt < ipo.subscriptionOpensAt || verifiedAt >= ipo.subscriptionClosesAt) {
    return finish(BidReason.IPO_NOT_OPEN);
  }
  // Unregistered id, or parameters that differ from the registered definition (NaN, Infinity, undefined,
  // negative, non-integer, or simply a different number): refuse. Object.is so that NaN never matches.
  if (registered === undefined || !Object.is(active.maxAttestationAgeMs, registered.maxAttestationAgeMs)) {
    return finish(BidReason.RULE_VERSION_UNSUPPORTED);
  }
  const maxAttestationAgeMs = registered.maxAttestationAgeMs;

  // 3. The bidding fund's own lock. Own UNKNOWN is allowed (not yet recorded); LOCKED is not. An answer
  //    that is not one of the three states (or a lookup that throws) is not "UNKNOWN": it is refused.
  const ownState = readParticipationState(deps.participation, fundId, ipoId);
  if (ownState === undefined) return finish(BidReason.PARTICIPATION_LOOKUP_INVALID);
  if (ownState === ParticipationState.NON_PARTICIPATION_LOCKED) {
    return finish(BidReason.NON_PARTICIPATION_LOCK_ACTIVE);
  }

  // 4. Attestation presence, subject, shape. The attestation is read ONCE into a frozen copy; every
  //    later check, the verifier, the rule engine and the receipt use that copy only.
  const fetched = deps.attestations.getAttestation(fundId, ipoId);
  if (fetched === undefined) return finish(BidReason.ATTESTATION_NOT_FOUND);
  const attestation = snapshotAttestation(fetched);
  if (attestation === undefined) return finish(BidReason.ATTESTATION_MALFORMED);
  ctx.attestation = attestation;
  if (attestation.fundId !== fundId || attestation.ipoId !== ipoId) {
    return finish(BidReason.ATTESTATION_SUBJECT_MISMATCH);
  }
  if (!isWellFormed(attestation)) return finish(BidReason.ATTESTATION_MALFORMED);
  if (attestation.ruleVersion !== ruleVersion) return finish(BidReason.RULE_VERSION_MISMATCH);

  // 5. Attester authorization and signature, as implemented by the injected verifier
  //    (Eip712AttestationVerifier checks both; AllowlistAttestationVerifier only authorization).
  let attester: AttesterVerificationResult;
  try {
    attester = deps.attesterVerifier.verify(attestation);
  } catch {
    return finish(BidReason.SIGNATURE_INVALID);
  }
  if (!attester.ok) return finish(attester.reasonCode);

  // 6. Revocation, validity window, staleness.
  if (deps.revocations.isRevoked(attestation.attestationId)) return finish(BidReason.ATTESTATION_REVOKED);
  if (verifiedAt < attestation.issuedAt) return finish(BidReason.ATTESTATION_NOT_YET_VALID);
  if (verifiedAt >= attestation.expiresAt) return finish(BidReason.ATTESTATION_EXPIRED);
  if (verifiedAt - attestation.issuedAt > maxAttestationAgeMs) {
    return finish(BidReason.ATTESTATION_STALE);
  }

  // 7. Nonce replay: nonce already bound to a different attestation.
  const bound = deps.nonces.boundAttestationId(attestation.attesterId, attestation.nonce);
  if (bound !== undefined && bound !== attestation.attestationId) {
    return finish(BidReason.ATTESTATION_NONCE_REPLAY);
  }

  // 8. Completeness: attested exposures must cover exactly the registry's underlying funds.
  const attested = attestation.underlyingExposures.map((e) => e.fundId);
  if (new Set(attested).size !== attested.length) return finish(BidReason.DUPLICATE_UNDERLYING_EXPOSURE);
  const registryIds = new Set(fund.underlyingFundIds);
  if (fund.underlyingFundIds.some((id) => !attested.includes(id))) {
    return finish(BidReason.UNDERLYING_EXPOSURE_OMITTED);
  }
  if (attested.some((id) => !registryIds.has(id))) {
    return finish(BidReason.UNDERLYING_EXPOSURE_NOT_IN_REGISTRY);
  }

  // 9. Rule evaluation and the bid check.
  const evaluation = evaluateRule(ruleVersion, {
    ipoId,
    grossCapacityKrw: attestation.grossCapacityKrw,
    exposures: attestation.underlyingExposures,
    participation: deps.participation,
  });
  if (evaluation === undefined) return finish(BidReason.RULE_VERSION_UNSUPPORTED);
  if (!evaluation.determined) {
    return finish(
      evaluation.cause === UndeterminedCause.ZERO_EXPOSURE_UNKNOWN
        ? BidReason.UNDERLYING_ZERO_EXPOSURE_UNKNOWN
        : BidReason.UNDERLYING_PARTICIPATION_UNKNOWN,
    );
  }
  ctx.flags = evaluation.flags;
  return finish(bidAmount <= evaluation.adjustedCapacityKrw ? BidReason.ELIGIBLE : BidReason.BID_EXCEEDS_ADJUSTED_CAPACITY);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isWellFormed(a: CapacityAttestation): boolean {
  return (
    isKrw(a.grossCapacityKrw) &&
    typeof a.attestationId === "string" &&
    typeof a.attesterId === "string" &&
    typeof a.nonce === "string" &&
    typeof a.signature === "string" &&
    Number.isSafeInteger(a.issuedAt) &&
    Number.isSafeInteger(a.expiresAt) &&
    a.issuedAt < a.expiresAt &&
    Array.isArray(a.underlyingExposures) &&
    a.underlyingExposures.every((e) => isSyntheticId(e.fundId) && isKrw(e.exposureKrw))
  );
}
