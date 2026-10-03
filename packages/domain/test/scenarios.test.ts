/**
 * Scenario suite A~E (issue #9), mapped 1:1 to docs/scenarios.md, evaluated at verifyBid level
 * against the ACTIVE rule DEMO_RULE_V2. Only pure domain functions are used (no I/O); all ids and
 * amounts are synthetic.
 *
 * OUT OF SCOPE here (needs the ledger / bid-intake structures that do not exist yet; tracked in
 * docs/design): bid intake, the closing cut-off, finalization, bid withdrawal, ledger events.
 * Existing per-module tests are kept as they are; this file adds a scenario-level regression net
 * and fills the gaps listed in docs/scenarios.md (clamp through verifyBid, check-order combinations).
 */
import { describe, expect, it } from "vitest";
import { AllowlistAttestationVerifier } from "../src/attestation.js";
import { DEMO_RULE_V1, DEMO_RULE_V2 } from "../src/rules.js";
import { PROOF_HASH_KIND, verifyBid } from "../src/verify.js";
import { HOUR, NOW, att, makeEnv, makeSignedEnv, mustPublish, signedAtt } from "./fixtures.js";
import type { Env } from "./fixtures.js";

const V2 = "DEMO_RULE_V2";
const BN = 1_000_000_000n;
const bid = (bidAmount: bigint, fundId = "fund_a", ipoId = "ipo_1") => ({ fundId, ipoId, bidAmount });
const rejected = (reasonCode: string) => ({ eligible: false, reasonCode });
const eligible = { eligible: true, reasonCode: "ELIGIBLE", flags: [] };

/** Common precondition under DEMO_RULE_V2: gross 30bn, fund_b 6bn PARTICIPATING, fund_c 4bn LOCKED => adjusted capacity 24bn. */
const v2att = (o: Parameters<typeof att>[0] = {}) => att({ ruleVersion: V2, ...o });
function world(o: { attestation?: ReturnType<typeof att>; recordStates?: boolean } = {}): Env {
  return makeEnv({ attestation: o.attestation ?? v2att(), recordStates: o.recordStates ?? true, rule: DEMO_RULE_V2 });
}

describe("Scenario A: normal participation passes", () => {
  it("20bn passes; boundary 24bn passes; 24bn + 1 KRW is rejected", () => {
    const { deps } = world();
    expect(verifyBid(bid(20n * BN), deps)).toMatchObject({ ...eligible, ruleVersion: V2 });
    expect(verifyBid(bid(24n * BN), deps)).toMatchObject(eligible);
    expect(verifyBid(bid(24n * BN + 1n), deps)).toMatchObject(rejected("BID_EXCEEDS_ADJUSTED_CAPACITY"));
  });

  it("the smallest valid bid (1 KRW) passes", () => {
    expect(verifyBid(bid(1n), world().deps)).toMatchObject(eligible);
  });

  it("proofHash is deterministic, labelled as NOT a ZK proof, and does not depend on the bid amount", () => {
    const { deps } = world();
    const a = verifyBid(bid(20n * BN), deps);
    const b = verifyBid(bid(20n * BN), deps);
    const smaller = verifyBid(bid(10n * BN), deps);
    expect(a.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.proofHash).toBe(b.proofHash);
    expect(a.proofHash).toBe(smaller.proofHash); // same outcome, amount is not in the receipt
    expect(a.proofHashKind).toBe(PROOF_HASH_KIND);
    expect(PROOF_HASH_KIND).toContain("NOT_A_ZK_PROOF");
    // a different outcome gives a different receipt
    expect(verifyBid(bid(25n * BN), deps).proofHash).not.toBe(a.proofHash);
  });

  it("verifyBid does not record anything: the ledger is unchanged after a passing bid", () => {
    const { deps, ledger } = world();
    const before = ledger.history().length;
    expect(verifyBid(bid(20n * BN), deps).eligible).toBe(true);
    expect(ledger.history().length).toBe(before);
    expect(ledger.getState("fund_a", "ipo_1")).toBe("UNKNOWN"); // recording the bidder is bid intake: out of scope
  });
});

