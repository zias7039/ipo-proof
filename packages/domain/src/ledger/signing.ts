/**
 * EIP-712 typed data for ledger requests (docs/design/participation-ledger-events.md §3.2).
 *
 * WHAT A SIGNATURE HERE MEANS: "the holder of the key registered for this principal asked for
 * exactly this action". That is provenance of a request. It is NOT a statement that the recorded
 * fact is true (principle B) and it is NOT a zero-knowledge proof (principle F; ZK STATUS: NOT
 * IMPLEMENTED). Signed fields are ids, enum tokens, hashes, sequence numbers and times only: no
 * amounts and no capacity (principle E).
 *
 * Domain separation: the ledger domain name/version differ from the attestation domain
 * (`ipo-proof CapacityAttestation`), and every request kind is its own EIP-712 primary type, so a
 * signature for one kind of request (or one deployment, fund, IPO, state) never verifies for
 * another. EIP-712 itself has no replay protection: `requestNonce` / `expiresAt` are enforced by
 * the ledger gate (authorized.ts), not here.
 *
 * Pure functions, no state, no I/O. Malformed inputs raise `Eip712EncodingError` from the digest
 * functions; the gate converts that into a rejection and never lets it escape.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  concat,
  encodeBytes32,
  encodeString,
  encodeUint256,
  typeHash,
} from "../eip712-encoding.js";
import { hashEip712Domain } from "../eip712.js";
import type { Eip712Domain } from "../eip712.js";

export const LEDGER_DOMAIN_NAME = "ipo-proof ParticipationLedger";
export const LEDGER_DOMAIN_VERSION = "1";

/**
 * `authorization.scheme` values. The design fixes only the first two names; the operator and
 * approval names are this implementation's provisional choice (open question in the PR).
 */
export const LedgerScheme = {
  LEDGER_ACTION: "EIP712_LEDGER_ACTION_V1",
  LEDGER_ANNULMENT: "EIP712_LEDGER_ANNULMENT_V1",
  ANNULMENT_APPROVAL: "EIP712_ANNULMENT_APPROVAL_V1",
  OPERATOR_ACTION: "EIP712_OPERATOR_ACTION_V1",
} as const;
export type LedgerScheme = (typeof LedgerScheme)[keyof typeof LedgerScheme];

/** The only operator action in this PR. */
export const OPERATOR_ACTION_IPO_CLOSED = "IPO_CLOSED";

