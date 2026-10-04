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
  encodeAddress,
  encodeBytes32,
  encodeString,
  encodeUint256,
  typeHash,
} from "../eip712-encoding.js";
import type { Eip712Domain } from "../eip712.js";
import { sha256CanonicalHex } from "../hash.js";
import { ledgerGenesisHash } from "./events.js";

export const LEDGER_DOMAIN_NAME = "ipo-proof ParticipationLedger";
export const LEDGER_DOMAIN_VERSION = "1";

/**
 * `authorization.scheme` values, as in design PR #38 section 2.2.2 (R16). The other two schemes of
 * that table (`EIP712_LEDGER_BID_WITHDRAWAL_V1`, `EIP712_LEDGER_KEY_REVOCATION_V1`) belong to R15 / R18,
 * which this module does not implement, so they are not defined here.
 */
export const LedgerScheme = {
  LEDGER_ACTION: "EIP712_LEDGER_ACTION_V1",
  LEDGER_ANNULMENT: "EIP712_LEDGER_ANNULMENT_V1",
  ANNULMENT_APPROVAL: "EIP712_LEDGER_ANNULMENT_APPROVAL_V1",
  OPERATOR_ACTION: "EIP712_LEDGER_OPERATOR_ACTION_V1",
} as const;
export type LedgerScheme = (typeof LedgerScheme)[keyof typeof LedgerScheme];

/** The only operator action this module signs for (IPO_FINALIZED / FINDING_ANNOTATED are not implemented). */
export const OPERATOR_ACTION_IPO_CLOSED = "IPO_CLOSED";

/** Domain tag of `OperatorAction.payloadDigest` (design #38 section 3.2). */
export const LEDGER_OPERATOR_PAYLOAD_DOMAIN = "ipo-proof/ledger-operator-payload/v1";

/**
 * `payloadDigest` of an operator action: `sha256(canonicalJson({domain, payload}))` as lowercase
 * 0x-hex (32 bytes). `payload` is the event payload WITHOUT the sequencer-filled fields, so for
 * IPO_CLOSED it is `{closesAt}` (not `ledgerSeqAtClose`). It binds the signature to the payload:
 * the same signature cannot be attached to a different payload.
 */
export function operatorPayloadDigest(payload: Record<string, unknown>): string {
  return `0x${sha256CanonicalHex({ domain: LEDGER_OPERATOR_PAYLOAD_DOMAIN, payload })}`;
}

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
    { name: "actorId", type: "string" },
    { name: "action", type: "string" },
    { name: "ipoId", type: "string" },
    { name: "payloadDigest", type: "bytes32" },
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
  /** Operator principalId. */
  readonly actorId: string;
  readonly action: string;
  readonly ipoId: string;
  /** `operatorPayloadDigest(...)`: lowercase 0x-prefixed 32-byte hex. */
  readonly payloadDigest: string;
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
      encodeString(m.actorId, "actorId"),
      encodeString(m.action, "action"),
      encodeString(m.ipoId, "ipoId"),
      encodeBytes32(m.payloadDigest, "payloadDigest"),
      encodeString(m.requestNonce, "requestNonce"),
      encodeUint256(m.expiresAt, "expiresAt"),
    ]),
  );
}

/** keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function ledgerDigest(domainSeparator: Uint8Array, structHash: Uint8Array): Uint8Array {
  return keccak_256(concat([Uint8Array.of(0x19, 0x01), domainSeparator, structHash]));
}

const LEDGER_DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)";

/**
 * The ledger EIP-712 domain separator for one ledger instance. Besides name / version / chainId /
 * verifyingContract it carries the standard EIP-712 `salt` field = the ledger's genesis hash
 * (`ledgerGenesisHash(ledgerId)`), so a signature made for one ledger instance (staging vs
 * production, one IPO's ledger vs another) never verifies on another even if everything else in the
 * domain is equal (M-3). Throws `Eip712EncodingError`/`TypeError` for invalid input (deployment configuration).
 */
export function ledgerDomainSeparator(domain: Eip712Domain, ledgerId: string): Uint8Array {
  const genesis = ledgerGenesisHash(ledgerId);
  if (genesis === undefined) throw new TypeError("ledgerId must be a synthetic identifier");
  return keccak_256(
    concat([
      typeHash(LEDGER_DOMAIN_TYPE_STRING),
      encodeString(domain.name, "domain.name"),
      encodeString(domain.version, "domain.version"),
      encodeUint256(domain.chainId, "domain.chainId"),
      encodeAddress(domain.verifyingContract, "domain.verifyingContract"),
      encodeBytes32(`0x${genesis}`, "domain.salt"),
    ]),
  );
}

/** Digest as the lowercase 0x hex string that `AnnulmentApprovalMessage.annulmentDigest` carries. */
export function digestToHex(digest: Uint8Array): string {
  return hex(digest);
}
