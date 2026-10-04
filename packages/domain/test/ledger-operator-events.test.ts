/**
 * The three event types that were "not supported" before: IPO_FINALIZED (R19), FINDING_ANNOTATED (R17)
 * and MANAGER_KEY_REVOKED (R18, R9). Design: PR #38 sections 2.3.1-2.3.3, rules R9, R17-R19, cases
 * L-62..L-76. Part 1 tests the ledger fold (no signatures), part 2 the signed gate.
 */
import { describe, expect, it } from "vitest";
import { HashChainedLedger, verifyChain } from "../src/ledger/chain.js";
import { parseLedgerEventDraft, ledgerGenesisHash } from "../src/ledger/events.js";
import { LEDGER_TEST_ID, annulDraft, closeDraft, CLOSES_AT, finalizeDraft, findingDraft, makeAuthWorld, mustSubmit, recordDraft, rej, revokeDraft } from "./ledger-auth-fixtures.js";
import { SIG, close, def, must, newLedger, participate, lock, plain } from "./ledger-fixtures.js";

const H = "c".repeat(64);
const base = (ipoId: string | null, actorId: string) => ({
  ipoId,
  actorId,
  authorization: { scheme: "EIP712_LEDGER_OPERATOR_ACTION_V1", requestNonce: "n_1", expiresAt: 2_000_000_000_000, signature: SIG },
  registrySeq: 1,
  requestedAt: 1_800_000_000_000,
});
const finalize = (cutoff: { ledgerSeqAtClose: number; ledgerHeadHashAtClose: string }, ipoId = "ipo_1", digest = H, extra: Record<string, unknown> = {}) => ({
  ...base(ipoId, "operator_1"),
  eventType: "IPO_FINALIZED",
  subjectFundId: null,
  coAuthorizations: [],
  payload: { ...cutoff, finalizationDigest: digest },
  ...extra,
});
const finding = (target: { seq: number; eventHash: string }, ipoId = "ipo_1", payloadExtra: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  ...base(ipoId, "operator_1"),
  eventType: "FINDING_ANNOTATED",
  subjectFundId: null,
  coAuthorizations: [],
  payload: { targetSeq: target.seq, targetEventHash: target.eventHash, kind: "RECORD_ERROR_NOTED", evidenceDigest: H, ...payloadExtra },
  ...extra,
});
const revoke = (managerId = "manager_x", keyId = "manager_x", extra: Record<string, unknown> = {}) => ({
  ...base(null, "admin_1"),
  authorization: { scheme: "EIP712_LEDGER_KEY_REVOCATION_V1", requestNonce: "n_1", expiresAt: 2_000_000_000_000, signature: SIG },
  eventType: "MANAGER_KEY_REVOKED",
  subjectFundId: null,
  coAuthorizations: [],
  payload: { managerId, revokedKeyId: keyId },
  ...extra,
});
const malformed = { ok: false, reasonCode: "EVENT_MALFORMED" };
const reject = (reasonCode: string) => ({ ok: false, reasonCode });

/** fund_a PARTICIPATING and fund_b LOCKED on ipo_1, then ipo_1 closed. Returns the ledger and the cut-off of the close. */
function closedLedger() {
  const { ledger } = newLedger();
  must(ledger.append(participate("fund_a", "ipo_1")));
  must(ledger.append(lock("fund_b", "ipo_1")));
  must(ledger.append(close(2, "ipo_1")));
  const closeEvent = def(ledger.events()[2]);
  return { ledger, cutoff: { ledgerSeqAtClose: 2, ledgerHeadHashAtClose: closeEvent.prevHash } };
}

