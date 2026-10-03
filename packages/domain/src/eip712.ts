import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { AttestationVerifier, AttesterVerificationResult } from "./attestation.js";
import { AttesterVerificationFailure } from "./attestation.js";
import type { AttesterId, CapacityAttestation } from "./model.js";

/* ------------------------------------------------------------------------------------------
 * EIP-712 verification of CapacityAttestation signatures
 *
 * What this module does: it checks that `attestation.signature` is a canonical secp256k1
 * signature, over the EIP-712 digest of the attestation's fields, by the address registered
 * for `attestation.attesterId`. Pure: no I/O, no chain access, no state, never throws on
 * attacker-controlled input.
 *
 * What it does NOT do: it says nothing about whether the attested numbers are TRUE. A
 * compromised or lying registered attester produces a valid signature over false data.
 * Key rotation, key revocation and attester governance are out of scope. This is a proof of
 * concept, not a security audit.
 *
 * Not supported (fail closed with SIGNATURE_INVALID): EIP-2098 compact 64-byte signatures, `v` of
 * 0/1 or EIP-155 style, and EIP-1271 contract-wallet signers (only a plain secp256k1 EOA address
 * can be registered; a contract address can never match a recovered signer).
 *
 * Cryptography is delegated to audited libraries (@noble/curves: secp256k1 recovery,
 * @noble/hashes: keccak-256). This file only does EIP-712 byte layout (type strings, 32-byte
 * word packing), which is cross-checked against viem's independent implementation in tests.
 * ---------------------------------------------------------------------------------------- */

/**
 * EIP-712 domain. Binding a signature to name/version/chainId/verifyingContract means an
 * attestation signed for one deployment (other chain, other contract, other protocol version)
 * does not verify under another. `chainId` and `verifyingContract` are domain-separation
 * labels here: this package does not talk to any chain.
 */
export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  /** Unsigned integer, up to uint256. */
  readonly chainId: bigint;
  /** 0x-prefixed 20-byte address (hex, 40 chars). */
  readonly verifyingContract: string;
}

/** Fixed name/version for this protocol's attestation signatures. Changing the payload layout requires a new version. */
export const ATTESTATION_DOMAIN_NAME = "ipo-proof CapacityAttestation";
export const ATTESTATION_DOMAIN_VERSION = "1";

/**
 * EIP-712 type definitions, in the standard JSON form. The signed message is every field of
 * CapacityAttestation EXCEPT `signature`. `bigint` KRW values are `uint256`; integer epoch-ms
 * times are `uint256`; identifiers and nonce are `string`; exposures are an array of structs.
 */
export const EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  CapacityAttestation: [
    { name: "attestationId", type: "string" },
    { name: "fundId", type: "string" },
    { name: "ipoId", type: "string" },
    { name: "ruleVersion", type: "string" },
    { name: "grossCapacityKrw", type: "uint256" },
    { name: "underlyingExposures", type: "UnderlyingExposure[]" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "attesterId", type: "string" },
  ],
  UnderlyingExposure: [
    { name: "fundId", type: "string" },
    { name: "exposureKrw", type: "uint256" },
  ],
} as const;

const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const EXPOSURE_TYPE_STRING = "UnderlyingExposure(string fundId,uint256 exposureKrw)";
// Per EIP-712: the primary type string is followed by referenced struct types, sorted by name.
const ATTESTATION_TYPE_STRING =
  "CapacityAttestation(string attestationId,string fundId,string ipoId,string ruleVersion," +
  "uint256 grossCapacityKrw,UnderlyingExposure[] underlyingExposures,uint256 issuedAt," +
  `uint256 expiresAt,string nonce,string attesterId)${EXPOSURE_TYPE_STRING}`;

const MAX_UINT256 = (1n << 256n) - 1n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const utf8 = new TextEncoder();
// ignoreBOM: keep a leading U+FEFF in the round-trip so a legitimate string starting with it is not mistaken for malformed.
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Thrown only for malformed *inputs to the encoder*; `Eip712AttestationVerifier.verify` converts it into a failure result. */
export class Eip712EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Eip712EncodingError";
  }
}

/* ----------------------------------- encoding helpers ----------------------------------- */

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encodeUint256(value: unknown, field: string): Uint8Array {
  let v: bigint;
  if (typeof value === "bigint") {
    v = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    v = BigInt(value);
  } else {
    throw new Eip712EncodingError(`${field}: expected a bigint or safe integer`);
  }
  if (v < 0n || v > MAX_UINT256) throw new Eip712EncodingError(`${field}: out of uint256 range`);
  return hexToBytes(v.toString(16).padStart(64, "0"));
}

/** `string` is encoded as keccak256(utf8). Lone surrogates would collapse to U+FFFD and collide, so they are rejected. */
function encodeString(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") throw new Eip712EncodingError(`${field}: expected a string`);
  const bytes = utf8.encode(value);
  if (utf8Decoder.decode(bytes) !== value) throw new Eip712EncodingError(`${field}: not well-formed Unicode`);
  return keccak_256(bytes);
}

