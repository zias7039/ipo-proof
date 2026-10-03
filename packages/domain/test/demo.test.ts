/**
 * Required demo scenario (all identifiers and amounts are synthetic):
 *   Gross capacity of fund_a: 30,000,000,000 KRW (from an attestation, never self-declared)
 *   fund_b: exposure 6,000,000,000 KRW, PARTICIPATING
 *   fund_c: exposure 4,000,000,000 KRW, NON_PARTICIPATION_LOCKED
 *   => Adjusted capacity = 30bn - 6bn = 24bn (fund_c is exempt)
 */
import { describe, expect, it } from "vitest";
import { evaluateDemoRuleV1 } from "../src/rules.js";
import { verifyBid } from "../src/verify.js";
import { att, makeEnv } from "./fixtures.js";

const bid = (bidAmount: bigint, fundId = "fund_a") => ({ fundId, ipoId: "ipo_1", bidAmount });

describe("DEMO_RULE_V1 demo scenario", () => {
  it("computes Adjusted Capacity = 24,000,000,000", () => {
    const { ledger } = makeEnv();
    const attestation = att();
    const r = evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: attestation.grossCapacityKrw,
      exposures: attestation.underlyingExposures,
      participation: ledger,
    });
    expect(attestation.grossCapacityKrw).toBe(30_000_000_000n);
    expect(r.adjustedCapacityKrw).toBe(24_000_000_000n);
  });

  it("bid 20,000,000,000 PASSES", () => {
    expect(verifyBid(bid(20_000_000_000n), makeEnv().deps)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
  });

  it("bid 25,000,000,000 is REJECTED", () => {
    expect(verifyBid(bid(25_000_000_000n), makeEnv().deps)).toMatchObject({
      eligible: false,
      reasonCode: "BID_EXCEEDS_ADJUSTED_CAPACITY",
    });
  });

  it("fund_c participation request is REJECTED with NON_PARTICIPATION_LOCK_ACTIVE", () => {
    const { ledger } = makeEnv();
    expect(ledger.requestParticipation("fund_c", "ipo_1")).toMatchObject({
      ok: false,
      reasonCode: "NON_PARTICIPATION_LOCK_ACTIVE",
    });
  });

  it("setting LOCKED on an already PARTICIPATING fund is rejected", () => {
    const { ledger } = makeEnv();
    expect(ledger.requestNonParticipationLock("fund_b", "ipo_1")).toMatchObject({ ok: false });
    expect(ledger.getState("fund_b", "ipo_1")).toBe("PARTICIPATING");
  });

  it("revoked credential is REJECTED", () => {
    const { deps, store } = makeEnv();
    store.revoke("att_1");
    expect(verifyBid(bid(20_000_000_000n), deps)).toMatchObject({ eligible: false, reasonCode: "ATTESTATION_REVOKED" });
  });

  it("expired attestation is REJECTED", () => {
    const { deps, clock } = makeEnv();
    clock.t += 2 * 60 * 60 * 1000;
    expect(verifyBid(bid(20_000_000_000n), deps)).toMatchObject({ eligible: false, reasonCode: "ATTESTATION_EXPIRED" });
  });

  it("wrong rule version is REJECTED", () => {
    const { deps } = makeEnv({ attestation: att({ ruleVersion: "OTHER_RULE_V1" }) });
    expect(verifyBid(bid(20_000_000_000n), deps)).toMatchObject({ eligible: false, reasonCode: "RULE_VERSION_MISMATCH" });
  });

  it("omitting a PARTICIPATING deduction (attestation lists fewer underlying funds than the registry) is REJECTED", () => {
    const omitted = att({ underlyingExposures: [{ fundId: "fund_c", exposureKrw: 4_000_000_000n }] });
    const { deps } = makeEnv({ attestation: omitted });
    // Without fund_b's 6bn deduction a 25bn bid would look eligible; it must be rejected anyway.
    expect(verifyBid(bid(25_000_000_000n), deps)).toMatchObject({
      eligible: false,
      reasonCode: "UNDERLYING_EXPOSURE_OMITTED",
    });
  });
});
