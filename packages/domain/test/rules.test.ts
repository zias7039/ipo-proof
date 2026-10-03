import { describe, expect, it } from "vitest";
import { InMemoryParticipationLedger } from "../src/participation.js";
import { DEMO_RULE_V1_ID, RuleFlag, Treatment, evaluateDemoRuleV1, evaluateRule, isSupportedRuleVersion } from "../src/rules.js";
import type { RuleDetermined, RuleEvaluation } from "../src/rules.js";

function ledger() {
  return new InMemoryParticipationLedger(() => 0);
}

/** Narrows an evaluation to the determined case, failing the test otherwise. */
function determined(r: RuleEvaluation): RuleDetermined {
  if (!r.determined) throw new Error(`expected a determined evaluation, got undetermined for ${r.unknownFundIds.join(",")}`);
  return r;
}

describe("DEMO_RULE_V1", () => {
  it("deducts PARTICIPATING and exempts NON_PARTICIPATION_LOCKED", () => {
    const l = ledger();
    l.requestParticipation("fund_b", "ipo_1");
    l.requestNonParticipationLock("fund_c", "ipo_1");
    const r = determined(evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 30_000_000_000n,
      exposures: [
        { fundId: "fund_b", exposureKrw: 6_000_000_000n },
        { fundId: "fund_c", exposureKrw: 4_000_000_000n },
      ],
      participation: l,
    }));
    expect(r.adjustedCapacityKrw).toBe(24_000_000_000n);
    expect(r.deductedKrw).toBe(6_000_000_000n);
    expect(r.lines.map((x) => x.treatment)).toEqual([Treatment.DEDUCTED, Treatment.EXEMPT_LOCKED]);
    expect(r.flags).toEqual([]);
  });

  it("UNKNOWN underlying exposure is NOT exempt and yields no capacity: the evaluation is undetermined", () => {
    const l = ledger(); // nothing recorded => UNKNOWN
    const r = evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 30_000_000_000n,
      exposures: [{ fundId: "fund_d", exposureKrw: 5_000_000_000n }],
      participation: l,
    });
    expect(r).toMatchObject({ determined: false, ruleVersion: DEMO_RULE_V1_ID, unknownFundIds: ["fund_d"] });
    expect(r.lines[0]?.treatment).toBe(Treatment.UNDETERMINED_UNKNOWN);
    expect("adjustedCapacityKrw" in r).toBe(false);
  });

  it("UNKNOWN is neither deducted like PARTICIPATING nor exempt like LOCKED", () => {
    const run = (p: InMemoryParticipationLedger) =>
      evaluateDemoRuleV1({
        ipoId: "ipo_1",
        grossCapacityKrw: 10n,
        exposures: [{ fundId: "fund_d", exposureKrw: 4n }],
        participation: p,
      });
    const participating = ledger();
    participating.requestParticipation("fund_d", "ipo_1");
    const locked = ledger();
    locked.requestNonParticipationLock("fund_d", "ipo_1");
    expect(determined(run(participating)).adjustedCapacityKrw).toBe(6n);
    expect(determined(run(locked)).adjustedCapacityKrw).toBe(10n);
    expect(run(ledger()).determined).toBe(false);
  });

  it("a single UNKNOWN among known funds makes the whole evaluation undetermined and lists only the UNKNOWN ones", () => {
    const l = ledger();
    l.requestParticipation("fund_b", "ipo_1");
    l.requestNonParticipationLock("fund_c", "ipo_1");
    const r = evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 30n,
      exposures: [
        { fundId: "fund_b", exposureKrw: 6n },
        { fundId: "fund_c", exposureKrw: 4n },
        { fundId: "fund_d", exposureKrw: 1n },
        { fundId: "fund_e", exposureKrw: 1n },
      ],
      participation: l,
    });
    expect(r).toMatchObject({ determined: false, unknownFundIds: ["fund_d", "fund_e"] });
    expect(r.lines.map((x) => x.treatment)).toEqual([
      Treatment.DEDUCTED,
      Treatment.EXEMPT_LOCKED,
      Treatment.UNDETERMINED_UNKNOWN,
      Treatment.UNDETERMINED_UNKNOWN,
    ]);
  });

  describe("fail-closed on unexpected ParticipationLookup values", () => {
    const weird: unknown[] = [undefined, null, "", "unknown", "Unknown", " UNKNOWN", "PARTICIPATING ", "locked", "NON_PARTICIPATION_LOCKED\n", 0, false, {}, "anything_else"];
    const lookupReturning = (value: unknown) => ({ getState: () => value as never });
    const run = (participation: { getState: () => never }) =>
      evaluateDemoRuleV1({
        ipoId: "ipo_1",
        grossCapacityKrw: 30n,
        exposures: [{ fundId: "fund_b", exposureKrw: 6n }],
        participation,
      });

    for (const value of weird) {
      it(`treats ${JSON.stringify(value) ?? String(value)} as UNKNOWN: undetermined, never exempt`, () => {
        const r = run(lookupReturning(value));
        expect(r).toMatchObject({ determined: false, unknownFundIds: ["fund_b"] });
        expect(r.lines[0]).toMatchObject({ state: "UNKNOWN", treatment: Treatment.UNDETERMINED_UNKNOWN });
      });
    }

    it("treats a lookup that throws as UNKNOWN instead of propagating or exempting", () => {
      const throwing = {
        getState: (): never => {
          throw new Error("ledger unavailable");
        },
      };
      expect(run(throwing)).toMatchObject({ determined: false, unknownFundIds: ["fund_b"] });
    });

    it("still evaluates the exact known states normally", () => {
      expect(determined(run(lookupReturning("PARTICIPATING"))).adjustedCapacityKrw).toBe(24n);
      expect(determined(run(lookupReturning("NON_PARTICIPATION_LOCKED"))).adjustedCapacityKrw).toBe(30n);
    });
  });

  it("clamps at zero and flags when deductions exceed gross", () => {
    const l = ledger();
    l.requestParticipation("fund_b", "ipo_1");
    const r = determined(evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 5n,
      exposures: [{ fundId: "fund_b", exposureKrw: 9n }],
      participation: l,
    }));
    expect(r.adjustedCapacityKrw).toBe(0n);
    expect(r.flags).toContain(RuleFlag.DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO);
  });

  it("is deterministic and does not mutate its input", () => {
    const l = ledger();
    l.requestParticipation("fund_b", "ipo_1");
    const exposures = [{ fundId: "fund_b", exposureKrw: 1n }];
    const input = { ipoId: "ipo_1", grossCapacityKrw: 3n, exposures, participation: l };
    expect(evaluateDemoRuleV1(input)).toEqual(evaluateDemoRuleV1(input));
    expect(exposures).toEqual([{ fundId: "fund_b", exposureKrw: 1n }]);
  });

  it("only participation of the same IPO counts", () => {
    const l = ledger();
    l.requestParticipation("fund_b", "ipo_2");
    const r = evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 10n,
      exposures: [{ fundId: "fund_b", exposureKrw: 4n }],
      participation: l,
    });
    expect(r.lines[0]?.state).toBe("UNKNOWN");
  });

  it("dispatches by rule version id", () => {
    expect(isSupportedRuleVersion(DEMO_RULE_V1_ID)).toBe(true);
    expect(isSupportedRuleVersion("DEMO_RULE_V2")).toBe(false);
    expect(evaluateRule("DEMO_RULE_V2", { ipoId: "ipo_1", grossCapacityKrw: 0n, exposures: [], participation: ledger() })).toBeUndefined();
  });
});