describe("Scenario B: bid above the payment capacity", () => {
  it("250억 (25bn) is rejected against the 24bn adjusted capacity", () => {
    expect(verifyBid(bid(25n * BN), world().deps)).toMatchObject({ ...rejected("BID_EXCEEDS_ADJUSTED_CAPACITY"), flags: [] });
  });

  it("deduction larger than gross: capacity clamps to 0, the flag reaches BidVerification.flags, every positive bid is rejected", () => {
    const small = v2att({
      grossCapacityKrw: 5n,
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 9n }, // PARTICIPATING => deducted
        { fundId: "fund_c", exposureKrw: 4n }, // LOCKED => exempt
      ],
    });
    const { deps } = world({ attestation: small });
    for (const amount of [1n, 5n, 6n, 100n * BN]) {
      expect(verifyBid(bid(amount), deps), String(amount)).toMatchObject({
        ...rejected("BID_EXCEEDS_ADJUSTED_CAPACITY"),
        flags: ["DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO"],
      });
    }
  });

  it("the bidder cannot supply capacity: extra or capacity-like fields are rejected, not read", () => {
    const { deps } = world();
    for (const extra of ["capacityKrw", "grossCapacityKrw", "adjustedCapacityKrw"]) {
      expect(verifyBid({ ...bid(1n), [extra]: 999n * BN }, deps), extra).toMatchObject(rejected("INVALID_BID_REQUEST"));
    }
  });

  it("malformed amounts are rejected (number, negative, zero, decimal string)", () => {
    const { deps } = world();
    for (const amount of [20, -1n, 0n, "1.5", "20000000000"]) {
      expect(verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount: amount }, deps).eligible, String(amount)).toBe(false);
    }
  });
});

