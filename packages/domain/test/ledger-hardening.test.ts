/**
 * Security-QA review of PR #40: B-1 (no runtime access to the gate's internals / the log), M-2 (R6b),
 * M-3 (ledger id), the OperatorAction payload binding and the lowercase-signature rule.
 * M-1 and L-1 tests live in ledger-auth.test.ts next to the rules they change.
 */
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";
import { HashChainedLedger, verifyChain } from "../src/ledger/chain.js";
import { LEDGER_GENESIS_PREV_HASH, ledgerGenesisHash } from "../src/ledger/events.js";
import { AuthorizedLedger } from "../src/ledger/authorized.js";
import { PrincipalRole } from "../src/ledger/principals.js";
import {
  CLOSES_AT,
  LEDGER_TEST_DOMAIN,
  LEDGER_TEST_ID,
  PRINCIPALS,
  TEST_MAX_TTL_MS,
  annulDraft,
  closeDraft,
  makeAuthWorld,
  mustSubmit,
  principals,
  recordDraft,
  rej,
} from "./ledger-auth-fixtures.js";
import { HOUR, NOW } from "./fixtures.js";
import { must, newLedger, participate, lock, plain } from "./ledger-fixtures.js";
import { InMemoryFundRegistry, InMemoryIpoRegistry } from "../src/registry.js";

const sub = (w: ReturnType<typeof makeAuthWorld>, r: unknown) => w.ledger.submit(r);

describe("B-1: the gate's internals and the log cannot be changed at runtime", () => {
  it("an AuthorizedLedger has no own properties at all, and is frozen", () => {
    const w = makeAuthWorld();
    const l = w.ledger as unknown as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(l)).toEqual([]);
    expect(Object.getOwnPropertySymbols(l)).toEqual([]);
    expect(Object.isFrozen(l)).toBe(true);
    for (const name of ["config", "domainSeparator", "annulmentEnabled", "ledger", "consumed"]) expect(l[name], name).toBeUndefined();
  });

  it("assigning to the instance throws and cannot swap the principals (QA PoC: ledger.config.principals = ...)", async () => {
    const w = makeAuthWorld();
    const l = w.ledger as unknown as Record<string, unknown>;
    expect(() => {
      l["config"] = { principals: principals() };
    }).toThrow(TypeError);
    expect(() => {
      l["annulmentEnabled"] = true;
    }).toThrow(TypeError);
    // a forged signature by a key that is not registered stays rejected
    expect(sub(w, await recordDraft({ signer: "stranger_key" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(0);
  });

  it("the principal registry is frozen: its lookup methods cannot be swapped after the gate was built", () => {
    const registry = principals();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(() => {
      (registry as unknown as Record<string, unknown>)["get"] = () => undefined;
    }).toThrow(TypeError);
  });

  it("events() returns a frozen array: pop / push / splice throw and the head hash and state stay consistent (QA PoC)", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    mustSubmit(w.ledger, await recordDraft({ nonce: "b", fund: "fund_z", state: "NON_PARTICIPATION_LOCKED" }));
    const head = w.ledger.headHash();
    const events = w.ledger.events() as unknown as unknown[];
    expect(Object.isFrozen(events)).toBe(true);
    expect(() => events.pop()).toThrow(TypeError);
    expect(() => events.push({ forged: true })).toThrow(TypeError);
    expect(() => events.splice(0, 1)).toThrow(TypeError);
    expect(() => {
      events[0] = {};
    }).toThrow(TypeError);
    expect(w.ledger.headHash()).toBe(head);
    expect(w.ledger.events().length).toBe(2);
    expect(w.ledger.getState("fund_z", "ipo_1")).toBe("NON_PARTICIPATION_LOCKED");
    // the next honest request still works and the chain still verifies
    mustSubmit(w.ledger, await recordDraft({ nonce: "c", fund: "fund_y", actor: "manager_y", state: "PARTICIPATING" }));
    expect(verifyChain(plain(w.ledger.events()), { ledgerId: LEDGER_TEST_ID }).ok).toBe(true);
  });

  it("an array handed out earlier is a stable snapshot: later commits do not change it", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    const before = w.ledger.events();
    mustSubmit(w.ledger, await recordDraft({ nonce: "b", fund: "fund_z" }));
    expect(before.length).toBe(1);
    expect(w.ledger.events().length).toBe(2);
  });

  it("event objects are frozen too", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    const e = w.ledger.events()[0] as unknown as Record<string, unknown>;
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      e["actorId"] = "manager_y";
    }).toThrow(TypeError);
  });

  it("HashChainedLedger.events() is frozen as well (issue #37 section 2) and the class has no enumerable internals", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_b")));
    must(ledger.append(lock("fund_c")));
    const head = ledger.headHash();
    expect(() => (ledger.events() as unknown as unknown[]).pop()).toThrow(TypeError);
    expect(ledger.headHash()).toBe(head);
    expect(ledger.events().length).toBe(2);
    expect(Object.getOwnPropertyNames(ledger)).toEqual([]);
  });

  it("fromEvents rebuilds a ledger whose events() is frozen", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_b")));
    const rebuilt = HashChainedLedger.fromEvents(plain(ledger.events()), () => NOW);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(Object.isFrozen(rebuilt.ledger.events())).toBe(true);
    expect(rebuilt.ledger.headHash()).toBe(ledger.headHash());
  });

  it("the package barrel does not export the unauthenticated write path (HashChainedLedger) but does export the gate", () => {
    const names = Object.keys(barrel);
    expect(names).not.toContain("HashChainedLedger");
    expect(names).toContain("AuthorizedLedger");
    expect(names).toContain("verifyChain");
    expect(barrel.AuthorizedLedger).toBe(AuthorizedLedger);
  });
});

