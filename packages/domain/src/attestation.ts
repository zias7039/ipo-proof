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

export class InMemoryAttestationStore implements AttestationSource, RevocationLookup, NonceLookup {
  private readonly attestations = new Map<string, CapacityAttestation>();
  private readonly revoked = new Set<string>();
  private readonly nonces = new Map<string, string>();

  /** Publishes an attestation and binds its nonce. Returns false if the nonce is already bound to another attestation. */
  publish(attestation: CapacityAttestation): boolean {
    const nonceKey = JSON.stringify([attestation.attesterId, attestation.nonce]);
    const bound = this.nonces.get(nonceKey);
    if (bound !== undefined && bound !== attestation.attestationId) {
      return false;
    }
    this.nonces.set(nonceKey, attestation.attestationId);
    this.attestations.set(JSON.stringify([attestation.fundId, attestation.ipoId]), attestation);
    return true;
  }

  revoke(attestationId: string): void {
    this.revoked.add(attestationId);
  }

  getAttestation(fundId: FundId, ipoId: IpoId): CapacityAttestation | undefined {
    return this.attestations.get(JSON.stringify([fundId, ipoId]));
  }

  isRevoked(attestationId: string): boolean {
    return this.revoked.has(attestationId);
  }

  boundAttestationId(attesterId: AttesterId, nonce: string): string | undefined {
    return this.nonces.get(JSON.stringify([attesterId, nonce]));
  }
}
