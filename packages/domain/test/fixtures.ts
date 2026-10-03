import type { CapacityAttestation } from "../src/model.js";
import { AllowlistAttestationVerifier, InMemoryAttestationStore } from "../src/attestation.js";
import type { AttestationVerifier } from "../src/attestation.js";
import { InMemoryParticipationLedger } from "../src/participation.js";
import { InMemoryFundRegistry, InMemoryIpoRegistry } from "../src/registry.js";
import { DEMO_RULE_V1 } from "../src/rules.js";
import type { VerifyBidDeps } from "../src/verify.js";
import { Eip712AttestationVerifier } from "../src/eip712.js";
import { TEST_DOMAIN, signAttestation, syntheticAccount } from "./signing.js";

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


/**
 * TEST-ONLY verifier that accepts everything. Fixture stores use it by default so that tests can
 * put arbitrary (unsigned, tampered, unauthorized) attestations in front of `verifyBid` and prove
 * that `verifyBid` itself re-verifies whatever it reads (defence in depth). The publish gate with
 * a real verifier is tested separately (`store-publish.test.ts`, option `strictStore`).
 */
export const PERMISSIVE_VERIFIER: AttestationVerifier = { verify: () => ({ ok: true }) };

/** Publishes and fails the test loudly if the store refuses, so a rejected publish can never go unnoticed. */
export function mustPublish(store: InMemoryAttestationStore, attestation: CapacityAttestation): void {
  const r = store.publish(attestation);
  if (!r.ok) throw new Error(`fixture publish rejected: ${r.reasonCode}`);
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
export function makeEnv(
  opts: { attestation?: CapacityAttestation | null; recordStates?: boolean; storeVerifier?: AttestationVerifier } = {},
): Env {
  const clock = { t: NOW, now: () => clock.t };
  const ledger = new InMemoryParticipationLedger(() => clock.t);
  if (opts.recordStates !== false) {
    ledger.requestParticipation("fund_b", "ipo_1");
    ledger.requestNonParticipationLock("fund_c", "ipo_1");
  }
  const store = new InMemoryAttestationStore(opts.storeVerifier ?? PERMISSIVE_VERIFIER);
  if (opts.attestation !== null) mustPublish(store, opts.attestation ?? att());
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

/* ------------------------------------------------------------------------------------------
 * Signed-attestation fixtures (EIP-712). The allowlist-based `makeEnv` above is unchanged.
 * Registry: attester_1 and attester_2 each bound to their own synthetic test key.
 * ---------------------------------------------------------------------------------------- */

export const SIGNER_LABELS = { attester_1: "attester_1", attester_2: "attester_2" } as const;

export function attesterRegistry(): [string, string][] {
  return Object.entries(SIGNER_LABELS).map(([id, label]) => [id, syntheticAccount(label).address]);
}

export function makeEip712Verifier(): Eip712AttestationVerifier {
  return new Eip712AttestationVerifier({ domain: TEST_DOMAIN, attesters: attesterRegistry() });
}

/** Like `att()`, but signed by `signerLabel` (default: attester_1's synthetic key). */
export async function signedAtt(
  overrides: Partial<CapacityAttestation> = {},
  signerLabel: string = SIGNER_LABELS.attester_1,
): Promise<CapacityAttestation> {
  return signAttestation(att(overrides), signerLabel);
}

/** Same demo world as `makeEnv`, but attestations are checked by the EIP-712 verifier. */
export function makeSignedEnv(
  opts: { attestation?: CapacityAttestation | null; recordStates?: boolean; strictStore?: boolean } = {},
): Env {
  const verifier = makeEip712Verifier();
  const env = makeEnv({
    recordStates: opts.recordStates ?? true,
    attestation: opts.attestation ?? null,
    storeVerifier: opts.strictStore === true ? verifier : PERMISSIVE_VERIFIER,
  });
  return { ...env, deps: { ...env.deps, attesterVerifier: verifier } };
}
