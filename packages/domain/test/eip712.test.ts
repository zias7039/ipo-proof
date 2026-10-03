import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import {
  Eip712AttestationVerifier,
  ATTESTATION_DOMAIN_NAME,
  ATTESTATION_DOMAIN_VERSION,
  EIP712_TYPES,
  attestationDigest,
  canonicalExposures,
  recoverAttestationSigner,
} from "../src/eip712.js";
import type { CapacityAttestation } from "../src/model.js";
import { SIGNER_LABELS, att, attesterRegistry, makeEip712Verifier, signedAtt } from "./fixtures.js";
import { TEST_DOMAIN, attestationMessage, signAttestation, syntheticAccount, toHighS, viemDomain, withV } from "./signing.js";

const SIG_INVALID = { ok: false, reasonCode: "SIGNATURE_INVALID" } as const;
const UNAUTHORIZED = { ok: false, reasonCode: "ATTESTER_UNAUTHORIZED" } as const;
const verifier = makeEip712Verifier();
const toHex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

describe("EIP-712 encoding is cross-checked against viem (independent implementation)", () => {
  const cases: Record<string, Partial<CapacityAttestation>> = {
    "demo attestation": {},
    "no exposures": { underlyingExposures: [] },
    "unicode and empty strings": { nonce: "", attestationId: "att_\u00e9\u{1f600}" },
    "uint256 maximum": { grossCapacityKrw: 2n ** 256n - 1n },
    "unsorted exposures": {
      underlyingExposures: [
        { fundId: "fund_z", exposureKrw: 1n },
        { fundId: "fund_b", exposureKrw: 9n },
        { fundId: "fund_b", exposureKrw: 2n },
      ],
    },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    it(`digest matches viem.hashTypedData: ${name}`, () => {
      const a = att(overrides);
      // viem is given the exposures in canonical order, because that is what is defined as signed.
      const expected = hashTypedData({
        domain: viemDomain(TEST_DOMAIN),
        types: { CapacityAttestation: EIP712_TYPES.CapacityAttestation, UnderlyingExposure: EIP712_TYPES.UnderlyingExposure },
        primaryType: "CapacityAttestation",
        message: attestationMessage({ ...a, underlyingExposures: canonicalExposures(a.underlyingExposures) }),
      });
      expect(toHex(attestationDigest(a, TEST_DOMAIN))).toBe(expected);
    });
  }

  it("signs the documented domain name/version", () => {
    expect(TEST_DOMAIN.name).toBe(ATTESTATION_DOMAIN_NAME);
    expect(TEST_DOMAIN.version).toBe(ATTESTATION_DOMAIN_VERSION);
  });
});

describe("Eip712AttestationVerifier: accepts genuine attestations", () => {
  it("accepts a signature by the registered key of each attester", async () => {
    expect(verifier.verify(await signedAtt())).toEqual({ ok: true });
    expect(verifier.verify(await signedAtt({ attesterId: "attester_2" }, SIGNER_LABELS.attester_2))).toEqual({ ok: true });
  });

  it("is insensitive to hex letter case of the signature (same bytes)", async () => {
    const a = await signedAtt();
    expect(verifier.verify({ ...a, signature: `0x${a.signature.slice(2).toUpperCase()}` })).toEqual({ ok: true });
  });

  it("treats underlyingExposures as a set: any array order verifies the same", async () => {
    const a = await signedAtt();
    const reversed = { ...a, underlyingExposures: [...a.underlyingExposures].reverse() };
    expect(verifier.verify(reversed)).toEqual({ ok: true });
  });

  it("accepts integer-number time fields exactly like their bigint value", async () => {
    // issuedAt/expiresAt are numbers in the model and uint256 on the wire.
    const a = await signedAtt({ issuedAt: 5, expiresAt: 9 });
    expect(verifier.verify(a)).toEqual({ ok: true });
  });
});

