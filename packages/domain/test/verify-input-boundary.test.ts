/**
 * Issue #36: verifyBid input boundary must fail closed.
 *  1. rule parameters come from the registered definition; a caller object that differs is refused
 *  2. the attestation is read once into a frozen copy (no TOCTOU between signature check and rule engine)
 *  3. the bidding fund's own lock lookup is normalised like the underlying funds' lookups
 *  4. a missing / malformed active rule version returns a reason code instead of throwing
 * Receipts of previously valid inputs must be byte-identical (pinned hashes below were taken on main @ 0eb5d89).
 */
import { describe, expect, it } from "vitest";
import { InMemoryAttestationStore, snapshotAttestation } from "../src/attestation.js";
import type { AttestationSource, AttestationVerifier } from "../src/attestation.js";
import type { CapacityAttestation } from "../src/model.js";
import { ParticipationState, readParticipationState } from "../src/participation.js";
import type { ParticipationLookup } from "../src/participation.js";
import { DEMO_RULE_V1, DEMO_RULE_V2, getRegisteredRuleVersion } from "../src/rules.js";
import { INVALID_RULE_VERSION_ID, verifyBid } from "../src/verify.js";
import type { VerifyBidDeps } from "../src/verify.js";
import { HOUR, NOW, att, makeEnv, makeSignedEnv, mustPublish, signedAtt } from "./fixtures.js";

const bid = (bidAmount: bigint = 1n) => ({ fundId: "fund_a", ipoId: "ipo_1", bidAmount });
const withRule = (deps: VerifyBidDeps, activeRuleVersion: unknown): VerifyBidDeps => ({ ...deps, activeRuleVersion: activeRuleVersion as never });
const rejected = (reasonCode: string) => ({ eligible: false, reasonCode });

describe("receipts of valid inputs are unchanged (rule-id immutability)", () => {
  it("pins proofHash for ELIGIBLE, BID_EXCEEDS, DEMO_RULE_V2 and RULE_VERSION_UNSUPPORTED", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(24_000_000_000n), deps).proofHash).toBe("f072ab07ad9bbb8e475739cd10641e71b914891fab8f0606e52f862312132521");
    expect(verifyBid(bid(24_000_000_001n), deps).proofHash).toBe("9e3955a7e2809376a3194d624c7d551ceaf574897e7d0bd0a6799aaa67854539");
    const v2 = makeEnv({ rule: DEMO_RULE_V2, attestation: att({ ruleVersion: "DEMO_RULE_V2" }) });
    expect(verifyBid(bid(24_000_000_000n), v2.deps).proofHash).toBe("a7d1ecf96bc066249757337770bc6ab56f684276215ea5cdf67e9b8a60a8c081");
    const unsupported = verifyBid(bid(24_000_000_000n), withRule(deps, { ...DEMO_RULE_V1, id: "DEMO_RULE_V9" }));
    expect(unsupported).toMatchObject(rejected("RULE_VERSION_UNSUPPORTED"));
    expect(unsupported.proofHash).toBe("73aab67e7cf6e556919fef083497318112758615afb34aa0f1b65a6420c6d11e");
  });
});

