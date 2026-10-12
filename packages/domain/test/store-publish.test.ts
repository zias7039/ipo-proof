/**
 * InMemoryAttestationStore.publish gate: signature verification before any state change, and
 * replacement ordering per (fundId, ipoId). Uses the REAL EIP-712 verifier in the store.
 */
import { describe, expect, it } from "vitest";
import { AllowlistAttestationVerifier, InMemoryAttestationStore } from "../src/attestation.js";
import { verifyBid } from "../src/verify.js";
import { HOUR, NOW, makeSignedEnv, signedAtt } from "./fixtures.js";

const bid = (bidAmount: bigint) => ({ fundId: "fund_a", ipoId: "ipo_1", bidAmount });
const rejected = (reasonCode: string) => ({ ok: false, reasonCode });
const OK = { ok: true } as const;

const strictEnv = () => makeSignedEnv({ strictStore: true });

describe("publish verifies the signature before touching any state", () => {
  it("a garbage signature cannot squat a nonce: the genuine attestation can still be published", async () => {
    const { store, deps } = strictEnv();
    const genuine = await signedAtt({ attestationId: "att_genuine", nonce: "n_shared" });
    const squatter = { ...genuine, attestationId: "att_squat", signature: "0x00" };
    expect(store.publish(squatter)).toEqual(rejected("SIGNATURE_INVALID"));
    expect(store.boundAttestationId("attester_1", "n_shared")).toBeUndefined();
    expect(store.getAttestation("fund_a", "ipo_1")).toBeUndefined();
    expect(store.publish(genuine)).toEqual(OK);
    expect(store.boundAttestationId("attester_1", "n_shared")).toBe("att_genuine");
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
  });

  it("a garbage signature cannot overwrite a genuine attestation", async () => {
    const { store, deps } = strictEnv();
    const genuine = await signedAtt();
    expect(store.publish(genuine)).toEqual(OK);
    const overwrite = { ...genuine, attestationId: "att_x", nonce: "n_x", issuedAt: genuine.issuedAt + 1, signature: "" };
    expect(store.publish(overwrite)).toEqual(rejected("SIGNATURE_INVALID"));
    expect(store.getAttestation("fund_a", "ipo_1")).toEqual(genuine);
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
  });

  it("rejects an attesterId signed with another registered attester's key, and leaves no trace", async () => {
    const { store } = strictEnv();
    const wrongKey = await signedAtt({ attesterId: "attester_1", nonce: "n_wk" }, "attester_2");
    expect(store.publish(wrongKey)).toEqual(rejected("SIGNATURE_INVALID"));
    expect(store.boundAttestationId("attester_1", "n_wk")).toBeUndefined();
    expect(store.getAttestation("fund_a", "ipo_1")).toBeUndefined();
  });

  it("rejects an unregistered attester with ATTESTER_UNAUTHORIZED, even if validly self-signed", async () => {
    const { store } = strictEnv();
    expect(store.publish(await signedAtt({ attesterId: "attester_9" }, "attester_9"))).toEqual(rejected("ATTESTER_UNAUTHORIZED"));
    expect(store.getAttestation("fund_a", "ipo_1")).toBeUndefined();
  });

  it("with the allowlist verifier the gate checks authorization only (signatures are NOT checked there)", () => {
    const store = new InMemoryAttestationStore(new AllowlistAttestationVerifier(["attester_1"]));
    expect(store.publish({ ...(signedFixture()), attesterId: "attester_x" })).toEqual(rejected("ATTESTER_UNAUTHORIZED"));
  });
});

function signedFixture() {
  return {
    attestationId: "att_1",
    fundId: "fund_a",
    ipoId: "ipo_1",
    ruleVersion: "DEMO_RULE_V1",
    grossCapacityKrw: 1n,
    underlyingExposures: [],
    issuedAt: 1,
    expiresAt: 2,
    nonce: "n",
    attesterId: "attester_1",
    signature: "placeholder",
  };
}