describe("Scenario C: UNKNOWN underlying funds are rejected (policy of issue #10), DEMO_RULE_V2", () => {
  const unknownWorld = (b: bigint, c: bigint) =>
    world({
      attestation: v2att({
        underlyingExposures: [
          { fundId: "fund_b", exposureKrw: b },
          { fundId: "fund_c", exposureKrw: c },
        ],
      }),
      recordStates: false,
    });

  it("all underlying UNKNOWN: any amount (including 1 and 24bn) is rejected, never deducted or exempted", () => {
    const { deps } = unknownWorld(6n * BN, 4n * BN);
    for (const amount of [1n, 20n * BN, 24n * BN, 30n * BN]) {
      expect(verifyBid(bid(amount), deps), String(amount)).toMatchObject({
        ...rejected("UNDERLYING_PARTICIPATION_UNKNOWN"),
        flags: [],
      });
    }
  });

  it("only one UNKNOWN among known funds is still rejected", () => {
    const { deps, ledger } = unknownWorld(6n * BN, 4n * BN);
    ledger.requestNonParticipationLock("fund_c", "ipo_1"); // fund_b stays UNKNOWN
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("UNDERLYING_PARTICIPATION_UNKNOWN"));
  });

  it("once the states are recorded the same bid is evaluated normally (240억 passes)", () => {
    const { deps, ledger } = unknownWorld(6n * BN, 4n * BN);
    expect(verifyBid(bid(24n * BN), deps).eligible).toBe(false);
    ledger.requestParticipation("fund_b", "ipo_1");
    ledger.requestNonParticipationLock("fund_c", "ipo_1");
    expect(verifyBid(bid(24n * BN), deps)).toMatchObject(eligible);
  });

  it("the bidding fund's own UNKNOWN is allowed (not recorded yet)", () => {
    expect(verifyBid(bid(1n), world().deps).eligible).toBe(true);
    expect(world().ledger.getState("fund_a", "ipo_1")).toBe("UNKNOWN");
  });

  it("V2 variant: a 0 KRW UNKNOWN fund is a data error for any amount (S-16a)", () => {
    const { deps } = unknownWorld(0n, 4n * BN);
    for (const amount of [1n, 24n * BN]) {
      expect(verifyBid(bid(amount), deps), String(amount)).toMatchObject({
        ...rejected("UNDERLYING_ZERO_EXPOSURE_UNKNOWN"),
        flags: [],
      });
    }
  });

  it("V2 variant: the data-error code wins over the generic UNKNOWN code regardless of exposure order (S-16b)", () => {
    expect(verifyBid(bid(1n), unknownWorld(0n, 4n * BN).deps).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
    expect(verifyBid(bid(1n), unknownWorld(4n * BN, 0n).deps).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
  });

  it("V2 variant: recording the 0 KRW fund before judging removes the data error (S-16c); 0 KRW PARTICIPATING/LOCKED is normal", () => {
    const { deps, ledger } = unknownWorld(0n, 4n * BN);
    ledger.requestNonParticipationLock("fund_c", "ipo_1");
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("UNDERLYING_ZERO_EXPOSURE_UNKNOWN");
    ledger.requestParticipation("fund_b", "ipo_1"); // 0 KRW participating: deduction 0
    expect(verifyBid(bid(30n * BN), deps)).toMatchObject(eligible); // 30bn gross - 0 (fund_c is exempt)
    expect(verifyBid(bid(30n * BN + 1n), deps).reasonCode).toBe("BID_EXCEEDS_ADJUSTED_CAPACITY");
  });

  it("the frozen DEMO_RULE_V1 gives the generic code for the same 0 KRW UNKNOWN data (rule id => same meaning)", () => {
    const a = att({ underlyingExposures: [{ fundId: "fund_b", exposureKrw: 0n }, { fundId: "fund_c", exposureKrw: 4n * BN }] });
    const { deps } = makeEnv({ attestation: a, recordStates: false, rule: DEMO_RULE_V1 });
    expect(verifyBid(bid(1n), deps)).toMatchObject({ ...rejected("UNDERLYING_PARTICIPATION_UNKNOWN"), ruleVersion: "DEMO_RULE_V1" });
  });

  it("the receipt shows the reason code but no amount and no underlying fund id", () => {
    const r = verifyBid(bid(24n * BN), unknownWorld(0n, 4n * BN).deps);
    const text = JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    for (const secret of ["24000000000", "30000000000", "4000000000", "fund_b", "fund_c"]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe("Scenario D: state conflicts and exposure omission/duplication", () => {
  it("(1) participation requested for a LOCKED fund is rejected and the ledger is unchanged", () => {
    const { ledger } = world();
    const before = ledger.history().length;
    expect(ledger.requestParticipation("fund_c", "ipo_1")).toMatchObject({ ok: false, reasonCode: "NON_PARTICIPATION_LOCK_ACTIVE" });
    expect(ledger.getState("fund_c", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    expect(ledger.history().length).toBe(before);
  });

  it("(2) LOCKED requested for a PARTICIPATING fund is rejected and PARTICIPATING stays", () => {
    const { ledger } = world();
    expect(ledger.requestNonParticipationLock("fund_b", "ipo_1")).toMatchObject({ ok: false, reasonCode: "PARTICIPATION_ALREADY_RECORDED" });
    expect(ledger.getState("fund_b", "ipo_1")).toBe("PARTICIPATING");
  });

  it("(3) a LOCKED fund cannot bid, even for 1 KRW", () => {
    const { deps, ledger } = world();
    ledger.requestNonParticipationLock("fund_a", "ipo_1");
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("NON_PARTICIPATION_LOCK_ACTIVE"));
  });

  it("(4) omitting fund_b's exposure is rejected even for a bid that would otherwise be too big", () => {
    const omitted = v2att({ underlyingExposures: [{ fundId: "fund_c", exposureKrw: 4n * BN }] });
    const { deps } = world({ attestation: omitted });
    for (const amount of [1n, 25n * BN]) {
      expect(verifyBid(bid(amount), deps), String(amount)).toMatchObject(rejected("UNDERLYING_EXPOSURE_OMITTED"));
    }
  });

  it("(5) a fund outside the registry's list, and a duplicated exposure, are rejected", () => {
    const extra = v2att({
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 6n * BN },
        { fundId: "fund_c", exposureKrw: 4n * BN },
        { fundId: "fund_z", exposureKrw: 1n },
      ],
    });
    expect(verifyBid(bid(1n), world({ attestation: extra }).deps)).toMatchObject(rejected("UNDERLYING_EXPOSURE_NOT_IN_REGISTRY"));
    const dup = v2att({
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 6n * BN },
        { fundId: "fund_b", exposureKrw: 6n * BN },
        { fundId: "fund_c", exposureKrw: 4n * BN },
      ],
    });
    expect(verifyBid(bid(1n), world({ attestation: dup }).deps)).toMatchObject(rejected("DUPLICATE_UNDERLYING_EXPOSURE"));
  });

  it("participation recorded for a different IPO does not count (a deduction only for the same IPO)", () => {
    const { deps, ledger } = world({ recordStates: false });
    ledger.requestParticipation("fund_b", "ipo_other");
    ledger.requestNonParticipationLock("fund_c", "ipo_other");
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("UNDERLYING_PARTICIPATION_UNKNOWN"));
  });

  it("a state-changing request cannot be undone: UNKNOWN is not a valid target, repeats are rejected", () => {
    const { ledger } = world();
    expect(ledger.apply("fund_b", "ipo_1", "UNKNOWN")).toMatchObject({ ok: false, reasonCode: "INVALID_TARGET_STATE" });
    expect(ledger.requestParticipation("fund_b", "ipo_1")).toMatchObject({ ok: false });
    expect(ledger.getState("fund_b", "ipo_1")).toBe("PARTICIPATING");
  });
});

describe("Scenario E: attestation invalid / reused", () => {
  it("revoked -> ATTESTATION_REVOKED", () => {
    const { deps, store } = world();
    store.revoke("att_1");
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("ATTESTATION_REVOKED"));
  });

  it("expiry boundary is exclusive", () => {
    const { deps, clock } = world();
    clock.t = NOW + HOUR - 1;
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
    clock.t = NOW + HOUR;
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("ATTESTATION_EXPIRED"));
  });

  it("older than the max age but not expired -> ATTESTATION_STALE (boundary exactly at max age is accepted)", () => {
    const max = DEMO_RULE_V2.maxAttestationAgeMs;
    const atBoundary = world({ attestation: v2att({ issuedAt: NOW - max, expiresAt: NOW + HOUR }) });
    expect(verifyBid(bid(1n), atBoundary.deps).eligible).toBe(true);
    const stale = world({ attestation: v2att({ issuedAt: NOW - max - 1, expiresAt: NOW + HOUR }) });
    expect(verifyBid(bid(1n), stale.deps)).toMatchObject(rejected("ATTESTATION_STALE"));
  });

  it("issued in the future -> ATTESTATION_NOT_YET_VALID", () => {
    const { deps } = world({ attestation: v2att({ issuedAt: NOW + 1, expiresAt: NOW + HOUR }) });
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("ATTESTATION_NOT_YET_VALID"));
  });

  it("another attestation id reusing the same attester+nonce -> ATTESTATION_NONCE_REPLAY; re-verifying the same one is fine", () => {
    const { deps, store } = world();
    expect(store.publish(v2att({ attestationId: "att_replay", nonce: "nonce_1" }))).toEqual({ ok: false, reasonCode: "NONCE_ALREADY_BOUND" });
    const replay = v2att({ attestationId: "att_replay", nonce: "nonce_1" });
    expect(verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => replay } })).toMatchObject(rejected("ATTESTATION_NONCE_REPLAY"));
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
    expect(verifyBid(bid(2n), deps).eligible).toBe(true);
  });

  it("rule version mismatch: a V1 attestation under active V2, and a V2 attestation under active V1", () => {
    expect(verifyBid(bid(1n), world({ attestation: att() }).deps)).toMatchObject(rejected("RULE_VERSION_MISMATCH"));
    const v1world = makeEnv({ attestation: v2att(), rule: DEMO_RULE_V1 });
    expect(verifyBid(bid(1n), v1world.deps)).toMatchObject(rejected("RULE_VERSION_MISMATCH"));
  });

  it("unauthorized attester -> ATTESTER_UNAUTHORIZED", () => {
    const { deps } = world({ attestation: v2att({ attesterId: "attester_evil" }) });
    expect(verifyBid(bid(1n), { ...deps, attesterVerifier: new AllowlistAttestationVerifier(["attester_1"]) })).toMatchObject(
      rejected("ATTESTER_UNAUTHORIZED"),
    );
  });

  it("outside the subscription window -> IPO_NOT_OPEN (before open and at/after close)", () => {
    const { deps, clock } = world();
    clock.t = NOW - 24 * HOUR - 1;
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("IPO_NOT_OPEN"));
    clock.t = NOW + 24 * HOUR;
    expect(verifyBid(bid(1n), deps)).toMatchObject(rejected("IPO_NOT_OPEN"));
  });

  it("no attestation, or one for another subject -> rejected", () => {
    expect(verifyBid(bid(1n), makeEnv({ attestation: null, rule: DEMO_RULE_V2 }).deps)).toMatchObject(rejected("ATTESTATION_NOT_FOUND"));
    const { deps } = world();
    const other = v2att({ fundId: "fund_x" });
    expect(verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => other } })).toMatchObject(rejected("ATTESTATION_SUBJECT_MISMATCH"));
  });

  describe("precedence when several reasons apply (documented check order of verifyBid)", () => {
    it("IPO window beats everything else", () => {
      const { deps, store, clock } = world();
      store.revoke("att_1");
      clock.t = NOW + 24 * HOUR;
      expect(verifyBid(bid(1n), deps).reasonCode).toBe("IPO_NOT_OPEN");
    });

    it("own LOCK beats attestation problems", () => {
      const { deps, store, ledger } = world();
      store.revoke("att_1");
      ledger.requestNonParticipationLock("fund_a", "ipo_1");
      expect(verifyBid(bid(1n), deps).reasonCode).toBe("NON_PARTICIPATION_LOCK_ACTIVE");
    });

    it("rule version mismatch beats unauthorized attester and revocation", () => {
      const { deps, store } = world({ attestation: att({ attesterId: "attester_evil" }) }); // V1 attestation, active V2
      store.revoke("att_1");
      expect(verifyBid(bid(1n), deps).reasonCode).toBe("RULE_VERSION_MISMATCH");
    });

    it("unauthorized attester beats revoked", () => {
      const { deps, store } = world({ attestation: v2att({ attesterId: "attester_evil" }) });
      store.revoke("att_1");
      expect(verifyBid(bid(1n), deps).reasonCode).toBe("ATTESTER_UNAUTHORIZED");
    });

    it("revoked beats expired, expired beats nonce replay, replay beats exposure omission", () => {
      const e = world();
      e.store.revoke("att_1");
      e.clock.t = NOW + HOUR;
      expect(verifyBid(bid(1n), e.deps).reasonCode).toBe("ATTESTATION_REVOKED");

      const e2 = world();
      e2.clock.t = NOW + HOUR;
      const replayExpired = v2att({ attestationId: "att_replay", nonce: "nonce_1" });
      expect(verifyBid(bid(1n), { ...e2.deps, attestations: { getAttestation: () => replayExpired } }).reasonCode).toBe("ATTESTATION_EXPIRED");

      const e3 = world();
      const replayOmitting = v2att({ attestationId: "att_replay", nonce: "nonce_1", underlyingExposures: [] });
      expect(verifyBid(bid(1n), { ...e3.deps, attestations: { getAttestation: () => replayOmitting } }).reasonCode).toBe("ATTESTATION_NONCE_REPLAY");
    });

    it("attestation-level problems come before UNKNOWN handling; exposure completeness comes before UNKNOWN too", () => {
      const e = world({ recordStates: false });
      e.store.revoke("att_1");
      expect(verifyBid(bid(1n), e.deps).reasonCode).toBe("ATTESTATION_REVOKED");
      const omitted = world({ attestation: v2att({ underlyingExposures: [{ fundId: "fund_c", exposureKrw: 0n }] }), recordStates: false });
      expect(verifyBid(bid(1n), omitted.deps).reasonCode).toBe("UNDERLYING_EXPOSURE_OMITTED");
    });
  });

  describe("signature forgery with the EIP-712 verifier injected (DEMO_RULE_V2)", () => {
    const signedWorld = async (o: Parameters<typeof signedAtt>[0] = {}, signer?: string): Promise<Env> => {
      const e = makeSignedEnv({ rule: DEMO_RULE_V2 });
      mustPublish(e.store, signer === undefined ? await signedAtt({ ruleVersion: V2, ...o }) : await signedAtt({ ruleVersion: V2, ...o }, signer));
      return e;
    };

    it("a genuinely signed attestation passes at the 24bn boundary", async () => {
      const { deps } = await signedWorld();
      expect(verifyBid(bid(24n * BN), deps)).toMatchObject(eligible);
      expect(verifyBid(bid(24n * BN + 1n), deps).reasonCode).toBe("BID_EXCEEDS_ADJUSTED_CAPACITY");
    });

    it("tampering after signing (inflated gross) -> SIGNATURE_INVALID", async () => {
      const e = makeSignedEnv({ rule: DEMO_RULE_V2 });
      mustPublish(e.store, { ...(await signedAtt({ ruleVersion: V2 })), grossCapacityKrw: 300n * BN });
      expect(verifyBid(bid(100n * BN), e.deps)).toMatchObject(rejected("SIGNATURE_INVALID"));
    });

    it("placeholder signature and a key that is not the attester's -> SIGNATURE_INVALID", async () => {
      const e = makeSignedEnv({ rule: DEMO_RULE_V2 });
      mustPublish(e.store, { ...(await signedAtt({ ruleVersion: V2 })), signature: "unverified_demo_signature" });
      expect(verifyBid(bid(1n), e.deps)).toMatchObject(rejected("SIGNATURE_INVALID"));
      expect(verifyBid(bid(1n), (await signedWorld({}, "attester_2")).deps)).toMatchObject(rejected("SIGNATURE_INVALID"));
    });

    it("a signature is provenance only: a genuinely signed 0 KRW UNKNOWN still gets the data-error rejection", async () => {
      const e = makeSignedEnv({ rule: DEMO_RULE_V2, recordStates: false });
      mustPublish(
        e.store,
        await signedAtt({
          ruleVersion: V2,
          underlyingExposures: [{ fundId: "fund_b", exposureKrw: 0n }, { fundId: "fund_c", exposureKrw: 4n * BN }],
        }),
      );
      expect(verifyBid(bid(1n), e.deps)).toMatchObject(rejected("UNDERLYING_ZERO_EXPOSURE_UNKNOWN"));
    });
  });
});