describe("FINDING_ANNOTATED (R17, L-62..L-65): a note on an earlier event, no effect on any state", () => {
  it("is accepted before the close and after IPO_FINALIZED; every state is unchanged (L-62)", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a", "ipo_1")));
    must(ledger.append(lock("fund_b", "ipo_1")));
    const target = def(ledger.events()[0]);
    const statesBefore = ["fund_a", "fund_b"].map((f) => [ledger.getState(f, "ipo_1"), ledger.getStateAt(f, "ipo_1", 1)]);
    for (const kind of ["ATTESTATION_REVOKED_AFTER_CLOSE", "DISPUTE_RAISED", "RECORD_ERROR_NOTED", "KEY_COMPROMISE_NOTED"]) {
      expect(ledger.append(finding(target, "ipo_1", { kind })).ok, kind).toBe(true);
    }
    expect(ledger.append(finding(target, "ipo_1", { evidenceDigest: null })).ok).toBe(true);
    expect(["fund_a", "fund_b"].map((f) => [ledger.getState(f, "ipo_1"), ledger.getStateAt(f, "ipo_1", 1)])).toEqual(statesBefore);
    // after the close and the finalization
    const n = ledger.events().length;
    must(ledger.append(close(n, "ipo_1")));
    const closeEvent = def(ledger.events()[n]);
    must(ledger.append(finalize({ ledgerSeqAtClose: n, ledgerHeadHashAtClose: closeEvent.prevHash })));
    expect(ledger.append(finding(target)).ok).toBe(true);
    expect(ledger.append(finding(closeEvent)).ok).toBe(true); // an IPO_CLOSED event may be annotated
    expect(ledger.isFinalized("ipo_1")).toBe(true);
    expect(verifyChain(plain(ledger.events())).ok).toBe(true);
  });

  it("the target must exist, be earlier, match the hash, belong to the same IPO and not be an annotation (L-64)", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a", "ipo_1")));
    must(ledger.append(participate("fund_a", "ipo_2")));
    const e1 = def(ledger.events()[0]);
    const e2 = def(ledger.events()[1]);
    const head = ledger.headHash();
    const note = must(ledger.append(finding(e1)))[0];
    const bad = [
      finding({ seq: 99, eventHash: e1.eventHash }), // no such seq
      finding({ seq: 4, eventHash: e1.eventHash }), // not earlier (it would be seq 4 itself)
      finding({ seq: 5, eventHash: e1.eventHash }), // later than the event
      finding({ seq: 1, eventHash: H }), // wrong hash
      finding(e2), // event of another IPO
      finding(def(note)), // an annotation cannot be annotated
    ];
    for (const b of bad) expect(ledger.append(b), JSON.stringify(b.payload)).toEqual(reject("LEDGER_FINDING_TARGET_INVALID"));
    expect(ledger.events().length).toBe(3);
    expect(ledger.headHash()).not.toBe(head);
  });

  it("a rejected event can never become a target, and a global key revocation is not an event of any IPO", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a", "ipo_1")));
    must(ledger.append(revoke()));
    const revoked = def(ledger.events()[1]);
    expect(ledger.append(finding(revoked))).toEqual(reject("LEDGER_FINDING_TARGET_INVALID"));
    // the failed annotation (seq 3 would be taken) left no trace: the next event still gets seq 3
    expect(def(must(ledger.append(finding(def(ledger.events()[0]))))[0]).seq).toBe(3);
  });

  it("no free text, no amounts, closed kind list, hex digest only, no extra fields (L-63, T-19)", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a", "ipo_1")));
    const t = def(ledger.events()[0]);
    const head = ledger.headHash();
    const bad = [
      finding(t, "ipo_1", { note: "hello" }),
      finding(t, "ipo_1", { amount: 5 }),
      finding(t, "ipo_1", { kind: "WHATEVER" }),
      finding(t, "ipo_1", { kind: "record_error_noted" }),
      finding(t, "ipo_1", { evidenceDigest: "abc" }),
      finding(t, "ipo_1", { evidenceDigest: "C".repeat(64) }),
      finding(t, "ipo_1", { evidenceDigest: undefined }),
      finding(t, "ipo_1", { targetSeq: 0 }),
      finding(t, "ipo_1", { targetSeq: 1.5 }),
      finding(t, "ipo_1", { targetEventHash: "xyz" }),
      finding(t, "ipo_1", {}, { subjectFundId: "fund_a" }),
      finding(t, "ipo_1", {}, { coAuthorizations: [{ approverId: "admin_1", scheme: "EIP712_LEDGER_ANNULMENT_APPROVAL_V1", requestNonce: "a_1", expiresAt: 2_000_000_000_000, signature: SIG }] }),
      finding(t, "ipo_1", {}, { ipoId: null }), // only MANAGER_KEY_REVOKED may have no IPO
    ];
    for (const b of bad) expect(ledger.append(b), JSON.stringify(b.payload)).toEqual(malformed);
    const missing = finding(t);
    delete (missing.payload as Record<string, unknown>)["evidenceDigest"];
    expect(ledger.append(missing)).toEqual(malformed);
    expect(ledger.headHash()).toBe(head);
  });
});