describe("#36-1: rule parameters are not taken from the caller", () => {
  const stale = () => makeEnv({ attestation: att({ issuedAt: NOW - 1000 * HOUR, expiresAt: NOW + HOUR }) });

  it("baseline: the registered limit marks a 1000-hour-old attestation stale", () => {
    expect(verifyBid(bid(), stale().deps)).toMatchObject(rejected("ATTESTATION_STALE"));
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["undefined", undefined],
    ["null", null],
    ["negative", -1],
    ["zero", 0],
    ["non-integer", 1.5],
    ["string", "86400000"],
    ["bigint", 86_400_000n],
    ["huge", 1e15],
    ["one ms more than registered", DEMO_RULE_V1.maxAttestationAgeMs + 1],
    ["one ms less than registered", DEMO_RULE_V1.maxAttestationAgeMs - 1],
  ])("maxAttestationAgeMs = %s is refused, never turned into 'no stale check'", (_label, value) => {
    const { deps } = stale();
    const r = verifyBid(bid(), withRule(deps, { ...DEMO_RULE_V1, maxAttestationAgeMs: value }));
    expect(r).toMatchObject(rejected("RULE_VERSION_UNSUPPORTED"));
    expect(r.ruleVersion).toBe("DEMO_RULE_V1");
  });

  it("a missing maxAttestationAgeMs key is refused too (also for DEMO_RULE_V2)", () => {
    const { deps } = stale();
    const partial: Record<string, unknown> = { ...DEMO_RULE_V1 };
    delete partial["maxAttestationAgeMs"];
    expect(verifyBid(bid(), withRule(deps, partial)).reasonCode).toBe("RULE_VERSION_UNSUPPORTED");
    const v2 = makeEnv({ rule: DEMO_RULE_V2, attestation: att({ ruleVersion: "DEMO_RULE_V2", issuedAt: NOW - 1000 * HOUR }) });
    expect(verifyBid(bid(), withRule(v2.deps, { ...DEMO_RULE_V2, maxAttestationAgeMs: Number.NaN })).reasonCode).toBe("RULE_VERSION_UNSUPPORTED");
  });

  it("the exact registered object and an equal copy are accepted; the limit boundary is unchanged (24 h valid, +1 ms stale)", () => {
    const ok = makeEnv({ attestation: att({ issuedAt: NOW - DEMO_RULE_V1.maxAttestationAgeMs }) });
    expect(verifyBid(bid(), ok.deps).reasonCode).toBe("ELIGIBLE");
    expect(verifyBid(bid(), withRule(ok.deps, { ...DEMO_RULE_V1 })).reasonCode).toBe("ELIGIBLE");
    const old = makeEnv({ attestation: att({ issuedAt: NOW - DEMO_RULE_V1.maxAttestationAgeMs - 1 }) });
    expect(verifyBid(bid(), old.deps).reasonCode).toBe("ATTESTATION_STALE");
  });

  it("the registry exposes the frozen definitions and nothing for unknown ids or non-strings", () => {
    expect(getRegisteredRuleVersion("DEMO_RULE_V1")).toBe(DEMO_RULE_V1);
    expect(getRegisteredRuleVersion("DEMO_RULE_V9")).toBeUndefined();
    expect(getRegisteredRuleVersion(undefined)).toBeUndefined();
    expect(getRegisteredRuleVersion("__proto__")).toBeUndefined();
    expect(getRegisteredRuleVersion("constructor")).toBeUndefined();
  });
});

describe("#36-4: a missing or malformed active rule version returns a reason code (no throw)", () => {
  const throwingGetter = Object.defineProperty({}, "id", {
    get() {
      throw new Error("boom");
    },
  });
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "DEMO_RULE_V1"],
    ["an empty object", {}],
    ["id undefined", { ...DEMO_RULE_V1, id: undefined }],
    ["id null", { ...DEMO_RULE_V1, id: null }],
    ["id a number", { ...DEMO_RULE_V1, id: 1 }],
    ["id an object", { ...DEMO_RULE_V1, id: { toString: () => "DEMO_RULE_V1" } }],
    ["a throwing accessor", throwingGetter],
  ])("%s -> RULE_VERSION_UNSUPPORTED", (_label, rule) => {
    const { deps } = makeEnv();
    const run = () => verifyBid(bid(), withRule(deps, rule));
    expect(run).not.toThrow();
    const r = run();
    expect(r).toMatchObject(rejected("RULE_VERSION_UNSUPPORTED"));
    expect(r.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a non-string id is reported with a fixed placeholder that is not a valid id; the request checks still run first", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(), withRule(deps, undefined)).ruleVersion).toBe(INVALID_RULE_VERSION_ID);
    expect(verifyBid({ nope: 1 }, withRule(deps, undefined)).reasonCode).toBe("INVALID_BID_REQUEST");
    expect(verifyBid({ ...bid(), fundId: "fund_ghost" }, withRule(deps, undefined)).reasonCode).toBe("FUND_NOT_REGISTERED");
  });

  it("the active rule is read once: an accessor that changes between reads cannot pass the check and then differ", () => {
    const { deps } = makeEnv();
    let reads = 0;
    const flip = {
      get id() {
        reads += 1;
        return reads === 1 ? "DEMO_RULE_V1" : "DEMO_RULE_V9";
      },
      get maxAttestationAgeMs() {
        return DEMO_RULE_V1.maxAttestationAgeMs;
      },
    };
    const r = verifyBid(bid(), withRule(deps, flip));
    expect(reads).toBe(1);
    expect(r.ruleVersion).toBe("DEMO_RULE_V1");
    expect(r.reasonCode).toBe("ELIGIBLE");
  });
});

