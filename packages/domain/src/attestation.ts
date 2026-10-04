import type { AttesterId, CapacityAttestation, FundId, IpoId } from "./model.js";

/* ------------------------------------------------------------------------------------------
 * Attester verification (authorization + signature)
 *
 * `AttestationVerifier` is the seam where signature checking plugs into `verifyBid`.
 *  - `Eip712AttestationVerifier` (eip712.ts) checks authorization AND the EIP-712 signature,
 *    bound to the attester's registered key.
 *  - `AllowlistAttestationVerifier` (below) checks authorization ONLY and does NOT look at
 *    `attestation.signature`. It must not be used as evidence that an attestation is authentic.
 * ---------------------------------------------------------------------------------------- */

export const AttesterVerificationFailure = {
  ATTESTER_UNAUTHORIZED: "ATTESTER_UNAUTHORIZED",
  /** Returned by signature-checking verifiers (Eip712AttestationVerifier). Never returned by AllowlistAttestationVerifier. */
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
} as const;
export type AttesterVerificationFailure = (typeof AttesterVerificationFailure)[keyof typeof AttesterVerificationFailure];

export type AttesterVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: AttesterVerificationFailure };

export interface AttestationVerifier {
  verify(attestation: CapacityAttestation): AttesterVerificationResult;
}

/**
 * Authorization-only verifier: signature verification is NOT performed. Kept for tests and
 * demos of the other `verifyBid` checks.
 *
 * @deprecated Not evidence of authenticity; do not use as the basis of any production-like
 * trust decision. Use `Eip712AttestationVerifier`.
 */
export class AllowlistAttestationVerifier implements AttestationVerifier {
  private readonly allowed: ReadonlySet<AttesterId>;

  constructor(allowedAttesters: Iterable<AttesterId>) {
    this.allowed = new Set(allowedAttesters);
  }

  verify(attestation: CapacityAttestation): AttesterVerificationResult {
    return this.allowed.has(attestation.attesterId)
      ? { ok: true }
      : { ok: false, reasonCode: AttesterVerificationFailure.ATTESTER_UNAUTHORIZED };
  }
}

/**
 * Reads every field of an attestation exactly ONCE and returns a frozen deep copy, or `undefined`
 * if reading throws (e.g. a throwing accessor) or the input is not an object. All later checks
 * (shape, signature, rule evaluation, receipt) must use the copy, never the original, so that an
 * object whose fields change between reads (accessors, shared mutable objects, proxies) cannot make
 * the signature check and the rule engine see different values.
 *
 * It copies only; it does not judge the values (types and ranges are checked later, in the
 * existing order, so reason codes do not change). Unknown extra properties are not copied.
 * Holes and non-object entries in `underlyingExposures` become `undefined`/throw and are rejected.
 */