describe("IPO_FINALIZED (R19, L-70..L-74): only after the close, matching the cut-off, once", () => {
  it("is refused without IPO_CLOSED, also when only another IPO is closed (L-70)", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a", "ipo_1")));
    expect(ledger.append(finalize({ ledgerSeqAtClose: 1, ledgerHeadHashAtClose: H }))).toEqual(reject("IPO_NOT_CLOSED"));
    must(ledger.append(close(1, "ipo_2")));
    const c = def(ledger.events()[1]);
    expect(ledger.append(finalize({ ledgerSeqAtClose: 1, ledgerHeadHashAtClose: c.prevHash }))).toEqual(reject("IPO_NOT_CLOSED"));
    expect(ledger.events().length).toBe(2);
  });

  it("is accepted with the cut-off of the IPO_CLOSED; afterwards state events and corrections are still refused (L-71)", () => {
    const { ledger, cutoff } = closedLedger();
    expect(ledger.isFinalized("ipo_1")).toBe(false);
    must(ledger.append(finalize(cutoff)));
    expect(ledger.isFinalized("ipo_1")).toBe(true);
    expect(ledger.isFinalized("ipo_2")).toBe(false);
    expect(ledger.append(participate("fund_c", "ipo_1"))).toEqual(reject("IPO_ALREADY_CLOSED"));
    expect(ledger.getState("fund_a", "ipo_1")).toBe("PARTICIPATING");
    expect(verifyChain(plain(ledger.events())).ok).toBe(true);
  });

  it("the head hash of the cut-off for an empty ledger at the close is the genesis hash", () => {
    const { ledger } = newLedger();
    must(ledger.append(close(0, "ipo_1")));
    expect(ledger.append(finalize({ ledgerSeqAtClose: 0, ledgerHeadHashAtClose: def(ledgerGenesisHash(undefined)) })).ok).toBe(true);
  });

  it("wrong ledgerSeqAtClose or ledgerHeadHashAtClose is a cut-off mismatch (T-20)", () => {
    const { ledger, cutoff } = closedLedger();
    expect(ledger.append(finalize({ ledgerSeqAtClose: 1, ledgerHeadHashAtClose: cutoff.ledgerHeadHashAtClose }))).toEqual(reject("LEDGER_FINALIZATION_CUTOFF_MISMATCH"));
    expect(ledger.append(finalize({ ledgerSeqAtClose: 2, ledgerHeadHashAtClose: H }))).toEqual(reject("LEDGER_FINALIZATION_CUTOFF_MISMATCH"));
    expect(ledger.append(finalize({ ledgerSeqAtClose: 3, ledgerHeadHashAtClose: cutoff.ledgerHeadHashAtClose }))).toEqual(reject("LEDGER_FINALIZATION_CUTOFF_MISMATCH"));
    expect(ledger.events().length).toBe(3);
  });

  it("a second IPO_FINALIZED is refused whatever its digest; there is no overwrite path (L-73)", () => {
    const { ledger, cutoff } = closedLedger();
    must(ledger.append(finalize(cutoff)));
    expect(ledger.append(finalize(cutoff))).toEqual(reject("IPO_ALREADY_FINALIZED"));
    expect(ledger.append(finalize(cutoff, "ipo_1", "f".repeat(64)))).toEqual(reject("IPO_ALREADY_FINALIZED"));
    expect(ledger.events().length).toBe(4);
  });

  it("another IPO is judged on its own close and finalization", () => {
    const { ledger, cutoff } = closedLedger();
    must(ledger.append(finalize(cutoff)));
    must(ledger.append(close(4, "ipo_2")));
    const c2 = def(ledger.events()[4]);
    expect(ledger.append(finalize({ ledgerSeqAtClose: 4, ledgerHeadHashAtClose: c2.prevHash }, "ipo_2")).ok).toBe(true);
  });

  it("bad shapes are malformed (L-74)", () => {
    const { ledger, cutoff } = closedLedger();
    const bad = [
      finalize(cutoff, "ipo_1", "abc"),
      finalize(cutoff, "ipo_1", H.toUpperCase()),
      finalize(cutoff, "ipo_1", H, { subjectFundId: "fund_a" }),
      finalize(cutoff, "ipo_1", H, { ipoId: null }),
      finalize(cutoff, "ipo_1", H, { coAuthorizations: [{ approverId: "admin_1", scheme: "EIP712_LEDGER_ANNULMENT_APPROVAL_V1", requestNonce: "a_1", expiresAt: 2_000_000_000_000, signature: SIG }] }),
      finalize(cutoff, "ipo_1", H, { payload: { ...cutoff, finalizationDigest: H, note: "x" } }),
      finalize({ ledgerSeqAtClose: -1, ledgerHeadHashAtClose: cutoff.ledgerHeadHashAtClose }),
      finalize({ ledgerSeqAtClose: 2, ledgerHeadHashAtClose: "zz" }),
    ];
    for (const b of bad) expect(ledger.append(b), JSON.stringify(b.payload)).toEqual(malformed);
  });
});

