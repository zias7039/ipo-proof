import type { Krw } from "./money.js";

/**
 * Identifiers are synthetic, pseudonymous strings such as `fund_a`, `ipo_1`, `attester_1`.
 * This repository must never contain real fund names, AUM, or personal data.
 */
export type FundId = string;
export type IpoId = string;
export type AttesterId = string;
export type RuleVersionId = string;

const SYNTHETIC_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** Identifiers must be lowercase snake-case tokens (e.g. `fund_a`). */
export function isSyntheticId(value: unknown): value is string {
  return typeof value === "string" && SYNTHETIC_ID.test(value);
}

/**
 * A fund known to the (independent) fund registry.
 * `underlyingFundIds` is the registry's view of the funds this fund invests in. It is the
 * reference used to detect attestations that omit an underlying fund.
 */
export interface Fund {
  readonly fundId: FundId;
  readonly managerId: string;
  readonly underlyingFundIds: readonly FundId[];
}

/** An IPO subscription. Times are integer epoch milliseconds. */
export interface IPO {
  readonly ipoId: IpoId;
  readonly subscriptionOpensAt: number;
  readonly subscriptionClosesAt: number;
}

/** The attested KRW exposure of the subject fund to one underlying fund. */
export interface UnderlyingFundExposure {
  readonly fundId: FundId;
  readonly exposureKrw: Krw;
}

/** Parameters of a rule version. The computation itself lives in the rule engine. */
export interface RuleVersion {
  readonly id: RuleVersionId;
  readonly description: string;
  /** Attestations older than this (now - issuedAt) are STALE. Integer milliseconds. */
  readonly maxAttestationAgeMs: number;
}

/**
 * The ONLY source of gross payment capacity in the system. It is produced by an attester,
 * never by the asset manager submitting a bid. Times are integer epoch milliseconds.
 *
 * `signature` is an opaque string. Signature verification is NOT IMPLEMENTED in this slice
 * (see AttestationVerifier); revocation is tracked outside the signed object.
 */
export interface CapacityAttestation {
  readonly attestationId: string;
  readonly fundId: FundId;
  readonly ipoId: IpoId;
  readonly ruleVersion: RuleVersionId;
  readonly grossCapacityKrw: Krw;
  readonly underlyingExposures: readonly UnderlyingFundExposure[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly attesterId: AttesterId;
  readonly signature: string;
}
