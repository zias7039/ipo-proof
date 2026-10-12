/**
 * 속성 기반(property-based) 테스트: 규칙 엔진과 verifyBid의 불변식 (이슈 #22).
 *
 * 예시 기반 테스트가 다루지 못하는 "임의 입력에서도 성립해야 하는 성질"만 다룬다.
 * 모든 식별자와 금액은 합성 데이터이며, 금액은 bigint다.
 *
 * 알려진 결함(이슈 #36)을 재현하는 케이스는 `it.fails`로 표시했다. 결함이 고쳐지면 해당 테스트가
 * "예상과 달리 통과"로 실패하므로, 그때 `it.fails`를 `it`으로 바꾸면 된다.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isKrw } from "../src/money.js";
import { ParticipationState } from "../src/participation.js";
import type { ParticipationLookup } from "../src/participation.js";
import { DEMO_RULE_V1, DEMO_RULE_V2, evaluateDemoRuleV1, evaluateDemoRuleV2, evaluateRule } from "../src/rules.js";
import type { RuleEvaluation, RuleInput } from "../src/rules.js";
import { verifyBid } from "../src/verify.js";
import { HOUR, NOW, att, makeEnv } from "./fixtures.js";

const RUNS = { numRuns: 200 };
const KNOWN = [ParticipationState.PARTICIPATING, ParticipationState.NON_PARTICIPATION_LOCKED] as const;
const FUND_IDS = ["fund_b", "fund_c", "fund_d", "fund_e"] as const;

const krw = fc.bigInt({ min: 0n, max: 10n ** 15n });
type Known = (typeof KNOWN)[number];

interface Line {
  readonly fundId: string;
  readonly exposureKrw: bigint;
  readonly state: Known;
}
/** 서로 다른 하위펀드 0~4개, 각각 임의 노출액(0 포함)과 알려진 상태(참여/락). */
const knownLines = fc
  .shuffledSubarray([...FUND_IDS], { minLength: 0, maxLength: FUND_IDS.length })
  .chain((ids) => fc.tuple(...ids.map((fundId) => fc.record({ fundId: fc.constant(fundId), exposureKrw: krw, state: fc.constantFrom(...KNOWN) }))))
  .map((lines) => lines as readonly Line[]);

const lookupOf = (states: Record<string, unknown>): ParticipationLookup => ({ getState: (fundId) => states[fundId] as never });

function inputOf(gross: bigint, lines: readonly Line[], states: Record<string, unknown>): RuleInput {
  return {
    ipoId: "ipo_1",
    grossCapacityKrw: gross,
    exposures: lines.map((l) => ({ fundId: l.fundId, exposureKrw: l.exposureKrw })),
    participation: lookupOf(states),
  };
}
const statesOf = (lines: readonly Line[]): Record<string, unknown> => Object.fromEntries(lines.map((l) => [l.fundId, l.state]));
const determinedOf = (r: RuleEvaluation) => {
  if (!r.determined) throw new Error("expected a determined evaluation");
  return r;
};

const EVALUATORS = [
  ["DEMO_RULE_V1", evaluateDemoRuleV1],
  ["DEMO_RULE_V2", evaluateDemoRuleV2],
] as const;

