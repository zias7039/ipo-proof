/**
 * DEMO_RULE_V2: V1 plus "an UNKNOWN underlying fund with 0 KRW exposure is a data error".
 * Also pins that DEMO_RULE_V1 stays frozen (same id => same meaning).
 */
import { describe, expect, it } from "vitest";
import { InMemoryParticipationLedger } from "../src/participation.js";
import { DEMO_RULE_V1, DEMO_RULE_V2, evaluateDemoRuleV1, evaluateDemoRuleV2, evaluateRule } from "../src/rules.js";
import type { RuleEvaluation, RuleUndetermined } from "../src/rules.js";
import { PROOF_HASH_KIND, verifyBid } from "../src/verify.js";
import { att, makeEnv, makeSignedEnv, mustPublish, signedAtt } from "./fixtures.js";

const V2 = "DEMO_RULE_V2";
const bid = (bidAmount: bigint) => ({ fundId: "fund_a", ipoId: "ipo_1", bidAmount });
const fail = (reasonCode: string) => ({ eligible: false, reasonCode });
const GROSS = 30_000_000_000n;
const FOUR_BN = 4_000_000_000n;

/** A V2 attestation with the given exposures for fund_b / fund_c. */
const v2 = (b: bigint, c: bigint) =>
  att({
    ruleVersion: V2,
    underlyingExposures: [
      { fundId: "fund_b", exposureKrw: b },
      { fundId: "fund_c", exposureKrw: c },
    ],
  });
const env = (a = v2(0n, FOUR_BN), recordStates = false) => makeEnv({ attestation: a, recordStates, rule: DEMO_RULE_V2 });

function undetermined(r: RuleEvaluation): RuleUndetermined {
  if (r.determined) throw new Error("expected an undetermined evaluation");
  return r;
}
const ledger = () => new InMemoryParticipationLedger(() => 0);

