import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/hash.js";
import { DEMO_RULE_V1 } from "../src/rules.js";
import { PROOF_HASH_KIND, buildReceipt, verifyBid } from "../src/verify.js";
import { HOUR, NOW, att, makeEnv } from "./fixtures.js";

const bid = (bidAmount: unknown, fundId = "fund_a") => ({ fundId, ipoId: "ipo_1", bidAmount });

describe("verifyBid: capacity check", () => {
  it("accepts a bid exactly at adjusted capacity and rejects one KRW above", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(24_000_000_000n), deps)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
    expect(verifyBid(bid(24_000_000_001n), deps)).toMatchObject({
      eligible: false,
      reasonCode: "BID_EXCEEDS_ADJUSTED_CAPACITY",
    });
  });

  it("returns ruleVersion, verifiedAt from the injected clock, and no throw", () => {
    const { deps } = makeEnv();
    const r = verifyBid(bid(1n), deps);
    expect(r.ruleVersion).toBe("DEMO_RULE_V1");
    expect(r.verifiedAt).toBe(NOW);
  });
});

describe("verifyBid: request shape (no self-declared capacity)", () => {
  it("rejects a request that tries to supply a capacity value", () => {
    const { deps } = makeEnv();
    const sneaky = { ...bid(25_000_000_000n), grossCapacityKrw: 100_000_000_000n };
    expect(verifyBid(sneaky, deps)).toMatchObject({ eligible: false, reasonCode: "INVALID_BID_REQUEST" });
    const sneaky2 = { ...bid(25_000_000_000n), adjustedCapacity: 100_000_000_000n };
    expect(verifyBid(sneaky2, deps).reasonCode).toBe("INVALID_BID_REQUEST");
  });

  it("rejects non-object, missing or non-synthetic ids", () => {
    const { deps } = makeEnv();
    expect(verifyBid(null, deps).reasonCode).toBe("INVALID_BID_REQUEST");
    expect(verifyBid("fund_a", deps).reasonCode).toBe("INVALID_BID_REQUEST");
    expect(verifyBid({ fundId: "fund_a", ipoId: "ipo_1" }, deps).reasonCode).toBe("INVALID_BID_REQUEST");
    expect(verifyBid(bid(1n, "Real Fund Name"), deps).reasonCode).toBe("INVALID_BID_REQUEST");
  });

  it("rejects number, negative, zero and fractional bid amounts", () => {
    const { deps } = makeEnv();
    for (const amount of [1000, 1.5, -1n, 0n, "1000", undefined]) {
      expect(verifyBid(bid(amount), deps).reasonCode).toBe("INVALID_BID_AMOUNT");
    }
  });
});

describe("verifyBid: registries and subject", () => {
  it("rejects unregistered fund, unknown IPO, IPO outside window", () => {
    const { deps, clock } = makeEnv();
    expect(verifyBid(bid(1n, "fund_zzz"), deps).reasonCode).toBe("FUND_NOT_REGISTERED");
    expect(verifyBid({ fundId: "fund_a", ipoId: "ipo_9", bidAmount: 1n }, deps).reasonCode).toBe("IPO_NOT_FOUND");
    clock.t = NOW + 25 * HOUR;
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("IPO_NOT_OPEN");
    clock.t = NOW - 25 * HOUR;
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("IPO_NOT_OPEN");
  });

  it("rejects when no attestation exists (capacity cannot be assumed)", () => {
    const { deps } = makeEnv({ attestation: null });
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("ATTESTATION_NOT_FOUND");
  });

  it("rejects an attestation whose subject does not match the bid", () => {
    // Store lookup is keyed by subject, so craft a source that returns the wrong attestation.
    const { deps } = makeEnv();
    const wrong = att({ fundId: "fund_b" });
    const r = verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => wrong } });
    expect(r.reasonCode).toBe("ATTESTATION_SUBJECT_MISMATCH");
  });

  it("rejects a malformed attestation", () => {
    const { deps } = makeEnv();
    const bad = att({ grossCapacityKrw: -5n });
    expect(verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => bad } }).reasonCode).toBe(
      "ATTESTATION_MALFORMED",
    );
    const floaty = att({ grossCapacityKrw: 1.5 as unknown as bigint });
    expect(verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => floaty } }).reasonCode).toBe(
      "ATTESTATION_MALFORMED",
    );
    const inverted = att({ issuedAt: NOW, expiresAt: NOW - 1 });
    expect(verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => inverted } }).reasonCode).toBe(
      "ATTESTATION_MALFORMED",
    );
  });
});

