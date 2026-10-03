/** State derivation over events: transitions, absence = UNKNOWN, close cut-off, corrections (design L-10, L-11, L-14, L-22..L-33). */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../src/ledger/chain.js";
import { LedgerProjection } from "../src/ledger/derive.js";
import { DEMO_RULE_V1 } from "../src/rules.js";
import { verifyBid } from "../src/verify.js";
import { makeEnv } from "./fixtures.js";
import { annul, close, lock, must, newLedger, participate, participateBound, plain, def } from "./ledger-fixtures.js";

const rejected = (reasonCode: string) => ({ ok: false, reasonCode });

describe("absence is UNKNOWN, never non-participation (principle C)", () => {
  it("an empty ledger, unknown fund, unknown IPO and other-IPO records are all UNKNOWN", () => {
    const { ledger } = newLedger();
    expect(ledger.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
    must(ledger.append(participate("fund_x", "ipo_2")));
    expect(ledger.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
    expect(ledger.getState("fund_y", "ipo_2")).toBe("UNKNOWN");
    expect(ledger.getStateAt("fund_x", "ipo_2", 0)).toBe("UNKNOWN");
  });

  it("invalid atSeq values give UNKNOWN (fail closed)", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate()));
    for (const bad of [Number.NaN, 1.5, Infinity, -1]) expect(ledger.getStateAt("fund_x", "ipo_1", bad), String(bad)).toBe("UNKNOWN");
    expect(ledger.getStateAt("fund_x", "ipo_1", Number.MAX_SAFE_INTEGER)).toBe("PARTICIPATING");
  });

  it("used as the participation lookup of verifyBid: UNKNOWN underlying funds are rejected until the ledger records them", () => {
    const base = makeEnv({ recordStates: false });
    const { ledger } = newLedger();
    const deps = { ...base.deps, participation: ledger };
    const bid = { fundId: "fund_a", ipoId: "ipo_1", bidAmount: 24_000_000_000n };
    expect(verifyBid(bid, deps)).toMatchObject({ eligible: false, reasonCode: "UNDERLYING_PARTICIPATION_UNKNOWN" });
    must(ledger.append(participate("fund_b")));
    must(ledger.append(lock("fund_c")));
    expect(verifyBid(bid, deps)).toMatchObject({ eligible: true, reasonCode: "ELIGIBLE" });
    expect(DEMO_RULE_V1.id).toBe("DEMO_RULE_V1");
  });
});

