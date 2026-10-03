import { describe, expect, it } from "vitest";
import {
  InMemoryParticipationLedger,
  ParticipationState as S,
  TransitionRejection,
  transition,
} from "../src/participation.js";

describe("transition()", () => {
  it("allows UNKNOWN -> PARTICIPATING and UNKNOWN -> NON_PARTICIPATION_LOCKED", () => {
    expect(transition(S.UNKNOWN, S.PARTICIPATING)).toEqual({ ok: true, from: S.UNKNOWN, to: S.PARTICIPATING });
    expect(transition(S.UNKNOWN, S.NON_PARTICIPATION_LOCKED)).toEqual({
      ok: true,
      from: S.UNKNOWN,
      to: S.NON_PARTICIPATION_LOCKED,
    });
  });

  it("forbids PARTICIPATING -> NON_PARTICIPATION_LOCKED", () => {
    expect(transition(S.PARTICIPATING, S.NON_PARTICIPATION_LOCKED)).toMatchObject({
      ok: false,
      reasonCode: TransitionRejection.PARTICIPATION_ALREADY_RECORDED,
    });
  });

  it("forbids NON_PARTICIPATION_LOCKED -> PARTICIPATING with NON_PARTICIPATION_LOCK_ACTIVE", () => {
    expect(transition(S.NON_PARTICIPATION_LOCKED, S.PARTICIPATING)).toMatchObject({
      ok: false,
      reasonCode: "NON_PARTICIPATION_LOCK_ACTIVE",
    });
  });

  it("forbids same-state repeats", () => {
    expect(transition(S.PARTICIPATING, S.PARTICIPATING).ok).toBe(false);
    expect(transition(S.NON_PARTICIPATION_LOCKED, S.NON_PARTICIPATION_LOCKED).ok).toBe(false);
  });

  it("never allows moving back to UNKNOWN or to garbage targets", () => {
    for (const from of Object.values(S)) {
      expect(transition(from, S.UNKNOWN)).toMatchObject({ ok: false, reasonCode: TransitionRejection.INVALID_TARGET_STATE });
      expect(transition(from, "SOMETHING_ELSE").ok).toBe(false);
    }
  });

  it("exhaustively allows only the two UNKNOWN-origin transitions", () => {
    const allowed: string[] = [];
    for (const from of Object.values(S)) {
      for (const to of Object.values(S)) {
        if (transition(from, to).ok) allowed.push(`${from}->${to}`);
      }
    }
    expect(allowed.sort()).toEqual(["UNKNOWN->NON_PARTICIPATION_LOCKED", "UNKNOWN->PARTICIPATING"]);
  });
});

describe("InMemoryParticipationLedger", () => {
  it("treats absence as UNKNOWN, not as non-participation", () => {
    const ledger = new InMemoryParticipationLedger(() => 1);
    expect(ledger.getState("fund_a", "ipo_1")).toBe(S.UNKNOWN);
    expect(ledger.history()).toHaveLength(0);
  });

  it("records state per Fund+IPO pair independently", () => {
    const ledger = new InMemoryParticipationLedger(() => 1);
    ledger.requestParticipation("fund_a", "ipo_1");
    expect(ledger.getState("fund_a", "ipo_1")).toBe(S.PARTICIPATING);
    expect(ledger.getState("fund_a", "ipo_2")).toBe(S.UNKNOWN);
    expect(ledger.getState("fund_b", "ipo_1")).toBe(S.UNKNOWN);
  });

  it("rejects participation for a locked fund and leaves state/history unchanged", () => {
    const ledger = new InMemoryParticipationLedger(() => 5);
    expect(ledger.requestNonParticipationLock("fund_c", "ipo_1").ok).toBe(true);
    const r = ledger.requestParticipation("fund_c", "ipo_1");
    expect(r).toMatchObject({ ok: false, reasonCode: "NON_PARTICIPATION_LOCK_ACTIVE" });
    expect(ledger.getState("fund_c", "ipo_1")).toBe(S.NON_PARTICIPATION_LOCKED);
    expect(ledger.history()).toHaveLength(1);
  });

  it("rejects locking an already PARTICIPATING fund", () => {
    const ledger = new InMemoryParticipationLedger(() => 5);
    ledger.requestParticipation("fund_b", "ipo_1");
    const r = ledger.requestNonParticipationLock("fund_b", "ipo_1");
    expect(r).toMatchObject({ ok: false, reasonCode: "PARTICIPATION_ALREADY_RECORDED" });
    expect(ledger.getState("fund_b", "ipo_1")).toBe(S.PARTICIPATING);
  });

  it("appends history entries with injected clock time", () => {
    let t = 100;
    const ledger = new InMemoryParticipationLedger(() => t++);
    ledger.requestParticipation("fund_a", "ipo_1");
    ledger.requestNonParticipationLock("fund_c", "ipo_1");
    expect(ledger.history()).toEqual([
      { seq: 1, fundId: "fund_a", ipoId: "ipo_1", from: "UNKNOWN", to: "PARTICIPATING", at: 100 },
      { seq: 2, fundId: "fund_c", ipoId: "ipo_1", from: "UNKNOWN", to: "NON_PARTICIPATION_LOCKED", at: 101 },
    ]);
  });
});