describe("verifyBid: participation lock", () => {
  it("rejects a bid from a NON_PARTICIPATION_LOCKED fund", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(1n, "fund_c"), deps)).toMatchObject({
      eligible: false,
      reasonCode: "NON_PARTICIPATION_LOCK_ACTIVE",
    });
  });

  it("allows the bidding fund's own state to be UNKNOWN (nothing recorded yet)", () => {
    const { deps, ledger } = makeEnv();
    expect(ledger.getState("fund_a", "ipo_1")).toBe("UNKNOWN");
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
  });
});

describe("verifyBid: attestation integrity checks", () => {
  it("rejects a wrong rule version", () => {
    const { deps } = makeEnv({ attestation: att({ ruleVersion: "DEMO_RULE_V0" }) });
    expect(verifyBid(bid(1n), deps)).toMatchObject({ eligible: false, reasonCode: "RULE_VERSION_MISMATCH" });
  });

  it("rejects when the active rule version is not supported by the engine", () => {
    const { deps } = makeEnv({ attestation: att({ ruleVersion: "DEMO_RULE_V9" }) });
    const r = verifyBid(bid(1n), { ...deps, activeRuleVersion: { ...DEMO_RULE_V1, id: "DEMO_RULE_V9" } });
    expect(r.reasonCode).toBe("RULE_VERSION_UNSUPPORTED");
  });

  it("rejects an unauthorized attester", () => {
    const { deps } = makeEnv({ attestation: att({ attesterId: "attester_evil" }) });
    expect(verifyBid(bid(1n), deps)).toMatchObject({ eligible: false, reasonCode: "ATTESTER_UNAUTHORIZED" });
  });

  it("rejects a revoked attestation", () => {
    const { deps, store } = makeEnv();
    store.revoke("att_1");
    expect(verifyBid(bid(1n), deps)).toMatchObject({ eligible: false, reasonCode: "ATTESTATION_REVOKED" });
  });

  it("rejects an expired attestation (expiry boundary is exclusive)", () => {
    const { deps, clock } = makeEnv();
    clock.t = NOW + HOUR - 1;
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
    clock.t = NOW + HOUR;
    expect(verifyBid(bid(1n), deps)).toMatchObject({ eligible: false, reasonCode: "ATTESTATION_EXPIRED" });
  });

  it("rejects an attestation that is not yet valid", () => {
    const { deps } = makeEnv({ attestation: att({ issuedAt: NOW + 1, expiresAt: NOW + HOUR }) });
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("ATTESTATION_NOT_YET_VALID");
  });

  it("rejects a stale attestation that has not expired yet", () => {
    const issuedAt = NOW - DEMO_RULE_V1.maxAttestationAgeMs - 1;
    const { deps } = makeEnv({ attestation: att({ issuedAt, expiresAt: NOW + HOUR }) });
    expect(verifyBid(bid(1n), deps)).toMatchObject({ eligible: false, reasonCode: "ATTESTATION_STALE" });
  });

  it("rejects nonce replay (same attester+nonce already bound to another attestation)", () => {
    const { deps, store } = makeEnv();
    const original = att({ attestationId: "att_orig", fundId: "fund_z", nonce: "nonce_1" });
    // nonce_1 was already bound to att_1 by makeEnv; a different attestation reusing it is a replay.
    expect(store.publish(original)).toBe(false);
    const replay = att({ attestationId: "att_replay", nonce: "nonce_1" });
    const r = verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => replay } });
    expect(r).toMatchObject({ eligible: false, reasonCode: "ATTESTATION_NONCE_REPLAY" });
  });

  it("does not treat re-verification of the same attestation as a replay", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
    expect(verifyBid(bid(2n), deps).eligible).toBe(true);
  });
});