describe("M-2 / R6b: nothing is accepted once the sequencer clock reached the closing time", () => {
  it("record, lock and correction are refused at and after closesAt, with no grace and without IPO_CLOSED", async () => {
    const w = makeAuthWorld();
    const [p] = mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    w.clock.t = CLOSES_AT - 1;
    expect(sub(w, await recordDraft({ nonce: "b", fund: "fund_z" }))).toMatchObject({ ok: true });
    for (const t of [CLOSES_AT, CLOSES_AT + 1, CLOSES_AT + 30 * 24 * HOUR]) {
      w.clock.t = t;
      const exp = { expiresAt: t + HOUR };
      expect(sub(w, await recordDraft({ nonce: `r${t}`, fund: "fund_y", actor: "manager_y", ...exp })), `record at ${t}`).toEqual(rej("IPO_WINDOW_ELAPSED"));
      expect(sub(w, await recordDraft({ nonce: `l${t}`, fund: "fund_y", actor: "manager_y", state: "NON_PARTICIPATION_LOCKED", ...exp })), `lock at ${t}`).toEqual(rej("IPO_WINDOW_ELAPSED"));
      expect(sub(w, await annulDraft(p as never, { nonce: `a${t}`, approvalNonce: `p${t}`, expiresAt: t + HOUR, approvalExpiresAt: t + HOUR })), `annul at ${t}`).toEqual(rej("IPO_WINDOW_ELAPSED"));
    }
    expect(w.ledger.isClosed("ipo_1")).toBe(false);
    expect(w.ledger.getState("fund_y", "ipo_1")).toBe("UNKNOWN");
    expect(w.ledger.getState("fund_x", "ipo_1")).toBe("PARTICIPATING");
  });

  it("the window is per IPO: a different IPO is judged by its own closing time", async () => {
    const w = makeAuthWorld({
      config: {
        ipos: new InMemoryIpoRegistry([
          { ipoId: "ipo_1", subscriptionOpensAt: NOW - 24 * HOUR, subscriptionClosesAt: NOW + HOUR },
          { ipoId: "ipo_2", subscriptionOpensAt: NOW - 24 * HOUR, subscriptionClosesAt: NOW + 48 * HOUR },
        ]),
      },
    });
    w.clock.t = NOW + 2 * HOUR;
    expect(sub(w, await recordDraft({ nonce: "a", ipo: "ipo_1", expiresAt: NOW + 3 * HOUR }))).toEqual(rej("IPO_WINDOW_ELAPSED"));
    expect(sub(w, await recordDraft({ nonce: "b", ipo: "ipo_2", expiresAt: NOW + 3 * HOUR }))).toMatchObject({ ok: true });
  });

  it("IPO_CLOSED itself is still accepted at closesAt (R8), and after it the ledger fold's more specific rejection applies", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    w.clock.t = CLOSES_AT;
    expect(sub(w, await recordDraft({ nonce: "late1", fund: "fund_y", actor: "manager_y", expiresAt: CLOSES_AT + HOUR }))).toEqual(rej("IPO_WINDOW_ELAPSED"));
    mustSubmit(w.ledger, await closeDraft({ nonce: "c", ledgerSeqAtClose: 1, expiresAt: CLOSES_AT + HOUR }));
    expect(sub(w, await recordDraft({ nonce: "late2", fund: "fund_y", actor: "manager_y", expiresAt: CLOSES_AT + HOUR }))).toEqual(rej("IPO_ALREADY_CLOSED"));
  });

  it("with no operator configured the window still closes (the gap QA found: it stayed open forever)", async () => {
    const w = makeAuthWorld({ principals: principals(PRINCIPALS.filter((p) => p.role !== PrincipalRole.LEDGER_OPERATOR)) });
    w.clock.t = CLOSES_AT + 30 * 24 * HOUR;
    expect(sub(w, await recordDraft({ expiresAt: w.clock.t + HOUR }))).toEqual(rej("IPO_WINDOW_ELAPSED"));
    expect(w.ledger.events().length).toBe(0);
  });
});

