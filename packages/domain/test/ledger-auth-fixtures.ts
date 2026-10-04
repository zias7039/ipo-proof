/**
 * Fixtures for the authorized-ledger tests. Signing goes through viem (an implementation
 * independent of src/ledger/signing.ts), so a passing round trip also cross-checks the encoding.
 * All keys are synthetic (derived from public labels, see signing.ts); no real identities.
 */
import { hashTypedData } from "viem";
import type { Eip712Domain } from "../src/eip712.js";
import { AuthorizedLedger } from "../src/ledger/authorized.js";
import type { LedgerEvent } from "../src/ledger/events.js";
import type { AuthorizedLedgerConfig } from "../src/ledger/authorized.js";
import { ledgerGenesisHash } from "../src/ledger/events.js";
import { LEDGER_DOMAIN_NAME, LEDGER_DOMAIN_VERSION, LEDGER_EIP712_TYPES, LedgerScheme, operatorPayloadDigest } from "../src/ledger/signing.js";
import { PrincipalRole, createPrincipalRegistry } from "../src/ledger/principals.js";
import type { PrincipalInput, PrincipalRegistry } from "../src/ledger/principals.js";
import { InMemoryFundRegistry, InMemoryIpoRegistry } from "../src/registry.js";
import { HOUR, NOW } from "./fixtures.js";
import { def } from "./ledger-fixtures.js";
import { syntheticAccount, viemDomain } from "./signing.js";
import type { Hex } from "./signing.js";

export const LEDGER_TEST_DOMAIN: Eip712Domain = {
  name: LEDGER_DOMAIN_NAME,
  version: LEDGER_DOMAIN_VERSION,
  chainId: 31337n,
  verifyingContract: `0x${"1".repeat(38)}ed`,
};

export const LEDGER_TEST_ID = "ledger_test";
/** Longest accepted request lifetime in the test world: 14 days (FAR is 10 days ahead). */
export const TEST_MAX_TTL_MS = 14 * 24 * HOUR;

/** viem form of the ledger domain: the four domain fields plus `salt` = genesis hash of the ledger id (M-3). */
export function ledgerViemDomain(domain: Eip712Domain, ledgerId: string = LEDGER_TEST_ID) {
  const genesis = ledgerGenesisHash(ledgerId);
  if (genesis === undefined) throw new Error("bad ledger id in fixture");
  return { ...viemDomain(domain), salt: `0x${genesis}` as Hex };
}

export const CLOSES_AT = NOW + 24 * HOUR;
export const FAR = NOW + 10 * 24 * HOUR;

const P = (principalId: string, role: string, controllerId = `ctrl_${principalId}`): PrincipalInput => ({
  principalId,
  role,
  address: syntheticAccount(principalId).address,
  controllerId,
});

export const PRINCIPALS: PrincipalInput[] = [
  P("manager_x", PrincipalRole.FUND_MANAGER),
  P("manager_y", PrincipalRole.FUND_MANAGER),
  P("operator_1", PrincipalRole.LEDGER_OPERATOR),
  P("admin_1", PrincipalRole.REGISTRY_ADMIN),
];

export function principals(entries: PrincipalInput[] = PRINCIPALS): PrincipalRegistry {
  const r = createPrincipalRegistry(entries);
  if (!r.ok) throw new Error(`fixture principals rejected: ${r.reasonCode}`);
  return r.registry;
}

export interface AuthWorld {
  readonly ledger: AuthorizedLedger;
  readonly clock: { t: number };
}

export function makeAuthWorld(o: { principals?: PrincipalRegistry; config?: Partial<AuthorizedLedgerConfig>; start?: number } = {}): AuthWorld {
  const clock = { t: o.start ?? NOW };
  const ledger = new AuthorizedLedger({
    now: () => clock.t,
    domain: LEDGER_TEST_DOMAIN,
    principals: o.principals ?? principals(),
    funds: new InMemoryFundRegistry([
      { fundId: "fund_x", managerId: "manager_x", underlyingFundIds: [] },
      { fundId: "fund_y", managerId: "manager_y", underlyingFundIds: [] },
      { fundId: "fund_z", managerId: "manager_x", underlyingFundIds: [] },
    ]),
    ipos: new InMemoryIpoRegistry([
      { ipoId: "ipo_1", subscriptionOpensAt: NOW - 24 * HOUR, subscriptionClosesAt: CLOSES_AT },
      { ipoId: "ipo_2", subscriptionOpensAt: NOW - 24 * HOUR, subscriptionClosesAt: CLOSES_AT },
    ]),
    registrySeq: 1,
    ledgerId: LEDGER_TEST_ID,
    maxRequestTtlMs: TEST_MAX_TTL_MS,
    ...o.config,
  });
  return { ledger, clock };
}