describe.each(EVALUATORS)("%s: 알려진 상태만 있을 때의 산식 불변식", (_name, evaluate) => {
  it("조정 용량 = max(총 용량 - 참여 중 노출 합, 0), 조정 용량 <= 총 용량, 모든 금액은 bigint", () => {
    fc.assert(
      fc.property(krw, knownLines, (gross, lines) => {
        const r = determinedOf(evaluate(inputOf(gross, lines, statesOf(lines))));
        const expectedDeducted = lines.filter((l) => l.state === ParticipationState.PARTICIPATING).reduce((s, l) => s + l.exposureKrw, 0n);
        expect(r.deductedKrw).toBe(expectedDeducted);
        expect(r.adjustedCapacityKrw).toBe(gross > expectedDeducted ? gross - expectedDeducted : 0n);
        expect(r.adjustedCapacityKrw <= gross).toBe(true);
        expect(r.flags.length === 1).toBe(expectedDeducted > gross);
        for (const v of [r.grossCapacityKrw, r.deductedKrw, r.adjustedCapacityKrw]) expect(typeof v).toBe("bigint");
        expect(isKrw(r.adjustedCapacityKrw)).toBe(true);
      }),
      RUNS,
    );
  });

  it("단조성: 참여 중 펀드의 노출을 늘리거나 락 펀드를 참여로 바꿔도 조정 용량은 늘지 않는다", () => {
    fc.assert(
      fc.property(krw, knownLines, krw, fc.nat(), (gross, lines, extra, pick) => {
        if (lines.length === 0) return;
        const before = determinedOf(evaluate(inputOf(gross, lines, statesOf(lines)))).adjustedCapacityKrw;
        const i = pick % lines.length;
        const target = lines[i] as Line;

        const raised = lines.map((l, j) => (j === i ? { ...l, exposureKrw: l.exposureKrw + extra } : l));
        const afterRaise = determinedOf(evaluate(inputOf(gross, raised, statesOf(raised)))).adjustedCapacityKrw;
        expect(afterRaise <= before).toBe(true);

        const toParticipating = lines.map((l, j) => (j === i ? { ...l, state: ParticipationState.PARTICIPATING } : l));
        const afterSwitch = determinedOf(evaluate(inputOf(gross, toParticipating, statesOf(toParticipating)))).adjustedCapacityKrw;
        expect(afterSwitch <= before).toBe(true);
        void target;
      }),
      RUNS,
    );
  });

  it("노출 순서를 섞어도 결과(금액, 플래그)는 같다", () => {
    fc.assert(
      fc.property(krw, knownLines, fc.nat(), (gross, lines, seed) => {
        const rotated = lines.length === 0 ? lines : [...lines.slice(seed % lines.length), ...lines.slice(0, seed % lines.length)];
        const a = determinedOf(evaluate(inputOf(gross, lines, statesOf(lines))));
        const b = determinedOf(evaluate(inputOf(gross, rotated, statesOf(rotated))));
        expect([b.deductedKrw, b.adjustedCapacityKrw, b.flags]).toEqual([a.deductedKrw, a.adjustedCapacityKrw, a.flags]);
      }),
      RUNS,
    );
  });
});

/** "정확히 두 개의 알려진 문자열"이 아닌 모든 값: 쓰레기 값, 대소문자·공백 변형, null, undefined, 객체, 숫자 등. */
const junkState = fc.oneof(
  fc.anything(),
  fc.constantFrom(undefined, null, "", "UNKNOWN", "unknown", "Unknown", " UNKNOWN", "PARTICIPATING ", "participating", "non_participation_locked", " NON_PARTICIPATION_LOCKED", 0, 1, false, true),
  fc.string(),
  fc.constantFrom(...KNOWN).map((s) => `${s} `),
  fc.constantFrom(...KNOWN).map((s) => s.toLowerCase()),
).filter((v) => v !== ParticipationState.PARTICIPATING && v !== ParticipationState.NON_PARTICIPATION_LOCKED);

describe.each(EVALUATORS)("%s: UNKNOWN과 예상 밖 조회 값은 fail-closed", (_name, evaluate) => {
  it("임의의 쓰레기 값이 하나라도 있으면 determined=false이고, 그 펀드가 unknownFundIds에 들어간다 (면제·차감 계산 없음)", () => {
    fc.assert(
      fc.property(krw, knownLines, junkState, fc.nat(), (gross, lines, junk, pick) => {
        if (lines.length === 0) return;
        const i = pick % lines.length;
        const states = { ...statesOf(lines), [(lines[i] as Line).fundId]: junk };
        const r = evaluate(inputOf(gross, lines, states));
        expect(r.determined).toBe(false);
        if (!r.determined) expect(r.unknownFundIds).toContain((lines[i] as Line).fundId);
      }),
      RUNS,
    );
  });

  it("조회가 예외를 던져도 UNKNOWN 취급(거부)이며 예외가 밖으로 나오지 않는다", () => {
    fc.assert(
      fc.property(krw, knownLines, fc.nat(), (gross, lines, pick) => {
        if (lines.length === 0) return;
        const bad = (lines[pick % lines.length] as Line).fundId;
        const participation: ParticipationLookup = {
          getState: (fundId) => {
            if (fundId === bad) throw new Error("boom");
            return (statesOf(lines)[fundId] ?? ParticipationState.UNKNOWN) as never;
          },
        };
        const r = evaluate({ ...inputOf(gross, lines, {}), participation });
        expect(r.determined).toBe(false);
      }),
      RUNS,
    );
  });

  it("UNKNOWN이 섞인 입력은 노출액·총 용량·입찰이 무엇이든 절대 determined=true가 아니다", () => {
    fc.assert(
      fc.property(krw, knownLines, krw, (gross, lines, unknownExposure) => {
        const exposures = [...lines.map((l) => ({ fundId: l.fundId, exposureKrw: l.exposureKrw })), { fundId: "fund_z", exposureKrw: unknownExposure }];
        const r = evaluate({ ipoId: "ipo_1", grossCapacityKrw: gross, exposures, participation: lookupOf({ ...statesOf(lines) }) });
        expect(r.determined).toBe(false);
      }),
      RUNS,
    );
  });
});

