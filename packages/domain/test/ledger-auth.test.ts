/**
 * AuthorizedLedger: authentication (R2-R4), authorization (R1, R5, R8, R10, R14) and the
 * pass-through of the ledger's domain rules (R6, R7, R11-R13). Design acceptance cases L-01..L-12,
 * L-19, L-22..L-31, L-34..L-38. Out of scope here and asserted as rejections: R15, BIND-1.
 */
import { describe, expect, it } from "vitest";
import { AuthorizedLedger } from "../src/ledger/authorized.js";
import { verifyChain } from "../src/ledger/chain.js";
import { PrincipalRole, approverIsIndependent, createPrincipalRegistry } from "../src/ledger/principals.js";
import type { Principal, PrincipalRegistry } from "../src/ledger/principals.js";
import { toHighS, withV, syntheticAccount } from "./signing.js";
import {
  CLOSES_AT,
  LEDGER_TEST_DOMAIN,
  PRINCIPALS,
  annulDraft,
  closeDraft,
  makeAuthWorld,
  mustSubmit,
  principals,
  recordDraft,
  rej,
  signTyped,
} from "./ledger-auth-fixtures.js";
import { HOUR, NOW } from "./fixtures.js";
import { InMemoryFundRegistry } from "../src/registry.js";
import { def, plain } from "./ledger-fixtures.js";

const sub = (w: ReturnType<typeof makeAuthWorld>, r: unknown) => w.ledger.submit(r);

