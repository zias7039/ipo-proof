/**
 * Low-level EIP-712 byte-layout helpers (32-byte word packing, string/address/uint256/bytes32
 * encoding, signer-address normalization). Shared by the attestation verifier (eip712.ts) and the
 * ledger action signatures (ledger/signing.ts). No state, no I/O. Cryptography itself lives in
 * @noble/curves and @noble/hashes.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

export const MAX_UINT256 = (1n << 256n) - 1n;
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
export const utf8 = new TextEncoder();
// ignoreBOM: keep a leading U+FEFF in the round-trip so a legitimate string starting with it is not mistaken for malformed.
export const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Thrown only for malformed *inputs to the encoder*; `Eip712AttestationVerifier.verify` converts it into a failure result. */
export class Eip712EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Eip712EncodingError";
  }
}

/* ----------------------------------- encoding helpers ----------------------------------- */

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function encodeUint256(value: unknown, field: string): Uint8Array {
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
export function encodeString(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") throw new Eip712EncodingError(`${field}: expected a string`);
  const bytes = utf8.encode(value);
  if (utf8Decoder.decode(bytes) !== value) throw new Eip712EncodingError(`${field}: not well-formed Unicode`);
  return keccak_256(bytes);
}

export function encodeAddress(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Eip712EncodingError(`${field}: expected a 0x-prefixed 20-byte hex address`);
  }
  return hexToBytes(value.slice(2).toLowerCase().padStart(64, "0"));
}

export const typeHash = (typeString: string): Uint8Array => keccak_256(utf8.encode(typeString));


const BYTES32_RE = /^0x[0-9a-f]{64}$/;

/** `bytes32` from a lowercase 0x-prefixed 32-byte hex string. */
export function encodeBytes32(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !BYTES32_RE.test(value)) {
    throw new Eip712EncodingError(`${field}: expected a lowercase 0x-prefixed 32-byte hex string`);
  }
  return hexToBytes(value.slice(2));
}

/** EIP-55 mixed-case checksum encoding of a 20-byte address (lowercase hex, no prefix, in). */
export function toChecksumAddress(lowerHex: string): string {
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
export function normalizeSignerAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new TypeError(`invalid signer address: ${JSON.stringify(address)}`);
  const body = address.slice(2);
  const lower = body.toLowerCase();
  if (body !== lower && body !== body.toUpperCase() && address !== toChecksumAddress(lower)) {
    throw new TypeError(`signer address has an invalid EIP-55 checksum: ${address}`);
  }
  if (/^0+$/.test(lower)) throw new TypeError("signer address must not be the zero address");
  return `0x${lower}`;
}