describe("DEMO_RULE_V2 through verifyBid: zero-exposure UNKNOWN is a data error", () => {
  it("rejects a 0 KRW UNKNOWN underlying fund with UNDERLYING_ZERO_EXPOSURE_UNKNOWN, for any bid size", () => {
    const { deps, ledger: l } = env(v2(0n, FOUR_BN), false);
    l.requestNonParticipationLock("fund_c", "ipo_1"); // fund_b stays UNKNOWN with 0 KRW
    for (const amount of [1n, 20_000_000_000n, GROSS, GROSS + 1n]) {
      expect(verifyBid(bid(amount), deps), String(amount)).toMatchObject({ ...fail("UNDERLYING_ZERO_EXPOSURE_UNKNOWN"), flags: [] });
    }
  });

  it("takes precedence over the generic UNKNOWN rejection when a non-zero UNKNOWN is also present (either order)", () => {
    // fund_b: 0 KRW UNKNOWN, fund_c: 4bn UNKNOWN
    expect(verifyBid(bid(1n), env(v2(0n, FOUR_BN)).deps).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
    // fund_b: 4bn UNKNOWN, fund_c: 0 KRW UNKNOWN
    expect(verifyBid(bid(1n), env(v2(FOUR_BN, 0n)).deps).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
  });

  it("a non-zero UNKNOWN (and no zero-exposure UNKNOWN) keeps the generic reason", () => {
    expect(verifyBid(bid(1n), env(v2(FOUR_BN, FOUR_BN)).deps).reasonCode).toBe("UNDERLYING_PARTICIPATION_UNKNOWN");
    // zero exposure but KNOWN (fund_b PARTICIPATING), non-zero UNKNOWN fund_c
    const { deps, ledger: l } = env(v2(0n, FOUR_BN));
    l.requestParticipation("fund_b", "ipo_1");
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_PARTICIPATION_UNKNOWN");
  });

  it("0 KRW exposure is evaluated normally when the fund is PARTICIPATING or LOCKED", () => {
    const participating = env(v2(0n, FOUR_BN));
    participating.ledger.requestParticipation("fund_b", "ipo_1");
    participating.ledger.requestParticipation("fund_c", "ipo_1");
    expect(verifyBid(bid(GROSS - FOUR_BN), participating.deps)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
    expect(verifyBid(bid(GROSS - FOUR_BN + 1n), participating.deps).reasonCode).toBe("BID_EXCEEDS_ADJUSTED_CAPACITY");

    const locked = env(v2(0n, FOUR_BN));
    locked.ledger.requestNonParticipationLock("fund_b", "ipo_1");
    locked.ledger.requestNonParticipationLock("fund_c", "ipo_1");
    expect(verifyBid(bid(GROSS), locked.deps).eligible).toBe(true);
    expect(verifyBid(bid(GROSS + 1n), locked.deps).reasonCode).toBe("BID_EXCEEDS_ADJUSTED_CAPACITY");
  });

  it("recording the 0 KRW fund's state before the bid is judged removes the data error (design S-16c)", () => {
    const { deps, ledger: l } = env(v2(0n, FOUR_BN));
    l.requestNonParticipationLock("fund_c", "ipo_1");
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
    l.requestParticipation("fund_b", "ipo_1");
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
    expect(l.history().length).toBe(2); // verifyBid itself recorded nothing
  });

  it("earlier checks still win: omitted / duplicate / unregistered exposures are reported before the data error", () => {
    const omitted = att({ ruleVersion: V2, underlyingExposures: [{ fundId: "fund_b", exposureKrw: 0n }] }); // fund_c missing
    expect(verifyBid(bid(1n), env(omitted).deps).reasonCode).toBe("UNDERLYING_EXPOSURE_OMITTED");
    const dup = att({
      ruleVersion: V2,
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 0n },
        { fundId: "fund_b", exposureKrw: 0n },
        { fundId: "fund_c", exposureKrw: 0n },
      ],
    });
    expect(verifyBid(bid(1n), env(dup).deps).reasonCode).toBe("DUPLICATE_UNDERLYING_EXPOSURE");
    const extra = att({
      ruleVersion: V2,
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 0n },
        { fundId: "fund_c", exposureKrw: 0n },
        { fundId: "fund_x", exposureKrw: 0n },
      ],
    });
    expect(verifyBid(bid(1n), env(extra).deps).reasonCode).toBe("UNDERLYING_EXPOSURE_NOT_IN_REGISTRY");
  });

  it("fails closed: unexpected participation values on a 0 KRW exposure count as UNKNOWN and hit the data error", () => {
    const { deps } = env(v2(0n, FOUR_BN));
    for (const value of [undefined, null, "", "unknown", "PARTICIPATING "]) {
      const participation = { getState: (fundId: string): never => (fundId === "fund_a" ? ("UNKNOWN" as never) : (value as never)) };
      expect(verifyBid(bid(1n), { ...deps, participation }).reasonCode, String(value)).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
    }
    const throwing = {
      getState: (fundId: string) => {
        if (fundId === "fund_a") return "UNKNOWN" as const;
        throw new Error("ledger unavailable");
      },
    };
    expect(verifyBid(bid(1n), { ...deps, participation: throwing }).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
  });

  it("the demo numbers are unchanged under V2 (30bn gross, 6bn PARTICIPATING, 4bn LOCKED => 24bn)", () => {
    const { deps } = env(v2(6_000_000_000n, FOUR_BN), true);
    expect(verifyBid(bid(24_000_000_000n), deps)).toMatchObject({ eligible: true, ruleVersion: V2 });
    expect(verifyBid(bid(24_000_000_001n), deps).reasonCode).toBe("BID_EXCEEDS_ADJUSTED_CAPACITY");
  });

  it("works with EIP-712 signed V2 attestations (ruleVersion is part of the signed message)", async () => {
    const e = makeSignedEnv({ recordStates: false, rule: DEMO_RULE_V2 });
    mustPublish(e.store, await signedAtt({ ruleVersion: V2, underlyingExposures: v2(0n, FOUR_BN).underlyingExposures }));
    expect(verifyBid(bid(1n), e.deps).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
    // Re-labelling a signed V1 attestation as V2 breaks the signature.
    const e2 = makeSignedEnv({ rule: DEMO_RULE_V2 });
    mustPublish(e2.store, { ...(await signedAtt()), ruleVersion: V2 });
    expect(verifyBid(bid(1n), e2.deps).reasonCode).toBe("SIGNATURE_INVALID");
  });

  it("the rule version in the receipt and the attestation must match: V1 and V2 do not mix", () => {
    const v1Att = makeEnv({ attestation: att(), rule: DEMO_RULE_V2 });
    expect(verifyBid(bid(1n), v1Att.deps).reasonCode).toBe("RULE_VERSION_MISMATCH");
    const v2Att = makeEnv({ attestation: v2(6_000_000_000n, FOUR_BN), rule: DEMO_RULE_V1 });
    expect(verifyBid(bid(1n), v2Att.deps).reasonCode).toBe("RULE_VERSION_MISMATCH");
  });

  it("receipts of the same data differ per rule version (ruleVersion is hashed with the reason code)", () => {
    const one = verifyBid(bid(1n), env(v2(0n, FOUR_BN)).deps);
    const other = verifyBid(bid(1n), makeEnv({ attestation: att({ underlyingExposures: [{ fundId: "fund_b", exposureKrw: 0n }, { fundId: "fund_c", exposureKrw: FOUR_BN }] }), recordStates: false }).deps);
    expect(one.proofHashKind).toBe(PROOF_HASH_KIND);
    expect(one.ruleVersion).toBe(V2);
    expect(other.ruleVersion).toBe("DEMO_RULE_V1");
    expect(one.reasonCode).not.toBe(other.reasonCode);
    expect(one.proofHash).not.toBe(other.proofHash);
  });
});

describe("DEMO_RULE_V2 rule function", () => {
  const run = (p: InMemoryParticipationLedger, b: bigint, c: bigint) =>
    evaluateDemoRuleV2({
      ipoId: "ipo_1",
      grossCapacityKrw: 10n,
      exposures: [
        { fundId: "fund_b", exposureKrw: b },
        { fundId: "fund_c", exposureKrw: c },
      ],
      participation: p,
    });

  it("reports the zero-exposure UNKNOWN funds separately from all UNKNOWN funds", () => {
    const r = undetermined(run(ledger(), 0n, 3n));
    expect(r).toMatchObject({
      ruleVersion: V2,
      cause: "ZERO_EXPOSURE_UNKNOWN",
      unknownFundIds: ["fund_b", "fund_c"],
      zeroExposureUnknownFundIds: ["fund_b"],
    });
  });

  it("only UNKNOWN funds count: a 0 KRW LOCKED fund does not trigger the data error", () => {
    const l = ledger();
    l.requestNonParticipationLock("fund_b", "ipo_1");
    expect(undetermined(run(l, 0n, 3n))).toMatchObject({ cause: "UNKNOWN_PARTICIPATION", zeroExposureUnknownFundIds: [], unknownFundIds: ["fund_c"] });
  });

  it("is registered for dispatch and keeps the same age limit as V1", () => {
    expect(evaluateRule(V2, { ipoId: "ipo_1", grossCapacityKrw: 1n, exposures: [], participation: ledger() })).toMatchObject({ determined: true, ruleVersion: V2 });
    expect(DEMO_RULE_V2.maxAttestationAgeMs).toBe(DEMO_RULE_V1.maxAttestationAgeMs);
  });
});

describe("DEMO_RULE_V1 is frozen (do not change these expectations; add a new rule version instead)", () => {
  it("V1 does not distinguish zero-exposure UNKNOWN funds: it reports the generic cause", () => {
    const r = undetermined(
      evaluateDemoRuleV1({
        ipoId: "ipo_1",
        grossCapacityKrw: 10n,
        exposures: [{ fundId: "fund_b", exposureKrw: 0n }, { fundId: "fund_c", exposureKrw: 3n }],
        participation: ledger(),
      }),
    );
    expect(r).toMatchObject({ ruleVersion: "DEMO_RULE_V1", cause: "UNKNOWN_PARTICIPATION", zeroExposureUnknownFundIds: [] });
  });

  it("through verifyBid, V1 still answers UNDERLYING_PARTICIPATION_UNKNOWN for zero-exposure UNKNOWN data", () => {
    const a = att({ underlyingExposures: [{ fundId: "fund_b", exposureKrw: 0n }, { fundId: "fund_c", exposureKrw: FOUR_BN }] });
    const { deps, ledger: l } = makeEnv({ attestation: a, recordStates: false });
    l.requestNonParticipationLock("fund_c", "ipo_1");
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_PARTICIPATION_UNKNOWN");
  });

  it("V1 id, description-independent parameters and the reason codes it can produce are unchanged", () => {
    expect(DEMO_RULE_V1.id).toBe("DEMO_RULE_V1");
    expect(DEMO_RULE_V1.maxAttestationAgeMs).toBe(24 * 60 * 60 * 1000);
    expect(DEMO_RULE_V1.description).not.toContain("data error");
  });
});