describe("L-01: a registered manager records its own fund with a valid signature", () => {
  it("appends the event and updates the state; the chain verifies; the event carries the signed authorization", async () => {
    const w = makeAuthWorld();
    const draft = await recordDraft();
    const r = sub(w, draft);
    expect(r).toMatchObject({ ok: true, replayed: false });
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
    const [e] = w.ledger.events();
    expect(e).toMatchObject({ seq: 1, actorId: "manager_x", eventType: "PARTICIPATION_RECORDED", recordedAt: NOW });
    expect(e?.authorization).toEqual((draft as { authorization: unknown }).authorization);
    expect(verifyChain(plain(w.ledger.events())).ok).toBe(true);
    expect(await sub(w, await recordDraft({ fund: "fund_z", nonce: "req_2", state: "NON_PARTICIPATION_LOCKED" }))).toMatchObject({ ok: true });
    expect(w.ledger.getState("fund_z", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
  });

  it("the gate has no write path around it: the inner ledger and the nonce table are not reachable", () => {
    const w = makeAuthWorld();
    const l = w.ledger as unknown as Record<string, unknown>;
    const names = [...Object.getOwnPropertyNames(l), ...Object.getOwnPropertyNames(Object.getPrototypeOf(l) as object)];
    for (const n of names) expect(n, n).not.toMatch(/^(append|appendAtomic|ledger|consumed|clockValue)$/);
    expect(l["submit"]).toBeTypeOf("function");
  });
});

describe("authentication: signature forgery, tampering and replay across contexts (L-03, L-05..L-07)", () => {
  it("rejects a signature by a key that is not the actor's: another principal's key, an unregistered key", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ signer: "manager_y" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await recordDraft({ signer: "stranger_key" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(0);
  });

  it("rejects an unregistered actor id even with a valid signature by its own key (LEDGER_ACTOR_UNKNOWN)", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ actor: "manager_ghost" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
  });

  it.each([
    ["targetState", { targetState: "NON_PARTICIPATION_LOCKED" }],
    ["fund", { fundId: "fund_z" }],
    ["ipo", { ipoId: "ipo_2" }],
    ["actor", { actorId: "manager_y" }],
    ["requestNonce", { requestNonce: "req_999" }],
    ["expiresAt", { expiresAt: 1_999_999_999_999 }],
  ])("a signature over a different %s does not authorize this request (L-03, L-06)", async (_name, signed) => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ signed }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(0);
  });

  it("the signature of a PARTICIPATING request cannot be used for a LOCKED event (event type reuse)", async () => {
    const w = makeAuthWorld();
    const p = (await recordDraft()) as { authorization: unknown };
    const locked = { ...(await recordDraft({ state: "NON_PARTICIPATION_LOCKED" })), authorization: p.authorization };
    expect(sub(w, locked)).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
  });

  it("a signature for another typed-data kind cannot be reused: LedgerAction as annulment/close, OperatorAction as record (L-07)", async () => {
    const w = makeAuthWorld();
    const [p] = mustSubmit(w.ledger, await recordDraft());
    const action = (await recordDraft({ nonce: "req_5", fund: "fund_z" })) as { authorization: { signature: string } };
    const annul = await annulDraft(def(p));
    const swapped = { ...annul, authorization: { ...(annul as { authorization: object }).authorization, signature: action.authorization.signature } };
    expect(sub(w, swapped)).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    const close = await closeDraft({ ledgerSeqAtClose: 1 });
    const closeWithAction = { ...close, authorization: { ...(close as { authorization: object }).authorization, signature: action.authorization.signature } };
    w.clock.t = CLOSES_AT;
    expect(sub(w, closeWithAction)).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
  });

  it("a signature made under another domain verifies nowhere here: name, version, chainId, verifyingContract (L-07)", async () => {
    const w = makeAuthWorld();
    for (const domain of [
      { ...LEDGER_TEST_DOMAIN, name: "ipo-proof CapacityAttestation" },
      { ...LEDGER_TEST_DOMAIN, version: "2" },
      { ...LEDGER_TEST_DOMAIN, chainId: 1n },
      { ...LEDGER_TEST_DOMAIN, verifyingContract: `0x${"2".repeat(40)}` },
    ]) {
      expect(sub(w, await recordDraft({ domain })), JSON.stringify(domain, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    }
    expect(w.ledger.events().length).toBe(0);
  });

  it("non-canonical or malformed signatures are rejected: high-s, v of 0/1, wrong length, not hex, empty, unverified placeholder", async () => {
    const w = makeAuthWorld();
    const good = (await recordDraft()) as { authorization: { signature: string } };
    const sig = good.authorization.signature;
    const variants = [toHighS(sig), withV(sig, 0), withV(sig, 1), withV(sig, 29), sig.slice(0, -2), `${sig}00`, `0x${"zz".repeat(65)}`, sig.slice(2)];
    for (const signature of variants) {
      const d = { ...good, authorization: { ...good.authorization, signature } };
      const r = sub(w, d);
      expect(r.ok, signature.slice(0, 20)).toBe(false);
    }
    expect(sub(w, { ...good, authorization: { ...good.authorization, signature: "0x" + "ab".repeat(65) } })).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(0);
  });

  it("an upper-case hex signature of the same bytes is the same signature", async () => {
    const w = makeAuthWorld();
    const d = (await recordDraft()) as { authorization: { signature: string } };
    const upper = `0x${d.authorization.signature.slice(2).toUpperCase()}`;
    expect(sub(w, { ...d, authorization: { ...d.authorization, signature: upper } })).toMatchObject({ ok: true });
  });

  it("authorization.scheme must match the event type", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ scheme: "EIP712_LEDGER_ANNULMENT_V1" }))).toEqual(rej("LEDGER_AUTH_SCHEME_MISMATCH"));
    expect(sub(w, await recordDraft({ scheme: "EIP712_OPERATOR_ACTION_V1" }))).toEqual(rej("LEDGER_AUTH_SCHEME_MISMATCH"));
  });
});

describe("R3 expiry, R4 nonce / idempotency (L-04, L-05, L-08, L-26)", () => {
  it("expiresAt must be strictly in the future of the sequencer clock", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ expiresAt: NOW }))).toEqual(rej("LEDGER_REQUEST_EXPIRED"));
    expect(sub(w, await recordDraft({ expiresAt: NOW - 1 }))).toEqual(rej("LEDGER_REQUEST_EXPIRED"));
    expect(sub(w, await recordDraft({ expiresAt: NOW + 1 }))).toMatchObject({ ok: true });
    w.clock.t = NOW + 1;
    expect(sub(w, await recordDraft({ fund: "fund_z", nonce: "req_2", expiresAt: NOW + 1 }))).toEqual(rej("LEDGER_REQUEST_EXPIRED"));
  });

  it("an identical signed request sent twice returns the first result and adds no event (L-04)", async () => {
    const w = makeAuthWorld();
    const d = await recordDraft();
    const first = sub(w, d);
    const second = sub(w, d);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true });
    expect(second.ok && first.ok && second.events).toEqual(first.ok && first.events);
    expect(w.ledger.events().length).toBe(1);
  });

  it("the same nonce with different content is a replay: LEDGER_NONCE_REPLAY (L-05)", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft());
    const other = await recordDraft({ fund: "fund_z", state: "NON_PARTICIPATION_LOCKED" }); // same nonce req_1
    expect(sub(w, other)).toEqual(rej("LEDGER_NONCE_REPLAY"));
    expect(w.ledger.events().length).toBe(1);
  });

  it("nonces are scoped per principal", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "shared" }));
    expect(sub(w, await recordDraft({ actor: "manager_y", fund: "fund_y", nonce: "shared" }))).toMatchObject({ ok: true });
  });

  it("a rejected request does not consume its nonce", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    expect(sub(w, await recordDraft({ nonce: "b", state: "NON_PARTICIPATION_LOCKED" }))).toEqual(rej("PARTICIPATION_ALREADY_RECORDED"));
    expect(sub(w, await recordDraft({ nonce: "b", fund: "fund_z" }))).toMatchObject({ ok: true });
  });

  it("an expired resend is expired, not idempotent (R3 before R4)", async () => {
    const w = makeAuthWorld();
    const d = await recordDraft({ expiresAt: NOW + 10 });
    mustSubmit(w.ledger, d);
    w.clock.t = NOW + 10;
    expect(sub(w, d)).toEqual(rej("LEDGER_REQUEST_EXPIRED"));
  });
});