describe("replacement order per (fundId, ipoId)", () => {
  // att_old: 30bn issued 5h ago (bid of 20bn is ELIGIBLE). att_new: 1bn issued 1h ago (20bn bid exceeds).
  const oldAtt = () => signedAtt({ attestationId: "att_old", nonce: "n_old", issuedAt: NOW - 5 * HOUR, expiresAt: NOW + HOUR });
  const newAtt = () =>
    signedAtt({ attestationId: "att_new", nonce: "n_new", grossCapacityKrw: 1_000_000_000n, issuedAt: NOW - HOUR, expiresAt: NOW + HOUR });

  it("a newer attestation replaces the current one and takes effect", async () => {
    const { store, deps } = strictEnv();
    expect(store.publish(await oldAtt())).toEqual(OK);
    expect(verifyBid(bid(20_000_000_000n), deps).eligible).toBe(true);
    expect(store.publish(await newAtt())).toEqual(OK);
    expect(verifyBid(bid(20_000_000_000n), deps)).toMatchObject({ eligible: false, reasonCode: "BID_EXCEEDS_ADJUSTED_CAPACITY" });
  });

  it("re-publishing the replaced (older, larger) attestation cannot bring it back", async () => {
    const { store, deps } = strictEnv();
    const old = await oldAtt();
    expect(store.publish(old)).toEqual(OK);
    expect(store.publish(await newAtt())).toEqual(OK);
    expect(store.publish(old)).toEqual(rejected("ATTESTATION_SUPERSEDED"));
    expect(verifyBid(bid(20_000_000_000n), deps)).toMatchObject({ eligible: false, reasonCode: "BID_EXCEEDS_ADJUSTED_CAPACITY" });
  });

  it("re-issuing the old content under a fresh id and nonce (older issuedAt) is refused too", async () => {
    const { store, deps } = strictEnv();
    expect(store.publish(await oldAtt())).toEqual(OK);
    expect(store.publish(await newAtt())).toEqual(OK);
    const reissued = await signedAtt({ attestationId: "att_old2", nonce: "n_old2", issuedAt: NOW - 5 * HOUR, expiresAt: NOW + HOUR });
    expect(store.publish(reissued)).toEqual(rejected("NOT_NEWER_THAN_CURRENT"));
    expect(store.boundAttestationId("attester_1", "n_old2")).toBeUndefined();
    expect(store.getAttestation("fund_a", "ipo_1")?.attestationId).toBe("att_new");
    expect(verifyBid(bid(20_000_000_000n), deps).eligible).toBe(false);
  });

  it("an equal issuedAt does not replace the current attestation", async () => {
    const { store } = strictEnv();
    expect(store.publish(await newAtt())).toEqual(OK);
    const sameTime = await signedAtt({ attestationId: "att_tie", nonce: "n_tie", issuedAt: NOW - HOUR, expiresAt: NOW + HOUR });
    expect(store.publish(sameTime)).toEqual(rejected("NOT_NEWER_THAN_CURRENT"));
    expect(store.getAttestation("fund_a", "ipo_1")?.attestationId).toBe("att_new");
  });

  it("nonce bindings of replaced attestations stay in force", async () => {
    const { store } = strictEnv();
    expect(store.publish(await oldAtt())).toEqual(OK);
    expect(store.publish(await newAtt())).toEqual(OK);
    const reusesOldNonce = await signedAtt({ attestationId: "att_newer", nonce: "n_old", issuedAt: NOW - 30 * 60 * 1000, expiresAt: NOW + HOUR });
    expect(store.publish(reusesOldNonce)).toEqual(rejected("NONCE_ALREADY_BOUND"));
  });

  it("a revoked current attestation can be replaced by a genuinely newer one", async () => {
    const { store, deps } = strictEnv();
    expect(store.publish(await oldAtt())).toEqual(OK);
    store.revoke("att_old");
    expect(verifyBid(bid(1n), deps).reasonCode).toBe("ATTESTATION_REVOKED");
    expect(store.publish(await signedAtt({ attestationId: "att_fresh", nonce: "n_fresh" }))).toEqual(OK);
    expect(verifyBid(bid(1n), deps).eligible).toBe(true);
  });

  it("revocation of a replaced attestation does not matter for lookups, and a revoked id cannot return", async () => {
    const { store } = strictEnv();
    const old = await oldAtt();
    expect(store.publish(old)).toEqual(OK);
    expect(store.publish(await newAtt())).toEqual(OK);
    store.revoke("att_old");
    expect(store.publish(old)).toEqual(rejected("ATTESTATION_SUPERSEDED"));
  });
});

describe("attestationId handling", () => {
  it("re-publishing the identical current attestation is an idempotent success", async () => {
    const { store } = strictEnv();
    const a = await signedAtt();
    expect(store.publish(a)).toEqual(OK);
    expect(store.publish({ ...a })).toEqual(OK);
    expect(store.getAttestation("fund_a", "ipo_1")).toEqual(a);
  });

  it("the same attestationId with different (validly signed) content is refused", async () => {
    const { store } = strictEnv();
    expect(store.publish(await signedAtt())).toEqual(OK);
    const changed = await signedAtt({ grossCapacityKrw: 99n, issuedAt: NOW - 30 * 60 * 1000 });
    expect(store.publish(changed)).toEqual(rejected("ATTESTATION_ID_CONFLICT"));
    expect(store.getAttestation("fund_a", "ipo_1")?.grossCapacityKrw).toBe(30_000_000_000n);
  });

  it("a nonce reused by a different attestationId is refused and leaves no state", async () => {
    const { store } = strictEnv();
    expect(store.publish(await signedAtt())).toEqual(OK);
    const other = await signedAtt({ attestationId: "att_2", fundId: "fund_b" });
    expect(store.publish(other)).toEqual(rejected("NONCE_ALREADY_BOUND"));
    expect(store.getAttestation("fund_b", "ipo_1")).toBeUndefined();
  });
});