describe("transitions (principle D; design L-10)", () => {
  it("UNKNOWN -> PARTICIPATING and UNKNOWN -> NON_PARTICIPATION_LOCKED are the only recorded transitions", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    must(ledger.append(lock("fund_b")));
    expect(ledger.getState("fund_a", "ipo_1")).toBe("PARTICIPATING");
    expect(ledger.getState("fund_b", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
  });

  it("reversal, switching and repeats are rejected with the existing transition reasons and leave the ledger unchanged", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    must(ledger.append(lock("fund_b")));
    const head = ledger.headHash();
    expect(ledger.append(lock("fund_a"))).toEqual(rejected("PARTICIPATION_ALREADY_RECORDED"));
    expect(ledger.append(participate("fund_a"))).toEqual(rejected("PARTICIPATION_ALREADY_RECORDED"));
    expect(ledger.append(participate("fund_b"))).toEqual(rejected("NON_PARTICIPATION_LOCK_ACTIVE"));
    expect(ledger.append(lock("fund_b"))).toEqual(rejected("NON_PARTICIPATION_LOCK_ACTIVE"));
    expect(ledger.headHash()).toBe(head);
    expect(ledger.events().length).toBe(2);
    expect(ledger.getState("fund_a", "ipo_1")).toBe("PARTICIPATING");
    expect(ledger.getState("fund_b", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
  });

  it("a payload whose `from` disagrees with the derived state is rejected", () => {
    const { ledger } = newLedger();
    const wrongFrom = participate("fund_a", "ipo_1", { payload: { from: "PARTICIPATING", to: "PARTICIPATING", origin: "INDEPENDENT" } });
    expect(ledger.append(wrongFrom)).toEqual(rejected("LEDGER_PAYLOAD_STATE_MISMATCH"));
    const lockedFrom = lock("fund_a", "ipo_1", { payload: { from: "NON_PARTICIPATION_LOCKED", to: "NON_PARTICIPATION_LOCKED", origin: "INDEPENDENT" } });
    expect(ledger.append(lockedFrom)).toEqual(rejected("LEDGER_PAYLOAD_STATE_MISMATCH"));
    expect(ledger.events().length).toBe(0);
  });

  it("states are per (fund, IPO)", () => {
    const { ledger } = newLedger();
    must(ledger.append(lock("fund_a", "ipo_1")));
    must(ledger.append(participate("fund_a", "ipo_2")));
    expect(ledger.getState("fund_a", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    expect(ledger.getState("fund_a", "ipo_2")).toBe("PARTICIPATING");
  });
});

describe("IPO_CLOSED cut-off (design L-11, L-14, L-31)", () => {
  it("after IPO_CLOSED, state events and corrections for that IPO are rejected; other IPOs and past states are unaffected", () => {
    const { ledger } = newLedger();
    const [p] = must(ledger.append(participate("fund_a", "ipo_1")));
    must(ledger.append(close(1, "ipo_1")));
    const head = ledger.headHash();
    expect(ledger.append(participate("fund_b", "ipo_1"))).toEqual(rejected("IPO_ALREADY_CLOSED"));
    expect(ledger.append(lock("fund_b", "ipo_1"))).toEqual(rejected("IPO_ALREADY_CLOSED"));
    expect(ledger.append(annul(def(p), { fundId: "fund_a" }))).toEqual(rejected("IPO_ALREADY_CLOSED"));
    expect(ledger.headHash()).toBe(head);
    expect(ledger.getState("fund_a", "ipo_1")).toBe("PARTICIPATING");
    expect(ledger.getState("fund_b", "ipo_1")).toBe("UNKNOWN"); // stays UNKNOWN for good
    must(ledger.append(participate("fund_b", "ipo_2")));
    expect(ledger.isClosed("ipo_1")).toBe(true);
    expect(ledger.isClosed("ipo_2")).toBe(false);
    expect(ledger.cutoffSeq("ipo_1")).toBe(1);
    expect(ledger.cutoffSeq("ipo_2")).toBeUndefined();
  });

  it("a second IPO_CLOSED is rejected; ledgerSeqAtClose must be seq - 1", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    expect(ledger.append(close(5))).toEqual(rejected("LEDGER_CLOSE_SEQ_MISMATCH"));
    expect(ledger.append(close(0))).toEqual(rejected("LEDGER_CLOSE_SEQ_MISMATCH"));
    must(ledger.append(close(1)));
    expect(ledger.append(close(2))).toEqual(rejected("IPO_ALREADY_CLOSED"));
  });

  it("ordering is by seq, not by claimed time: a back-dated requestedAt does not get past the close (L-19)", () => {
    const { ledger } = newLedger();
    must(ledger.append(close(0)));
    expect(ledger.append(participate("fund_a", "ipo_1", { requestedAt: 1 }))).toEqual(rejected("IPO_ALREADY_CLOSED"));
  });

  it("getStateAt returns the state as of a seq, including the cut-off seq, and ignores later events", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    must(ledger.append(lock("fund_b")));
    must(ledger.append(close(2)));
    expect(ledger.getStateAt("fund_a", "ipo_1", 0)).toBe("UNKNOWN");
    expect(ledger.getStateAt("fund_a", "ipo_1", 1)).toBe("PARTICIPATING");
    expect(ledger.getStateAt("fund_b", "ipo_1", 1)).toBe("UNKNOWN");
    expect(ledger.getStateAt("fund_b", "ipo_1", def(ledger.cutoffSeq("ipo_1")))).toBe("NON_PARTICIPATION_LOCKED");
  });
});

describe("EVENT_ANNULLED corrections (design L-22..L-33)", () => {
  const withP = () => {
    const { ledger } = newLedger();
    must(ledger.append(lock("fund_y"))); // seq 1
    must(ledger.append(lock("fund_z"))); // seq 2
    must(ledger.append(lock("fund_w"))); // seq 3
    must(ledger.append(lock("fund_v"))); // seq 4
    const [p] = must(ledger.append(participate("fund_x"))); // seq 5
    return { ledger, p: def(p) };
  };

  it("a correction appends an event, resets the effective state to UNKNOWN and leaves the old event and the chain intact (L-22)", () => {
    const { ledger, p } = withP();
    expect(p.seq).toBe(5);
    const [a] = must(ledger.append(annul(p)));
    expect(a?.seq).toBe(6);
    expect(ledger.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
    expect(ledger.getStateAt("fund_x", "ipo_1", 5)).toBe("PARTICIPATING");
    expect(ledger.getStateAt("fund_x", "ipo_1", 6)).toBe("UNKNOWN");
    expect(ledger.events()[4]).toBe(p);
    expect(verifyChain(plain(ledger.events()))).toMatchObject({ ok: true, length: 6 });
  });

  it("after a correction a fresh record is possible, and then a correction again (new target), but not of the stale target", () => {
    const { ledger, p } = withP();
    must(ledger.append(annul(p)));
    const [again] = must(ledger.append(lock("fund_x"))); // seq 7
    expect(ledger.getState("fund_x", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    expect(ledger.append(annul(p))).toEqual(rejected("LEDGER_ANNUL_TARGET_INVALID")); // already annulled
    must(ledger.append(annul(def(again))));
    expect(ledger.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
  });

  it("invalid targets are rejected and change nothing: wrong hash, annulment as target, other fund, other IPO, non-state event, future seq, already annulled (L-27)", () => {
    const { ledger, p } = withP();
    const [a] = must(ledger.append(annul(p))); // seq 6
    const head = ledger.headHash();
    const events = ledger.events();
    const cases = [
      annul({ seq: 5, eventHash: "c".repeat(64) }), // wrong hash (and already annulled)
      annul(def(a)), // a correction cannot be corrected
      annul(def(events[0]), { fundId: "fund_x" }), // seq 1 belongs to fund_y
      annul(def(events[0]), { fundId: "fund_y", ipoId: "ipo_2" }), // other IPO
      annul({ seq: 99, eventHash: "d".repeat(64) }), // does not exist yet
      annul({ seq: 7, eventHash: "d".repeat(64) }), // its own position / the future
    ];
    for (const c of cases) expect(ledger.append(c), JSON.stringify(c.payload)).toEqual(rejected("LEDGER_ANNUL_TARGET_INVALID"));
    expect(ledger.headHash()).toBe(head);
  });

  it("only the event that created the CURRENT effective state can be corrected", () => {
    const { ledger, p } = withP();
    must(ledger.append(annul(p)));
    const [second] = must(ledger.append(participate("fund_x")));
    expect(ledger.append(annul(p))).toEqual(rejected("LEDGER_ANNUL_TARGET_INVALID"));
    must(ledger.append(annul(def(second))));
  });

  it("a correction with replacement appends both events with consecutive seq (L-28)", () => {
    const { ledger, p } = withP();
    const added = must(ledger.appendAtomic([annul(p, { replacement: "NON_PARTICIPATION_LOCKED" }), lock("fund_x")]));
    expect(added.map((e) => e.seq)).toEqual([6, 7]);
    expect(added[1]?.prevHash).toBe(added[0]?.eventHash);
    expect(ledger.getState("fund_x", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    expect(ledger.getStateAt("fund_x", "ipo_1", 6)).toBe("UNKNOWN");
    expect(verifyChain(plain(ledger.events())).ok).toBe(true);
  });

  it("atomicity: a lone correction that owes a replacement, a wrong replacement, or a bad second draft add NOTHING (L-29)", () => {
    const { ledger, p } = withP();
    const head = ledger.headHash();
    const owed = annul(p, { replacement: "NON_PARTICIPATION_LOCKED" });
    expect(ledger.append(owed)).toEqual(rejected("LEDGER_ANNUL_REPLACEMENT_MISSING"));
    expect(ledger.appendAtomic([owed, participate("fund_x")])).toEqual(rejected("LEDGER_ANNUL_REPLACEMENT_MISSING")); // wrong state
    expect(ledger.appendAtomic([owed, lock("fund_other")])).toEqual(rejected("LEDGER_ANNUL_REPLACEMENT_MISSING")); // wrong fund
    expect(ledger.appendAtomic([owed, close(6), lock("fund_x")])).toEqual(rejected("LEDGER_ANNUL_REPLACEMENT_MISSING")); // something in between
    expect(ledger.appendAtomic([owed, lock("fund_x", "ipo_1", { payload: { from: "UNKNOWN", to: "NON_PARTICIPATION_LOCKED", origin: "INDEPENDENT" } }), lock("fund_x")])).toMatchObject({ ok: false });
    expect(ledger.appendAtomic([owed, { not: "a draft" }])).toEqual(rejected("EVENT_MALFORMED"));
    expect(ledger.appendAtomic([])).toEqual(rejected("EVENT_MALFORMED"));
    expect(ledger.headHash()).toBe(head);
    expect(ledger.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
    expect(ledger.events().length).toBe(5);
  });

  it("verifyChain rejects a chain where the owed replacement is missing or not adjacent", () => {
    // Build the two-event chain, then cut the replacement off the end.
    const { ledger, p } = withP();
    must(ledger.appendAtomic([annul(p, { replacement: "NON_PARTICIPATION_LOCKED" }), lock("fund_x")]));
    const events = plain(ledger.events());
    expect(verifyChain(events.slice(0, 6))).toEqual({ ok: false, seq: 6, reasonCode: "LEDGER_ANNUL_REPLACEMENT_MISSING" });
  });

  it("a correction needs exactly one approver co-signature (bid withdrawals none); shape only, signatures are not verified here", () => {
    const { ledger, p } = withP();
    expect(ledger.append(annul(p, { co: [] }))).toEqual(rejected("EVENT_MALFORMED"));
    expect(ledger.append(annul(p, { co: [annul(p).coAuthorizations[0], annul(p).coAuthorizations[0]] }))).toEqual(rejected("EVENT_MALFORMED"));
    expect(ledger.append(participate("fund_q", "ipo_1", { coAuthorizations: annul(p).coAuthorizations }))).toEqual(rejected("EVENT_MALFORMED"));
    expect(ledger.events().length).toBe(5);
  });
});

describe("BIND-1 records and bid withdrawal (structural side of R12 / R15)", () => {
  it("a BIND-1 PARTICIPATING cannot be corrected around the bid (R12, L-30)", () => {
    const { ledger } = newLedger();
    const [b] = must(ledger.append(participateBound("fund_x", "ipo_1", "bid_1")));
    expect(ledger.append(annul(def(b)))).toEqual(rejected("LEDGER_ANNUL_BOUND_TO_BID"));
    expect(ledger.append(annul(def(b), { reason: "KEY_COMPROMISE" }))).toEqual(rejected("LEDGER_ANNUL_BOUND_TO_BID"));
    expect(ledger.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
  });

  it("an independent PARTICIPATING can be corrected (L-30)", () => {
    const { ledger } = newLedger();
    const [p] = must(ledger.append(participate()));
    must(ledger.append(annul(def(p))));
    expect(ledger.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
  });

  it("a withdrawal of the matching bid annuls the BIND-1 record, with or without a replacement (L-39, L-40)", () => {
    const a = newLedger().ledger;
    const [b1] = must(a.append(participateBound("fund_x", "ipo_1", "bid_1")));
    must(a.append(annul(def(b1), { reason: "BID_WITHDRAWN", bidId: "bid_1" })));
    expect(a.getState("fund_x", "ipo_1")).toBe("UNKNOWN");

    const b = newLedger().ledger;
    const [b2] = must(b.append(participateBound("fund_x", "ipo_1", "bid_1")));
    must(b.appendAtomic([annul(def(b2), { reason: "BID_WITHDRAWN", bidId: "bid_1", replacement: "NON_PARTICIPATION_LOCKED" }), lock("fund_x")]));
    expect(b.getState("fund_x", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
  });

  it("a withdrawal of another bid, or of an independent record, does not annul anything (L-43)", () => {
    const { ledger } = newLedger();
    const [b] = must(ledger.append(participateBound("fund_x", "ipo_1", "bid_1")));
    expect(ledger.append(annul(def(b), { reason: "BID_WITHDRAWN", bidId: "bid_2" }))).toEqual(rejected("LEDGER_ANNUL_TARGET_INVALID"));
    const other = newLedger().ledger;
    const [p] = must(other.append(participate("fund_x")));
    expect(other.append(annul(def(p), { reason: "BID_WITHDRAWN", bidId: "bid_1" }))).toEqual(rejected("LEDGER_ANNUL_TARGET_INVALID"));
    expect(other.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
  });

  it("a withdrawal after the close is rejected (L-41)", () => {
    const { ledger } = newLedger();
    const [b] = must(ledger.append(participateBound("fund_x", "ipo_1", "bid_1")));
    must(ledger.append(close(1)));
    expect(ledger.append(annul(def(b), { reason: "BID_WITHDRAWN", bidId: "bid_1" }))).toEqual(rejected("IPO_ALREADY_CLOSED"));
  });
});

describe("LedgerProjection", () => {
  it("clone is independent of the original", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate()));
    const p = new LedgerProjection();
    const copy = p.clone();
    expect(copy.getState("fund_x", "ipo_1")).toBe("UNKNOWN");
    expect(copy).not.toBe(p);
  });

  it("a rejected event does not leave a trace in the projection (all-or-nothing apply)", () => {
    const { ledger } = newLedger();
    must(ledger.append(lock("fund_a")));
    for (let i = 0; i < 3; i++) expect(ledger.append(participate("fund_a")).ok).toBe(false);
    expect(ledger.getStateAt("fund_a", "ipo_1", 99)).toBe("NON_PARTICIPATION_LOCKED");
    expect(ledger.events().length).toBe(1);
  });
});