describe("R1 / R5 authorization (L-02, L-09, L-10)", () => {
  it("another manager, the operator and the admin cannot record someone else's fund (no proxy recording, T-02)", async () => {
    const w = makeAuthWorld();
    for (const actor of ["manager_y", "operator_1", "admin_1"]) {
      expect(sub(w, await recordDraft({ actor, nonce: `n_${actor}` })), actor).toEqual(rej("LEDGER_ACTOR_NOT_FUND_MANAGER"));
    }
    expect(w.ledger.events().length).toBe(0);
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
  });

  it("unregistered fund or IPO is rejected only after the signature checks out (no existence leak to invalid callers, L-09)", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ fund: "fund_ghost" }))).toEqual(rej("FUND_NOT_REGISTERED"));
    expect(sub(w, await recordDraft({ ipo: "ipo_ghost" }))).toEqual(rej("IPO_NOT_FOUND"));
    expect(sub(w, await recordDraft({ fund: "fund_ghost", signer: "stranger_key" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await recordDraft({ ipo: "ipo_ghost", signer: "stranger_key" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
  });

  it("a registered fund whose registry manager differs from the signer is refused even if the signer is a manager", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ actor: "manager_x", fund: "fund_y" }))).toEqual(rej("LEDGER_ACTOR_NOT_FUND_MANAGER"));
  });

  it("role is checked as well as identity: a fund wrongly registered to a non-manager principal still cannot be recorded by it", async () => {
    const w = makeAuthWorld({ config: { funds: new InMemoryFundRegistry([{ fundId: "fund_x", managerId: "operator_1", underlyingFundIds: [] }]) } });
    expect(sub(w, await recordDraft({ actor: "operator_1" }))).toEqual(rej("LEDGER_ACTOR_NOT_FUND_MANAGER"));
    expect(w.ledger.events().length).toBe(0);
  });

  it("transition rules still apply through the gate: repeats and reversals are rejected with the existing reasons (L-10)", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    mustSubmit(w.ledger, await recordDraft({ nonce: "b", fund: "fund_z", state: "NON_PARTICIPATION_LOCKED" }));
    const head = w.ledger.headHash();
    expect(sub(w, await recordDraft({ nonce: "c", state: "NON_PARTICIPATION_LOCKED" }))).toEqual(rej("PARTICIPATION_ALREADY_RECORDED"));
    expect(sub(w, await recordDraft({ nonce: "d" }))).toEqual(rej("PARTICIPATION_ALREADY_RECORDED"));
    expect(sub(w, await recordDraft({ nonce: "e", fund: "fund_z" }))).toEqual(rej("NON_PARTICIPATION_LOCK_ACTIVE"));
    expect(w.ledger.headHash()).toBe(head);
  });

  it("the request must claim the registry version the gate uses (registrySeq is an audit field, not caller-chosen)", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await recordDraft({ registrySeq: 2 }))).toEqual(rej("LEDGER_REGISTRY_SEQ_MISMATCH"));
  });
});