describe("Eip712AttestationVerifier: forgery and tampering", () => {
  it("rejects an attestation signed with a different key (forgery)", async () => {
    const forged = await signedAtt({}, "not_a_registered_key");
    expect(verifier.verify(forged)).toEqual(SIG_INVALID);
  });

  it("rejects an attesterId that is allowlisted but signed with ANOTHER attester's key", async () => {
    const a = await signedAtt({ attesterId: "attester_1" }, SIGNER_LABELS.attester_2);
    expect(verifier.verify(a)).toEqual(SIG_INVALID);
  });

  it("rejects a signature copied onto a different attestation", async () => {
    const a = await signedAtt();
    expect(verifier.verify({ ...att({ attestationId: "att_2", nonce: "nonce_2" }), signature: a.signature })).toEqual(SIG_INVALID);
  });

  const tamperings: [string, Partial<CapacityAttestation>][] = [
    ["attestationId", { attestationId: "att_9" }],
    ["fundId", { fundId: "fund_b" }],
    ["ipoId", { ipoId: "ipo_2" }],
    ["ruleVersion", { ruleVersion: "DEMO_RULE_V2" }],
    ["grossCapacityKrw (+1 KRW)", { grossCapacityKrw: 30_000_000_001n }],
    ["grossCapacityKrw (inflated)", { grossCapacityKrw: 300_000_000_000n }],
    ["issuedAt", { issuedAt: 1 }],
    ["expiresAt (extended)", { expiresAt: 1_800_000_000_000 + 10 * 3_600_000 }],
    ["nonce", { nonce: "nonce_2" }],
    ["attesterId (to another registered attester)", { attesterId: "attester_2" }],
    ["exposure amount lowered", { underlyingExposures: [{ fundId: "fund_b", exposureKrw: 1n }, { fundId: "fund_c", exposureKrw: 4_000_000_000n }] }],
    ["exposure removed", { underlyingExposures: [{ fundId: "fund_c", exposureKrw: 4_000_000_000n }] }],
    ["exposure added", { underlyingExposures: [...att().underlyingExposures, { fundId: "fund_d", exposureKrw: 1n }] }],
    ["exposure fund swapped", { underlyingExposures: [{ fundId: "fund_d", exposureKrw: 6_000_000_000n }, { fundId: "fund_c", exposureKrw: 4_000_000_000n }] }],
    ["exposures emptied", { underlyingExposures: [] }],
  ];
  for (const [field, change] of tamperings) {
    it(`rejects a signed attestation after changing ${field}`, async () => {
      const signed = await signedAtt();
      expect(verifier.verify({ ...signed, ...change })).toEqual(SIG_INVALID);
    });
  }
});

describe("Eip712AttestationVerifier: authorization (registry)", () => {
  it("rejects an attester that is not in the registry, even with an otherwise valid signature", async () => {
    const stranger = await signedAtt({ attesterId: "attester_9" }, "attester_9");
    expect(verifier.verify(stranger)).toEqual(UNAUTHORIZED);
  });

  it("reports UNAUTHORIZED (not SIGNATURE_INVALID) for unregistered attesters regardless of signature", () => {
    expect(verifier.verify(att({ attesterId: "attester_9", signature: "" }))).toEqual(UNAUTHORIZED);
  });

  it("does not confuse object-prototype names with registered attesters", () => {
    for (const attesterId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(verifier.verify(att({ attesterId }))).toEqual(UNAUTHORIZED);
    }
  });
});