describe("0원 UNKNOWN 우선 규칙 (V2) / V1 동결", () => {
  const unknownLine = fc.record({ fundId: fc.constantFrom(...FUND_IDS), exposureKrw: fc.oneof(fc.constant(0n), krw) });
  const unknownSet = fc.uniqueArray(unknownLine, { selector: (l) => l.fundId, minLength: 1, maxLength: FUND_IDS.length });

  it("V2: UNKNOWN 중 0원 노출이 하나라도 있으면 입력 순서와 무관하게 ZERO_EXPOSURE_UNKNOWN, 아니면 UNKNOWN_PARTICIPATION", () => {
    fc.assert(
      fc.property(krw, unknownSet, fc.nat(), (gross, unknowns, seed) => {
        const rotated = [...unknowns.slice(seed % unknowns.length), ...unknowns.slice(0, seed % unknowns.length)];
        const expected = unknowns.some((u) => u.exposureKrw === 0n) ? "ZERO_EXPOSURE_UNKNOWN" : "UNKNOWN_PARTICIPATION";
        for (const exposures of [unknowns, rotated, [...unknowns].reverse()]) {
          const r = evaluateDemoRuleV2({ ipoId: "ipo_1", grossCapacityKrw: gross, exposures, participation: lookupOf({}) });
          expect(r.determined).toBe(false);
          if (!r.determined) expect(r.cause).toBe(expected);
        }
      }),
      RUNS,
    );
  });

  it("V1은 0원을 구분하지 않는다 (동결): 항상 UNKNOWN_PARTICIPATION이고 zeroExposureUnknownFundIds는 비어 있다", () => {
    fc.assert(
      fc.property(krw, unknownSet, (gross, unknowns) => {
        const r = evaluateDemoRuleV1({ ipoId: "ipo_1", grossCapacityKrw: gross, exposures: unknowns, participation: lookupOf({}) });
        expect(r.determined).toBe(false);
        if (!r.determined) {
          expect(r.cause).toBe("UNKNOWN_PARTICIPATION");
          expect(r.zeroExposureUnknownFundIds).toEqual([]);
        }
      }),
      RUNS,
    );
  });

  it("verifyBid: 0원 UNKNOWN 우선 규칙은 사유 코드만 바꾼다 — 어떤 입찰 금액에서도 적격(eligible)이 되지 않는다", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 13n }), fc.constantFrom(0n, 1n, 5n), (bidAmount, exposureC) => {
        const e = makeEnv({
          rule: DEMO_RULE_V2,
          recordStates: false,
          attestation: att({ ruleVersion: "DEMO_RULE_V2", underlyingExposures: [{ fundId: "fund_b", exposureKrw: 3n }, { fundId: "fund_c", exposureKrw: exposureC }] }),
        });
        const r = verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount }, e.deps);
        expect(r.eligible).toBe(false);
        expect(r.reasonCode).toBe(exposureC === 0n ? "UNDERLYING_ZERO_EXPOSURE_UNKNOWN" : "UNDERLYING_PARTICIPATION_UNKNOWN");
      }),
      RUNS,
    );
  });
});