describe("verifyBid: underlying exposure completeness", () => {
  it("rejects when the attestation omits an underlying fund the registry knows (omitted deduction)", () => {
    // Omits fund_b, the PARTICIPATING fund whose deduction would lower capacity.
    const omitted = att({ underlyingExposures: [{ fundId: "fund_c", exposureKrw: 4_000_000_000n }] });
    const { deps } = makeEnv({ attestation: omitted });
    expect(verifyBid(bid(25_000_000_000n), deps)).toMatchObject({
      eligible: false,
      reasonCode: "UNDERLYING_EXPOSURE_OMITTED",
    });
    // Even a bid that would pass with the omitted deduction removed is rejected for the omission.
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_EXPOSURE_OMITTED");
  });

  it("rejects an attestation listing no underlying funds at all", () => {
    const { deps } = makeEnv({ attestation: att({ underlyingExposures: [] }) });
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_EXPOSURE_OMITTED");
  });

  it("rejects exposures to funds the registry does not list, and duplicates", () => {
    const extra = att({
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 1n },
        { fundId: "fund_c", exposureKrw: 1n },
        { fundId: "fund_q", exposureKrw: 1n },
      ],
    });
    expect(verifyBid(bid(1n), makeEnv({ attestation: extra }).deps).reasonCode).toBe("UNDERLYING_EXPOSURE_NOT_IN_REGISTRY");
    const dup = att({
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 1n },
        { fundId: "fund_b", exposureKrw: 1n },
        { fundId: "fund_c", exposureKrw: 1n },
      ],
    });
    expect(verifyBid(bid(1n), makeEnv({ attestation: dup }).deps).reasonCode).toBe("DUPLICATE_UNDERLYING_EXPOSURE");
  });
});

describe("verifyBid: UNKNOWN underlying participation is rejected (never exempt, never assumed)", () => {
  it("rejects when every underlying fund is UNKNOWN, for any bid size", () => {
    const { deps, ledger } = makeEnv({ recordStates: false });
    expect(ledger.getState("fund_b", "ipo_1")).toBe("UNKNOWN");
    expect(ledger.getState("fund_c", "ipo_1")).toBe("UNKNOWN");
    for (const amount of [1n, 20_000_000_000n, 24_000_000_000n, 25_000_000_000n]) {
      const r = verifyBid(bid(amount), deps);
      expect(r).toMatchObject({ eligible: false, reasonCode: "UNDERLYING_PARTICIPATION_UNKNOWN", flags: [] });
    }
  });

  it("rejects a mixed case: one underlying fund known, the other UNKNOWN (either way round)", () => {
    const a = makeEnv({ recordStates: false });
    a.ledger.requestParticipation("fund_b", "ipo_1"); // fund_c stays UNKNOWN
    expect(verifyBid(bid(1n), a.deps).reasonCode).toBe("UNDERLYING_PARTICIPATION_UNKNOWN");
    const b = makeEnv({ recordStates: false });
    b.ledger.requestNonParticipationLock("fund_c", "ipo_1"); // fund_b stays UNKNOWN
    expect(verifyBid(bid(1n), b.deps).reasonCode).toBe("UNDERLYING_PARTICIPATION_UNKNOWN");
  });

  it("evaluates normally once the UNKNOWN fund is recorded, and verifyBid itself records nothing", () => {
    const { deps, ledger } = makeEnv({ recordStates: false });
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_PARTICIPATION_UNKNOWN");
    expect(ledger.history()).toEqual([]);
    ledger.requestParticipation("fund_b", "ipo_1");
    ledger.requestNonParticipationLock("fund_c", "ipo_1");
    expect(verifyBid(bid(24_000_000_000n), deps)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
  });

  it("only participation in the same IPO counts: a record for another IPO leaves the fund UNKNOWN", () => {
    const { deps, ledger } = makeEnv({ recordStates: false });
    ledger.requestParticipation("fund_b", "ipo_2");
    ledger.requestNonParticipationLock("fund_c", "ipo_2");
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_PARTICIPATION_UNKNOWN");
  });

  it("earlier checks still win: an omitted underlying fund is reported before UNKNOWN participation", () => {
    const omitted = att({ underlyingExposures: [{ fundId: "fund_c", exposureKrw: 4_000_000_000n }] });
    const { deps } = makeEnv({ attestation: omitted, recordStates: false });
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_EXPOSURE_OMITTED");
  });

  it("the receipt for an UNKNOWN rejection carries no amounts and no underlying fund ids", () => {
    const { deps } = makeEnv({ recordStates: false });
    const r = verifyBid(bid(1n), deps);
    const receipt = buildReceipt({
      fundId: "fund_a",
      ipoId: "ipo_1",
      ruleVersion: r.ruleVersion,
      attestationId: "att_1",
      attesterId: "attester_1",
      eligible: false,
      reasonCode: r.reasonCode,
      flags: r.flags,
      verifiedAt: r.verifiedAt,
    });
    expect(r.proofHash).toBe(createHash("sha256").update(canonicalJson(receipt), "utf8").digest("hex"));
    expect(JSON.stringify(receipt)).not.toMatch(/fund_b|fund_c/);
  });

  it("the bidding fund's own UNKNOWN state is still allowed when the underlying funds are known", () => {
    const { deps, ledger } = makeEnv();
    expect(ledger.getState("fund_a", "ipo_1")).toBe("UNKNOWN");
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
  });

  it("flags are empty when every underlying state is known", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(1n), deps).flags).toEqual([]);
  });
});