describe("MANAGER_KEY_REVOKED (R18, R9, L-66..L-68): one global event, no IPO", () => {
  it("is accepted while several IPOs are open and recorded as revoked; no state changes (L-66)", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a", "ipo_1")));
    must(ledger.append(participate("fund_a", "ipo_2")));
    expect(ledger.isKeyRevoked("manager_x", "manager_x")).toBe(false);
    const [ev] = must(ledger.append(revoke()));
    expect(def(ev).ipoId).toBeNull();
    expect(def(ev).subjectFundId).toBeNull();
    expect(ledger.isKeyRevoked("manager_x", "manager_x")).toBe(true);
    expect(ledger.isKeyRevoked("manager_x", "other_key")).toBe(false);
    expect(ledger.isKeyRevoked("manager_y", "manager_x")).toBe(false);
    expect(ledger.getState("fund_a", "ipo_1")).toBe("PARTICIPATING");
    expect(ledger.getState("fund_a", "ipo_2")).toBe("PARTICIPATING");
    expect(verifyChain(plain(ledger.events())).ok).toBe(true);
    const restored = HashChainedLedger.fromEvents(plain(ledger.events()), () => 0);
    expect(restored.ok && restored.ledger.isKeyRevoked("manager_x", "manager_x")).toBe(true);
  });

  it("is allowed after an IPO closed and finalized (a global event is not limited by R6)", () => {
    const { ledger, cutoff } = closedLedger();
    must(ledger.append(finalize(cutoff)));
    expect(ledger.append(revoke()).ok).toBe(true);
  });

  it("revoking the same key again is refused (R18)", () => {
    const { ledger } = newLedger();
    must(ledger.append(revoke()));
    expect(ledger.append(revoke("manager_x", "manager_x", { authorization: { scheme: "EIP712_LEDGER_KEY_REVOCATION_V1", requestNonce: "n_2", expiresAt: 2_000_000_000_000, signature: SIG } }))).toEqual(reject("LEDGER_KEY_ALREADY_REVOKED"));
    expect(ledger.append(revoke("manager_y")).ok).toBe(true);
  });

  it("ipoId must be null for this type and for no other (L-68)", () => {
    const { ledger } = newLedger();
    expect(ledger.append(revoke("manager_x", "manager_x", { ipoId: "ipo_1" }))).toEqual(malformed);
    expect(ledger.append(revoke("manager_x", "manager_x", { ipoId: undefined }))).toEqual(malformed);
    expect(ledger.append(revoke("manager_x", "manager_x", { subjectFundId: "fund_a" }))).toEqual(malformed);
    expect(ledger.append(revoke("manager_x", "manager_x", { payload: { managerId: "manager_x", revokedKeyId: "manager_x", ipoId: "ipo_1" } }))).toEqual(malformed);
    expect(ledger.append(revoke("Bad Id"))).toEqual(malformed);
    expect(ledger.append(revoke("manager_x", "Bad Key"))).toEqual(malformed);
    expect(ledger.append({ ...participate(), ipoId: null })).toEqual(malformed);
    expect(ledger.append({ ...close(0), ipoId: null })).toEqual(malformed);
    expect(ledger.events().length).toBe(0);
  });

  it("an event cannot be corrected away: EVENT_ANNULLED only targets participation records", () => {
    const { ledger, cutoff } = closedLedger();
    const { ledger: l2 } = newLedger();
    must(l2.append(revoke()));
    expect(parseLedgerEventDraft(revoke()).ok).toBe(true);
    // annulment of a revocation, a finalization and an annotation are invalid targets
    const nonState = [def(l2.events()[0])];
    must(ledger.append(finalize(cutoff)));
    nonState.push(def(ledger.events()[3]));
    for (const target of nonState) {
      const a = {
        ...participate("fund_a", "ipo_9"),
        eventType: "EVENT_ANNULLED",
        coAuthorizations: [{ approverId: "admin_1", scheme: "EIP712_LEDGER_ANNULMENT_APPROVAL_V1", requestNonce: "a_1", expiresAt: 2_000_000_000_000, signature: SIG }],
        payload: { targetSeq: target.seq, targetEventHash: target.eventHash, reason: "MISTAKEN_ENTRY", replacement: null },
      };
      expect(newLedger().ledger.append(a)).toEqual(reject("LEDGER_ANNUL_TARGET_INVALID"));
    }
  });
});