function encodeAddress(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Eip712EncodingError(`${field}: expected a 0x-prefixed 20-byte hex address`);
  }
  return hexToBytes(value.slice(2).toLowerCase().padStart(64, "0"));
}

const typeHash = (typeString: string): Uint8Array => keccak_256(utf8.encode(typeString));

/** EIP-712 `hashStruct(EIP712Domain)`, i.e. the domain separator. */
export function hashEip712Domain(domain: Eip712Domain): Uint8Array {
  return keccak_256(
    concat([
      typeHash(DOMAIN_TYPE_STRING),
      encodeString(domain.name, "domain.name"),
      encodeString(domain.version, "domain.version"),
      encodeUint256(domain.chainId, "domain.chainId"),
      encodeAddress(domain.verifyingContract, "domain.verifyingContract"),
    ]),
  );
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Exposure canonicalization (documented design decision): `underlyingExposures` is signed as a
 * SET, in canonical order: ascending `fundId` (UTF-16 code-unit order, same as canonicalJson),
 * ties broken by ascending `exposureKrw`. Consequences:
 *  - The same exposures in a different array order verify identically (order is not part of
 *    the signed meaning; the rule engine sums them, so order has no effect on results).
 *  - Different exposure sets (added, removed or changed entries) never share a digest.
 *  - Duplicate `fundId` entries are NOT merged and NOT rejected here: they are signed as given,
 *    and `verifyBid` rejects them afterwards (DUPLICATE_UNDERLYING_EXPOSURE).
 */
export function canonicalExposures(
  exposures: CapacityAttestation["underlyingExposures"],
): CapacityAttestation["underlyingExposures"] {
  if (!Array.isArray(exposures)) throw new Eip712EncodingError("underlyingExposures: expected an array");
  if (exposures.some((e) => typeof e !== "object" || e === null)) {
    throw new Eip712EncodingError("underlyingExposures: expected an array of objects");
  }
  return [...exposures].sort((a, b) => {
    const byFund = compareCodeUnits(String(a.fundId), String(b.fundId));
    if (byFund !== 0) return byFund;
    return a.exposureKrw < b.exposureKrw ? -1 : a.exposureKrw > b.exposureKrw ? 1 : 0;
  });
}

/** EIP-712 `hashStruct(CapacityAttestation)` over every field except `signature`. */
export function hashAttestationStruct(a: CapacityAttestation): Uint8Array {
  const exposureHashes = canonicalExposures(a.underlyingExposures).map((e, i) => {
    return keccak_256(
      concat([
        typeHash(EXPOSURE_TYPE_STRING),
        encodeString(e.fundId, `underlyingExposures[${i}].fundId`),
        encodeUint256(e.exposureKrw, `underlyingExposures[${i}].exposureKrw`),
      ]),
    );
  });
  return keccak_256(
    concat([
      typeHash(ATTESTATION_TYPE_STRING),
      encodeString(a.attestationId, "attestationId"),
      encodeString(a.fundId, "fundId"),
      encodeString(a.ipoId, "ipoId"),
      encodeString(a.ruleVersion, "ruleVersion"),
      encodeUint256(a.grossCapacityKrw, "grossCapacityKrw"),
      keccak_256(concat(exposureHashes)),
      encodeUint256(a.issuedAt, "issuedAt"),
      encodeUint256(a.expiresAt, "expiresAt"),
      encodeString(a.nonce, "nonce"),
      encodeString(a.attesterId, "attesterId"),
    ]),
  );
}

/** The 32-byte digest an attester signs: keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function attestationDigest(a: CapacityAttestation, domain: Eip712Domain): Uint8Array {
  return digestWithSeparator(hashEip712Domain(domain), a);
}

function digestWithSeparator(domainSeparator: Uint8Array, a: CapacityAttestation): Uint8Array {
  return keccak_256(concat([Uint8Array.of(0x19, 0x01), domainSeparator, hashAttestationStruct(a)]));
}

/* --------------------------------- addresses & signatures --------------------------------- */

/** EIP-55 mixed-case checksum encoding of a 20-byte address (lowercase hex, no prefix, in). */
function toChecksumAddress(lowerHex: string): string {
  const hash = bytesToHex(keccak_256(utf8.encode(lowerHex)));
  let out = "0x";
  for (let i = 0; i < lowerHex.length; i++) {
    const c = lowerHex.charAt(i);
    out += Number.parseInt(hash.charAt(i), 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * Normalizes a configured signer address to lowercase `0x...`. All-lowercase and all-uppercase
 * hex are accepted; mixed case must be a valid EIP-55 checksum (catches typos). Throws
 * `TypeError` on bad configuration (this is deploy-time config, not attacker input).
 */
function normalizeSignerAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new TypeError(`invalid signer address: ${JSON.stringify(address)}`);
  const body = address.slice(2);
  const lower = body.toLowerCase();
  if (body !== lower && body !== body.toUpperCase() && address !== toChecksumAddress(lower)) {
    throw new TypeError(`signer address has an invalid EIP-55 checksum: ${address}`);
  }
  if (/^0+$/.test(lower)) throw new TypeError("signer address must not be the zero address");
  return `0x${lower}`;
}

const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

/**
 * Recovers the signer address (lowercase `0x...`) of a canonical 65-byte `r || s || v` signature,
 * or returns undefined if the signature is not acceptable. Rejected (never thrown):
 *  - anything that is not `0x` + 130 hex chars (empty, wrong length, non-hex, no prefix);
 *  - `v` other than 27 or 28 (0/1 and EIP-155 style values are not accepted: one encoding per signature);
 *  - `r` or `s` outside [1, n-1];
 *  - high-`s` (s > n/2): the malleable twin of a valid signature;
 *  - failure to recover a curve point.
 * Hex case is not significant (same bytes).
 */
export function recoverAttestationSigner(digest: Uint8Array, signature: unknown): string | undefined {
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return undefined;
  const bytes = hexToBytes(signature.slice(2));
  const v = bytes[64];
  if (v !== 27 && v !== 28) return undefined;
  try {
    const r = BigInt(`0x${bytesToHex(bytes.subarray(0, 32))}`);
    const s = BigInt(`0x${bytesToHex(bytes.subarray(32, 64))}`);
    if (r < 1n || r >= CURVE_ORDER || s < 1n || s >= CURVE_ORDER) return undefined;
    const sig = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), "compact").addRecoveryBit(v - 27);
    if (sig.hasHighS()) return undefined;
    const publicKey = sig.recoverPublicKey(digest).toBytes(false); // 65 bytes: 0x04 || X || Y
    return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
  } catch {
    // noble throws on unrecoverable signatures (e.g. r is not an x-coordinate on the curve).
    return undefined;
  }
}

/* ------------------------------------------ verifier ------------------------------------------ */

export interface Eip712AttestationVerifierConfig {
  readonly domain: Eip712Domain;
  /**
   * Attester registry: attesterId -> the single address allowed to sign for it. Being in the
   * registry is the authorization (allowlist); the address is the key binding. Each attesterId
   * and each address may appear at most once (so one key cannot speak for two attesters).
   */
  readonly attesters: Iterable<readonly [AttesterId, string]>;
}

/**
 * Verifies EIP-712 signatures on CapacityAttestations against a registry that binds each
 * attesterId to one signer address.
 *
 *  - attesterId not in the registry                      -> ATTESTER_UNAUTHORIZED
 *  - unparsable / non-canonical / wrong-domain / tampered
 *    signature, or signer != the registered address      -> SIGNATURE_INVALID
 *
 * Stateless and deterministic; `verify` does not throw on malformed attestations.
 */
export class Eip712AttestationVerifier implements AttestationVerifier {
  private readonly domainSeparator: Uint8Array;
  private readonly signers: ReadonlyMap<AttesterId, string>;

  /** Throws `TypeError` on invalid configuration (bad or zero domain values, bad/duplicate address, duplicate attesterId). */
  constructor(config: Eip712AttestationVerifierConfig) {
    // Misconfiguration guard: a zero chainId or zero verifyingContract weakens cross-deployment separation.
    if (config.domain.chainId === 0n) throw new TypeError("domain.chainId must not be 0");
    if (typeof config.domain.verifyingContract === "string" && /^0x0{40}$/i.test(config.domain.verifyingContract)) {
      throw new TypeError("domain.verifyingContract must not be the zero address");
    }
    this.domainSeparator = hashEip712Domain(config.domain);
    const signers = new Map<AttesterId, string>();
    const addresses = new Set<string>();
    for (const [attesterId, address] of config.attesters) {
      const normalized = normalizeSignerAddress(address);
      if (signers.has(attesterId)) throw new TypeError(`duplicate attesterId in registry: ${attesterId}`);
      if (addresses.has(normalized)) throw new TypeError(`signer address registered for more than one attester: ${normalized}`);
      signers.set(attesterId, normalized);
      addresses.add(normalized);
    }
    this.signers = signers;
  }

  verify(attestation: CapacityAttestation): AttesterVerificationResult {
    const invalid = { ok: false, reasonCode: AttesterVerificationFailure.SIGNATURE_INVALID } as const;
    // The type says object, but callers may pass anything: fail closed instead of throwing.
    if (typeof attestation !== "object" || attestation === null) return invalid;
    const expectedSigner = this.signers.get(attestation.attesterId);
    if (expectedSigner === undefined) {
      return { ok: false, reasonCode: AttesterVerificationFailure.ATTESTER_UNAUTHORIZED };
    }
    let digest: Uint8Array;
    try {
      digest = digestWithSeparator(this.domainSeparator, attestation);
    } catch (e) {
      if (e instanceof Eip712EncodingError) return invalid; // cannot be a signed payload
      throw e;
    }
    return recoverAttestationSigner(digest, attestation.signature) === expectedSigner ? { ok: true } : invalid;
  }
}
