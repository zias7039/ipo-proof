import { describe, expect, it } from "vitest";
import { AllowlistAttestationVerifier, InMemoryAttestationStore } from "../src/attestation.js";
import { att } from "./fixtures.js";

const allowlist = new AllowlistAttestationVerifier(["attester_1", "attester_2"]);

describe("AllowlistAttestationVerifier", () => {
  it("accepts allowlisted attesters and rejects others (signature NOT checked)", () => {
    const v = new AllowlistAttestationVerifier(["attester_1"]);
    expect(v.verify(att())).toEqual({ ok: true });
    expect(v.verify(att({ attesterId: "attester_x" }))).toEqual({ ok: false, reasonCode: "ATTESTER_UNAUTHORIZED" });
    // A garbage signature is still accepted: signature verification is NOT IMPLEMENTED.
    expect(v.verify(att({ signature: "not-a-real-signature" }))).toEqual({ ok: true });
  });
});

describe("InMemoryAttestationStore", () => {
  it("binds a nonce to the first attestation and refuses reuse by another", () => {
    const s = new InMemoryAttestationStore(allowlist);
    expect(s.publish(att({ attestationId: "att_1", nonce: "n1" }))).toEqual({ ok: true });
    expect(s.publish(att({ attestationId: "att_2", fundId: "fund_z", nonce: "n1" }))).toEqual({ ok: false, reasonCode: "NONCE_ALREADY_BOUND" });
    expect(s.boundAttestationId("attester_1", "n1")).toBe("att_1");
    expect(s.getAttestation("fund_z", "ipo_1")).toBeUndefined();
  });

  it("scopes nonces per attester", () => {
    const s = new InMemoryAttestationStore(allowlist);
    expect(s.publish(att({ attestationId: "att_1", nonce: "n1" }))).toEqual({ ok: true });
    expect(s.publish(att({ attestationId: "att_2", fundId: "fund_z", attesterId: "attester_2", nonce: "n1" }))).toEqual({ ok: true });
  });

  it("tracks revocation", () => {
    const s = new InMemoryAttestationStore(allowlist);
    expect(s.publish(att())).toEqual({ ok: true });
    expect(s.isRevoked("att_1")).toBe(false);
    s.revoke("att_1");
    expect(s.isRevoked("att_1")).toBe(true);
  });
});
