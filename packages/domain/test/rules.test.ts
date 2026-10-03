import { describe, expect, it } from "vitest";
import { InMemoryParticipationLedger } from "../src/participation.js";
import { DEMO_RULE_V1_ID, RuleFlag, Treatment, evaluateDemoRuleV1, evaluateRule, isSupportedRuleVersion } from "../src/rules.js";

function ledger() {
  return new InMemoryParticipationLedger(() => 0);
}

describe("DEMO_RULE_V1", () => {
  it("deducts PARTICIPATING and exempts NON_PARTICIPATION_LOCKED", () => {
    const l = ledger();
    l.requestParticipation("fund_b", "ipo_1");
    l.requestNonParticipationLock("fund_c", "ipo_1");
    const r = evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 30_000_000_000n,
      exposures: [
        { fundId: "fund_b", exposureKrw: 6_000_000_000n },
        { fundId: "fund_c", exposureKrw: 4_000_000_000n },
      ],
      participation: l,
    });
    expect(r.adjustedCapacityKrw).toBe(24_000_000_000n);
    expect(r.deductedKrw).toBe(6_000_000_000n);
    expect(r.lines.map((x) => x.treatment)).toEqual([Treatment.DEDUCTED, Treatment.EXEMPT_LOCKED]);
    expect(r.flags).toEqual([]);
  });

  it("UNKNOWN underlying exposure is NOT exempt: it is deducted and flagged", () => {
    const l = ledger(); // nothing recorded => UNKNOWN
    const r = evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 30_000_000_000n,
      exposures: [{ fundId: "fund_d", exposureKrw: 5_000_000_000n }],
      participation: l,
    });
    expect(r.adjustedCapacityKrw).toBe(25_000_000_000n);
    expect(r.lines[0]?.treatment).toBe(Treatment.DEDUCTED_UNKNOWN_CONSERVATIVE);
    expect(r.flags).toEqual([RuleFlag.UNKNOWN_UNDERLYING_DEDUCTED]);
  });

  it("UNKNOWN is treated exactly like PARTICIPATING for the number, differently from LOCKED", () => {
    const unknown = ledger();
    const participating = ledger();
    participating.requestParticipation("fund_d", "ipo_1");
    const locked = ledger();
    locked.requestNonParticipationLock("fund_d", "ipo_1");
    const run = (p: InMemoryParticipationLedger) =>
      evaluateDemoRuleV1({
        ipoId: "ipo_1",
        grossCapacityKrw: 10n,
        exposures: [{ fundId: "fund_d", exposureKrw: 4n }],
        participation: p,
      }).adjustedCapacityKrw;
    expect(run(unknown)).toBe(run(participating));
    expect(run(unknown)).toBe(6n);
    expect(run(locked)).toBe(10n);
  });

  it("clamps at zero and flags when deductions exceed gross", () => {
    const l = ledger();
    l.requestParticipation("fund_b", "ipo_1");
    const r = evaluateDemoRuleV1({
      ipoId: "ipo_1",
      grossCapacityKrw: 5n,
      exposures: [{ fundId: "fund_b", exposureKrw: 9n }],
      participation: l,
    });
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