describe("M-3: the ledger id is part of the genesis and of the signature domain", () => {
  it("two ledger ids give two genesis values; a missing id keeps the placeholder genesis", () => {
    const a = ledgerGenesisHash("ledger_a");
    const b = ledgerGenesisHash("ledger_b");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(LEDGER_GENESIS_PREV_HASH);
    expect(ledgerGenesisHash(undefined)).toBe(LEDGER_GENESIS_PREV_HASH);
    expect(ledgerGenesisHash("Not Valid")).toBeUndefined();
    expect(ledgerGenesisHash("")).toBeUndefined();
  });

  it("the first event of the chain links to the ledger-specific genesis; an empty ledger's head is that genesis", async () => {
    const w = makeAuthWorld();
    expect(w.ledger.headHash()).toBe(ledgerGenesisHash(LEDGER_TEST_ID));
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    expect(w.ledger.events()[0]?.prevHash).toBe(ledgerGenesisHash(LEDGER_TEST_ID));
    expect(w.ledger.ledgerId).toBe(LEDGER_TEST_ID);
  });

  it("a request signed for ledger A is refused by ledger B with everything else equal (QA PoC: staging vs production)", async () => {
    const a = makeAuthWorld({ config: { ledgerId: "ledger_a" } });
    const b = makeAuthWorld({ config: { ledgerId: "ledger_b" } });
    const forA = await recordDraft({ nonce: "a", ledgerId: "ledger_a" });
    expect(sub(a, forA)).toMatchObject({ ok: true });
    expect(sub(b, forA)).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(b.ledger.events().length).toBe(0);
    // and the signature for the default test ledger id is not valid on A
    expect(sub(a, await recordDraft({ nonce: "z" }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
  });

  it("a chain of ledger A does not verify as a chain of ledger B (cross-ledger replay of whole chains)", async () => {
    const a = makeAuthWorld({ config: { ledgerId: "ledger_a" } });
    mustSubmit(a.ledger, await recordDraft({ nonce: "a", ledgerId: "ledger_a" }));
    const stored = plain(a.ledger.events());
    expect(verifyChain(stored, { ledgerId: "ledger_a" }).ok).toBe(true);
    expect(verifyChain(stored, { ledgerId: "ledger_b" })).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_PREV_HASH_MISMATCH" });
    expect(verifyChain(stored)).toEqual({ ok: false, seq: 1, reasonCode: "LEDGER_PREV_HASH_MISMATCH" });
    expect(HashChainedLedger.fromEvents(stored, () => NOW, { ledgerId: "ledger_b" }).ok).toBe(false);
    expect(HashChainedLedger.fromEvents(stored, () => NOW, { ledgerId: "ledger_a" }).ok).toBe(true);
    expect(verifyChain(stored, { ledgerId: "Bad Id" }).ok).toBe(false);
  });

  it("invalid ledger ids and lifetimes are configuration errors (TypeError)", () => {
    const base = { now: () => NOW, domain: LEDGER_TEST_DOMAIN, principals: principals(), funds: new InMemoryFundRegistry([]), ipos: new InMemoryIpoRegistry([]), registrySeq: 1 };
    expect(() => new AuthorizedLedger({ ...base, ledgerId: "Not Valid", maxRequestTtlMs: HOUR })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, ledgerId: "", maxRequestTtlMs: HOUR })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, ledgerId: "ledger_a", maxRequestTtlMs: 0 })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, ledgerId: "ledger_a", maxRequestTtlMs: Number.NaN })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, ledgerId: "ledger_a", maxRequestTtlMs: TEST_MAX_TTL_MS + 0.5 })).toThrow(TypeError);
    expect(() => new AuthorizedLedger({ ...base, ledgerId: "ledger_a", maxRequestTtlMs: HOUR })).not.toThrow();
    expect(() => new HashChainedLedger(() => NOW, { ledgerId: "Not Valid" })).toThrow(TypeError);
  });
});

describe("OperatorAction binds the actor and the payload (design #38 section 3.2)", () => {
  it("a signature over another closesAt, another operator id or another ipo is rejected", async () => {
    const w = makeAuthWorld();
    w.clock.t = CLOSES_AT;
    const exp = { expiresAt: CLOSES_AT + HOUR };
    expect(sub(w, await closeDraft({ nonce: "c1", ledgerSeqAtClose: 0, signedClosesAt: CLOSES_AT + 1, ...exp }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await closeDraft({ nonce: "c2", ledgerSeqAtClose: 0, signedActor: "manager_x", ...exp }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(sub(w, await closeDraft({ nonce: "c3", ledgerSeqAtClose: 0, ipo: "ipo_2", signedIpo: "ipo_1", ...exp }))).toEqual(rej("LEDGER_SIGNATURE_INVALID"));
    expect(w.ledger.events().length).toBe(0);
    expect(sub(w, await closeDraft({ nonce: "c4", ledgerSeqAtClose: 0, ...exp }))).toMatchObject({ ok: true });
  });

  it("ledgerSeqAtClose is filled by the sequencer and is deliberately not part of the signature: changing it does not break the signature but the fold still checks it", async () => {
    const w = makeAuthWorld();
    mustSubmit(w.ledger, await recordDraft({ nonce: "a" }));
    w.clock.t = CLOSES_AT;
    expect(sub(w, await closeDraft({ nonce: "c1", ledgerSeqAtClose: 7, expiresAt: CLOSES_AT + HOUR }))).toEqual(rej("LEDGER_CLOSE_SEQ_MISMATCH"));
  });
});