/** Signs `message` as `primaryType` with the synthetic key of `signer`. */
export async function signTyped(
  signer: string,
  primaryType: keyof typeof LEDGER_EIP712_TYPES,
  message: Record<string, unknown>,
  domain: Eip712Domain = LEDGER_TEST_DOMAIN,
  ledgerId: string = LEDGER_TEST_ID,
): Promise<string> {
  return syntheticAccount(signer).signTypedData({
    domain: ledgerViemDomain(domain, ledgerId),
    types: { [primaryType]: LEDGER_EIP712_TYPES[primaryType] },
    primaryType,
    message,
  } as never);
}

/** The EIP-712 digest (independent implementation) of a message. */
export function viemDigest(primaryType: keyof typeof LEDGER_EIP712_TYPES, message: Record<string, unknown>, domain: Eip712Domain = LEDGER_TEST_DOMAIN, ledgerId: string = LEDGER_TEST_ID): Hex {
  return hashTypedData({
    domain: ledgerViemDomain(domain, ledgerId),
    types: { [primaryType]: LEDGER_EIP712_TYPES[primaryType] },
    primaryType,
    message,
  } as never);
}

const big = (n: number): bigint => BigInt(n);

/**
 * Default nonces are unique per built request: a request rejected by the domain rules now consumes
 * its nonce (M-1), so tests that send several requests must not share one by accident. Tests that
 * need a shared or repeated nonce pass it explicitly.
 */
let nonceCounter = 0;
const fresh = (prefix: string): string => `${prefix}_${++nonceCounter}`;

export interface RecordOpts {
  actor?: string;
  signer?: string;
  fund?: string;
  ipo?: string;
  state?: "PARTICIPATING" | "NON_PARTICIPATION_LOCKED";
  nonce?: string;
  expiresAt?: number;
  domain?: Eip712Domain;
  /** Ledger id the signature is made for (default: the test ledger). */
  ledgerId?: string;
  /** Values that are signed but NOT what is sent (to simulate tampering after signing). */
  signed?: Partial<{ actorId: string; fundId: string; ipoId: string; targetState: string; requestNonce: string; expiresAt: number }>;
  scheme?: string;
  registrySeq?: number;
  extra?: Record<string, unknown>;
  payloadExtra?: Record<string, unknown>;
}

export async function recordDraft(o: RecordOpts = {}): Promise<Record<string, unknown>> {
  const actor = o.actor ?? "manager_x";
  const fund = o.fund ?? "fund_x";
  const ipo = o.ipo ?? "ipo_1";
  const state = o.state ?? "PARTICIPATING";
  const nonce = o.nonce ?? fresh("req");
  const expiresAt = o.expiresAt ?? FAR;
  const s = o.signed ?? {};
  const signature = await signTyped(
    o.signer ?? actor,
    "LedgerAction",
    {
      actorId: s.actorId ?? actor,
      fundId: s.fundId ?? fund,
      ipoId: s.ipoId ?? ipo,
      targetState: s.targetState ?? state,
      requestNonce: s.requestNonce ?? nonce,
      expiresAt: big(s.expiresAt ?? expiresAt),
    },
    o.domain,
    o.ledgerId,
  );
  return {
    eventType: state === "PARTICIPATING" ? "PARTICIPATION_RECORDED" : "NON_PARTICIPATION_LOCKED_RECORDED",
    ipoId: ipo,
    subjectFundId: fund,
    actorId: actor,
    authorization: { scheme: o.scheme ?? LedgerScheme.LEDGER_ACTION, requestNonce: nonce, expiresAt, signature },
    coAuthorizations: [],
    payload: { from: "UNKNOWN", to: state, origin: "INDEPENDENT", ...o.payloadExtra },
    registrySeq: o.registrySeq ?? 1,
    requestedAt: NOW,
    ...o.extra,
  };
}

export interface AnnulOpts {
  actor?: string;
  signer?: string;
  fund?: string;
  ipo?: string;
  reason?: "MISTAKEN_ENTRY" | "KEY_COMPROMISE";
  replacement?: "PARTICIPATING" | "NON_PARTICIPATION_LOCKED" | null;
  nonce?: string;
  expiresAt?: number;
  /** Approver. `null` = no approval at all. */
  approver?: string | null;
  approverSigner?: string;
  approvalNonce?: string;
  approvalExpiresAt?: number;
  approvalScheme?: string;
  /** Make the approval cover a different annulment digest. */
  approvalDigestOverride?: string;
  registrySeq?: number;
  signed?: Partial<{ targetSeq: number; replacementState: string; reason: string }>;
}

