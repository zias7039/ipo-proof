/** Trusted checkpoints for verifyChain / fromEvents (issue #37 section 3, design section 2.5). */
import { describe, expect, it } from "vitest";
import { HashChainedLedger, verifyChain } from "../src/ledger/chain.js";
import type { ChainOptions } from "../src/ledger/chain.js";
import { close, lock, must, participate } from "./ledger-fixtures.js";

/** Checkpoints require a ledgerId (C-5), so every ledger in this file has one. */
const LID = "ledger_cp";
const vc = (events: readonly unknown[], options: ChainOptions = {}) => verifyChain(events, { ledgerId: LID, ...options });

function chainOf(n: number, ledgerId: string = LID) {
  const ledger = new HashChainedLedger(() => 1_800_000_000_001, { ledgerId });
  const drafts = [
    participate("fund_a", "ipo_1"),
    lock("fund_b", "ipo_1"),
    participate("fund_c", "ipo_1"),
    participate("fund_a", "ipo_2"),
    close(4, "ipo_1"),
  ];
  for (const d of drafts.slice(0, n)) must(ledger.append(d));
  return ledger;
}

const cp = (l: HashChainedLedger, seq: number) => ({ seq, eventHash: l.events()[seq - 1]?.eventHash ?? "" });

describe("checkpoints: truncation and rewriting are detected only when a trusted anchor exists", () => {
  it("without a checkpoint a cut-off end verifies (the documented limit)", () => {
    const events = chainOf(5).events();
    expect(vc(events.slice(0, 3)).ok).toBe(true);
  });

  it("a chain that reaches the checkpoint with the same hash verifies, also after it grew", () => {
    const full = chainOf(5);
    const anchor = cp(full, 3);
    expect(vc(full.events(), { checkpoints: [anchor] })).toMatchObject({ ok: true, length: 5 });
    expect(vc(full.events().slice(0, 3), { checkpoints: [anchor] })).toMatchObject({ ok: true, length: 3 });
    expect(vc(full.events(), { checkpoints: [cp(full, 1), cp(full, 3), cp(full, 5)] })).toMatchObject({ ok: true });
  });

  it("truncation below the checkpoint is detected, including losing the IPO_CLOSED / LOCKED event (issue #37 section 3)", () => {
    const full = chainOf(5);
    const events = full.events();
    expect(vc(events.slice(0, 4), { checkpoints: [cp(full, 5)] })).toEqual({
      ok: false,
      seq: 5,
      reasonCode: "LEDGER_CHECKPOINT_NOT_REACHED",
    });
    expect(vc([], { checkpoints: [cp(full, 1)] })).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_CHECKPOINT_NOT_REACHED" });
  });

  it("a rewritten history (valid chain, different event at the checkpoint position) is detected", () => {
    const real = chainOf(5);
    const fake = new HashChainedLedger(() => 1_800_000_000_001, { ledgerId: LID });
    must(fake.append(participate("fund_a", "ipo_1")));
    must(fake.append(participate("fund_b", "ipo_1"))); // fund_b participates instead of being locked
    must(fake.append(participate("fund_c", "ipo_1")));
    expect(vc(fake.events()).ok).toBe(true); // internally consistent, which is exactly the problem
    expect(vc(fake.events(), { checkpoints: [cp(real, 3)] })).toEqual({
      ok: false,
      seq: 3,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
  });

  it("two different trusted hashes for the same position fail closed", () => {
    const l = chainOf(3);
    expect(vc(l.events(), { checkpoints: [cp(l, 2), { seq: 2, eventHash: "f".repeat(64) }] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
    // order must not matter (a later entry must not silently replace an earlier one)
    expect(vc(l.events(), { checkpoints: [{ seq: 2, eventHash: "f".repeat(64) }, cp(l, 2)] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
    expect(vc(l.events(), { checkpoints: [cp(l, 2), cp(l, 2)] }).ok).toBe(true);
  });

  it("a checkpoint from another ledger (other ledgerId) does not match", () => {
    const a = chainOf(3, "ledger_a");
    const b = chainOf(3, "ledger_b");
    expect(vc(a.events(), { ledgerId: "ledger_a", checkpoints: [cp(b, 3)] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
  });

  it("an event failure before the checkpoint position is still reported first", () => {
    const l = chainOf(5);
    const tampered = l.events().map((e, i) => (i === 1 ? { ...e, recordedAt: e.recordedAt + 1 } : e));
    expect(vc(tampered, { checkpoints: [cp(l, 5)] })).toMatchObject({ ok: false, seq: 2, reasonCode: "LEDGER_EVENT_HASH_MISMATCH" });
  });

  it("malformed checkpoints are rejected as LEDGER_CHECKPOINT_INVALID and never throw", () => {
    const l = chainOf(3);
    const good = cp(l, 2);
    const bad: unknown[] = [
      null,
      "x",
      [],
      {},
      { seq: 0, eventHash: good.eventHash },
      { seq: -1, eventHash: good.eventHash },
      { seq: 1.5, eventHash: good.eventHash },
      { seq: Number.MAX_SAFE_INTEGER + 1, eventHash: good.eventHash },
      { seq: "2", eventHash: good.eventHash },
      { seq: 2, eventHash: good.eventHash.toUpperCase() },
      { seq: 2, eventHash: good.eventHash.slice(2) },
      { seq: 2, eventHash: 5 },
      { ...good, extra: 1 },
      { seq: 2 },
      Object.defineProperty({ eventHash: good.eventHash }, "seq", { get: () => 2, enumerable: true }),
      new Proxy({}, { ownKeys: () => { throw new Error("boom"); } }),
    ];
    for (const b of bad) {
      expect(vc(l.events(), { checkpoints: [b as never] }), String(b)).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    }
    // anything that is not an array is rejected, even if Array.from would turn it into an empty list
    for (const notAnArray of ["nope", {}, { length: 0 }, new Set(), 5, null]) {
      expect(vc(l.events(), { checkpoints: notAnArray as never }), String(notAnArray)).toMatchObject({ reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    }
    expect(verifyChain(l.events(), { ledgerId: LID, get checkpoints(): never { throw new Error("boom"); } })).toMatchObject({ reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    expect(vc(l.events(), { checkpoints: [] }).ok).toBe(true);
  });

  it("fromEvents applies the same checkpoints", () => {
    const full = chainOf(5);
    expect(HashChainedLedger.fromEvents(full.events().slice(0, 4), () => 0, { ledgerId: LID, checkpoints: [cp(full, 5)] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_NOT_REACHED",
    });
    const ok = HashChainedLedger.fromEvents(full.events(), () => 0, { ledgerId: LID, checkpoints: [cp(full, 5)] });
    expect(ok.ok).toBe(true);
  });
});

describe("re-review C-2..C-5: anchored status, freshness pin, ledgerId requirement", () => {
  it("C-2: the result says whether it is anchored and how far (anchoredAtSeq)", () => {
    const full = chainOf(5);
    expect(vc(full.events())).toMatchObject({ ok: true, anchoredAtSeq: null, ledgerBound: true });
    expect(vc(full.events(), { checkpoints: [] })).toMatchObject({ ok: true, anchoredAtSeq: null });
    expect(vc(full.events(), { checkpoints: [cp(full, 2)] })).toMatchObject({ ok: true, anchoredAtSeq: 2 });
    expect(vc(full.events(), { checkpoints: [cp(full, 4), cp(full, 2), cp(full, 3)] })).toMatchObject({ ok: true, anchoredAtSeq: 4 });
    // placeholder genesis without checkpoints stays usable but is visibly unanchored and not ledger-bound
    expect(verifyChain(full.events())).toMatchObject({ ok: false }); // other genesis than LID
    expect(verifyChain([])).toMatchObject({ ok: true, anchoredAtSeq: null, ledgerBound: false });
  });

  it("C-4: events after the last anchor are covered by the hash chain only (documented limit, visible via anchoredAtSeq)", () => {
    const real = chainOf(5);
    const fake = new HashChainedLedger(() => 1_800_000_000_001, { ledgerId: LID });
    must(fake.append(participate("fund_a", "ipo_1")));
    must(fake.append(lock("fund_b", "ipo_1")));
    must(fake.append(participate("fund_c", "ipo_1"))); // seq 1..3 identical to the real chain
    must(fake.append(participate("fund_a", "ipo_2")));
    must(fake.append(close(4, "ipo_2"))); // 4..5 rewritten (other IPO closed)
    const r = vc(fake.events(), { checkpoints: [cp(real, 3)] });
    expect(r).toMatchObject({ ok: true, length: 5, anchoredAtSeq: 3 }); // passes: nothing anchors 4..5
    expect(vc(fake.events(), { checkpoints: [cp(real, 5)] })).toMatchObject({ ok: false, reasonCode: "LEDGER_CHECKPOINT_MISMATCH" });
  });

  it("C-5: checkpoints without a ledgerId are refused (an anchor means nothing against the placeholder genesis)", () => {
    const full = chainOf(3);
    expect(verifyChain(full.events(), { checkpoints: [cp(full, 2)] })).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    expect(verifyChain([], { checkpoints: [{ seq: 1, eventHash: "a".repeat(64) }] })).toMatchObject({ reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    expect(HashChainedLedger.fromEvents(full.events(), () => 0, { checkpoints: [cp(full, 2)] })).toMatchObject({ ok: false, reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    expect(verifyChain([], { checkpoints: [] })).toMatchObject({ ok: true }); // no anchors, nothing to bind
  });

  it("C-3: minCheckpointSeq rejects an older (or missing) anchor than one the caller already holds", () => {
    const full = chainOf(5);
    const events = full.events();
    expect(vc(events, { checkpoints: [cp(full, 5)], minCheckpointSeq: 5 })).toMatchObject({ ok: true, anchoredAtSeq: 5 });
    expect(vc(events, { checkpoints: [cp(full, 5)], minCheckpointSeq: 3 })).toMatchObject({ ok: true });
    expect(vc(events, { checkpoints: [cp(full, 3)], minCheckpointSeq: 5 })).toEqual({ ok: false, seq: 6, reasonCode: "LEDGER_CHECKPOINT_STALE" });
    expect(vc(events, { minCheckpointSeq: 1 })).toMatchObject({ ok: false, reasonCode: "LEDGER_CHECKPOINT_STALE" });
    expect(vc(events, { checkpoints: [], minCheckpointSeq: 1 })).toMatchObject({ ok: false, reasonCode: "LEDGER_CHECKPOINT_STALE" });
  });

  it("C-3: rollback to an older chain with its older (valid) anchor passes without the pin and fails with it", () => {
    const full = chainOf(5);
    const rolledBack = full.events().slice(0, 3);
    const oldAnchor = cp(full, 3);
    expect(vc(rolledBack, { checkpoints: [oldAnchor] })).toMatchObject({ ok: true, length: 3, anchoredAtSeq: 3 }); // the documented limit
    expect(vc(rolledBack, { checkpoints: [oldAnchor], minCheckpointSeq: 5 })).toMatchObject({ ok: false, reasonCode: "LEDGER_CHECKPOINT_STALE" });
    // feeding the previous result back in is the intended use
    const first = vc(full.events(), { checkpoints: [cp(full, 5)] });
    const pin = first.ok ? first.anchoredAtSeq : null;
    expect(pin).toBe(5);
    expect(vc(rolledBack, { checkpoints: [oldAnchor], minCheckpointSeq: pin ?? 1 })).toMatchObject({ ok: false, reasonCode: "LEDGER_CHECKPOINT_STALE" });
  });

  it("minCheckpointSeq must be a positive safe integer and needs a ledgerId; chain errors are still reported first", () => {
    const full = chainOf(3);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, 3n, Number.MAX_SAFE_INTEGER + 1]) {
      expect(vc(full.events(), { checkpoints: [cp(full, 3)], minCheckpointSeq: bad as never }), String(bad)).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    }
    expect(verifyChain(full.events(), { minCheckpointSeq: 1 })).toMatchObject({ ok: false, reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    const tampered = full.events().map((e, i) => (i === 1 ? { ...e, recordedAt: e.recordedAt + 1 } : e));
    expect(vc(tampered, { checkpoints: [cp(full, 1)], minCheckpointSeq: 3 })).toMatchObject({ ok: false, seq: 2, reasonCode: "LEDGER_EVENT_HASH_MISMATCH" });
    expect(verifyChain(full.events(), { ledgerId: LID, get minCheckpointSeq(): never { throw new Error("boom"); } })).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_CHECKPOINT_INVALID" });
  });

  it("fromEvents applies the freshness pin too", () => {
    const full = chainOf(5);
    expect(HashChainedLedger.fromEvents(full.events().slice(0, 3), () => 0, { ledgerId: LID, checkpoints: [cp(full, 3)], minCheckpointSeq: 5 })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_STALE",
    });
  });
});