export function snapshotAttestation(source: unknown): CapacityAttestation | undefined {
  try {
    if (typeof source !== "object" || source === null) return undefined;
    const s = source as Record<string, unknown>;
    const rawExposures = s["underlyingExposures"];
    const exposures: unknown = Array.isArray(rawExposures)
      ? Object.freeze(
          Array.from(rawExposures as unknown[], (e) => {
            const x = e as Record<string, unknown>;
            return Object.freeze({ fundId: x["fundId"], exposureKrw: x["exposureKrw"] });
          }),
        )
      : rawExposures;
    return Object.freeze({
      attestationId: s["attestationId"],
      fundId: s["fundId"],
      ipoId: s["ipoId"],
      ruleVersion: s["ruleVersion"],
      grossCapacityKrw: s["grossCapacityKrw"],
      underlyingExposures: exposures,
      issuedAt: s["issuedAt"],
      expiresAt: s["expiresAt"],
      nonce: s["nonce"],
      attesterId: s["attesterId"],
      signature: s["signature"],
    }) as unknown as CapacityAttestation;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------------------------
 * Injected read-only state used by verifyBid
 * ---------------------------------------------------------------------------------------- */

/** The only way capacity enters the system: an attestation looked up by subject. */
export interface AttestationSource {
  getAttestation(fundId: FundId, ipoId: IpoId): CapacityAttestation | undefined;
}

/** Revocation is tracked outside the signed attestation object. */
export interface RevocationLookup {
  isRevoked(attestationId: string): boolean;
}

/**
 * Nonce registry. A nonce (scoped per attester) is bound to the first attestation that used
 * it. Seeing the same nonce on a DIFFERENT attestationId is a replay.
 * Re-verifying the SAME attestation (e.g. multiple bids) is not a replay.
 */
export interface NonceLookup {
  boundAttestationId(attesterId: AttesterId, nonce: string): string | undefined;
}

/** Why `InMemoryAttestationStore.publish` refused an attestation. Nothing is stored or bound when it does. */
export const PublishRejection = {
  /** attesterId is not authorized by the injected verifier. */
  ATTESTER_UNAUTHORIZED: "ATTESTER_UNAUTHORIZED",
  /** The injected verifier rejected the signature. */
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  /** The (attesterId, nonce) pair is already bound to a different attestationId. */
  NONCE_ALREADY_BOUND: "NONCE_ALREADY_BOUND",
  /** Same attestationId as an already published attestation, but with different content. */
  ATTESTATION_ID_CONFLICT: "ATTESTATION_ID_CONFLICT",
  /** This attestationId was already replaced by a newer attestation for the subject; it cannot come back. */
  ATTESTATION_SUPERSEDED: "ATTESTATION_SUPERSEDED",
  /** For the same (fundId, ipoId), a replacement must have a strictly greater issuedAt than the current one. */
  NOT_NEWER_THAN_CURRENT: "NOT_NEWER_THAN_CURRENT",
  /** The attestation could not be read once into a plain copy (not an object, or a field access threw). */
  ATTESTATION_MALFORMED: "ATTESTATION_MALFORMED",
} as const;
export type PublishRejection = (typeof PublishRejection)[keyof typeof PublishRejection];

export type PublishResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: PublishRejection };

/**
 * In-memory attestation store. `publish` is the ONLY mutation path for attestations and nonces
 * (besides `revoke`); `verifyBid` only reads.
 *
 * Publishing rules, checked in this order, with no state change on any rejection:
 *  1. The injected `AttestationVerifier` must accept the attestation (authorization + signature),
 *     so unsigned or wrongly signed input can neither squat a nonce nor replace a genuine attestation.
 *  2. attestationId: re-publishing the identical current attestation is a no-op success; an id that
 *     was already replaced can never return (ATTESTATION_SUPERSEDED); an id reused with different
 *     content is refused (ATTESTATION_ID_CONFLICT).
 *  3. (attesterId, nonce) may be bound to one attestationId only (NONCE_ALREADY_BOUND). Bindings
 *     are never released, including those of replaced attestations.
 *  4. Per (fundId, ipoId) only the newest attestation is served. A new one replaces the current one
 *     only if its issuedAt is strictly greater (NOT_NEWER_THAN_CURRENT otherwise), so an older,
 *     possibly larger-capacity attestation cannot be put back in place of a newer one.
 *
 * `verifyBid` still verifies whatever it reads, so this gate is defence in depth, not a substitute.
 */
export class InMemoryAttestationStore implements AttestationSource, RevocationLookup, NonceLookup {
  private readonly current = new Map<string, CapacityAttestation>();
  private readonly byId = new Map<string, CapacityAttestation>();
  private readonly superseded = new Set<string>();
  private readonly revoked = new Set<string>();
  private readonly nonces = new Map<string, string>();

  constructor(private readonly verifier: AttestationVerifier) {}

  publish(input: CapacityAttestation): PublishResult {
    // Read the input once. The verifier checks this copy and the store keeps this same copy, so what
    // was verified is exactly what is served later.
    const attestation = snapshotAttestation(input);
    if (attestation === undefined) return { ok: false, reasonCode: PublishRejection.ATTESTATION_MALFORMED };
    let verdict: AttesterVerificationResult;
    try {
      verdict = this.verifier.verify(attestation);
    } catch {
      return { ok: false, reasonCode: PublishRejection.SIGNATURE_INVALID };
    }
    if (!verdict.ok) return { ok: false, reasonCode: verdict.reasonCode };

    const existing = this.byId.get(attestation.attestationId);
    if (existing !== undefined) {
      if (this.superseded.has(attestation.attestationId)) {
        return { ok: false, reasonCode: PublishRejection.ATTESTATION_SUPERSEDED };
      }
      return sameAttestation(existing, attestation)
        ? { ok: true }
        : { ok: false, reasonCode: PublishRejection.ATTESTATION_ID_CONFLICT };
    }

    const nonceKey = JSON.stringify([attestation.attesterId, attestation.nonce]);
    if (this.nonces.has(nonceKey)) {
      return { ok: false, reasonCode: PublishRejection.NONCE_ALREADY_BOUND };
    }

    const subjectKey = JSON.stringify([attestation.fundId, attestation.ipoId]);
    const replaced = this.current.get(subjectKey);
    if (replaced !== undefined && !(attestation.issuedAt > replaced.issuedAt)) {
      return { ok: false, reasonCode: PublishRejection.NOT_NEWER_THAN_CURRENT };
    }

    // All checks passed: mutate.
    if (replaced !== undefined) this.superseded.add(replaced.attestationId);
    this.nonces.set(nonceKey, attestation.attestationId);
    this.byId.set(attestation.attestationId, attestation);
    this.current.set(subjectKey, attestation);
    return { ok: true };
  }

  revoke(attestationId: string): void {
    this.revoked.add(attestationId);
  }

  getAttestation(fundId: FundId, ipoId: IpoId): CapacityAttestation | undefined {
    return this.current.get(JSON.stringify([fundId, ipoId]));
  }

  isRevoked(attestationId: string): boolean {
    return this.revoked.has(attestationId);
  }

  boundAttestationId(attesterId: AttesterId, nonce: string): string | undefined {
    return this.nonces.get(JSON.stringify([attesterId, nonce]));
  }
}

/** Field-by-field equality (signature included) so an attestationId cannot be reused for different content. */
function sameAttestation(a: CapacityAttestation, b: CapacityAttestation): boolean {
  return (
    a.attestationId === b.attestationId &&
    a.fundId === b.fundId &&
    a.ipoId === b.ipoId &&
    a.ruleVersion === b.ruleVersion &&
    a.grossCapacityKrw === b.grossCapacityKrw &&
    a.issuedAt === b.issuedAt &&
    a.expiresAt === b.expiresAt &&
    a.nonce === b.nonce &&
    a.attesterId === b.attesterId &&
    a.signature === b.signature &&
    Array.isArray(a.underlyingExposures) &&
    Array.isArray(b.underlyingExposures) &&
    a.underlyingExposures.length === b.underlyingExposures.length &&
    a.underlyingExposures.every(
      (e, i) => e.fundId === b.underlyingExposures[i]?.fundId && e.exposureKrw === b.underlyingExposures[i]?.exposureKrw,
    )
  );
}