describe("verifyBid: receipt hash (proofHash)", () => {
  it("is labelled as a receipt hash, not a ZK proof", () => {
    const r = verifyBid(bid(1n), makeEnv().deps);
    expect(r.proofHashKind).toBe(PROOF_HASH_KIND);
    expect(PROOF_HASH_KIND).toContain("NOT_A_ZK_PROOF");
    expect(r.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("equals sha256 of the canonical receipt", () => {
    const r = verifyBid(bid(1n), makeEnv().deps);
    const receipt = buildReceipt({
      fundId: "fund_a",
      ipoId: "ipo_1",
      ruleVersion: "DEMO_RULE_V1",
      attestationId: "att_1",
      attesterId: "attester_1",
      eligible: true,
      reasonCode: "ELIGIBLE",
      flags: [],
      verifiedAt: NOW,
    });
    expect(r.proofHash).toBe(createHash("sha256").update(canonicalJson(receipt)).digest("hex"));
  });

  it("is deterministic", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(5n), deps)).toEqual(verifyBid(bid(5n), deps));
  });

  it("excludes sensitive values: different bid amounts with the same outcome hash identically", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(1n), deps).proofHash).toBe(verifyBid(bid(24_000_000_000n), deps).proofHash);
  });

  it("hashes only an allowlisted set of non-sensitive fields (no amounts)", () => {
    const receipt = buildReceipt({
      fundId: "fund_a",
      ipoId: "ipo_1",
      ruleVersion: "DEMO_RULE_V1",
      attestationId: "att_1",
      attesterId: "attester_1",
      eligible: false,
      reasonCode: "BID_EXCEEDS_ADJUSTED_CAPACITY",
      flags: [],
      verifiedAt: NOW,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      "attestationId",
      "attesterId",
      "eligible",
      "fundId",
      "flags",
      "ipoId",
      "kind",
      "reasonCode",
      "ruleVersion",
      "verifiedAt",
      "version",
    ].sort());
    expect(Object.values(receipt).some((v) => typeof v === "bigint")).toBe(false);
  });

  it("changes with outcome, subject and time", () => {
    const { deps, clock } = makeEnv();
    const pass = verifyBid(bid(1n), deps).proofHash;
    expect(verifyBid(bid(25_000_000_000n), deps).proofHash).not.toBe(pass);
    clock.t = NOW + 1;
    expect(verifyBid(bid(1n), deps).proofHash).not.toBe(pass);
  });

  it("is produced for rejected malformed requests too", () => {
    const r = verifyBid(undefined, makeEnv().deps);
    expect(r.eligible).toBe(false);
    expect(r.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyBid: purity", () => {
  it("does not change the ledger or the store", () => {
    const { deps, ledger } = makeEnv();
    const before = JSON.stringify(ledger.history());
    verifyBid(bid(1n), deps);
    verifyBid(bid(1n, "fund_c"), deps);
    expect(JSON.stringify(ledger.history())).toBe(before);
    expect(ledger.getState("fund_a", "ipo_1")).toBe("UNKNOWN");
  });
});
