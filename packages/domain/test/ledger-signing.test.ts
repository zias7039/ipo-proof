/** LedgerAction & friends: typed-data encoding against an independent implementation, domain separation, principal registry. */
import { describe, expect, it } from "vitest";
import {
  LEDGER_DOMAIN_NAME,
  LEDGER_EIP712_TYPES,
  digestToHex,
  hashAnnulmentApproval,
  hashLedgerAction,
  hashLedgerAnnulment,
  hashOperatorAction,
  ledgerDigest,
  ledgerDomainSeparator,
} from "../src/ledger/signing.js";
import { ATTESTATION_DOMAIN_NAME } from "../src/eip712.js";
import { Eip712EncodingError } from "../src/eip712-encoding.js";
import { PrincipalRole, annulmentConfigured, createPrincipalRegistry } from "../src/ledger/principals.js";
import { PRINCIPALS, LEDGER_TEST_DOMAIN, principals, viemDigest } from "./ledger-auth-fixtures.js";
import { syntheticAccount } from "./signing.js";

const dom = ledgerDomainSeparator(LEDGER_TEST_DOMAIN);
const HASH = `0x${"ab".repeat(32)}`;
const ACTION = { actorId: "manager_x", fundId: "fund_x", ipoId: "ipo_1", targetState: "PARTICIPATING", requestNonce: "req_1", expiresAt: 1_900_000_000_000 };
const ANNUL = { actorId: "manager_x", fundId: "fund_x", ipoId: "ipo_1", targetSeq: 5, targetEventHash: HASH, reason: "MISTAKEN_ENTRY", replacementState: "", requestNonce: "annul_1", expiresAt: 1_900_000_000_000 };
const APPROVAL = { approverId: "admin_1", annulmentDigest: HASH, requestNonce: "approval_1", expiresAt: 1_900_000_000_000 };
const OPERATOR = { action: "IPO_CLOSED", ipoId: "ipo_1", requestNonce: "close_1", expiresAt: 1_900_000_000_000 };

const big = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? BigInt(v) : v]));

describe("typed data matches an independent EIP-712 implementation (viem)", () => {
  it.each([
    ["LedgerAction", ACTION, () => hashLedgerAction(ACTION)],
    ["LedgerAnnulment", ANNUL, () => hashLedgerAnnulment(ANNUL)],
    ["AnnulmentApproval", APPROVAL, () => hashAnnulmentApproval(APPROVAL)],
    ["OperatorAction", OPERATOR, () => hashOperatorAction(OPERATOR)],
  ] as const)("%s digest", (name, message, hash) => {
    expect(digestToHex(ledgerDigest(dom, hash()))).toBe(viemDigest(name, big(message)));
  });

  it("the signed fields follow the design (§3.2) and contain no amount, capacity or exposure (principle E)", () => {
    expect(LEDGER_EIP712_TYPES.LedgerAction.map((f) => f.name)).toEqual(["actorId", "fundId", "ipoId", "targetState", "requestNonce", "expiresAt"]);
    expect(LEDGER_EIP712_TYPES.AnnulmentApproval.map((f) => f.name)).toEqual(["approverId", "annulmentDigest", "requestNonce", "expiresAt"]);
    const names = Object.values(LEDGER_EIP712_TYPES).flatMap((fields) => fields.map((f) => f.name.toLowerCase()));
    for (const n of names) expect(n, n).not.toMatch(/amount|krw|capacity|exposure|salt/);
  });
});

describe("domain and type separation", () => {
  it("the ledger domain is distinct from the attestation domain", () => {
    expect(LEDGER_DOMAIN_NAME).not.toBe(ATTESTATION_DOMAIN_NAME);
  });

  it("any change of name, version, chainId or verifyingContract changes the digest (L-07)", () => {
    const base = digestToHex(ledgerDigest(dom, hashLedgerAction(ACTION)));
    for (const d of [
      { ...LEDGER_TEST_DOMAIN, name: "other" },
      { ...LEDGER_TEST_DOMAIN, version: "2" },
      { ...LEDGER_TEST_DOMAIN, chainId: 1n },
      { ...LEDGER_TEST_DOMAIN, verifyingContract: `0x${"2".repeat(40)}` },
    ]) {
      expect(digestToHex(ledgerDigest(ledgerDomainSeparator(d), hashLedgerAction(ACTION)))).not.toBe(base);
    }
  });

  it("every field of every message is bound into the digest", () => {
    const cases: [Record<string, unknown>, (m: never) => Uint8Array][] = [
      [ACTION, hashLedgerAction as never],
      [ANNUL, hashLedgerAnnulment as never],
      [APPROVAL, hashAnnulmentApproval as never],
      [OPERATOR, hashOperatorAction as never],
    ];
    for (const [message, hash] of cases) {
      const base = digestToHex(hash(message as never));
      for (const [k, v] of Object.entries(message)) {
        const changed = typeof v === "number" ? v + 1 : v === HASH ? `0x${"cd".repeat(32)}` : `${String(v)}x`;
        expect(digestToHex(hash({ ...message, [k]: changed } as never)), k).not.toBe(base);
      }
    }
  });

  it("different request kinds never share a digest even with overlapping field values", () => {
    const digests = [
      digestToHex(ledgerDigest(dom, hashLedgerAction(ACTION))),
      digestToHex(ledgerDigest(dom, hashLedgerAnnulment(ANNUL))),
      digestToHex(ledgerDigest(dom, hashAnnulmentApproval(APPROVAL))),
      digestToHex(ledgerDigest(dom, hashOperatorAction(OPERATOR))),
    ];
    expect(new Set(digests).size).toBe(4);
  });

  it("malformed inputs raise Eip712EncodingError from the digest functions (the gate turns them into rejections)", () => {
    expect(() => hashLedgerAction({ ...ACTION, expiresAt: -1 })).toThrow(Eip712EncodingError);
    expect(() => hashLedgerAction({ ...ACTION, actorId: "\ud800" })).toThrow(Eip712EncodingError);
    expect(() => hashLedgerAnnulment({ ...ANNUL, targetEventHash: "0x12" })).toThrow(Eip712EncodingError);
    expect(() => hashLedgerAnnulment({ ...ANNUL, targetEventHash: HASH.toUpperCase().replace("0X", "0x") })).toThrow(Eip712EncodingError);
  });
});

