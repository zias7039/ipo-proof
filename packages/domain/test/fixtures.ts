import type { CapacityAttestation } from "../src/model.js";

export const NOW = 1_800_000_000_000;
export const HOUR = 60 * 60 * 1000;

/** Synthetic attestation builder. All ids are pseudonymous. */
export function att(overrides: Partial<CapacityAttestation> = {}): CapacityAttestation {
  return {
    attestationId: "att_1",
    fundId: "fund_a",
    ipoId: "ipo_1",
    ruleVersion: "DEMO_RULE_V1",
    grossCapacityKrw: 30_000_000_000n,
    underlyingExposures: [
      { fundId: "fund_b", exposureKrw: 6_000_000_000n },
      { fundId: "fund_c", exposureKrw: 4_000_000_000n },
    ],
    issuedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    nonce: "nonce_1",
    attesterId: "attester_1",
    signature: "unverified_demo_signature",
    ...overrides,
  };
}
