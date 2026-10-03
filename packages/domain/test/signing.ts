/**
 * TEST-ONLY signing helpers. This file lives under test/ and must never be imported from src/.
 *
 * All keys here are SYNTHETIC TEST KEYS: deterministic values derived at runtime from a public
 * label, never used with real funds or real identities. No private key literal is committed.
 * Signing goes through viem (an independent implementation from the one in src/eip712.ts), so
 * a passing round-trip also cross-checks src's EIP-712 encoding.
 */
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Eip712Domain } from "../src/eip712.js";
import { ATTESTATION_DOMAIN_NAME, ATTESTATION_DOMAIN_VERSION, EIP712_TYPES } from "../src/eip712.js";
import type { CapacityAttestation } from "../src/model.js";

/** Synthetic test domain. chainId/verifyingContract are placeholders, not a real deployment. */
export const TEST_DOMAIN: Eip712Domain = {
  name: ATTESTATION_DOMAIN_NAME,
  version: ATTESTATION_DOMAIN_VERSION,
  chainId: 31337n,
  verifyingContract: "0x00000000000000000000000000000000000a11ce",
};

export type Hex = `0x${string}`;

/** synthetic test key: sha256("ipo-proof synthetic test key / <label>"), valid secp256k1 scalar with overwhelming probability. */
export function syntheticPrivateKey(label: string): Hex {
  return `0x${createHash("sha256").update(`ipo-proof synthetic test key / ${label}`).digest("hex")}`;
}

export function syntheticAccount(label: string) {
  return privateKeyToAccount(syntheticPrivateKey(label));
}

/** The EIP-712 message for an attestation (everything except `signature`), in viem's shape. Order as given. */
export function attestationMessage(a: Omit<CapacityAttestation, "signature">) {
  return {
    attestationId: a.attestationId,
    fundId: a.fundId,
    ipoId: a.ipoId,
    ruleVersion: a.ruleVersion,
    grossCapacityKrw: a.grossCapacityKrw,
    underlyingExposures: a.underlyingExposures.map((e) => ({ fundId: e.fundId, exposureKrw: e.exposureKrw })),
    issuedAt: BigInt(a.issuedAt),
    expiresAt: BigInt(a.expiresAt),
    nonce: a.nonce,
    attesterId: a.attesterId,
  };
}

export function viemDomain(d: Eip712Domain) {
  return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract as Hex };
}

/** Signs `attestation` (its `signature` field is ignored) with the synthetic key for `signerLabel`. */
export async function signAttestation(
  attestation: CapacityAttestation,
  signerLabel: string,
  domain: Eip712Domain = TEST_DOMAIN,
): Promise<CapacityAttestation> {
  const signature = await syntheticAccount(signerLabel).signTypedData({
    domain: viemDomain(domain),
    types: { CapacityAttestation: EIP712_TYPES.CapacityAttestation, UnderlyingExposure: EIP712_TYPES.UnderlyingExposure },
    primaryType: "CapacityAttestation",
    message: attestationMessage(attestation),
  });
  return { ...attestation, signature };
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The malleable twin of a signature: s' = n - s, v flipped. Valid for ecrecover, rejected by the verifier. */
export function toHighS(signature: string): string {
  const r = signature.slice(2, 66);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  const highS = (SECP256K1_N - s).toString(16).padStart(64, "0");
  const flippedV = v === 27 ? 28 : 27;
  return `0x${r}${highS}${flippedV.toString(16).padStart(2, "0")}`;
}

/** Replaces the v byte (last byte) of a 65-byte hex signature. */
export function withV(signature: string, v: number): string {
  return `${signature.slice(0, 130)}${v.toString(16).padStart(2, "0")}`;
}