describe("Eip712AttestationVerifier: malformed and malleable signatures return failures, never throw", () => {
  it("rejects empty, short, long, non-hex, unprefixed and non-string signatures", async () => {
    const good = (await signedAtt()).signature;
    const bad: unknown[] = [
      "",
      "0x",
      good.slice(0, -2), // 64 bytes
      good.slice(0, -1), // odd length
      `${good}00`, // 66 bytes
      `0x${"zz".repeat(65)}`,
      good.slice(2), // no 0x prefix
      ` ${good}`,
      "unverified_demo_signature",
      undefined,
      null,
      42,
      {},
    ];
    for (const signature of bad) {
      const a = { ...att(), signature } as unknown as CapacityAttestation;
      expect(() => verifier.verify(a), String(signature)).not.toThrow();
      expect(verifier.verify(a), String(signature)).toEqual(SIG_INVALID);
    }
  });

  it("rejects v other than 27/28 (including 0/1 and EIP-155 style values)", async () => {
    const good = (await signedAtt()).signature;
    expect(verifier.verify({ ...att(), signature: good })).toEqual({ ok: true }); // sanity: untouched is valid
    for (const v of [0, 1, 2, 26, 29, 35, 37, 255]) {
      expect(verifier.verify({ ...att(), signature: withV(good, v) }), `v=${v}`).toEqual(SIG_INVALID);
    }
  });

  it("rejects the opposite parity of v (recovers a different address)", async () => {
    const a = await signedAtt();
    const v = Number.parseInt(a.signature.slice(130), 16);
    expect(verifier.verify({ ...a, signature: withV(a.signature, v === 27 ? 28 : 27) })).toEqual(SIG_INVALID);
  });

  it("rejects the high-s malleable twin of a valid signature, which still recovers the same signer", async () => {
    const a = await signedAtt();
    const twin = toHighS(a.signature);
    expect(twin).not.toBe(a.signature);
    // Prove the twin really is a mathematically valid signature by the same key (so only the high-s rule rejects it)...
    const digest = attestationDigest(a, TEST_DOMAIN);
    const recovered = secp256k1.Signature.fromBytes(Buffer.from(twin.slice(2, 130), "hex"), "compact")
      .addRecoveryBit(Number.parseInt(twin.slice(130), 16) - 27)
      .recoverPublicKey(digest)
      .toBytes(false);
    const twinSigner = `0x${Buffer.from(keccak_256(recovered.subarray(1)).subarray(12)).toString("hex")}`;
    expect(twinSigner).toBe(syntheticAccount(SIGNER_LABELS.attester_1).address.toLowerCase());
    // ...and that the verifier refuses it.
    expect(verifier.verify({ ...a, signature: twin })).toEqual(SIG_INVALID);
  });

  it("rejects r = 0, s = 0, r >= n and s >= n", async () => {
    const good = (await signedAtt()).signature;
    const r = good.slice(2, 66);
    const s = good.slice(66, 130);
    const v = good.slice(130);
    const n = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
    const zero = "0".repeat(64);
    for (const sig of [`0x${zero}${s}${v}`, `0x${r}${zero}${v}`, `0x${n}${s}${v}`, `0x${r}${n}${v}`, `0x${"f".repeat(64)}${s}${v}`]) {
      expect(verifier.verify({ ...att(), signature: sig })).toEqual(SIG_INVALID);
    }
  });

  it("rejects a well-formed signature whose r is not a curve x-coordinate (unrecoverable)", async () => {
    // r = 5 is not an x-coordinate of a point on secp256k1; the recovery step itself fails.
    const sig = `0x${"0".repeat(63)}5${"0".repeat(63)}1${"1b"}`;
    expect(() => verifier.verify({ ...att(), signature: sig })).not.toThrow();
    expect(verifier.verify({ ...att(), signature: sig })).toEqual(SIG_INVALID);
  });

  it("recoverAttestationSigner returns undefined (not an exception) for garbage", () => {
    expect(recoverAttestationSigner(new Uint8Array(32), "0x")).toBeUndefined();
    expect(recoverAttestationSigner(new Uint8Array(32), 123)).toBeUndefined();
  });
});

