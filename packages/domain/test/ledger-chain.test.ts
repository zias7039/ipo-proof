/** Hash chain: sequence, linkage, determinism, tamper detection (design L-01, L-13, L-20, L-21). */
import { describe, expect, it } from "vitest";
import { HashChainedLedger, verifyChain } from "../src/ledger/chain.js";
import { LEDGER_CHAIN_KIND, LEDGER_EVENT_HASH_DOMAIN, computeEventHash, ledgerGenesisHash } from "../src/ledger/events.js";
import type { LedgerEventUnhashed } from "../src/ledger/events.js";
import { sha256CanonicalHex } from "../src/hash.js";
import { TEST_CHAIN_ID, close, lock, must, newLedger, participate, plain, def, withoutHash } from "./ledger-fixtures.js";

/** A 5-event chain: fund_a P, fund_b L, fund_c P (ipo_1), fund_a P (ipo_2), close ipo_1. */
function fiveEvents() {
  const { ledger } = newLedger();
  must(ledger.append(participate("fund_a", "ipo_1")));
  must(ledger.append(lock("fund_b", "ipo_1")));
  must(ledger.append(participate("fund_c", "ipo_1")));
  must(ledger.append(participate("fund_a", "ipo_2")));
  must(ledger.append(close(4, "ipo_1")));
  return ledger;
}

describe("hash chain: structure", () => {
  it("assigns consecutive seq starting at 1 and links prevHash to the previous eventHash (L-01)", () => {
    const ev = fiveEvents().events();
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(ev[0]?.prevHash).toBe(ledgerGenesisHash(TEST_CHAIN_ID));
    for (let i = 1; i < ev.length; i++) expect(ev[i]?.prevHash).toBe(ev[i - 1]?.eventHash);
    expect(new Set(ev.map((e) => e.eventHash)).size).toBe(5);
    expect(fiveEvents().headHash()).toBe(ev[4]?.eventHash);
  });

  it("an empty ledger has the genesis head and verifies", () => {
    const { ledger } = newLedger();
    expect(ledger.headHash()).toBe(ledgerGenesisHash(TEST_CHAIN_ID));
    expect(verifyChain([], { ledgerId: TEST_CHAIN_ID })).toEqual({ ok: true, length: 0, headHash: ledgerGenesisHash(TEST_CHAIN_ID) });
  });

  it("verifyChain accepts the untouched chain and reports length and head", () => {
    const l = fiveEvents();
    expect(verifyChain(plain(l.events()), { ledgerId: TEST_CHAIN_ID })).toEqual({ ok: true, length: 5, headHash: l.headHash() });
  });

  it("eventHash is sha256 of the canonical JSON of the domain-tagged event without eventHash", () => {
    const e = def(fiveEvents().events()[0]);
    const { eventHash, ...unhashed } = e;
    expect(eventHash).toBe(sha256CanonicalHex({ domain: LEDGER_EVENT_HASH_DOMAIN, event: unhashed }));
    expect(eventHash).toBe(computeEventHash(unhashed as LedgerEventUnhashed));
    expect(LEDGER_EVENT_HASH_DOMAIN).toBe("ipo-proof/ledger-event/v1");
  });

  it("is labelled honestly: tamper evidence, not a blockchain, not ZK", () => {
    expect(LEDGER_CHAIN_KIND).toContain("NOT_A_BLOCKCHAIN");
    expect(LEDGER_CHAIN_KIND).toContain("NOT_A_ZK_PROOF");
  });
});