/** Standard JSON form of the types (used by tests to cross-check against an independent EIP-712 implementation). */
export const LEDGER_EIP712_TYPES = {
  LedgerAction: [
    { name: "actorId", type: "string" },
    { name: "fundId", type: "string" },
    { name: "ipoId", type: "string" },
    { name: "targetState", type: "string" },
    { name: "requestNonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
  LedgerAnnulment: [
    { name: "actorId", type: "string" },
    { name: "fundId", type: "string" },
    { name: "ipoId", type: "string" },
    { name: "targetSeq", type: "uint256" },
    { name: "targetEventHash", type: "bytes32" },
    { name: "reason", type: "string" },
    { name: "replacementState", type: "string" },
    { name: "requestNonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
  AnnulmentApproval: [
    { name: "approverId", type: "string" },
    { name: "annulmentDigest", type: "bytes32" },
    { name: "requestNonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
  OperatorAction: [
    { name: "action", type: "string" },
    { name: "ipoId", type: "string" },
    { name: "requestNonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

const typeString = (name: keyof typeof LEDGER_EIP712_TYPES): string =>
  `${name}(${LEDGER_EIP712_TYPES[name].map((f) => `${f.type} ${f.name}`).join(",")})`;

const LEDGER_ACTION_TYPE = typeString("LedgerAction");
const LEDGER_ANNULMENT_TYPE = typeString("LedgerAnnulment");
const ANNULMENT_APPROVAL_TYPE = typeString("AnnulmentApproval");
const OPERATOR_ACTION_TYPE = typeString("OperatorAction");

export interface LedgerActionMessage {
  readonly actorId: string;
  readonly fundId: string;
  readonly ipoId: string;
  /** "PARTICIPATING" | "NON_PARTICIPATION_LOCKED" */
  readonly targetState: string;
  readonly requestNonce: string;
  readonly expiresAt: number;
}
export interface LedgerAnnulmentMessage {
  readonly actorId: string;
  readonly fundId: string;
  readonly ipoId: string;
  readonly targetSeq: number;
  /** Lowercase 0x-prefixed 32-byte hex. */
  readonly targetEventHash: string;
  readonly reason: string;
  /** "" (none) | "PARTICIPATING" | "NON_PARTICIPATION_LOCKED" */
  readonly replacementState: string;
  readonly requestNonce: string;
  readonly expiresAt: number;
}
export interface AnnulmentApprovalMessage {
  readonly approverId: string;
  /** EIP-712 digest of the LedgerAnnulment being approved: lowercase 0x-prefixed 32-byte hex. */
  readonly annulmentDigest: string;
  readonly requestNonce: string;
  readonly expiresAt: number;
}
export interface OperatorActionMessage {
  readonly action: string;
  readonly ipoId: string;
  readonly requestNonce: string;
  readonly expiresAt: number;
}

const hex = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export function hashLedgerAction(m: LedgerActionMessage): Uint8Array {
  return keccak_256(
    concat([
      typeHash(LEDGER_ACTION_TYPE),
      encodeString(m.actorId, "actorId"),
      encodeString(m.fundId, "fundId"),
      encodeString(m.ipoId, "ipoId"),
      encodeString(m.targetState, "targetState"),
      encodeString(m.requestNonce, "requestNonce"),
      encodeUint256(m.expiresAt, "expiresAt"),
    ]),
  );
}

export function hashLedgerAnnulment(m: LedgerAnnulmentMessage): Uint8Array {
  return keccak_256(
    concat([
      typeHash(LEDGER_ANNULMENT_TYPE),
      encodeString(m.actorId, "actorId"),
      encodeString(m.fundId, "fundId"),
      encodeString(m.ipoId, "ipoId"),
      encodeUint256(m.targetSeq, "targetSeq"),
      encodeBytes32(m.targetEventHash, "targetEventHash"),
      encodeString(m.reason, "reason"),
      encodeString(m.replacementState, "replacementState"),
      encodeString(m.requestNonce, "requestNonce"),
      encodeUint256(m.expiresAt, "expiresAt"),
    ]),
  );
}

export function hashAnnulmentApproval(m: AnnulmentApprovalMessage): Uint8Array {
  return keccak_256(
    concat([
      typeHash(ANNULMENT_APPROVAL_TYPE),
      encodeString(m.approverId, "approverId"),
      encodeBytes32(m.annulmentDigest, "annulmentDigest"),
      encodeString(m.requestNonce, "requestNonce"),
      encodeUint256(m.expiresAt, "expiresAt"),
    ]),
  );
}

export function hashOperatorAction(m: OperatorActionMessage): Uint8Array {
  return keccak_256(
    concat([
      typeHash(OPERATOR_ACTION_TYPE),
      encodeString(m.action, "action"),
      encodeString(m.ipoId, "ipoId"),
      encodeString(m.requestNonce, "requestNonce"),
      encodeUint256(m.expiresAt, "expiresAt"),
    ]),
  );
}

/** keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function ledgerDigest(domainSeparator: Uint8Array, structHash: Uint8Array): Uint8Array {
  return keccak_256(concat([Uint8Array.of(0x19, 0x01), domainSeparator, structHash]));
}

/** The ledger EIP-712 domain separator for a deployment. */
export function ledgerDomainSeparator(domain: Eip712Domain): Uint8Array {
  return hashEip712Domain(domain);
}

/** Digest as the lowercase 0x hex string that `AnnulmentApprovalMessage.annulmentDigest` carries. */
export function digestToHex(digest: Uint8Array): string {
  return hex(digest);
}
