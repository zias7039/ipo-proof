/**
 * Integration: verifyBid with Eip712AttestationVerifier injected. The allowlist-based tests in
 * verify.test.ts / demo.test.ts are unchanged and still run with AllowlistAttestationVerifier.
 */
import { describe, expect, it } from "vitest";
import { verifyBid } from "../src/verify.js";
import type { CapacityAttestation } from "../src/model.js";
import { HOUR, NOW, makeSignedEnv, signedAtt } from "./fixtures.js";
import { TEST_DOMAIN, signAttestation, toHighS } from "./signing.js";

const bid = (bidAmount: bigint, fundId = "fund_a") => ({ fundId, ipoId: "ipo_1", bidAmount });
const fail = (reasonCode: string) => ({ eligible: false, reasonCode });

async function env(overrides: Partial<CapacityAttestation> = {}, signer?: string) {
  const e = makeSignedEnv();
  e.store.publish(signer === undefined ? await signedAtt(overrides) : await signedAtt(overrides, signer));
  return e;
}

describe("verifyBid + EIP-712: genuine attestation", () => {
  it("demo scenario: 20bn passes, 25bn is rejected, boundary is exactly 24bn", async () => {
    const { deps } = await env();
    expect(verifyBid(bid(20_000_000_000n), deps)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
    expect(verifyBid(bid(24_000_000_000n), deps)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
    expect(verifyBid(bid(24_000_000_001n), deps)).toMatchObject(fail("BID_EXCEEDS_ADJUSTED_CAPACITY"));
    expect(verifyBid(bid(25_000_000_000n), deps)).toMatchObject(fail("BID_EXCEEDS_ADJUSTED_CAPACITY"));
  });

  it("an attestation with exposures in a different order verifies identically", async () => {
    const reorder = await signedAtt();
    const e = makeSignedEnv();
    e.store.publish({ ...reorder, underlyingExposures: [...reorder.underlyingExposures].reverse() });
    expect(verifyBid(bid(24_000_000_000n), e.deps)).toMatchObject({ eligible: true });
  });
});

describe("verifyBid + EIP-712: forgery and tampering", () => {
  it("no attestation signature at all / placeholder signature -> SIGNATURE_INVALID", async () => {
    for (const signature of ["", "unverified_demo_signature"]) {
      const e = makeSignedEnv();
      e.store.publish({ ...(await signedAtt()), signature });
      expect(verifyBid(bid(1n), e.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
    }
  });

  it("attestation signed by an unregistered key -> SIGNATURE_INVALID", async () => {
    const { deps } = await env({}, "not_a_registered_key");
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("attester_1's attestation signed with attester_2's key -> SIGNATURE_INVALID", async () => {
    const { deps } = await env({ attesterId: "attester_1" }, "attester_2");
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("an unregistered attesterId -> ATTESTER_UNAUTHORIZED even with a valid signature by its own key", async () => {
    const { deps } = await env({ attesterId: "attester_9" }, "attester_9");
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("ATTESTER_UNAUTHORIZED"));
  });

  it("inflating grossCapacityKrw after signing cannot raise a bid's ceiling", async () => {
    const e = makeSignedEnv();
    e.store.publish({ ...(await signedAtt()), grossCapacityKrw: 300_000_000_000n });
    expect(verifyBid(bid(100_000_000_000n), e.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("lowering a participating underlying exposure after signing -> SIGNATURE_INVALID", async () => {
    const signed = await signedAtt();
    const e = makeSignedEnv();
    e.store.publish({
      ...signed,
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 0n },
        { fundId: "fund_c", exposureKrw: 4_000_000_000n },
      ],
    });
    expect(verifyBid(bid(30_000_000_000n), e.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("dropping an underlying exposure after signing reports SIGNATURE_INVALID before completeness", async () => {
    const signed = await signedAtt();
    const e = makeSignedEnv();
    e.store.publish({ ...signed, underlyingExposures: signed.underlyingExposures.slice(1) });
    expect(verifyBid(bid(1n), e.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("extending expiresAt after signing -> SIGNATURE_INVALID", async () => {
    const signed = await signedAtt({ expiresAt: NOW - 1 });
    const e = makeSignedEnv();
    e.store.publish({ ...signed, expiresAt: NOW + HOUR });
    expect(verifyBid(bid(1n), e.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("swapping nonce, fundId or ipoId after signing -> SIGNATURE_INVALID (fundId/ipoId stay consistent with the request)", async () => {
    const signed = await signedAtt();
    const e1 = makeSignedEnv();
    e1.store.publish({ ...signed, nonce: "nonce_other" });
    expect(verifyBid(bid(1n), e1.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
    // Re-targeting a signature made for fund_a/ipo_1 at another subject. fund_b is a registered fund.
    const e2 = makeSignedEnv();
    e2.store.publish({ ...signed, fundId: "fund_b" });
    expect(verifyBid({ fundId: "fund_b", ipoId: "ipo_1", bidAmount: 1n }, e2.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("malleated (high-s) copy of a valid signature -> SIGNATURE_INVALID", async () => {
    const signed = await signedAtt();
    const e = makeSignedEnv();
    e.store.publish({ ...signed, signature: toHighS(signed.signature) });
    expect(verifyBid(bid(1n), e.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("an attestation signed for another chain or verifying contract cannot be reused", async () => {
    for (const change of [{ chainId: 1n }, { verifyingContract: "0x00000000000000000000000000000000000b0b01" }]) {
      const e = makeSignedEnv();
      e.store.publish(await signAttestation((await signedAtt()), "attester_1", { ...TEST_DOMAIN, ...change }));
      expect(verifyBid(bid(1n), e.deps)).toMatchObject(fail("SIGNATURE_INVALID"));
    }
  });
});

describe("verifyBid + EIP-712: validly signed attestations are still subject to time, revocation and replay checks", () => {
  it("expired (signed correctly) -> ATTESTATION_EXPIRED", async () => {
    const { deps, clock } = await env();
    clock.t = NOW + HOUR; // expiresAt is exclusive
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("ATTESTATION_EXPIRED"));
  });

  it("not yet valid (signed correctly) -> ATTESTATION_NOT_YET_VALID", async () => {
    const { deps, clock } = await env({ issuedAt: NOW + HOUR, expiresAt: NOW + 2 * HOUR });
    expect(clock.t).toBe(NOW);
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("ATTESTATION_NOT_YET_VALID"));
  });

  it("stale (older than the rule's max age, but unexpired) -> ATTESTATION_STALE", async () => {
    const { deps } = await env({ issuedAt: NOW - 25 * HOUR, expiresAt: NOW + HOUR });
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("ATTESTATION_STALE"));
  });

  it("revoked (signed correctly) -> ATTESTATION_REVOKED, and revocation is not undone by the signature", async () => {
    const { deps, store } = await env();
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
    store.revoke("att_1");
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("ATTESTATION_REVOKED"));
  });

  it("nonce replay: a second, correctly signed attestation id reusing the nonce -> ATTESTATION_NONCE_REPLAY", async () => {
    const { deps, store } = await env(); // att_1 binds attester_1/nonce_1
    const replay = await signedAtt({ attestationId: "att_replay", nonce: "nonce_1" });
    expect(store.publish({ ...replay, fundId: "fund_z" })).toBe(false); // the store refuses to bind it
    const r = verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => replay } });
    expect(r).toMatchObject(fail("ATTESTATION_NONCE_REPLAY"));
  });

  it("nonce replay by copying a valid signature to another attestationId is a signature failure first", async () => {
    const { deps } = await env();
    const original = await signedAtt();
    const copy = { ...original, attestationId: "att_replay" };
    expect(verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => copy } })).toMatchObject(fail("SIGNATURE_INVALID"));
  });

  it("re-verifying the same signed attestation for many bids is not a replay", async () => {
    const { deps } = await env();
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
    expect(verifyBid(bid(2n), deps).eligible).toBe(true);
  });
});

describe("verifyBid + EIP-712: a valid signature does not bypass the remaining checks", () => {
  it("rule version mismatch -> RULE_VERSION_MISMATCH", async () => {
    const { deps } = await env({ ruleVersion: "DEMO_RULE_V0" });
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("RULE_VERSION_MISMATCH"));
  });

  it("subject mismatch (attestation for another fund returned for the bid) -> ATTESTATION_SUBJECT_MISMATCH", async () => {
    const { deps } = await env();
    const other = await signedAtt({ fundId: "fund_b" });
    expect(verifyBid(bid(1n), { ...deps, attestations: { getAttestation: () => other } })).toMatchObject(
      fail("ATTESTATION_SUBJECT_MISMATCH"),
    );
  });

  it("omitted underlying fund (signed that way by the attester) -> UNDERLYING_EXPOSURE_OMITTED", async () => {
    const { deps } = await env({ underlyingExposures: [{ fundId: "fund_c", exposureKrw: 4_000_000_000n }] });
    expect(verifyBid(bid(25_000_000_000n), deps)).toMatchObject(fail("UNDERLYING_EXPOSURE_OMITTED"));
  });

  it("underlying fund not in registry -> UNDERLYING_EXPOSURE_NOT_IN_REGISTRY", async () => {
    const { deps } = await env({
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 6_000_000_000n },
        { fundId: "fund_c", exposureKrw: 4_000_000_000n },
        { fundId: "fund_x", exposureKrw: 1n },
      ],
    });
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("UNDERLYING_EXPOSURE_NOT_IN_REGISTRY"));
  });

  it("duplicate exposure entries are signed as given and rejected by verifyBid -> DUPLICATE_UNDERLYING_EXPOSURE", async () => {
    const { deps } = await env({
      underlyingExposures: [
        { fundId: "fund_b", exposureKrw: 6_000_000_000n },
        { fundId: "fund_b", exposureKrw: 6_000_000_000n },
        { fundId: "fund_c", exposureKrw: 4_000_000_000n },
      ],
    });
    expect(verifyBid(bid(1n), deps)).toMatchObject(fail("DUPLICATE_UNDERLYING_EXPOSURE"));
  });

  it("malformed attestation (negative exposure) is rejected before signature handling -> ATTESTATION_MALFORMED", async () => {
    const e = makeSignedEnv();
    e.store.publish({ ...(await signedAtt()), underlyingExposures: [{ fundId: "fund_b", exposureKrw: -1n }] });
    expect(verifyBid(bid(1n), e.deps)).toMatchObject(fail("ATTESTATION_MALFORMED"));
  });

  it("UNKNOWN underlying participation is still deducted conservatively and flagged", async () => {
    const e = makeSignedEnv({ recordStates: false }); // fund_b and fund_c are both UNKNOWN
    e.store.publish(await signedAtt());
    const r = verifyBid(bid(20_000_000_001n), e.deps); // gross 30bn - (6bn + 4bn) = 20bn
    expect(r).toMatchObject(fail("BID_EXCEEDS_ADJUSTED_CAPACITY"));
    expect(r.flags).toContain("UNKNOWN_UNDERLYING_DEDUCTED");
    expect(verifyBid(bid(20_000_000_000n), e.deps).eligible).toBe(true);
  });

  it("the request still cannot carry a capacity value", async () => {
    const { deps } = await env();
    expect(verifyBid({ ...bid(1n), grossCapacityKrw: 10n ** 12n }, deps)).toMatchObject(fail("INVALID_BID_REQUEST"));
  });

  it("verifyBid does not mutate the store or attestation (pure)", async () => {
    const { deps, store } = await env();
    const before = JSON.stringify(store.getAttestation("fund_a", "ipo_1"), (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    verifyBid(bid(1n), deps);
    const after = JSON.stringify(store.getAttestation("fund_a", "ipo_1"), (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    expect(after).toBe(before);
    expect(store.isRevoked("att_1")).toBe(false);
  });
});
