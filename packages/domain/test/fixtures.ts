import type { CapacityAttestation } from "../src/model.js";
import { AllowlistAttestationVerifier, InMemoryAttestationStore } from "../src/attestation.js";
import { InMemoryParticipationLedger } from "../src/participation.js";
import { InMemoryFundRegistry, InMemoryIpoRegistry } from "../src/registry.js";
import { DEMO_RULE_V1 } from "../src/rules.js";
import type { VerifyBidDeps } from "../src/verify.js";

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


export interface Env {
  readonly deps: VerifyBidDeps;
  readonly ledger: InMemoryParticipationLedger;
  readonly store: InMemoryAttestationStore;
  readonly clock: { t: number; now(): number };
}

/**
 * Demo world (all ids synthetic):
 *  - fund_a is the bidding fund; the registry says it invests in fund_b and fund_c.
 *  - fund_b is PARTICIPATING in ipo_1, fund_c is NON_PARTICIPATION_LOCKED in ipo_1.
 *  - one valid attestation for fund_a / ipo_1 is published.
 */
export function makeEnv(opts: { attestation?: CapacityAttestation | null; recordStates?: boolean } = {}): Env {
  const clock = { t: NOW, now: () => clock.t };
  const ledger = new InMemoryParticipationLedger(() => clock.t);
  if (opts.recordStates !== false) {
    ledger.requestParticipation("fund_b", "ipo_1");
    ledger.requestNonParticipationLock("fund_c", "ipo_1");
  }
  const store = new InMemoryAttestationStore();
  if (opts.attestation !== null) store.publish(opts.attestation ?? att());
  const deps: VerifyBidDeps = {
    clock,
    activeRuleVersion: DEMO_RULE_V1,
    funds: new InMemoryFundRegistry([
      { fundId: "fund_a", managerId: "manager_1", underlyingFundIds: ["fund_b", "fund_c"] },
      { fundId: "fund_b", managerId: "manager_2", underlyingFundIds: [] },
      { fundId: "fund_c", managerId: "manager_3", underlyingFundIds: [] },
    ]),
    ipos: new InMemoryIpoRegistry([
      { ipoId: "ipo_1", subscriptionOpensAt: NOW - 24 * HOUR, subscriptionClosesAt: NOW + 24 * HOUR },
    ]),
    participation: ledger,
    attestations: store,
    revocations: store,
    nonces: store,
    attesterVerifier: new AllowlistAttestationVerifier(["attester_1"]),
  };
  return { deps, ledger, store, clock };
}