describe("verifyBid: 적격 판정은 독립적으로 계산한 조정 용량과 일치", () => {
  it("ELIGIBLE <=> bid <= max(gross - 참여 노출 합, 0), 아니면 BID_EXCEEDS_ADJUSTED_CAPACITY", () => {
    fc.assert(
      fc.property(krw, krw, krw, fc.constantFrom(...KNOWN), fc.constantFrom(...KNOWN), fc.bigInt({ min: 1n, max: 2n * 10n ** 15n }), (gross, expB, expC, stateB, stateC, bidAmount) => {
        const e = makeEnv({
          recordStates: false,
          attestation: att({ grossCapacityKrw: gross, underlyingExposures: [{ fundId: "fund_b", exposureKrw: expB }, { fundId: "fund_c", exposureKrw: expC }] }),
        });
        for (const [fundId, state] of [["fund_b", stateB], ["fund_c", stateC]] as const) {
          if (state === ParticipationState.PARTICIPATING) e.ledger.requestParticipation(fundId, "ipo_1");
          else e.ledger.requestNonParticipationLock(fundId, "ipo_1");
        }
        const deducted = (stateB === ParticipationState.PARTICIPATING ? expB : 0n) + (stateC === ParticipationState.PARTICIPATING ? expC : 0n);
        const adjusted = gross > deducted ? gross - deducted : 0n;
        const r = verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount }, e.deps);
        expect(r.eligible).toBe(bidAmount <= adjusted);
        expect(r.reasonCode).toBe(bidAmount <= adjusted ? "ELIGIBLE" : "BID_EXCEEDS_ADJUSTED_CAPACITY");
      }),
      RUNS,
    );
  });
});

describe("금액은 bigint만: 다른 타입은 어디에서도 금액으로 통과하지 못한다", () => {
  it("isKrw: bigint가 아닌 임의 값과 음수 bigint는 거부", () => {
    fc.assert(
      fc.property(fc.anything().filter((v) => typeof v !== "bigint"), (v) => {
        expect(isKrw(v)).toBe(false);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: -1n }), (v) => {
        expect(isKrw(v)).toBe(false);
      }),
      RUNS,
    );
  });

  it("verifyBid: 입찰 금액이 bigint가 아니거나 음수/0이면 INVALID_BID_AMOUNT로 거부 (숫자 1000도 거부)", () => {
    const e = makeEnv();
    const notMoney = fc.oneof(
      fc.anything().filter((v) => typeof v !== "bigint"),
      fc.integer(),
      fc.double(),
      fc.bigInt({ min: -(10n ** 15n), max: 0n }),
    );
    fc.assert(
      fc.property(notMoney, (bidAmount) => {
        const r = verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount }, e.deps);
        expect(r.eligible).toBe(false);
        expect(r.reasonCode).toBe("INVALID_BID_AMOUNT");
      }),
      RUNS,
    );
  });

  it("어테스테이션의 총 용량·노출액이 bigint가 아니거나 음수이면 ATTESTATION_MALFORMED로 거부 (규칙 평가에 도달하지 못함)", () => {
    const junkMoney = fc.oneof(
      fc.anything().filter((v) => typeof v !== "bigint"),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.bigInt({ min: -(10n ** 15n), max: -1n }),
    );
    fc.assert(
      fc.property(junkMoney, fc.boolean(), (bad, inExposure) => {
        const a = inExposure
          ? att({ underlyingExposures: [{ fundId: "fund_b", exposureKrw: bad as never }, { fundId: "fund_c", exposureKrw: 1n }] })
          : att({ grossCapacityKrw: bad as never });
        const e = makeEnv({ attestation: a });
        const r = verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount: 1n }, e.deps);
        expect(r.eligible).toBe(false);
        expect(r.reasonCode).toBe("ATTESTATION_MALFORMED");
      }),
      RUNS,
    );
  });
});