describe("R8: IPO_CLOSED (L-11, L-12, L-19)", () => {
  it("only the operator, only once the clock reached the IPO's closing time, only once per IPO", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft());
    expect(sub(w, await closeDraft({ ledgerSeqAtClose: 1 }))).toEqual(rej("IPO_NOT_YET_CLOSABLE"));
    w.clock.t = CLOSES_AT - 1;
    expect(sub(w, await closeDraft({ ledgerSeqAtClose: 1 }))).toEqual(rej("IPO_NOT_YET_CLOSABLE"));
    w.clock.t = CLOSES_AT;
    expect(sub(w, await closeDraft({ actor: "manager_x", ledgerSeqAtClose: 1 }))).toEqual(rej("LEDGER_OPERATOR_REQUIRED"));
    expect(sub(w, await closeDraft({ actor: "admin_1", ledgerSeqAtClose: 1 }))).toEqual(rej("LEDGER_OPERATOR_REQUIRED"));
    expect(sub(w, await closeDraft({ ledgerSeqAtClose: 1 }))).toMatchObject({ ok: true });
    expect(w.ledger.isClosed("ipo_1")).toBe(true);
    expect(w.ledger.cutoffSeq("ipo_1")).toBe(1);
    expect(sub(w, await closeDraft({ nonce: "close_2", ledgerSeqAtClose: 2 }))).toEqual(rej("IPO_ALREADY_CLOSED"));
  });

  it("closesAt must be the IPO's registered closing time; ledgerSeqAtClose must be seq - 1; the IPO must exist", async () => {
    const w = makeAuthWorld();
    w.clock.t = CLOSES_AT;
    expect(sub(w, await closeDraft({ closesAt: 0, ledgerSeqAtClose: 0 }))).toEqual(rej("LEDGER_CLOSE_TIME_MISMATCH"));
    expect(sub(w, await closeDraft({ ledgerSeqAtClose: 5 }))).toEqual(rej("LEDGER_CLOSE_SEQ_MISMATCH"));
    expect(sub(w, await closeDraft({ ipo: "ipo_ghost", ledgerSeqAtClose: 0 }))).toEqual(rej("IPO_NOT_FOUND"));
  });

  it("an operator signature for ipo_1 does not close ipo_2", async () => {
    const w = makeAuthWorld();
    w.clock.t = CLOSES_AT;
    expect(sub(w, await closeDraft({ ipo: "ipo_2", signedIpo: "ipo_1", ledgerSeqAtClose: 0 }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
  });

  it("after the close, state events and corrections are rejected; a back-dated requestedAt changes nothing (L-11, L-19)", async () => {
    const w = makeAuthWorld();
    const [p] = mustSubmit(w.ledger, await recordDraft());
    w.clock.t = CLOSES_AT;
    mustSubmit(w.ledger, await closeDraft({ ledgerSeqAtClose: 1 }));
    const head = w.ledger.headHash();
    expect(sub(w, await recordDraft({ nonce: "late", fund: "fund_z", extra: { requestedAt: 1 } }))).toEqual(rej("IPO_ALREADY_CLOSED"));
    expect(sub(w, await annulDraft(def(p), { nonce: "late_annul" }))).toEqual(rej("IPO_ALREADY_CLOSED"));
    expect(w.ledger.headHash()).toBe(head);
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
  });
});

describe("R10: corrections need the manager's LedgerAnnulment AND an independent approver (L-22..L-29)", () => {
  async function withP() {
    const w = makeAuthWorld();
    const [p] = mustSubmit(w.ledger, await recordDraft());
    return { w, p: def(p) };
  }

  it("L-22: manager + admin sign; state returns to UNKNOWN; the old event and the chain stay intact", async () => {
    const { w, p } = await withP();
    const r = sub(w, await annulDraft(p));
    expect(r).toMatchObject({ ok: true });
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
    expect(w.ledger.getStateAt("fund_x", "ipo_1", 1)).toBe("PARTICIPATING");
    expect(w.ledger.getStateAt("fund_x", "ipo_1", 2)).toBe("UNKNOWN");
    expect(w.ledger.events()[0]).toBe(p);
    expect(verifyChain(plain(w.ledger.events()))).toMatchObject({ ok: true, length: 2 });
  });

  it("L-23: manager signature without an approver -> LEDGER_ANNUL_COSIGN_REQUIRED, ledger unchanged", async () => {
    const { w, p } = await withP();
    const head = w.ledger.headHash();
    expect(sub(w, await annulDraft(p, { approver: null }))).toEqual(rej("LEDGER_ANNUL_COSIGN_REQUIRED"));
    expect(w.ledger.headHash()).toBe(head);
  });

  it("L-23: an approval without a valid manager signature is not enough", async () => {
    const { w, p } = await withP();
    expect(sub(w, await annulDraft(p, { signer: "stranger_key" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await annulDraft(p, { actor: "manager_ghost" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
  });

  it("the cosign requirement is only reached by a valid manager: a forged manager signature gets SIGNATURE_INVALID, not COSIGN_REQUIRED", async () => {
    const { w, p } = await withP();
    expect(sub(w, await annulDraft(p, { signer: "stranger_key", approver: null }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
  });

  it("L-24: another manager cannot correct this fund's event, even with a valid approval", async () => {
    const { w, p } = await withP();
    expect(sub(w, await annulDraft(p, { actor: "manager_y" }))).toEqual(rej("LEDGER_ACTOR_NOT_FUND_MANAGER"));
  });

  it("the approval is bound to this exact annulment: approvals over another digest, target, replacement or reason fail", async () => {
    const { w, p } = await withP();
    const other = await annulDraft(p, { nonce: "other", replacement: "NON_PARTICIPATION_LOCKED" }); // different annulment
    const otherApproval = (other as { coAuthorizations: unknown[] }).coAuthorizations;
    const base = await annulDraft(p);
    expect(sub(w, { ...base, coAuthorizations: otherApproval })).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await annulDraft(p, { approvalDigestOverride: `0x${"00".repeat(32)}` }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    // manager signature over other values than those sent
    expect(sub(w, await annulDraft(p, { signed: { replacementState: "PARTICIPATING" } }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await annulDraft(p, { signed: { reason: "KEY_COMPROMISE" } }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await annulDraft(p, { signed: { targetSeq: 2 } }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(1);
  });

  it("approval problems: signed with another key, unknown approver, wrong scheme, expired, nonce already used", async () => {
    const { w, p } = await withP();
    expect(sub(w, await annulDraft(p, { approverSigner: "stranger_key" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await annulDraft(p, { approver: "admin_ghost" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(sub(w, await annulDraft(p, { approvalScheme: "EIP712_LEDGER_ACTION_V1" }))).toEqual(rej("LEDGER_AUTH_SCHEME_MISMATCH"));
    expect(sub(w, await annulDraft(p, { approvalExpiresAt: NOW }))).toEqual(rej("LEDGER_REQUEST_EXPIRED"));
    expect(w.ledger.events().length).toBe(1);

    // an approval nonce can be used once
    mustSubmit(w.ledger, await annulDraft(p, { approvalNonce: "ap_1", nonce: "an_1" }));
    const [again] = mustSubmit(w.ledger, await recordDraft({ nonce: "r_2" }));
    expect(sub(w, await annulDraft(def(again), { approvalNonce: "ap_1", nonce: "an_2" }))).toEqual(rej("LEDGER_NONCE_REPLAY"));
  });

  it("an approver who is not a registry admin is refused (a second manager, the operator)", async () => {
    const { w, p } = await withP();
    expect(sub(w, await annulDraft(p, { approver: "manager_y" }))).toEqual(rej("LEDGER_ANNUL_APPROVER_NOT_AUTHORIZED"));
    expect(sub(w, await annulDraft(p, { approver: "operator_1" }))).toEqual(rej("LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT")); // I4
    expect(w.ledger.events().length).toBe(1);
  });

  it("L-26: resending the same correction is idempotent; the same nonce with another target is a replay", async () => {
    const { w, p } = await withP();
    const d = await annulDraft(p);
    expect(sub(w, d)).toMatchObject({ ok: true, replayed: false });
    expect(sub(w, d)).toMatchObject({ ok: true, replayed: true });
    expect(w.ledger.events().length).toBe(2);
    const [q] = mustSubmit(w.ledger, await recordDraft({ nonce: "r_9" }));
    expect(sub(w, await annulDraft(def(q), { nonce: "annul_1", approvalNonce: "approval_9" }))).toEqual(rej("LEDGER_NONCE_REPLAY"));
  });

  it("L-27: invalid targets are rejected by the ledger rules (stale target, wrong hash)", async () => {
    const { w, p } = await withP();
    expect(sub(w, await annulDraft({ seq: p.seq, eventHash: "c".repeat(64) }))).toEqual(rej("LEDGER_ANNUL_TARGET_INVALID"));
    mustSubmit(w.ledger, await annulDraft(p, { nonce: "an_a", approvalNonce: "ap_a" }));
    expect(sub(w, await annulDraft(p, { nonce: "an_b", approvalNonce: "ap_b" }))).toEqual(rej("LEDGER_ANNUL_TARGET_INVALID"));
  });

  it("L-28: a replacement is appended in the same atomic step, derived from the signed request", async () => {
    const { w, p } = await withP();
    const r = sub(w, await annulDraft(p, { replacement: "NON_PARTICIPATION_LOCKED" }));
    expect(r.ok && r.events.map((e) => [e.seq, e.eventType])).toEqual([
      [2, "EVENT_ANNULLED"],
      [3, "NON_PARTICIPATION_LOCKED_RECORDED"],
    ]);
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    expect(w.ledger.getStateAt("fund_x", "ipo_1", 2)).toBe("UNKNOWN");
    expect(w.ledger.events()[2]?.payload).toMatchObject({ origin: "INDEPENDENT", from: "UNKNOWN" });
    expect(verifyChain(plain(w.ledger.events())).ok).toBe(true);
  });

  it("L-29: a replacement outside the allowed values rejects the whole request", async () => {
    const { w, p } = await withP();
    const bad = (await annulDraft(p)) as { payload: Record<string, unknown> };
    expect(sub(w, { ...bad, payload: { ...bad.payload, replacement: "UNKNOWN" } }).ok).toBe(false);
    expect(w.ledger.events().length).toBe(1);
  });

  it("L-30: BIND-1 origin records are not accepted through the gate (the signature does not cover origin; bid intake is out of scope)", async () => {
    const w = makeAuthWorld();
    const d = (await recordDraft()) as { payload: Record<string, unknown> };
    expect(sub(w, { ...d, payload: { ...d.payload, origin: "BIND_1", bidId: "bid_1" } })).toEqual(rej("LEDGER_BIND_ORIGIN_NOT_SUPPORTED"));
    expect(w.ledger.events().length).toBe(0);
  });

  it("R15 is out of scope: BID_WITHDRAWN corrections are rejected, fail closed", async () => {
    const { w, p } = await withP();
    const d = (await annulDraft(p)) as { payload: Record<string, unknown> };
    const withdrawal = { ...d, coAuthorizations: [], payload: { ...d.payload, reason: "BID_WITHDRAWN", bidId: "bid_1" } };
    expect(sub(w, withdrawal)).toEqual(rej("LEDGER_BID_WITHDRAWAL_NOT_SUPPORTED"));
    expect(w.ledger.events().length).toBe(1);
  });
});

describe("R14: the approver must be independent; the feature fails closed (L-34..L-38)", () => {
  const entries = (patch: (p: (typeof PRINCIPALS)[number]) => (typeof PRINCIPALS)[number]) => PRINCIPALS.map(patch);

  async function setup(reg: PrincipalRegistry = principals()) {
    const w = makeAuthWorld({ principals: reg });
    const [p] = mustSubmit(w.ledger, await recordDraft());
    return { w, p: def(p) };
  }

  it("L-34: the manager approving its own correction (same id, same key) is refused", async () => {
    const { w, p } = await setup();
    expect(sub(w, await annulDraft(p, { approver: "manager_x" }))).toEqual(rej("LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT"));
    expect(w.ledger.events().length).toBe(1);
  });

  it("L-35: different ids but the same recovered key (registry that violates the key-uniqueness rule) is refused", async () => {
    // A hand-made registry (not built through createPrincipalRegistry) that lets two principals share a key.
    const base = principals();
    const manager = def(base.get("manager_x"));
    const evilAdmin: Principal = { principalId: "admin_evil", role: PrincipalRole.REGISTRY_ADMIN, address: manager.address, controllerId: "ctrl_admin_evil" };
    const reg: PrincipalRegistry = {
      get: (id) => (id === "admin_evil" ? evilAdmin : base.get(id)),
      operator: () => base.operator(),
      admins: () => [...base.admins(), evilAdmin],
    };
    const { w, p } = await setup(reg);
    const d = await annulDraft(p, { approver: "admin_evil", approverSigner: "manager_x" });
    expect(sub(w, d)).toEqual(rej("LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT"));
  });

  it("L-36: the approver reporting the same controller as the manager is refused", async () => {
    const reg = principals(entries((p) => (p.principalId === "admin_1" ? { ...p, controllerId: "ctrl_manager_x" } : p)));
    const { w, p } = await setup(reg);
    expect(sub(w, await annulDraft(p))).toEqual(rej("LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT"));
  });

  it("L-37: if the registry admin and the operator are the same party, corrections are disabled (fail closed); everything else works", async () => {
    const sameController = principals(entries((p) => (p.principalId === "admin_1" ? { ...p, controllerId: "ctrl_operator_1" } : p)));
    const { w, p } = await setup(sameController);
    expect(w.ledger.annulmentAvailable).toBe(false);
    expect(sub(w, await annulDraft(p))).toEqual(rej("LEDGER_ANNUL_DISABLED"));
    expect(sub(w, await annulDraft(p, { approver: null }))).toEqual(rej("LEDGER_ANNUL_DISABLED"));
    expect(sub(w, await recordDraft({ nonce: "r_2", fund: "fund_z" }))).toMatchObject({ ok: true });
    w.clock.t = CLOSES_AT;
    expect(sub(w, await closeDraft({ ledgerSeqAtClose: 2 }))).toMatchObject({ ok: true });
  });

  it("corrections are disabled when no admin or no operator is configured", async () => {
    for (const keep of [(p: (typeof PRINCIPALS)[number]) => p.role !== PrincipalRole.REGISTRY_ADMIN, (p: (typeof PRINCIPALS)[number]) => p.role !== PrincipalRole.LEDGER_OPERATOR]) {
      const { w, p } = await setup(principals(PRINCIPALS.filter(keep)));
      expect(w.ledger.annulmentAvailable).toBe(false);
      expect(sub(w, await annulDraft(p))).toEqual(rej("LEDGER_ANNUL_DISABLED"));
    }
  });

  it("an independent approver among several admins works; with an overlapping admin present the feature stays off", async () => {
    const second = { principalId: "admin_2", role: "REGISTRY_ADMIN", address: syntheticAccount("admin_2").address, controllerId: "ctrl_admin_2" };
    const ok = await setup(principals([...PRINCIPALS, second]));
    expect(sub(ok.w, await annulDraft(ok.p, { approver: "admin_2" }))).toMatchObject({ ok: true });
    const overlapping = { ...second, controllerId: "ctrl_operator_1" };
    const off = await setup(principals([...PRINCIPALS, overlapping]));
    expect(sub(off.w, await annulDraft(off.p))).toEqual(rej("LEDGER_ANNUL_DISABLED"));
  });

  it("L-38: registering one key for two principals is rejected when the registry is built", () => {
    const dup = [...PRINCIPALS, { principalId: "admin_2", role: "REGISTRY_ADMIN", address: def(PRINCIPALS[0]).address, controllerId: "ctrl_admin_2" }];
    expect(createPrincipalRegistry(dup)).toEqual({ ok: false, reasonCode: "PRINCIPAL_KEY_REUSE" });
  });
});

describe("fail closed: no throws, hostile input, bad configuration", () => {
  it("garbage and unsupported requests are rejections, never exceptions", async () => {
    const w = makeAuthWorld();
    const cases: unknown[] = [null, undefined, 1, "x", [], {}, await recordDraft({ extra: { amount: 1 } })];
    for (const c of cases) expect(sub(w, c), String(c)).toMatchObject({ ok: false });
    const getter = await recordDraft();
    Object.defineProperty(getter, "actorId", { enumerable: true, get: () => { throw new Error("boom"); } });
    expect(sub(w, getter)).toMatchObject({ ok: false });
    expect(sub(w, new Proxy({}, { ownKeys() { throw new Error("boom"); } }))).toMatchObject({ ok: false });
    for (const type of ["IPO_FINALIZED", "FINDING_ANNOTATED", "MANAGER_KEY_REVOKED"]) {
      expect(sub(w, { ...(await recordDraft()), eventType: type })).toEqual(rej("EVENT_TYPE_NOT_SUPPORTED"));
    }
    expect(w.ledger.events().length).toBe(0);
  });

  it("a throwing registry or a bad clock yields a rejection and changes nothing", async () => {
    const hostile = makeAuthWorld({ config: { funds: { getFund: () => { throw new Error("boom"); } } } });
    expect(hostile.ledger.submit(await recordDraft())).toMatchObject({ ok: false });
    expect(hostile.ledger.events().length).toBe(0);
    for (const t of [Number.NaN, -1, 1.5, Infinity]) {
      const w = makeAuthWorld({ start: t });
      expect(sub(w, await recordDraft())).toEqual(rej("LEDGER_CLOCK_INVALID"));
    }
  });

  it("invalid deployment configuration throws TypeError at construction (not attacker input)", () => {
    const base = { now: () => NOW, domain: LEDGER_TEST_DOMAIN, principals: principals(), funds: { getFund: () => undefined }, ipos: { getIpo: () => undefined }, registrySeq: 1 };
    expect(() => new AuthorizedLedger({ ...base, domain: { ...LEDGER_TEST_DOMAIN, name: "ipo-proof CapacityAttestation" } })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, domain: { ...LEDGER_TEST_DOMAIN, version: "2" } })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, domain: { ...LEDGER_TEST_DOMAIN, chainId: 0n } })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, domain: { ...LEDGER_TEST_DOMAIN, verifyingContract: `0x${"0".repeat(40)}` } })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, registrySeq: -1 })).toThrow(TypeError);
    expect(() => new AuthorizedLedger(base)).not.toThrow();
  });

  it("determinism: the same signed requests and clock give the same chain", async () => {
    const run = async () => {
      const w = makeAuthWorld();
      mustSubmit(w.ledger, await recordDraft());
      mustSubmit(w.ledger, await recordDraft({ nonce: "r_2", fund: "fund_z", state: "NON_PARTICIPATION_LOCKED" }));
      return w.ledger.headHash();
    };
    expect(await run()).toBe(await run());
  });

  it("the sequencer clock is read once per request: recordedAt of both events of a correction is the same instant", async () => {
    const w = makeAuthWorld();
    const [p] = mustSubmit(w.ledger, await recordDraft());
    w.clock.t = NOW + HOUR;
    const events = mustSubmit(w.ledger, await annulDraft(def(p), { replacement: "NON_PARTICIPATION_LOCKED" }));
    expect(events.map((e) => e.recordedAt)).toEqual([NOW + HOUR, NOW + HOUR]);
  });

  it("signTyped round trip sanity: a principal signing for itself with its registered key is accepted", async () => {
    expect(await signTyped("manager_x", "OperatorAction", { action: "x", ipoId: "ipo_1", requestNonce: "n", expiresAt: 1n })).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe("R14 unit: approverIsIndependent checks each independence condition on its own (I1..I4)", () => {
  const mk = (principalId: string, role: Principal["role"], addr: string, controllerId: string): Principal => ({ principalId, role, address: addr, controllerId });
  const A = `0x${"a".repeat(40)}`;
  const B = `0x${"b".repeat(40)}`;
  const C = `0x${"c".repeat(40)}`;
  const base = {
    actor: mk("m", PrincipalRole.FUND_MANAGER, A, "c_m"),
    approver: mk("adm", PrincipalRole.REGISTRY_ADMIN, B, "c_adm"),
    operator: mk("op", PrincipalRole.LEDGER_OPERATOR, C, "c_op"),
    recoveredActor: A,
    recoveredApprover: B,
  };

  it("holds for three distinct parties", () => {
    expect(approverIsIndependent(base)).toBe(true);
  });
  it("I1: same principal id as the actor is refused even if keys and controllers differ", () => {
    expect(approverIsIndependent({ ...base, approver: { ...base.approver, principalId: "m" } })).toBe(false);
  });
  it("I2: same recovered key as the actor, or as the operator, is refused", () => {
    expect(approverIsIndependent({ ...base, recoveredApprover: A })).toBe(false);
    expect(approverIsIndependent({ ...base, recoveredApprover: C })).toBe(false);
  });
  it("I3: same controller as the actor is refused", () => {
    expect(approverIsIndependent({ ...base, approver: { ...base.approver, controllerId: "c_m" } })).toBe(false);
  });
  it("I4: same controller as the operator is refused", () => {
    expect(approverIsIndependent({ ...base, approver: { ...base.approver, controllerId: "c_op" } })).toBe(false);
  });
  it("an unknown operator means independence cannot be shown (fail closed)", () => {
    expect(approverIsIndependent({ ...base, operator: undefined })).toBe(false);
  });
});

describe("the clock is read once per submission", () => {
  it("every check and the recorded time use the same instant, even if the clock advances during the call", async () => {
    let reads = 0;
    const w = makeAuthWorld({ config: { now: () => NOW + 1000 * ++reads } });
    const d = await recordDraft({ expiresAt: NOW + 1500 });
    const out = w.ledger.submit(d);
    expect(reads).toBe(1);
    expect(out.ok).toBe(true);
    expect(w.ledger.events()[0]?.recordedAt).toBe(NOW + 1000);
  });
});
