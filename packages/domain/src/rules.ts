import type { FundId, IpoId, RuleVersion, RuleVersionId, UnderlyingFundExposure } from "./model.js";
import type { Krw } from "./money.js";
import { sumKrw } from "./money.js";
import { ParticipationState } from "./participation.js";
import type { ParticipationLookup } from "./participation.js";

export const DEMO_RULE_V1_ID = "DEMO_RULE_V1";
export const DEMO_RULE_V2_ID = "DEMO_RULE_V2";

/*
 * RULE VERSION IMMUTABILITY: the meaning of a rule version id (formula, parameters, UNKNOWN
 * handling, and the set of reason codes it can produce) must never change once the id has been
 * used. A behaviour change needs a NEW id; the old id stays frozen and keeps its tests as the pin
 * (see `rules.test.ts`, "frozen"). Receipts hash `ruleVersion` together with `reasonCode`, so the
 * same id must always mean the same thing.
 */

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

/**
 * ILLUSTRATIVE demo rule only. Same formula and parameters as DEMO_RULE_V1, plus one extra
 * reason: an UNKNOWN underlying fund whose attested exposure is 0 KRW is treated as a DATA ERROR
 * (such a combination cannot exist), reported as `ZERO_EXPOSURE_UNKNOWN` and taking precedence
 * over the generic UNKNOWN rejection. Zero-exposure PARTICIPATING / NON_PARTICIPATION_LOCKED funds are
 * evaluated normally (deducted 0 / exempt).
 */
export const DEMO_RULE_V2: RuleVersion = {
  id: DEMO_RULE_V2_ID,
  description:
    "Illustrative: same formula as DEMO_RULE_V1. If any underlying fund is UNKNOWN the bid is rejected; if an UNKNOWN " +
    "underlying fund has 0 KRW attested exposure this is a data error with its own reason, which takes precedence.",
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
  /**
   * UNKNOWN_PARTICIPATION: at least one underlying fund is UNKNOWN (the only cause DEMO_RULE_V1 can report).
   * ZERO_EXPOSURE_UNKNOWN: DEMO_RULE_V2 only; an UNKNOWN fund has 0 KRW exposure (data error, takes precedence).
   */
  readonly cause: UndeterminedCause;
  /** Every UNKNOWN underlying fund (including the zero-exposure ones). */
  readonly unknownFundIds: readonly FundId[];
  /** UNKNOWN underlying funds with 0 KRW exposure; always empty under DEMO_RULE_V1, which does not distinguish them. */
  readonly zeroExposureUnknownFundIds: readonly FundId[];
  readonly lines: readonly ExposureLine[];
}

export const UndeterminedCause = {
  UNKNOWN_PARTICIPATION: "UNKNOWN_PARTICIPATION",
  ZERO_EXPOSURE_UNKNOWN: "ZERO_EXPOSURE_UNKNOWN",
} as const;
export type UndeterminedCause = (typeof UndeterminedCause)[keyof typeof UndeterminedCause];

export type RuleEvaluation = RuleDetermined | RuleUndetermined;

/**
 * DEMO_RULE_V1 (FROZEN, see the immutability note above).
 * Pure, deterministic. Same input and same participation snapshot => same output.
 * Returns `determined: false` (no number) if any underlying fund is UNKNOWN.
 */
export function evaluateDemoRuleV1(input: RuleInput): RuleEvaluation {
  return evaluateDemoRule(input, { id: DEMO_RULE_V1_ID, zeroExposureUnknownIsDataError: false });
}

/** DEMO_RULE_V2: V1 plus the zero-exposure UNKNOWN data-error rejection. Pure and deterministic. */
export function evaluateDemoRuleV2(input: RuleInput): RuleEvaluation {
  return evaluateDemoRule(input, { id: DEMO_RULE_V2_ID, zeroExposureUnknownIsDataError: true });
}

interface DemoRuleSpec {
  readonly id: RuleVersionId;
  readonly zeroExposureUnknownIsDataError: boolean;
}

function evaluateDemoRule(input: RuleInput, spec: DemoRuleSpec): RuleEvaluation {
  const lines: ExposureLine[] = input.exposures.map((e) => {
    const state = lookupState(input.participation, e.fundId, input.ipoId);
    return { fundId: e.fundId, exposureKrw: e.exposureKrw, state, treatment: treatmentFor(state) };
  });

  const unknownFundIds = lines.filter((l) => l.treatment === Treatment.UNDETERMINED_UNKNOWN).map((l) => l.fundId);
  if (unknownFundIds.length > 0) {
    const zeroExposureUnknownFundIds = spec.zeroExposureUnknownIsDataError
      ? lines.filter((l) => l.treatment === Treatment.UNDETERMINED_UNKNOWN && l.exposureKrw === 0n).map((l) => l.fundId)
      : [];
    return {
      determined: false,
      ruleVersion: spec.id,
      cause: zeroExposureUnknownFundIds.length > 0 ? UndeterminedCause.ZERO_EXPOSURE_UNKNOWN : UndeterminedCause.UNKNOWN_PARTICIPATION,
      unknownFundIds,
      zeroExposureUnknownFundIds,
      lines,
    };
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
    ruleVersion: spec.id,
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
  new Map([
    [DEMO_RULE_V1_ID, { version: DEMO_RULE_V1, evaluate: evaluateDemoRuleV1 }],
    [DEMO_RULE_V2_ID, { version: DEMO_RULE_V2, evaluate: evaluateDemoRuleV2 }],
  ]);

export function isSupportedRuleVersion(id: RuleVersionId): boolean {
  return RULES.has(id);
}

/** Dispatches to the rule implementation, or returns undefined for an unsupported version. */
export function evaluateRule(id: RuleVersionId, input: RuleInput): RuleEvaluation | undefined {
  return RULES.get(id)?.evaluate(input);
}