export async function annulDraft(target: { seq: number; eventHash: string }, o: AnnulOpts = {}): Promise<Record<string, unknown>> {
  const actor = o.actor ?? "manager_x";
  const fund = o.fund ?? "fund_x";
  const ipo = o.ipo ?? "ipo_1";
  const nonce = o.nonce ?? fresh("annul");
  const expiresAt = o.expiresAt ?? FAR;
  const replacement = o.replacement ?? null;
  const reason = o.reason ?? "MISTAKEN_ENTRY";
  const message = {
    actorId: actor,
    fundId: fund,
    ipoId: ipo,
    targetSeq: big(o.signed?.targetSeq ?? target.seq),
    targetEventHash: `0x${target.eventHash}`,
    reason: o.signed?.reason ?? reason,
    replacementState: o.signed?.replacementState ?? replacement ?? "",
    requestNonce: nonce,
    expiresAt: big(expiresAt),
  };
  const signature = await signTyped(o.signer ?? actor, "LedgerAnnulment", message);
  const approver = o.approver === undefined ? "admin_1" : o.approver;
  const coAuthorizations: unknown[] = [];
  if (approver !== null) {
    const approvalNonce = o.approvalNonce ?? fresh("approval");
    const approvalExpiresAt = o.approvalExpiresAt ?? FAR;
    const approvalSignature = await signTyped(o.approverSigner ?? approver, "AnnulmentApproval", {
      approverId: approver,
      annulmentDigest: o.approvalDigestOverride ?? viemDigest("LedgerAnnulment", message),
      requestNonce: approvalNonce,
      expiresAt: big(approvalExpiresAt),
    });
    coAuthorizations.push({
      approverId: approver,
      scheme: o.approvalScheme ?? LedgerScheme.ANNULMENT_APPROVAL,
      requestNonce: approvalNonce,
      expiresAt: approvalExpiresAt,
      signature: approvalSignature,
    });
  }
  return {
    eventType: "EVENT_ANNULLED",
    ipoId: ipo,
    subjectFundId: fund,
    actorId: actor,
    authorization: { scheme: LedgerScheme.LEDGER_ANNULMENT, requestNonce: nonce, expiresAt, signature },
    coAuthorizations,
    payload: { targetSeq: target.seq, targetEventHash: target.eventHash, reason, replacement },
    registrySeq: o.registrySeq ?? 1,
    requestedAt: NOW,
  };
}

export async function closeDraft(o: { actor?: string; signer?: string; ipo?: string; nonce?: string; closesAt?: number; ledgerSeqAtClose: number; signedIpo?: string; signedClosesAt?: number; signedActor?: string; expiresAt?: number }): Promise<Record<string, unknown>> {
  const actor = o.actor ?? "operator_1";
  const ipo = o.ipo ?? "ipo_1";
  const nonce = o.nonce ?? fresh("close");
  const expiresAt = o.expiresAt ?? FAR;
  const signature = await signTyped(o.signer ?? actor, "OperatorAction", {
    actorId: o.signedActor ?? actor,
    action: "IPO_CLOSED",
    ipoId: o.signedIpo ?? ipo,
    payloadDigest: operatorPayloadDigest({ closesAt: o.signedClosesAt ?? o.closesAt ?? CLOSES_AT }),
    requestNonce: nonce,
    expiresAt: big(expiresAt),
  });
  return {
    eventType: "IPO_CLOSED",
    ipoId: ipo,
    subjectFundId: null,
    actorId: actor,
    authorization: { scheme: LedgerScheme.OPERATOR_ACTION, requestNonce: nonce, expiresAt, signature },
    coAuthorizations: [],
    payload: { closesAt: o.closesAt ?? CLOSES_AT, ledgerSeqAtClose: o.ledgerSeqAtClose },
    registrySeq: 1,
    requestedAt: NOW,
  };
}

/** Appends via the gate or fails the test loudly. */
export function mustSubmit(ledger: AuthorizedLedger, request: unknown): LedgerEvent[] {
  const r = ledger.submit(request);
  if (!r.ok) throw new Error(`fixture submit rejected: ${r.reasonCode}`);
  return r.events.map((e) => def(e));
}

export const ok = { ok: true };
export const rej = (reasonCode: string) => ({ ok: false, reasonCode });
