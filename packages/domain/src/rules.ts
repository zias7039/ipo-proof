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
    "NON_PARTICIPATION_LOCKED underlying funds are exempt. UNKNOWN underlying funds are NOT exempt and are NOT " +
    "assumed away either: if any underlying fund is UNKNOWN, adjusted capacity is undetermined and the bid is rejected.",
  maxAttestationAgeMs: 24 * 60 * 60 * 1000,
};

/** How one underlying exposure was treated by the rule. */
export const Treatment = {
  /** Underlying fund is PARTICIPATING: exposure deducted. */
  DEDUCTED: "DEDUCTED",
  /** Underlying fund is NON_PARTICIPATION_LOCKED: exempt, not deducted. */
  EXEMPT_LOCKED: "EXEMPT_LOCKED",
  /**
   * Underlying fund is UNKNOWN (absent from the ledger, which is not the same as non-participating).
   * It is never exempt, and no number is produced while any underlying fund is in this state:
   * the whole evaluation is undetermined (see `RuleUndetermined`).
   */
  UNDETERMINED_UNKNOWN: "UNDETERMINED_UNKNOWN",
} as const;
export type Treatment = (typeof Treatment)[keyof typeof Treatment];

export const RuleFlag = {
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

/** All underlying participation states were known (PARTICIPATING or LOCKED): a capacity was computed. */
export interface RuleDetermined {
  readonly determined: true;
  readonly ruleVersion: RuleVersionId;
  readonly grossCapacityKrw: Krw;
  readonly deductedKrw: Krw;
  readonly adjustedCapacityKrw: Krw;
  readonly lines: readonly ExposureLine[];
  readonly flags: readonly RuleFlag[];
}

/**
 * At least one underlying fund is UNKNOWN, so no adjusted capacity is produced (policy decision
 * of issue #10: reject rather than deduct-and-flag). `lines` shows every exposure's state.
 */
export interface RuleUndetermined {
  readonly determined: false;
  readonly ruleVersion: RuleVersionId;
  readonly unknownFundIds: readonly FundId[];
  readonly lines: readonly ExposureLine[];
}

export type RuleEvaluation = RuleDetermined | RuleUndetermined;

/**
 * Pure, deterministic. Same input and same participation snapshot => same output.
 * Returns `determined: false` (no number) if any underlying fund is UNKNOWN.
 */
export function evaluateDemoRuleV1(input: RuleInput): RuleEvaluation {
  const lines: ExposureLine[] = input.exposures.map((e) => {
    const state = lookupState(input.participation, e.fundId, input.ipoId);
    return { fundId: e.fundId, exposureKrw: e.exposureKrw, state, treatment: treatmentFor(state) };
  });

  const unknownFundIds = lines.filter((l) => l.treatment === Treatment.UNDETERMINED_UNKNOWN).map((l) => l.fundId);
  if (unknownFundIds.length > 0) {
    return { determined: false, ruleVersion: DEMO_RULE_V1_ID, unknownFundIds, lines };
  }

  const deducted = sumKrw(lines.filter((l) => l.treatment === Treatment.DEDUCTED).map((l) => l.exposureKrw));
  const flags: RuleFlag[] = [];

  let adjusted = input.grossCapacityKrw - deducted;
  if (adjusted < 0n) {
    adjusted = 0n;
    flags.push(RuleFlag.DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO);
  }

  return {
    determined: true,
    ruleVersion: DEMO_RULE_V1_ID,
    grossCapacityKrw: input.grossCapacityKrw,
    deductedKrw: deducted,
    adjustedCapacityKrw: adjusted,
    lines,
    flags,
  };
}

/**
 * Fail-closed state lookup. `ParticipationLookup` is a public interface, so its return value is
 * not trusted at runtime: anything that is not exactly one of the three known states
 * (undefined, null, "", "unknown", " UNKNOWN", ...) is treated as UNKNOWN, and so is a lookup that
 * throws. UNKNOWN leads to rejection, so an unexpected value can never turn into an exemption.
 */
function lookupState(participation: ParticipationLookup, fundId: FundId, ipoId: IpoId): ParticipationState {
  let raw: unknown;
  try {
    raw = participation.getState(fundId, ipoId);
  } catch {
    return ParticipationState.UNKNOWN;
  }
  return raw === ParticipationState.PARTICIPATING || raw === ParticipationState.NON_PARTICIPATION_LOCKED
    ? raw
    : ParticipationState.UNKNOWN;
}

function treatmentFor(state: ParticipationState): Treatment {
  switch (state) {
    case ParticipationState.PARTICIPATING:
      return Treatment.DEDUCTED;
    case ParticipationState.NON_PARTICIPATION_LOCKED:
      return Treatment.EXEMPT_LOCKED;
    case ParticipationState.UNKNOWN:
      return Treatment.UNDETERMINED_UNKNOWN;
    default:
      return failClosed(state);
  }
}

/** Compile-time exhaustiveness check (`value` must be `never`) with a fail-closed runtime fallback. */
function failClosed(value: never): Treatment {
  void value;
  return Treatment.UNDETERMINED_UNKNOWN;
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