describe("hash chain: determinism (L-21)", () => {
  it("same drafts and same clock give identical events and hashes", () => {
    expect(fiveEvents().events()).toEqual(fiveEvents().events());
    expect(fiveEvents().headHash()).toBe(fiveEvents().headHash());
  });

  it("key order of the draft does not change the hash", () => {
    const a = newLedger().ledger;
    const b = newLedger().ledger;
    const d = participate("fund_a");
    const reversed = Object.fromEntries(Object.entries(d).reverse());
    must(a.append(d));
    must(b.append(reversed));
    expect(a.headHash()).toBe(b.headHash());
  });

  it("a different recordedAt, actor, payload or signature gives a different hash", () => {
    const base = newLedger().ledger;
    must(base.append(participate("fund_a")));
    const variants: Record<string, unknown>[] = [
      participate("fund_a", "ipo_1", { actorId: "manager_y" }),
      participate("fund_a", "ipo_1", { requestedAt: 1_800_000_000_001 }),
      participate("fund_a", "ipo_1", { registrySeq: 2 }),
      participate("fund_a", "ipo_1", { authorization: { ...participate().authorization, signature: `0x${"cd".repeat(65)}` } }),
      participate("fund_b"),
    ];
    for (const v of variants) {
      const other = newLedger().ledger;
      must(other.append(v));
      expect(other.headHash(), JSON.stringify(v)).not.toBe(base.headHash());
    }
    const later = newLedger(1_800_000_000_500).ledger;
    must(later.append(participate("fund_a")));
    expect(later.headHash()).not.toBe(base.headHash());
  });

  it("fromEvents on a verified chain restores the same state and head", () => {
    const l = fiveEvents();
    const r = HashChainedLedger.fromEvents(plain(l.events()), () => 9_000_000_000_000, { ledgerId: TEST_CHAIN_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger.headHash()).toBe(l.headHash());
    expect(r.ledger.getState("fund_a", "ipo_1")).toBe("PARTICIPATING");
    expect(r.ledger.getState("fund_b", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    expect(r.ledger.isClosed("ipo_1")).toBe(true);
  });

  it("fromEvents refuses a tampered chain", () => {
    const events = plain(fiveEvents().events());
    (def(events[1])["payload"] as Record<string, unknown>)["to"] = "PARTICIPATING";
    expect(HashChainedLedger.fromEvents(events, () => 1, { ledgerId: TEST_CHAIN_ID }).ok).toBe(false);
  });
});

describe("hash chain: tamper detection reports the first inconsistent position (L-13)", () => {
  const tampered = (mutate: (events: Record<string, unknown>[]) => Record<string, unknown>[]) => verifyChain(mutate(plain(fiveEvents().events())), { ledgerId: TEST_CHAIN_ID });

  it("changing a field without recomputing its hash -> LEDGER_EVENT_HASH_MISMATCH at that seq", () => {
    expect(
      tampered((e) => {
        def(e[2])["actorId"] = "manager_evil";
        return e;
      }),
    ).toEqual({ ok: false, seq: 3, reasonCode: "LEDGER_EVENT_HASH_MISMATCH" });
  });

  it("changing the payload state of a past event is detected (a LOCKED turned into PARTICIPATING)", () => {
    expect(
      tampered((e) => {
        (def(e[1])["payload"] as Record<string, unknown>)["to"] = "PARTICIPATING";
        def(e[1])["eventType"] = "PARTICIPATION_RECORDED";
        return e;
      }),
    ).toMatchObject({ ok: false, seq: 2, reasonCode: "LEDGER_EVENT_HASH_MISMATCH" });
  });

  it("changing the recorded signature or timestamp is detected (they are part of the hash)", () => {
    expect(
      tampered((e) => {
        (def(e[0])["authorization"] as Record<string, unknown>)["signature"] = `0x${"cd".repeat(65)}`;
        return e;
      }),
    ).toMatchObject({ ok: false, seq: 1, reasonCode: "LEDGER_EVENT_HASH_MISMATCH" });
    expect(
      tampered((e) => {
        def(e[3])["recordedAt"] = 1;
        return e;
      }),
    ).toMatchObject({ ok: false, seq: 4 });
  });

  it("changing an event AND recomputing its own hash breaks the link at the NEXT event", () => {
    const r = tampered((e) => {
      def(e[1])["actorId"] = "manager_evil";
      def(e[1])["eventHash"] = computeEventHash(withoutHash(def(e[1])) as unknown as LedgerEventUnhashed);
      return e;
    });
    expect(r).toEqual({ ok: false, seq: 3, reasonCode: "LEDGER_PREV_HASH_MISMATCH" });
  });

  it("deleting a middle event -> seq mismatch at the gap", () => {
    expect(tampered((e) => e.filter((_, i) => i !== 2))).toEqual({ ok: false, seq: 3, reasonCode: "LEDGER_SEQ_MISMATCH" });
  });

  it("deleting the first event, reordering two events, duplicating an event", () => {
    expect(tampered((e) => e.slice(1))).toMatchObject({ ok: false, seq: 1 });
    expect(tampered((e) => [def(e[0]), def(e[2]), def(e[1]), def(e[3]), def(e[4])])).toMatchObject({ ok: false, seq: 2, reasonCode: "LEDGER_SEQ_MISMATCH" });
    expect(tampered((e) => [def(e[0]), def(e[1]), def(e[1]), def(e[3]), def(e[4])])).toMatchObject({ ok: false, seq: 3 });
  });

  it("editing seq or prevHash fields", () => {
    expect(
      tampered((e) => {
        def(e[2])["seq"] = 9;
        return e;
      }),
    ).toMatchObject({ ok: false, seq: 3, reasonCode: "LEDGER_SEQ_MISMATCH" });
    expect(
      tampered((e) => {
        def(e[2])["prevHash"] = "f".repeat(64);
        return e;
      }),
    ).toMatchObject({ ok: false, seq: 3, reasonCode: "LEDGER_PREV_HASH_MISMATCH" });
  });

  it("a forged event inserted with correct linkage but valid-looking hash from nowhere is rejected", () => {
    const events = plain(fiveEvents().events());
    const forged = { ...def(events[1]), seq: 3, prevHash: def(events[1])["eventHash"], eventHash: "b".repeat(64) };
    expect(verifyChain([def(events[0]), def(events[1]), forged, ...events.slice(2)], { ledgerId: TEST_CHAIN_ID })).toMatchObject({ ok: false, seq: 3, reasonCode: "LEDGER_EVENT_HASH_MISMATCH" });
  });

  it("adding an extra field, or removing one, is malformed", () => {
    expect(
      tampered((e) => {
        def(e[0])["extra"] = 1;
        return e;
      }),
    ).toEqual({ ok: false, seq: 1, reasonCode: "EVENT_MALFORMED" });
    expect(
      tampered((e) => {
        delete def(e[0])["recordedAt"];
        return e;
      }),
    ).toEqual({ ok: false, seq: 1, reasonCode: "EVENT_MALFORMED" });
  });

  it("a hash-valid chain whose events break the state rules is rejected (the fold is part of verification)", () => {
    // Build a correctly hashed chain that records PARTICIPATING then LOCKED for the same fund.
    const events = plain(fiveEvents().events()).slice(0, 1);
    const prev = def(events[0]);
    const body = {
      ...lock("fund_a", "ipo_1"),
      schemaVersion: 1,
      seq: 2,
      prevHash: prev["eventHash"] as string,
      recordedAt: 1_800_000_000_100,
    };
    const eventHash = computeEventHash(body as unknown as LedgerEventUnhashed);
    expect(verifyChain([prev, { ...body, eventHash }], { ledgerId: TEST_CHAIN_ID })).toEqual({ ok: false, seq: 2, reasonCode: "PARTICIPATION_ALREADY_RECORDED" });
  });
});

describe("hash chain: known limits are real (documented, not hidden)", () => {
  it("cutting off the tail of the chain is NOT detected without an external checkpoint", () => {
    const events = plain(fiveEvents().events()).slice(0, 3);
    expect(verifyChain(events, { ledgerId: TEST_CHAIN_ID }).ok).toBe(true); // a shorter chain is still a valid chain
  });

  it("rewriting the LAST event together with its own hash is NOT detected without an external checkpoint", () => {
    const events = plain(fiveEvents().events());
    const last = def(events[4]);
    last["actorId"] = "operator_evil";
    last["eventHash"] = computeEventHash(withoutHash(last) as unknown as LedgerEventUnhashed);
    expect(verifyChain(events, { ledgerId: TEST_CHAIN_ID }).ok).toBe(true);
  });
});

describe("hash chain: rejected requests never enter the chain (L-20)", () => {
  it("100 rejected appends leave length and head unchanged", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    const head = ledger.headHash();
    for (let i = 0; i < 100; i++) {
      expect(ledger.append(lock("fund_a")).ok).toBe(false); // PARTICIPATING -> LOCKED is not allowed
    }
    expect(ledger.events().length).toBe(1);
    expect(ledger.headHash()).toBe(head);
  });

  it("callers cannot choose seq, prevHash, recordedAt, schemaVersion or eventHash", () => {
    const { ledger } = newLedger();
    for (const extra of [{ seq: 5 }, { prevHash: "a".repeat(64) }, { recordedAt: 1 }, { schemaVersion: 1 }, { eventHash: "a".repeat(64) }]) {
      expect(ledger.append({ ...participate("fund_a"), ...extra })).toEqual({ ok: false, reasonCode: "EVENT_MALFORMED" });
    }
    expect(ledger.events().length).toBe(0);
  });

  it("an invalid sequencer clock rejects the append and changes nothing", () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, Infinity]) {
      const ledger = new HashChainedLedger(() => bad, { ledgerId: TEST_CHAIN_ID });
      expect(ledger.append(participate("fund_a"))).toEqual({ ok: false, reasonCode: "LEDGER_CLOCK_INVALID" });
      expect(ledger.events().length).toBe(0);
    }
  });

  it("committed events are frozen and the caller's draft object cannot alter them afterwards", () => {
    const { ledger } = newLedger();
    const draft = participate("fund_a");
    const [e] = must(ledger.append(draft));
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(def(e).payload)).toBe(true);
    expect(() => {
      (e as unknown as Record<string, unknown>)["actorId"] = "x";
    }).toThrow();
    (draft.payload as Record<string, unknown>)["to"] = "NON_PARTICIPATION_LOCKED";
    expect(ledger.events()[0]?.payload).toMatchObject({ to: "PARTICIPATING" });
    expect(verifyChain(plain(ledger.events()), { ledgerId: TEST_CHAIN_ID }).ok).toBe(true);
  });
});