describe("#36-2: the attestation is read once (no TOCTOU)", () => {
  /** An attestation whose gross capacity is the signed value on the first read and 900bn afterwards. */
  function flipping(real: CapacityAttestation, counts: Record<string, number>): CapacityAttestation {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(real) as (keyof CapacityAttestation)[]) {
      Object.defineProperty(o, k, {
        enumerable: true,
        get() {
          counts[k] = (counts[k] ?? 0) + 1;
          if (k === "grossCapacityKrw") return counts[k] === 1 ? real.grossCapacityKrw : 900_000_000_000n;
          return real[k];
        },
      });
    }
    return o as unknown as CapacityAttestation;
  }

  it("a field that returns different values on later reads cannot inflate capacity after the signature check", async () => {
    const real = await signedAtt();
    const e = makeSignedEnv({ attestation: null });
    const source: AttestationSource = { getAttestation: () => flipping(real, {}) };
    const deps: VerifyBidDeps = { ...e.deps, attestations: source };
    // Signed capacity is 30bn (adjusted 24bn); a 25bn bid must be rejected, not ELIGIBLE.
    expect(verifyBid({ ...bid(), bidAmount: 25_000_000_000n }, deps)).toMatchObject(rejected("BID_EXCEEDS_ADJUSTED_CAPACITY"));
    expect(verifyBid({ ...bid(), bidAmount: 24_000_000_000n }, deps)).toMatchObject({ eligible: true });
  });

  it("each attestation field is read exactly once per verification", async () => {
    const real = await signedAtt();
    const e = makeSignedEnv({ attestation: null });
    const counts: Record<string, number> = {};
    verifyBid(bid(), { ...e.deps, attestations: { getAttestation: () => flipping(real, counts) } });
    expect(Object.keys(counts).length).toBe(Object.keys(real).length);
    for (const [k, n] of Object.entries(counts)) expect(n, k).toBe(1);
  });

  it("mutating the stored object while the verifier runs does not change what the rule engine sees", () => {
    const original = att();
    const mutable = { ...original } as { -readonly [K in keyof CapacityAttestation]: CapacityAttestation[K] };
    const e = makeEnv({ attestation: null });
    const verifier: AttestationVerifier = {
      verify: () => {
        mutable.grossCapacityKrw = 900_000_000_000n;
        return { ok: true };
      },
    };
    const deps: VerifyBidDeps = { ...e.deps, attestations: { getAttestation: () => mutable }, attesterVerifier: verifier };
    expect(verifyBid({ ...bid(), bidAmount: 25_000_000_000n }, deps)).toMatchObject(rejected("BID_EXCEEDS_ADJUSTED_CAPACITY"));
  });

  it("the verifier receives a frozen copy, not the caller's object", () => {
    const e = makeEnv();
    let seen: CapacityAttestation | undefined;
    const original = att();
    const deps: VerifyBidDeps = {
      ...e.deps,
      attestations: { getAttestation: () => original },
      attesterVerifier: {
        verify: (a) => {
          seen = a;
          return { ok: true };
        },
      },
    };
    verifyBid(bid(), deps);
    expect(seen).not.toBe(original);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen?.underlyingExposures)).toBe(true);
    expect(seen).toEqual(original);
  });

  it("a throwing accessor returns ATTESTATION_MALFORMED instead of throwing", () => {
    const e = makeEnv({ attestation: null });
    const bad = att();
    Object.defineProperty(bad, "grossCapacityKrw", {
      get() {
        throw new Error("boom");
      },
    });
    const throwingExposure = { ...att(), underlyingExposures: [{ fundId: "fund_b", get exposureKrw(): bigint { throw new Error("boom"); } }] };
    for (const a of [bad, throwingExposure]) {
      const run = () => verifyBid(bid(), { ...e.deps, attestations: { getAttestation: () => a as CapacityAttestation } });
      expect(run).not.toThrow();
      expect(run()).toMatchObject(rejected("ATTESTATION_MALFORMED"));
    }
  });

  it("a verifier that throws is a failed signature, not an exception", () => {
    const e = makeEnv();
    const deps: VerifyBidDeps = {
      ...e.deps,
      attesterVerifier: {
        verify: () => {
          throw new Error("boom");
        },
      },
    };
    expect(verifyBid(bid(), deps)).toMatchObject(rejected("SIGNATURE_INVALID"));
  });

  it("non-object attestations, holes and non-object exposure entries, and non-string identifiers are malformed", () => {
    const e = makeEnv({ attestation: null });
    const sparse = att();
    const holes: unknown[] = new Array<unknown>(2);
    holes[1] = { fundId: "fund_b", exposureKrw: 1n };
    (sparse as { underlyingExposures: unknown }).underlyingExposures = holes;
    const cases: unknown[] = [
      "not an object",
      42,
      sparse,
      { ...att(), underlyingExposures: [null] },
      { ...att(), underlyingExposures: "x" },
      { ...att(), underlyingExposures: undefined },
      { ...att(), signature: 123 },
      { ...att(), nonce: undefined },
      { ...att(), attesterId: 5 },
      { ...att(), attestationId: {} },
    ];
    for (const c of cases) {
      const r = verifyBid(bid(), { ...e.deps, attestations: { getAttestation: () => c as CapacityAttestation } });
      expect(r.eligible).toBe(false);
      expect(["ATTESTATION_MALFORMED", "ATTESTATION_SUBJECT_MISMATCH"], String(c)).toContain(r.reasonCode);
      expect(r.reasonCode, JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? "n" : v))).not.toBe("ELIGIBLE");
    }
    expect(verifyBid(bid(), { ...e.deps, attestations: { getAttestation: () => sparse } }).reasonCode).toBe("ATTESTATION_MALFORMED");
    expect(verifyBid(bid(), { ...e.deps, attestations: { getAttestation: () => ({ ...att(), signature: 123 }) as never } }).reasonCode).toBe("ATTESTATION_MALFORMED");
  });

  it("non-string identifiers never reach the receipt: it is the same as for a missing id", () => {
    const e = makeEnv({ attestation: null });
    const run = (attestationId: unknown) =>
      verifyBid(bid(), { ...e.deps, attestations: { getAttestation: () => ({ ...att(), attestationId }) as never } });
    const baseline = run(undefined);
    expect(baseline.reasonCode).toBe("ATTESTATION_MALFORMED");
    for (const odd of [5n, { a: 1 }, ["x"], Symbol("s")]) expect(run(odd).proofHash, String(typeof odd)).toBe(baseline.proofHash);
  });

  it("publish: a verifier that throws is a refused signature with no state change; a malformed duplicate does not throw", () => {
    const boomVerifier: AttestationVerifier = { verify: () => { throw new Error("boom"); } };
    const store = new InMemoryAttestationStore(boomVerifier);
    expect(store.publish(att())).toEqual({ ok: false, reasonCode: "SIGNATURE_INVALID" });
    expect(store.getAttestation("fund_a", "ipo_1")).toBeUndefined();

    const e = makeEnv({ attestation: null });
    const odd = { ...att(), underlyingExposures: undefined } as unknown as CapacityAttestation;
    expect(e.store.publish(odd)).toEqual({ ok: true });
    expect(() => e.store.publish(odd)).not.toThrow();
    expect(e.store.publish(odd)).toEqual({ ok: false, reasonCode: "ATTESTATION_ID_CONFLICT" });
  });

  it("snapshotAttestation copies known fields only and returns undefined for non-objects", () => {
    const withExtra = { ...att(), extra: "x" };
    const snap = snapshotAttestation(withExtra);
    expect(snap).toEqual(att());
    expect(Object.keys(snap ?? {})).not.toContain("extra");
    expect(snapshotAttestation(null)).toBeUndefined();
    expect(snapshotAttestation("x")).toBeUndefined();
  });

  it("publish: the verifier checks the same copy that is stored; later mutation of the input changes nothing", () => {
    const e = makeEnv({ attestation: null });
    const input = { ...att() } as { -readonly [K in keyof CapacityAttestation]: CapacityAttestation[K] };
    mustPublish(e.store, input);
    input.grossCapacityKrw = 900_000_000_000n;
    expect(e.store.getAttestation("fund_a", "ipo_1")?.grossCapacityKrw).toBe(30_000_000_000n);
    expect(verifyBid({ ...bid(), bidAmount: 25_000_000_000n }, e.deps).reasonCode).toBe("BID_EXCEEDS_ADJUSTED_CAPACITY");
  });

  it("publish: a flipping accessor is verified and stored as one consistent value; throwing inputs and verifiers are refused without state change", async () => {
    const real = await signedAtt();
    const e = makeSignedEnv({ attestation: null, strictStore: true });
    let n = 0;
    const flip = { ...real };
    Object.defineProperty(flip, "grossCapacityKrw", { enumerable: true, get: () => (++n === 1 ? real.grossCapacityKrw : 900_000_000_000n) });
    expect(e.store.publish(flip)).toEqual({ ok: true });
    expect(e.store.getAttestation("fund_a", "ipo_1")?.grossCapacityKrw).toBe(real.grossCapacityKrw);

    const e2 = makeSignedEnv({ attestation: null, strictStore: true });
    const boom = { ...real };
    Object.defineProperty(boom, "nonce", { enumerable: true, get: () => { throw new Error("boom"); } });
    expect(e2.store.publish(boom)).toEqual({ ok: false, reasonCode: "ATTESTATION_MALFORMED" });
    expect(e2.store.getAttestation("fund_a", "ipo_1")).toBeUndefined();
  });
});

