/** Trusted checkpoints for verifyChain / fromEvents (issue #37 section 3, design section 2.5). */
import { describe, expect, it } from "vitest";
import { HashChainedLedger, verifyChain } from "../src/ledger/chain.js";
import { close, lock, must, newLedger, participate } from "./ledger-fixtures.js";

function chainOf(n: number, ledgerId?: string) {
  const ledger = ledgerId === undefined ? newLedger().ledger : new HashChainedLedger(() => 1_800_000_000_001, { ledgerId });
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
    expect(verifyChain(events.slice(0, 3)).ok).toBe(true);
  });

  it("a chain that reaches the checkpoint with the same hash verifies, also after it grew", () => {
    const full = chainOf(5);
    const anchor = cp(full, 3);
    expect(verifyChain(full.events(), { checkpoints: [anchor] })).toMatchObject({ ok: true, length: 5 });
    expect(verifyChain(full.events().slice(0, 3), { checkpoints: [anchor] })).toMatchObject({ ok: true, length: 3 });
    expect(verifyChain(full.events(), { checkpoints: [cp(full, 1), cp(full, 3), cp(full, 5)] })).toMatchObject({ ok: true });
  });

  it("truncation below the checkpoint is detected, including losing the IPO_CLOSED / LOCKED event (issue #37 section 3)", () => {
    const full = chainOf(5);
    const events = full.events();
    expect(verifyChain(events.slice(0, 4), { checkpoints: [cp(full, 5)] })).toEqual({
      ok: false,
      seq: 5,
      reasonCode: "LEDGER_CHECKPOINT_NOT_REACHED",
    });
    expect(verifyChain([], { checkpoints: [cp(full, 1)] })).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_CHECKPOINT_NOT_REACHED" });
  });

  it("a rewritten history (valid chain, different event at the checkpoint position) is detected", () => {
    const real = chainOf(5);
    const fake = newLedger().ledger;
    must(fake.append(participate("fund_a", "ipo_1")));
    must(fake.append(participate("fund_b", "ipo_1"))); // fund_b participates instead of being locked
    must(fake.append(participate("fund_c", "ipo_1")));
    expect(verifyChain(fake.events()).ok).toBe(true); // internally consistent, which is exactly the problem
    expect(verifyChain(fake.events(), { checkpoints: [cp(real, 3)] })).toEqual({
      ok: false,
      seq: 3,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
  });

  it("two different trusted hashes for the same position fail closed", () => {
    const l = chainOf(3);
    expect(verifyChain(l.events(), { checkpoints: [cp(l, 2), { seq: 2, eventHash: "f".repeat(64) }] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
    // order must not matter (a later entry must not silently replace an earlier one)
    expect(verifyChain(l.events(), { checkpoints: [{ seq: 2, eventHash: "f".repeat(64) }, cp(l, 2)] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
    expect(verifyChain(l.events(), { checkpoints: [cp(l, 2), cp(l, 2)] }).ok).toBe(true);
  });

  it("a checkpoint from another ledger (other ledgerId) does not match", () => {
    const a = chainOf(3, "ledger_a");
    const b = chainOf(3, "ledger_b");
    expect(verifyChain(a.events(), { ledgerId: "ledger_a", checkpoints: [cp(b, 3)] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_MISMATCH",
    });
  });

  it("an event failure before the checkpoint position is still reported first", () => {
    const l = chainOf(5);
    const tampered = l.events().map((e, i) => (i === 1 ? { ...e, recordedAt: e.recordedAt + 1 } : e));
    expect(verifyChain(tampered, { checkpoints: [cp(l, 5)] })).toMatchObject({ ok: false, seq: 2, reasonCode: "LEDGER_EVENT_HASH_MISMATCH" });
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
      expect(verifyChain(l.events(), { checkpoints: [b as never] }), String(b)).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    }
    // anything that is not an array is rejected, even if Array.from would turn it into an empty list
    for (const notAnArray of ["nope", {}, { length: 0 }, new Set(), 5, null]) {
      expect(verifyChain(l.events(), { checkpoints: notAnArray as never }), String(notAnArray)).toMatchObject({ reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    }
    expect(verifyChain(l.events(), { get checkpoints(): never { throw new Error("boom"); } })).toMatchObject({ reasonCode: "LEDGER_CHECKPOINT_INVALID" });
    expect(verifyChain(l.events(), { checkpoints: [] }).ok).toBe(true);
  });

  it("fromEvents applies the same checkpoints", () => {
    const full = chainOf(5);
    expect(HashChainedLedger.fromEvents(full.events().slice(0, 4), () => 0, { checkpoints: [cp(full, 5)] })).toMatchObject({
      ok: false,
      reasonCode: "LEDGER_CHECKPOINT_NOT_REACHED",
    });
    const ok = HashChainedLedger.fromEvents(full.events(), () => 0, { checkpoints: [cp(full, 5)] });
    expect(ok.ok).toBe(true);
  });
});