describe("Eip712AttestationVerifier: non-object input and unsupported signature formats", () => {
  it("returns SIGNATURE_INVALID instead of throwing for null, undefined and primitives", () => {
    for (const input of [null, undefined, 0, "att_1", true]) {
      expect(() => verifier.verify(input as unknown as CapacityAttestation)).not.toThrow();
      expect(verifier.verify(input as unknown as CapacityAttestation)).toEqual(SIG_INVALID);
    }
  });

  it("treats an object without a usable attesterId as unauthorized rather than throwing", () => {
    for (const input of [{}, [], { attesterId: 5 }]) {
      expect(verifier.verify(input as unknown as CapacityAttestation)).toEqual(UNAUTHORIZED);
    }
  });

  it("does not support EIP-2098 compact (64-byte) signatures: they are rejected", async () => {
    const a = await signedAtt();
    const r = a.signature.slice(2, 66);
    const s = BigInt(`0x${a.signature.slice(66, 130)}`);
    const v = Number.parseInt(a.signature.slice(130), 16);
    const yParity = BigInt(v - 27);
    const compact = `0x${r}${((yParity << 255n) | s).toString(16).padStart(64, "0")}`;
    expect(compact).toHaveLength(2 + 128);
    expect(verifier.verify({ ...a, signature: compact })).toEqual(SIG_INVALID);
  });

  it("accepts a string that starts with U+FEFF (a legitimate character, not a BOM to strip)", async () => {
    const a = await signedAtt({ nonce: "\ufeffabc" });
    expect(verifier.verify(a)).toEqual({ ok: true });
    expect(verifier.verify({ ...a, nonce: "abc" })).toEqual(SIG_INVALID);
  });
});

describe("Eip712AttestationVerifier: attestations that cannot be encoded are failures, not exceptions", () => {
  const signed = async () => signedAtt();
  const mutate = async (change: Record<string, unknown>) => ({ ...(await signed()), ...change }) as unknown as CapacityAttestation;

  it("handles out-of-range, non-integer and wrong-typed fields", async () => {
    const changes: Record<string, unknown>[] = [
      { grossCapacityKrw: -1n },
      { grossCapacityKrw: 2n ** 256n },
      { grossCapacityKrw: 30 },
      { grossCapacityKrw: "30000000000" },
      { issuedAt: 1.5 },
      { expiresAt: -1 },
      { expiresAt: Number.NaN },
      { nonce: 7 },
      { fundId: undefined },
      { nonce: "bad\ud800surrogate" },
      { underlyingExposures: undefined },
      { underlyingExposures: "fund_b" },
      { underlyingExposures: [null] },
      { underlyingExposures: [{ fundId: "fund_b", exposureKrw: -1n }] },
      { underlyingExposures: [{ fundId: 5, exposureKrw: 1n }] },
    ];
    for (const change of changes) {
      const a = await mutate(change);
      expect(() => verifier.verify(a), JSON.stringify(Object.keys(change))).not.toThrow();
      expect(verifier.verify(a)).toEqual(SIG_INVALID);
    }
  });

  it("does not throw from the exposure sort comparator on malformed scalars (Symbol, object, hostile toString)", async () => {
    const symbolAmounts = [{ fundId: "fund_b", exposureKrw: Symbol("x") }, { fundId: "fund_b", exposureKrw: 1n }];
    const hostile = { toString: () => { throw new Error("boom"); } };
    const changes: Record<string, unknown>[] = [
      { underlyingExposures: symbolAmounts },
      { underlyingExposures: [...symbolAmounts].reverse() },
      { underlyingExposures: [{ fundId: Symbol("f"), exposureKrw: 1n }, { fundId: "fund_b", exposureKrw: 1n }] },
      { underlyingExposures: [{ fundId: hostile, exposureKrw: 1n }, { fundId: "fund_b", exposureKrw: 1n }] },
      { underlyingExposures: [{ fundId: "fund_b", exposureKrw: hostile }, { fundId: "fund_b", exposureKrw: 1n }] },
      { underlyingExposures: [{ fundId: "fund_b", exposureKrw: {} }, { fundId: "fund_b", exposureKrw: 2n }] },
    ];
    for (const change of changes) {
      const a = await mutate(change);
      expect(() => verifier.verify(a)).not.toThrow();
      expect(verifier.verify(a)).toEqual(SIG_INVALID);
    }
  });

  it("distinct strings never collide: lone surrogates are rejected rather than coerced to U+FFFD", async () => {
    const a = await signedAtt({ nonce: "x\ufffdy" });
    expect(verifier.verify(a)).toEqual({ ok: true });
    expect(verifier.verify({ ...a, nonce: "x\ud800y" })).toEqual(SIG_INVALID);
  });
});