describe("#36-3: the bidding fund's own lock lookup is normalised (fail closed)", () => {
  const run = (value: unknown) => {
    const e = makeEnv();
    // fund_a (the bidding fund) answers `value`; the underlying funds answer as in the demo world.
    const states: Record<string, unknown> = { fund_b: ParticipationState.PARTICIPATING, fund_c: ParticipationState.NON_PARTICIPATION_LOCKED };
    const lookup: ParticipationLookup = {
      getState: (f) => {
        if (f !== "fund_a") return (states[f] ?? ParticipationState.UNKNOWN) as ParticipationState;
        if (typeof value === "function") return (value as () => never)();
        return value as ParticipationState;
      },
    };
    return verifyBid(bid(), { ...e.deps, participation: lookup });
  };

  it.each([
    ["lowercase", "non_participation_locked"],
    ["leading space", " NON_PARTICIPATION_LOCKED"],
    ["trailing space", "NON_PARTICIPATION_LOCKED "],
    ["empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["number", 0],
    ["object", { state: "NON_PARTICIPATION_LOCKED" }],
  ])("a mis-spelled or non-state answer (%s) is refused, not treated as 'not locked'", (_label, value) => {
    expect(run(value)).toMatchObject(rejected("PARTICIPATION_LOOKUP_INVALID"));
  });

  it("a lookup that throws is refused, not propagated", () => {
    const r = run(() => {
      throw new Error("boom");
    });
    expect(r).toMatchObject(rejected("PARTICIPATION_LOOKUP_INVALID"));
  });

  it("the three real answers keep their meaning: LOCKED blocks, UNKNOWN and PARTICIPATING proceed (owner decision unchanged)", () => {
    expect(run(ParticipationState.NON_PARTICIPATION_LOCKED)).toMatchObject(rejected("NON_PARTICIPATION_LOCK_ACTIVE"));
    expect(run(ParticipationState.UNKNOWN)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
    expect(run(ParticipationState.PARTICIPATING)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
  });

  it("the own lock is read once per verification (a lookup that changes its answer cannot be asked twice)", () => {
    const e = makeEnv();
    let calls = 0;
    const lookup: ParticipationLookup = {
      getState: (f) => {
        if (f !== "fund_a") return f === "fund_b" ? ParticipationState.PARTICIPATING : ParticipationState.NON_PARTICIPATION_LOCKED;
        calls += 1;
        return calls === 1 ? ParticipationState.UNKNOWN : ParticipationState.NON_PARTICIPATION_LOCKED;
      },
    };
    expect(verifyBid(bid(), { ...e.deps, participation: lookup }).reasonCode).toBe("ELIGIBLE");
    expect(calls).toBe(1);
  });

  it("readParticipationState returns only the three states", () => {
    const l = (v: unknown): ParticipationLookup => ({ getState: () => v as ParticipationState });
    expect(readParticipationState(l("UNKNOWN"), "fund_a", "ipo_1")).toBe("UNKNOWN");
    expect(readParticipationState(l("PARTICIPATING"), "fund_a", "ipo_1")).toBe("PARTICIPATING");
    expect(readParticipationState(l("NON_PARTICIPATION_LOCKED"), "fund_a", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    for (const bad of [undefined, null, "", "unknown", 1, {}]) expect(readParticipationState(l(bad), "fund_a", "ipo_1")).toBeUndefined();
    expect(readParticipationState({ getState: () => { throw new Error("x"); } }, "fund_a", "ipo_1")).toBeUndefined();
  });
});

describe("re-review N-1: the request is read once into primitives (verdict and receipt describe the same bid)", () => {
  /** An accessor that answers `first` on the first read and `later` afterwards; `reads()` counts the reads. */
  function flipping<T>(first: T, later: T) {
    let n = 0;
    return { get: () => (++n === 1 ? first : later), reads: () => n };
  }

  it("a fundId that changes after the first read cannot split the verdict from the receipt", () => {
    const { deps } = makeEnv();
    const honest = verifyBid(bid(24_000_000_000n), deps);
    const f = flipping("fund_a", "fund_other");
    const request = { ipoId: "ipo_1", bidAmount: 24_000_000_000n };
    Object.defineProperty(request, "fundId", { enumerable: true, get: f.get });
    const result = verifyBid(request, deps);
    expect(result).toEqual(honest); // same verdict AND the same receipt hash as an honest request for fund_a
    expect(f.reads()).toBe(1);
  });

  it("the same holds for ipoId and bidAmount, each read exactly once", () => {
    const { deps } = makeEnv();
    const ipo = flipping("ipo_1", "ipo_other");
    const amount = flipping(24_000_000_000n, 1n);
    const fund = flipping("fund_a", "fund_x");
    const request = {};
    Object.defineProperty(request, "fundId", { enumerable: true, get: fund.get });
    Object.defineProperty(request, "ipoId", { enumerable: true, get: ipo.get });
    Object.defineProperty(request, "bidAmount", { enumerable: true, get: amount.get });
    expect(verifyBid(request, deps)).toEqual(verifyBid(bid(24_000_000_000n), deps));
    expect([fund.reads(), ipo.reads(), amount.reads()]).toEqual([1, 1, 1]);
  });

  it("an accessor that throws on a LATER read cannot make verifyBid throw", () => {
    const { deps } = makeEnv();
    let n = 0;
    const request = { ipoId: "ipo_1", bidAmount: 24_000_000_000n };
    Object.defineProperty(request, "fundId", {
      enumerable: true,
      get: () => {
        if (++n > 1) throw new Error("boom on later read");
        return "fund_a";
      },
    });
    expect(verifyBid(request, deps)).toMatchObject({ eligible: true }); // one call: exactly one read, no throw
    expect(n).toBe(1);
  });

  it("an accessor that throws on the first read makes the request invalid, with a null/null receipt (no exception)", () => {
    const { deps } = makeEnv();
    const request = { ipoId: "ipo_1", bidAmount: 1n };
    Object.defineProperty(request, "fundId", { enumerable: true, get: () => { throw new Error("boom"); } });
    const r = verifyBid(request, deps);
    expect(r).toMatchObject(rejected("INVALID_BID_REQUEST"));
    expect(r.proofHash).toBe(verifyBid({ fundId: 7, ipoId: 7, bidAmount: 1n }, deps).proofHash); // both receipts carry null ids
  });

  it("a Proxy is read once per field and its key list once; a throwing trap is an invalid request", () => {
    const { deps } = makeEnv();
    const log: string[] = [];
    const target = { fundId: "fund_a", ipoId: "ipo_1", bidAmount: 24_000_000_000n };
    const spy = new Proxy(target, {
      get: (t, k, r) => (log.push(`get:${String(k)}`), Reflect.get(t, k, r) as unknown),
      ownKeys: (t) => (log.push("ownKeys"), Reflect.ownKeys(t)),
    });
    expect(verifyBid(spy, deps)).toMatchObject({ eligible: true });
    expect(log.filter((l) => l.startsWith("get:")).sort()).toEqual(["get:bidAmount", "get:fundId", "get:ipoId"]);
    expect(log.filter((l) => l === "ownKeys")).toHaveLength(1);
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("boom"); } });
    expect(verifyBid(hostile, deps)).toMatchObject(rejected("INVALID_BID_REQUEST"));
  });

  it("the receipt of a valid request is unchanged by the snapshot (pinned hash)", () => {
    const { deps } = makeEnv();
    expect(verifyBid(bid(24_000_000_000n), deps).proofHash).toBe("f072ab07ad9bbb8e475739cd10641e71b914891fab8f0606e52f862312132521");
  });
});

describe("re-review N-2: only `ok === true` from the verifier passes (never a truthy value)", () => {
  const withVerifier = (answer: unknown) => {
    const { deps } = makeEnv();
    return verifyBid(bid(1n), { ...deps, attesterVerifier: { verify: () => answer as never } });
  };

  it("truthy lookalikes, malformed answers and unknown reason codes are SIGNATURE_INVALID", () => {
    for (const answer of [{ ok: "yes" }, { ok: 1 }, { ok: {} }, { ok: [] }, {}, { ok: false }, { ok: false, reasonCode: "WHATEVER" }, { ok: false, reasonCode: "ELIGIBLE" }, undefined, null, "ok", 1, true]) {
      expect(withVerifier(answer), JSON.stringify(answer)).toMatchObject(rejected("SIGNATURE_INVALID"));
    }
  });

  it("a verifier that throws is a failed signature; the known authorization failure keeps its own code; ok === true passes", () => {
    const { deps } = makeEnv();
    const throwing = verifyBid(bid(1n), { ...deps, attesterVerifier: { verify: () => { throw new Error("boom"); } } });
    expect(throwing).toMatchObject(rejected("SIGNATURE_INVALID"));
    expect(withVerifier({ ok: false, reasonCode: "ATTESTER_UNAUTHORIZED" })).toMatchObject(rejected("ATTESTER_UNAUTHORIZED"));
    expect(withVerifier({ ok: true })).toMatchObject({ eligible: true });
  });

  it("`ok` is read once: an accessor that flips after the first read does not pass", () => {
    let n = 0;
    const answer = {};
    Object.defineProperty(answer, "ok", { get: () => ++n === 1 });
    expect(withVerifier(answer)).toMatchObject({ eligible: true });
    expect(n).toBe(1);
    let m = 0;
    const flip = {};
    Object.defineProperty(flip, "ok", { get: () => ++m > 1 });
    expect(withVerifier(flip)).toMatchObject(rejected("SIGNATURE_INVALID"));
    expect(m).toBe(1);
  });

  it("publish applies the same rule", () => {
    for (const answer of [{ ok: "yes" }, { ok: 1 }, undefined, null, {}]) {
      const store = new InMemoryAttestationStore({ verify: () => answer as never });
      expect(store.publish(att()), JSON.stringify(answer)).toEqual({ ok: false, reasonCode: "SIGNATURE_INVALID" });
    }
    expect(new InMemoryAttestationStore({ verify: () => ({ ok: true }) }).publish(att())).toEqual({ ok: true });
  });
});

describe("re-review N-3: a failing dependency or a bad clock is a rejection, never an exception", () => {
  const boom = () => {
    throw new Error("boom");
  };

  it.each([
    ["funds", (d: VerifyBidDeps) => ({ ...d, funds: { getFund: boom } })],
    ["ipos", (d: VerifyBidDeps) => ({ ...d, ipos: { getIpo: boom } })],
    ["attestations", (d: VerifyBidDeps) => ({ ...d, attestations: { getAttestation: boom } })],
    ["revocations", (d: VerifyBidDeps) => ({ ...d, revocations: { isRevoked: boom } })],
    ["nonces", (d: VerifyBidDeps) => ({ ...d, nonces: { boundAttestationId: boom } })],
    ["clock", (d: VerifyBidDeps) => ({ ...d, clock: { now: boom } })],
  ])("%s throws -> DEPENDENCY_ERROR", (_name, mutate) => {
    const { deps } = makeEnv();
    const r = verifyBid(bid(1n), mutate(deps) as VerifyBidDeps);
    expect(r).toMatchObject({ eligible: false, reasonCode: "DEPENDENCY_ERROR" });
    expect(r.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a clock that is not a safe integer is refused (NaN, Infinity, float, string, undefined, bigint) and the time is the placeholder 0", () => {
    const { deps } = makeEnv();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, "1800000000000", undefined, 5n, Number.MAX_SAFE_INTEGER + 1]) {
      const r = verifyBid(bid(1n), { ...deps, clock: { now: () => bad as never } });
      expect(r, String(bad)).toMatchObject({ eligible: false, reasonCode: "DEPENDENCY_ERROR", verifiedAt: 0 });
    }
  });

  it("unusable deps (null, missing members) are a rejection too", () => {
    expect(verifyBid(bid(1n), null as never)).toMatchObject({ eligible: false, reasonCode: "DEPENDENCY_ERROR" });
    const { deps } = makeEnv();
    expect(verifyBid(bid(1n), { ...deps, funds: undefined as never })).toMatchObject({ eligible: false, reasonCode: "DEPENDENCY_ERROR" });
    expect(verifyBid(bid(1n), { ...deps, clock: undefined as never })).toMatchObject({ eligible: false, reasonCode: "DEPENDENCY_ERROR" });
  });

  it("every dependency is read from deps once (a getter that changes later does not matter)", () => {
    const { deps } = makeEnv();
    let n = 0;
    const flipping = { ...deps } as Record<string, unknown>;
    Object.defineProperty(flipping, "funds", { enumerable: true, get: () => (++n === 1 ? deps.funds : { getFund: boom }) });
    expect(verifyBid(bid(24_000_000_000n), flipping as unknown as VerifyBidDeps)).toMatchObject({ eligible: true });
    expect(n).toBe(1);
  });

  it("the exception-free contract also holds for the underlying funds' lookups (they are UNKNOWN, i.e. refused)", () => {
    const { deps } = makeEnv();
    const participation: ParticipationLookup = { getState: (f) => { if (f === "fund_a") return ParticipationState.UNKNOWN; throw new Error("boom"); } };
    expect(verifyBid(bid(1n), { ...deps, participation })).toMatchObject(rejected("UNDERLYING_PARTICIPATION_UNKNOWN"));
  });
});
