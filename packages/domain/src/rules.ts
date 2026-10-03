import type { FundId, IpoId, RuleVersion, RuleVersionId, UnderlyingFundExposure } from "./model.js";
import type { Krw } from "./money.js";
import { sumKrw } from "./money.js";
import { ParticipationState } from "./participation.js";
import type { ParticipationLookup } from "./participation.js";

export const DEMO_RULE_V1_ID = "DEMO_RULE_V1";

/**
 * ILLUSTRATIVE demo rule only. Not legal or regulatory advice and not a production
 * implementation of any securities regulation.
 */
export const DEMO_RULE_V1: RuleVersion = {
  id: DEMO_RULE_V1_ID,
  description:
    "Illustrative: Adjusted Capacity = Gross Capacity - sum of exposure to underlying funds that are PARTICIPATING. " +
    "NON_PARTICIPATION_LOCKED underlying funds are exempt. UNKNOWN underlying funds are NOT exempt (deducted).",
  maxAttestationAgeMs: 24 * 60 * 60 * 1000,
};

/** How one underlying exposure was treated by the rule. */
export const Treatment = {
  /** Underlying fund is PARTICIPATING: exposure deducted. */
  DEDUCTED: "DEDUCTED",
  /** Underlying fund is NON_PARTICIPATION_LOCKED: exempt, not deducted. */
  EXEMPT_LOCKED: "EXEMPT_LOCKED",
  /**
   * Underlying fund is UNKNOWN: conservative handling, exposure is deducted exactly as if
   * it were PARTICIPATING. UNKNOWN never receives the exemption.
   */
  DEDUCTED_UNKNOWN_CONSERVATIVE: "DEDUCTED_UNKNOWN_CONSERVATIVE",
} as const;
export type Treatment = (typeof Treatment)[keyof typeof Treatment];

export const RuleFlag = {
  UNKNOWN_UNDERLYING_DEDUCTED: "UNKNOWN_UNDERLYING_DEDUCTED",
  DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO: "DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO",
} as const;
export type RuleFlag = (typeof RuleFlag)[keyof typeof RuleFlag];

export interface ExposureLine {
  readonly fundId: FundId;
  readonly exposureKrw: Krw;
  readonly state: ParticipationState;
  readonly treatment: Treatment;
}

/**
 * Input to a rule. Capacity can ONLY come from a CapacityAttestation: callers pass the
 * attested gross capacity and attested exposures; there is no other capacity input.
 */
export interface RuleInput {
  readonly ipoId: IpoId;
  readonly grossCapacityKrw: Krw;
  readonly exposures: readonly UnderlyingFundExposure[];
  readonly participation: ParticipationLookup;
}

export interface RuleEvaluation {
  readonly ruleVersion: RuleVersionId;
  readonly grossCapacityKrw: Krw;
  readonly deductedKrw: Krw;
  readonly adjustedCapacityKrw: Krw;
  readonly lines: readonly ExposureLine[];
  readonly flags: readonly RuleFlag[];
}

/** Pure, deterministic. Same input and same participation snapshot => same output. */
export function evaluateDemoRuleV1(input: RuleInput): RuleEvaluation {
  const lines: ExposureLine[] = input.exposures.map((e) => {
    const state = input.participation.getState(e.fundId, input.ipoId);
    return { fundId: e.fundId, exposureKrw: e.exposureKrw, state, treatment: treatmentFor(state) };
  });

  const deducted = sumKrw(lines.filter((l) => l.treatment !== Treatment.EXEMPT_LOCKED).map((l) => l.exposureKrw));
  const flags: RuleFlag[] = [];
  if (lines.some((l) => l.treatment === Treatment.DEDUCTED_UNKNOWN_CONSERVATIVE)) {
    flags.push(RuleFlag.UNKNOWN_UNDERLYING_DEDUCTED);
  }

  let adjusted = input.grossCapacityKrw - deducted;
  if (adjusted < 0n) {
    adjusted = 0n;
    flags.push(RuleFlag.DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO);
  }

  return {
    ruleVersion: DEMO_RULE_V1_ID,
    grossCapacityKrw: input.grossCapacityKrw,
    deductedKrw: deducted,
    adjustedCapacityKrw: adjusted,
    lines,
    flags,
  };
}

function treatmentFor(state: ParticipationState): Treatment {
  switch (state) {
    case ParticipationState.PARTICIPATING:
      return Treatment.DEDUCTED;
    case ParticipationState.NON_PARTICIPATION_LOCKED:
      return Treatment.EXEMPT_LOCKED;
    case ParticipationState.UNKNOWN:
      return Treatment.DEDUCTED_UNKNOWN_CONSERVATIVE;
  }
}

const RULES: ReadonlyMap<RuleVersionId, { readonly version: RuleVersion; readonly evaluate: (i: RuleInput) => RuleEvaluation }> =
  new Map([[DEMO_RULE_V1_ID, { version: DEMO_RULE_V1, evaluate: evaluateDemoRuleV1 }]]);

export function isSupportedRuleVersion(id: RuleVersionId): boolean {
  return RULES.has(id);
}

/** Dispatches to the rule implementation, or returns undefined for an unsupported version. */
export function evaluateRule(id: RuleVersionId, input: RuleInput): RuleEvaluation | undefined {
  return RULES.get(id)?.evaluate(input);
}