/* --------------------------------- part 2: the signed gate --------------------------------- */

const sub = (w: ReturnType<typeof makeAuthWorld>, r: unknown) => w.ledger.submit(r);

/** ipo_1 with fund_x PARTICIPATING recorded, then closed by the operator. */
async function closedWorld() {
  const w = makeAuthWorld();
  mustSubmit(w.ledger, await recordDraft({ nonce: "p1" }));
  w.clock.t = CLOSES_AT;
  mustSubmit(w.ledger, await closeDraft({ ledgerSeqAtClose: 1 }));
  const close = def(w.ledger.events()[1]);
  return { w, cutoff: { ledgerSeqAtClose: 1, ledgerHeadHashAtClose: close.prevHash } };
}

describe("gate: IPO_FINALIZED and FINDING_ANNOTATED are operator-only and bound to their payload", () => {
  it("the operator's signed request is accepted, with the verdict digest pinned (L-71)", async () => {
    const { w, cutoff } = await closedWorld();
    const [ev] = mustSubmit(w.ledger, await finalizeDraft(cutoff));
    expect(def(ev).eventType).toBe("IPO_FINALIZED");
    expect(w.ledger.isFinalized("ipo_1")).toBe(true);
    expect(verifyChain(plain(w.ledger.events()), { ledgerId: LEDGER_TEST_ID }).ok).toBe(true);
    const target = def(w.ledger.events()[0]);
    expect(sub(w, await findingDraft(target)).ok).toBe(true);
    expect(sub(w, await findingDraft(target, { kind: "DISPUTE_RAISED", evidenceDigest: null })).ok).toBe(true);
  });

  it("a fund manager, an admin or a stranger cannot write them (L-65, L-74)", async () => {
    const { w, cutoff } = await closedWorld();
    const target = def(w.ledger.events()[0]);
    for (const actor of ["manager_x", "admin_1"]) {
      expect(sub(w, await finalizeDraft(cutoff, { actor })), actor).toEqual(rej("LEDGER_OPERATOR_REQUIRED"));
      expect(sub(w, await findingDraft(target, { actor })), actor).toEqual(rej("LEDGER_OPERATOR_REQUIRED"));
    }
    expect(sub(w, await finalizeDraft(cutoff, { signer: "manager_x" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await findingDraft(target, { actor: "nobody_1" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(w.ledger.isFinalized("ipo_1")).toBe(false);
    expect(w.ledger.events().length).toBe(2);
  });

  it("the signature covers the payload: another digest, kind or target is a signature failure (L-75)", async () => {
    const { w, cutoff } = await closedWorld();
    const target = def(w.ledger.events()[0]);
    const signedX = { ...cutoff, finalizationDigest: "1".repeat(64) };
    const d = await finalizeDraft(cutoff, { digest: "2".repeat(64), signedPayload: signedX });
    expect(sub(w, d)).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    const f = await findingDraft(target, { kind: "DISPUTE_RAISED", signedPayload: { targetSeq: target.seq, targetEventHash: target.eventHash, kind: "RECORD_ERROR_NOTED", evidenceDigest: "e".repeat(64) } });
    expect(sub(w, f)).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    // the action name is signed too: a FINDING_ANNOTATED signature is useless for IPO_FINALIZED and vice versa
    expect(sub(w, await finalizeDraft(cutoff, { signedAction: "FINDING_ANNOTATED" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await findingDraft(target, { signedAction: "IPO_FINALIZED" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await finalizeDraft(cutoff, { signedAction: "IPO_CLOSED" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(2);
  });

  it("the scheme must be the operator action scheme (R16)", async () => {
    const { w, cutoff } = await closedWorld();
    expect(sub(w, await finalizeDraft(cutoff, { scheme: "EIP712_LEDGER_ACTION_V1" }))).toEqual(rej("LEDGER_SCHEME_MISMATCH"));
    expect(sub(w, await finalizeDraft(cutoff, { scheme: "EIP712_LEDGER_KEY_REVOCATION_V1" }))).toEqual(rej("LEDGER_SCHEME_MISMATCH"));
  });

  it("not before the close, not with another cut-off, only once; the same signed resend returns the first result (L-70, L-73)", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "p1" }));
    expect(sub(w, await finalizeDraft({ ledgerSeqAtClose: 1, ledgerHeadHashAtClose: "a".repeat(64) }))).toEqual(rej("IPO_NOT_CLOSED"));
    w.clock.t = CLOSES_AT;
    mustSubmit(w.ledger, await closeDraft({ ledgerSeqAtClose: 1 }));
    const cutoff = { ledgerSeqAtClose: 1, ledgerHeadHashAtClose: def(w.ledger.events()[1]).prevHash };
    expect(sub(w, await finalizeDraft({ ...cutoff, ledgerHeadHashAtClose: "a".repeat(64) }))).toEqual(rej("LEDGER_FINALIZATION_CUTOFF_MISMATCH"));
    const first = await finalizeDraft(cutoff, { nonce: "fin_1" });
    expect(sub(w, first)).toMatchObject({ ok: true, replayed: false });
    expect(sub(w, first)).toMatchObject({ ok: true, replayed: true }); // (c) same nonce, same request
    expect(sub(w, await finalizeDraft(cutoff, { nonce: "fin_2" }))).toEqual(rej("IPO_ALREADY_FINALIZED")); // (a)
    expect(sub(w, await finalizeDraft(cutoff, { nonce: "fin_3", digest: "f".repeat(64) }))).toEqual(rej("IPO_ALREADY_FINALIZED")); // (b)
    expect(w.ledger.events().length).toBe(3);
  });

  it("an unregistered IPO is refused for both; a finding needs a valid target", async () => {
    const { w, cutoff } = await closedWorld();
    const target = def(w.ledger.events()[0]);
    expect(sub(w, await findingDraft(target, { ipo: "ipo_unknown" }))).toEqual(rej("IPO_NOT_FOUND"));
    expect(sub(w, await finalizeDraft(cutoff, { ipo: "ipo_unknown" }))).toEqual(rej("IPO_NOT_FOUND"));
    expect(sub(w, await findingDraft({ seq: 77, eventHash: target.eventHash }))).toEqual(rej("LEDGER_FINDING_TARGET_INVALID"));
    expect(sub(w, await findingDraft({ seq: target.seq, eventHash: "9".repeat(64) }))).toEqual(rej("LEDGER_FINDING_TARGET_INVALID"));
  });

  it("an annotation works while the window is still open and does not change what the participation lookup returns", async () => {
    const w = makeAuthWorld();
    const [rec] = mustSubmit(w.ledger, await recordDraft({ nonce: "p1" }));
    expect(sub(w, await findingDraft(def(rec))).ok).toBe(true);
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
    w.clock.t = CLOSES_AT + 1; // after the close time (R6b) an annotation is still allowed: it is not a state event
    expect(sub(w, await findingDraft(def(rec))).ok).toBe(true);
  });
});

describe("gate: MANAGER_KEY_REVOKED by a registry admin ends the use of that key everywhere (R9, R18, T-18)", () => {
  it("after the revocation the manager's new requests fail on every IPO, other managers are unaffected (L-66)", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "ok1", fund: "fund_x", ipo: "ipo_1" }));
    const [rev] = mustSubmit(w.ledger, await revokeDraft({ managerId: "manager_x" }));
    expect(def(rev).ipoId).toBeNull();
    expect(w.ledger.isKeyRevoked("manager_x", "manager_x")).toBe(true);
    expect(sub(w, await recordDraft({ fund: "fund_z", ipo: "ipo_1" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await recordDraft({ fund: "fund_x", ipo: "ipo_2" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await annulDraft(def(w.ledger.events()[0])))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    // an earlier event stays, and the earlier state is not rolled back
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
    // a different manager keeps working
    expect(sub(w, await recordDraft({ actor: "manager_y", fund: "fund_y", ipo: "ipo_2" })).ok).toBe(true);
  });

  it("even a resend of a request that was accepted before the revocation is refused (a revoked key is trusted for nothing new)", async () => {
    const w = makeAuthWorld();
    const earlier = await recordDraft({ nonce: "ok1" });
    mustSubmit(w.ledger, earlier);
    mustSubmit(w.ledger, await revokeDraft());
    expect(sub(w, earlier)).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(2);
  });

  it("only a registry admin may revoke (R18): not the manager itself, not the operator", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await revokeDraft({ actor: "manager_x" }))).toEqual(rej("LEDGER_REGISTRY_ADMIN_REQUIRED"));
    expect(sub(w, await revokeDraft({ actor: "operator_1" }))).toEqual(rej("LEDGER_REGISTRY_ADMIN_REQUIRED"));
    expect(sub(w, await revokeDraft({ signer: "manager_x" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await revokeDraft({ actor: "nobody_1" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(w.ledger.isKeyRevoked("manager_x", "manager_x")).toBe(false);
    expect(sub(w, await recordDraft({ nonce: "still_ok" })).ok).toBe(true);
  });

  it("the manager and the key must be registered, and only manager keys can be revoked this way", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await revokeDraft({ managerId: "manager_unknown", keyId: "manager_unknown" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(sub(w, await revokeDraft({ managerId: "manager_x", keyId: "some_other_key" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(sub(w, await revokeDraft({ managerId: "operator_1", keyId: "operator_1" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(sub(w, await revokeDraft({ managerId: "admin_1", keyId: "admin_1" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(w.ledger.events().length).toBe(0);
  });

  it("the signature covers manager and key; scheme is the revocation scheme; a second revocation is refused", async () => {
    const w = makeAuthWorld();
    expect(sub(w, await revokeDraft({ managerId: "manager_y", keyId: "manager_y", signed: { managerId: "manager_x", revokedKeyId: "manager_x" } }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await revokeDraft({ scheme: "EIP712_LEDGER_OPERATOR_ACTION_V1" }))).toEqual(rej("LEDGER_SCHEME_MISMATCH"));
    expect(w.ledger.events().length).toBe(0);
    mustSubmit(w.ledger, await revokeDraft());
    expect(sub(w, await revokeDraft())).toEqual(rej("LEDGER_KEY_ALREADY_REVOKED"));
    expect(w.ledger.events().length).toBe(1);
  });

  it("works after the IPO window closed and after finalization (a global event is not an IPO state event)", async () => {
    const { w, cutoff } = await closedWorld();
    mustSubmit(w.ledger, await finalizeDraft(cutoff));
    expect(sub(w, await revokeDraft({ managerId: "manager_y" })).ok).toBe(true);
  });

  it("a configured key id is the one that has to be named", async () => {
    const { PRINCIPALS, principals } = await import("./ledger-auth-fixtures.js");
    const custom = PRINCIPALS.map((p) => (p.principalId === "manager_x" ? { ...p, keyId: "key_manager_x_2026" } : p));
    const w = makeAuthWorld({ principals: principals(custom) });
    expect(sub(w, await revokeDraft({ managerId: "manager_x", keyId: "manager_x" }))).toEqual(rej("LEDGER_ACTOR_UNKNOWN"));
    expect(sub(w, await revokeDraft({ managerId: "manager_x", keyId: "key_manager_x_2026" })).ok).toBe(true);
    expect(w.ledger.isKeyRevoked("manager_x", "key_manager_x_2026")).toBe(true);
  });
});

describe("principle E", () => {
  it("the new events carry no amount, capacity or exposure field", () => {
    const { ledger, cutoff } = closedLedger();
    must(ledger.append(finalize(cutoff)));
    const json = JSON.stringify(ledger.events());
    expect(json).not.toMatch(/amount|capacity|krw|exposure/i);
  });
});