describe("principal registry (never throws; bad configuration is a rejection)", () => {
  const e = (principalId: string, role: string, address: string, controllerId = `ctrl_${principalId}`) => ({ principalId, role, address, controllerId });
  const a1 = syntheticAccount("p_1").address;
  const a2 = syntheticAccount("p_2").address;

  it("registers principals and normalizes addresses to lowercase", () => {
    const r = createPrincipalRegistry([e("manager_x", "FUND_MANAGER", syntheticAccount("manager_x").address)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.registry.get("manager_x")?.address).toBe(syntheticAccount("manager_x").address.toLowerCase());
    expect(r.registry.get("nobody")).toBeUndefined();
  });

  it("the same signing key for two principals is rejected: PRINCIPAL_KEY_REUSE (L-38), in any case form", () => {
    expect(createPrincipalRegistry([e("p_1", "FUND_MANAGER", a1), e("p_2", "REGISTRY_ADMIN", a1)])).toEqual({ ok: false, reasonCode: "PRINCIPAL_KEY_REUSE" });
    expect(createPrincipalRegistry([e("p_1", "FUND_MANAGER", a1.toLowerCase()), e("p_2", "REGISTRY_ADMIN", a1)])).toEqual({ ok: false, reasonCode: "PRINCIPAL_KEY_REUSE" });
  });

  it("duplicate ids, bad roles/ids/addresses, zero address, bad checksum and a second operator are rejected", () => {
    expect(createPrincipalRegistry([e("p_1", "FUND_MANAGER", a1), e("p_1", "FUND_MANAGER", a2)])).toEqual({ ok: false, reasonCode: "PRINCIPAL_DUPLICATE" });
    const bad = [
      e("p_1", "KING", a1),
      e("Bad Id", "FUND_MANAGER", a1),
      e("p_1", "FUND_MANAGER", "0x1234"),
      e("p_1", "FUND_MANAGER", `0x${"0".repeat(40)}`),
      e("p_1", "FUND_MANAGER", `0x${"aB".repeat(20)}`),
      e("p_1", "FUND_MANAGER", a1, "Not Synthetic"),
    ];
    for (const entry of bad) expect(createPrincipalRegistry([entry]), JSON.stringify(entry)).toEqual({ ok: false, reasonCode: "PRINCIPAL_CONFIG_INVALID" });
    expect(createPrincipalRegistry([e("op_1", "LEDGER_OPERATOR", a1), e("op_2", "LEDGER_OPERATOR", a2)])).toEqual({ ok: false, reasonCode: "PRINCIPAL_CONFIG_INVALID" });
    expect(createPrincipalRegistry([null as never])).toEqual({ ok: false, reasonCode: "PRINCIPAL_CONFIG_INVALID" });
  });

  it("annulment is configured only with an operator and at least one admin that is not the operator (I5)", () => {
    expect(annulmentConfigured(principals())).toBe(true);
    expect(annulmentConfigured(principals(PRINCIPALS.filter((p) => p.role !== PrincipalRole.REGISTRY_ADMIN)))).toBe(false);
    expect(annulmentConfigured(principals(PRINCIPALS.filter((p) => p.role !== PrincipalRole.LEDGER_OPERATOR)))).toBe(false);
    // same self-reported controller for operator and admin => not independent
    const sameController = PRINCIPALS.map((p) => (p.role === PrincipalRole.REGISTRY_ADMIN ? { ...p, controllerId: "ctrl_operator_1" } : p));
    expect(annulmentConfigured(principals(sameController))).toBe(false);
    // one overlapping admin among several disables the feature (fail closed)
    const extraAdmin = { principalId: "admin_2", role: "REGISTRY_ADMIN", address: syntheticAccount("admin_2").address, controllerId: "ctrl_operator_1" };
    expect(annulmentConfigured(principals([...PRINCIPALS, extraAdmin]))).toBe(false);
  });
});
