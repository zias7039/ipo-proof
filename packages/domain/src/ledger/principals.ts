/**
 * Principal registry: who may sign ledger requests, in which role, with which key (design §3.2
 * "운용사 키 레지스트리", §4.1 roles, §4.5 independence data).
 *
 * Each principal has exactly one role, one signing address and one self-reported `controllerId`
 * (the label of whoever actually controls the key). `controllerId` is NOT verified by anything
 * (design P14-A06, Q14-N6): independence checks only compare these registered labels, ids and
 * keys. They cannot see one person holding several keys under different labels (T-16).
 *
 * Key rotation, revocation (R9) and quorum are NOT implemented: the registry is static.
 * Creation never throws: bad configuration returns a rejection (fail closed).
 */
import { normalizeSignerAddress } from "../eip712-encoding.js";
import { isSyntheticId } from "../model.js";

export const PrincipalRole = {
  FUND_MANAGER: "FUND_MANAGER",
  LEDGER_OPERATOR: "LEDGER_OPERATOR",
  /** Registry administrator: the only role that may approve an annulment (R10), if independent (R14). */
  REGISTRY_ADMIN: "REGISTRY_ADMIN",
} as const;
export type PrincipalRole = (typeof PrincipalRole)[keyof typeof PrincipalRole];

export interface Principal {
  readonly principalId: string;
  readonly role: PrincipalRole;
  /** Lowercase 0x-prefixed 20-byte address of the one key allowed to sign for this principal. */
  readonly address: string;
  /** Self-reported label of the party that controls the key. Not verified. */
  readonly controllerId: string;
}

export interface PrincipalRegistry {
  get(principalId: string): Principal | undefined;
  /** The single ledger operator (design D14-Q3), if configured. */
  operator(): Principal | undefined;
  admins(): readonly Principal[];
}

export const PrincipalRegistryRejection = {
  /** The same signing address is registered for more than one principal (L-38). */
  PRINCIPAL_KEY_REUSE: "PRINCIPAL_KEY_REUSE",
  /** The same principalId appears twice. */
  PRINCIPAL_DUPLICATE: "PRINCIPAL_DUPLICATE",
  /** Bad id, role, address (including zero or bad checksum), controllerId, or more than one operator. */
  PRINCIPAL_CONFIG_INVALID: "PRINCIPAL_CONFIG_INVALID",
} as const;
export type PrincipalRegistryRejection = (typeof PrincipalRegistryRejection)[keyof typeof PrincipalRegistryRejection];

export type PrincipalRegistryResult =
  | { readonly ok: true; readonly registry: PrincipalRegistry }
  | { readonly ok: false; readonly reasonCode: PrincipalRegistryRejection };

const ROLES: readonly string[] = Object.values(PrincipalRole);

export interface PrincipalInput {
  readonly principalId: string;
  readonly role: string;
  readonly address: string;
  readonly controllerId: string;
}

export function createPrincipalRegistry(entries: Iterable<PrincipalInput>): PrincipalRegistryResult {
  const fail = (reasonCode: PrincipalRegistryRejection): PrincipalRegistryResult => ({ ok: false, reasonCode });
  const byId = new Map<string, Principal>();
  const addresses = new Set<string>();
  try {
    for (const e of entries) {
      if (typeof e !== "object" || e === null) return fail(PrincipalRegistryRejection.PRINCIPAL_CONFIG_INVALID);
      const { principalId, role, address, controllerId } = e;
      if (!isSyntheticId(principalId) || !isSyntheticId(controllerId) || typeof role !== "string" || !ROLES.includes(role)) {
        return fail(PrincipalRegistryRejection.PRINCIPAL_CONFIG_INVALID);
      }
      if (typeof address !== "string") return fail(PrincipalRegistryRejection.PRINCIPAL_CONFIG_INVALID);
      const normalized = normalizeSignerAddress(address); // throws TypeError on bad/zero/bad-checksum
      if (byId.has(principalId)) return fail(PrincipalRegistryRejection.PRINCIPAL_DUPLICATE);
      if (addresses.has(normalized)) return fail(PrincipalRegistryRejection.PRINCIPAL_KEY_REUSE);
      byId.set(principalId, Object.freeze({ principalId, role: role as PrincipalRole, address: normalized, controllerId }));
      addresses.add(normalized);
    }
  } catch {
    return fail(PrincipalRegistryRejection.PRINCIPAL_CONFIG_INVALID);
  }
  const all = [...byId.values()];
  const operators = all.filter((p) => p.role === PrincipalRole.LEDGER_OPERATOR);
  if (operators.length > 1) return fail(PrincipalRegistryRejection.PRINCIPAL_CONFIG_INVALID);
  const operator = operators[0];
  const admins = Object.freeze(all.filter((p) => p.role === PrincipalRole.REGISTRY_ADMIN));
  return {
    ok: true,
    // frozen: nobody holding the registry can swap its methods after the gate was built (B-1)
    registry: Object.freeze({
      get: (principalId: string) => byId.get(principalId),
      operator: () => operator,
      admins: () => admins,
    }),
  };
}

/** Same principal by id, signing address or self-reported controller. */
export function sameParty(a: Principal, b: Principal): boolean {
  return a.principalId === b.principalId || a.address === b.address || a.controllerId === b.controllerId;
}

/**
 * I5 (design §4.5): the annulment feature is available only if an operator and at least one
 * registry admin are configured and NO admin is the same party as the operator. Otherwise it is
 * switched off (fail closed): a registry admin who is also the operator would approve their own
 * sequencing, which the design does not accept as an independent approval.
 */
export function annulmentConfigured(registry: PrincipalRegistry): boolean {
  const operator = registry.operator();
  const admins = registry.admins();
  if (operator === undefined || admins.length === 0) return false;
  return admins.every((a) => !sameParty(a, operator));
}

/**
 * I1-I4 for one annulment: the approver must not be the actor (I1), the two recovered signing
 * addresses and the registered addresses must differ and the approver's must differ from the
 * operator's (I2), the self-reported controllers must differ (I3), and the approver must not be
 * the operator (I4, by id, address and controller). Returns true only if all hold.
 */
export function approverIsIndependent(args: {
  readonly actor: Principal;
  readonly approver: Principal;
  readonly operator: Principal | undefined;
  readonly recoveredActor: string;
  readonly recoveredApprover: string;
}): boolean {
  const { actor, approver, operator, recoveredActor, recoveredApprover } = args;
  if (operator === undefined) return false; // cannot show independence from an unknown operator
  return (
    approver.principalId !== actor.principalId && // I1
    recoveredApprover !== recoveredActor && // I2
    approver.address !== actor.address &&
    approver.address !== operator.address &&
    recoveredApprover !== operator.address &&
    approver.controllerId !== actor.controllerId && // I3
    !sameParty(approver, operator) // I4
  );
}