describe("Eip712AttestationVerifier: domain separation", () => {
  const domains: [string, Partial<typeof TEST_DOMAIN>][] = [
    ["different chainId", { chainId: 1n }],
    ["different verifyingContract", { verifyingContract: "0x00000000000000000000000000000000000b0b01" }],
    ["different domain version", { version: "2" }],
    ["different domain name", { name: "some other protocol" }],
  ];
  for (const [label, change] of domains) {
    it(`an attestation signed for another domain does not verify (${label}), and vice versa`, async () => {
      const otherDomain = { ...TEST_DOMAIN, ...change };
      const signedForOther = await signAttestation(att(), SIGNER_LABELS.attester_1, otherDomain);
      expect(verifier.verify(signedForOther)).toEqual(SIG_INVALID);
      // The same signature IS valid under the domain it was made for (so the rejection above is due to the domain only).
      const otherVerifier = new Eip712AttestationVerifier({ domain: otherDomain, attesters: attesterRegistry() });
      expect(otherVerifier.verify(signedForOther)).toEqual({ ok: true });
      // And a signature for our domain does not verify there.
      expect(otherVerifier.verify(await signedAtt())).toEqual(SIG_INVALID);
    });
  }
});

describe("Eip712AttestationVerifier: configuration validation (deploy-time, may throw)", () => {
  const address = syntheticAccount("attester_1").address;
  const make = (attesters: [string, string][], domain = TEST_DOMAIN) => () => new Eip712AttestationVerifier({ domain, attesters });

  it("accepts lowercase, uppercase-hex and valid EIP-55 addresses", () => {
    expect(make([["attester_1", address]])).not.toThrow(); // viem returns EIP-55
    expect(make([["attester_1", address.toLowerCase()]])).not.toThrow();
    expect(make([["attester_1", `0x${address.slice(2).toUpperCase()}`]])).not.toThrow();
  });

  it("rejects malformed, wrongly checksummed and zero addresses", () => {
    expect(make([["attester_1", "0x1234"]])).toThrow(TypeError);
    expect(make([["attester_1", "attester_1"]])).toThrow(TypeError);
    const flipped = address.replace(/[a-f]/, (c) => c.toUpperCase()).replace(/[A-F]/, (c) => c.toLowerCase());
    // flipping case of one letter in an EIP-55 address breaks the checksum (unless it was all-digits)
    if (flipped !== address && /[a-fA-F]/.test(address.slice(2))) {
      expect(make([["attester_1", flipped]])).toThrow(TypeError);
    }
    expect(make([["attester_1", `0x${"0".repeat(40)}`]])).toThrow(TypeError);
  });

  it("rejects duplicate attesterIds and one address bound to two attesters", () => {
    const other = syntheticAccount("attester_2").address;
    expect(make([["attester_1", address], ["attester_1", other]])).toThrow(TypeError);
    expect(make([["attester_1", address], ["attester_2", address.toLowerCase()]])).toThrow(TypeError);
  });

  it("rejects a zero chainId and a zero verifyingContract (weakened domain separation)", () => {
    expect(make([["attester_1", address]], { ...TEST_DOMAIN, chainId: 0n })).toThrow(TypeError);
    expect(make([["attester_1", address]], { ...TEST_DOMAIN, verifyingContract: `0x${"0".repeat(40)}` })).toThrow(TypeError);
    expect(make([["attester_1", address]], { ...TEST_DOMAIN, chainId: 1n })).not.toThrow();
  });

  it("rejects an invalid domain", () => {
    expect(make([["attester_1", address]], { ...TEST_DOMAIN, chainId: -1n })).toThrow();
    expect(make([["attester_1", address]], { ...TEST_DOMAIN, verifyingContract: "0x12" })).toThrow();
  });

  it("an empty registry authorizes nobody", async () => {
    const empty = new Eip712AttestationVerifier({ domain: TEST_DOMAIN, attesters: [] });
    expect(empty.verify(await signedAtt())).toEqual(UNAUTHORIZED);
  });
});