describe("규칙 버전 선택은 fail-closed", () => {
  const V = ["DEMO_RULE_V1", "DEMO_RULE_V2"] as const;
  const junkVersion = fc.oneof(
    fc.anything(),
    fc.string(),
    fc.constantFrom("", "demo_rule_v1", "demo_rule_v2", "DEMO_RULE_V1 ", " DEMO_RULE_V2", "DEMO_RULE_V3", "__proto__", "constructor", "toString", 1, 2, null, undefined),
  );

  it("어테스테이션 ruleVersion이 활성 버전과 정확히 같지 않으면 항상 거부되고, 적격이 될 수 없다", () => {
    fc.assert(
      fc.property(fc.constantFrom(...V), junkVersion, (active, claimed) => {
        fc.pre(claimed !== active);
        const e = makeEnv({ rule: active === "DEMO_RULE_V1" ? DEMO_RULE_V1 : DEMO_RULE_V2, attestation: att({ ruleVersion: claimed as never }) });
        const r = verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount: 1n }, e.deps);
        expect(r.eligible).toBe(false);
        expect(r.reasonCode).toBe("RULE_VERSION_MISMATCH");
      }),
      RUNS,
    );
  });

  it("활성 규칙 id가 등록되지 않은 값이면 RULE_VERSION_UNSUPPORTED이고 폴백(더 허용적인 버전으로의 평가)이 없다", () => {
    fc.assert(
      fc.property(junkVersion, (id) => {
        fc.pre(id !== "DEMO_RULE_V1" && id !== "DEMO_RULE_V2");
        fc.pre(typeof id === "string"); // 문자열이 아닌 id는 영수증 해시 단계에서 예외가 나는 별도 항목(#36 §4)
        const e = makeEnv({ rule: { ...DEMO_RULE_V1, id: id as string }, attestation: att({ ruleVersion: id as string }) });
        const r = verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount: 1n }, e.deps);
        expect(r.eligible).toBe(false);
        expect(r.reasonCode).toBe("RULE_VERSION_UNSUPPORTED");
        expect(evaluateRule(id as string, inputOf(1n, [], {}))).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("V1 활성 + V2 어테스테이션, V2 활성 + V1 어테스테이션은 항상 RULE_VERSION_MISMATCH (입찰 금액·노출과 무관)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 13n }), krw, (bidAmount, gross) => {
        for (const [active, claimed] of [[DEMO_RULE_V1, "DEMO_RULE_V2"], [DEMO_RULE_V2, "DEMO_RULE_V1"]] as const) {
          const e = makeEnv({ rule: active, attestation: att({ ruleVersion: claimed, grossCapacityKrw: gross }) });
          expect(verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount }, e.deps)).toMatchObject({ eligible: false, reasonCode: "RULE_VERSION_MISMATCH" });
        }
      }),
      RUNS,
    );
  });
});

/* ------------------------------------------------------------------------------------------
 * 알려진 결함 (이슈 #36). 아래 테스트는 "올바른 동작"을 단언하며 현재 main에서는 실패하므로
 * it.fails로 표시한다. 수정 PR이 병합되면 it.fails -> it 으로 바꾼다.
 * ---------------------------------------------------------------------------------------- */
describe("알려진 결함 (#36)", () => {
  // 한국어 설명: maxAttestationAgeMs가 NaN/Infinity/undefined이면 stale 검사가 꺼져 1000시간 전 어테스테이션이 통과한다.
  it.fails("[#36 §1] 이상한 maxAttestationAgeMs(NaN, Infinity, undefined)로 stale 검사가 꺼지면 안 된다", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const e = makeEnv({
        rule: { ...DEMO_RULE_V1, maxAttestationAgeMs: bad as number },
        attestation: att({ issuedAt: NOW - 1000 * HOUR, expiresAt: NOW + HOUR }),
      });
      expect(verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount: 1n }, e.deps).eligible).toBe(false);
    }
  });

  // 한국어 설명: 본인 펀드의 락 조회는 정규화 없이 === 비교라, 락을 잘못 표기한 값(소문자, 공백 포함 등)이면 통과한다.
  it.fails("[#36 §3] 본인 펀드의 조회 값이 예상 밖(락처럼 보이는 변형 포함)이면 적격이 되면 안 된다", () => {
    const e = makeEnv();
    for (const raw of ["non_participation_locked", " NON_PARTICIPATION_LOCKED", undefined, null]) {
      const participation: ParticipationLookup = { getState: (fundId, ipoId) => (fundId === "fund_a" ? (raw as never) : e.ledger.getState(fundId, ipoId)) };
      expect(verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount: 1n }, { ...e.deps, participation }).eligible).toBe(false);
    }
  });
});
