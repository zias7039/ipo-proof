/** Event envelope parsing: strictness, closed payloads, principle E (no amounts), unsupported types (design §2.2-§2.3). */
import { describe, expect, it } from "vitest";
import { HashChainedLedger, verifyChain } from "../src/ledger/chain.js";
import { parseLedgerEvent, parseLedgerEventDraft } from "../src/ledger/events.js";
import { TEST_CHAIN_ID, annul, auth, close, lock, must, newLedger, participate, participateBound, plain, SIG, def } from "./ledger-fixtures.js";

const malformed = { ok: false, reasonCode: "EVENT_MALFORMED" };
const draftOk = (d: unknown) => parseLedgerEventDraft(d).ok;

describe("principle E: events carry no amounts, and any extra field makes the event malformed", () => {
  it("rejects amount-like fields at the top level and inside payloads/authorization", () => {
    const { ledger } = newLedger();
    for (const field of ["bidAmount", "exposureKrw", "grossCapacityKrw", "capacityKrw", "amount", "note", "underlyingFundIds"]) {
      expect(ledger.append({ ...participate("fund_a"), [field]: "1" }), `top ${field}`).toEqual(malformed);
      expect(
        ledger.append(participate("fund_a", "ipo_1", { payload: { from: "UNKNOWN", to: "PARTICIPATING", origin: "INDEPENDENT", [field]: "1" } })),
        `payload ${field}`,
      ).toEqual(malformed);
      expect(ledger.append(participate("fund_a", "ipo_1", { authorization: { ...auth(), [field]: "1" } })), `auth ${field}`).toEqual(malformed);
    }
    for (const value of [24_000_000_000n, 24_000_000_000, 1.5, "24000000000"]) {
      expect(ledger.append(participate("fund_a", "ipo_1", { payload: { from: "UNKNOWN", to: "PARTICIPATING", origin: "INDEPENDENT", amount: value } }))).toEqual(malformed);
    }
    expect(ledger.events().length).toBe(0);
  });

  it("a bigint where an integer is expected is rejected (no silent coercion)", () => {
    expect(draftOk(close(0, "ipo_1"))).toBe(true);
    expect(draftOk({ ...close(0), requestedAt: 1n })).toBe(false);
    expect(draftOk({ ...close(0), payload: { closesAt: 1n, ledgerSeqAtClose: 0 } })).toBe(false);
  });

  it("the serialized chain contains only ids, enum tokens, hashes, signatures and integer times", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    must(ledger.append(lock("fund_b")));
    must(ledger.append(close(2)));
    const text = JSON.stringify(ledger.events());
    for (const forbidden of ["Krw", "amount", "capacity", "exposure", "bid_amount"]) expect(text.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
  });
});

describe("strict parsing (fail closed)", () => {
  it("accepts the four supported event types in their valid shapes", () => {
    const { ledger } = newLedger();
    const [p] = must(ledger.append(participate("fund_a")));
    must(ledger.append(participateBound("fund_b", "ipo_1", "bid_1")));
    must(ledger.append(lock("fund_c")));
    must(ledger.append(annul(def(p), { fundId: "fund_a" })));
    must(ledger.append(close(4)));
    expect(verifyChain(plain(ledger.events()), { ledgerId: TEST_CHAIN_ID }).ok).toBe(true);
  });

  it("rejects non-objects, arrays, missing/extra fields and wrong types", () => {
    for (const bad of [null, undefined, 1, "x", [], {}, { ...participate(), eventType: undefined }]) expect(parseLedgerEventDraft(bad), String(bad)).toEqual(malformed);
    const d = participate();
    for (const key of Object.keys(d)) {
      const rest = Object.fromEntries(Object.entries(d).filter(([k]) => k !== key));
      expect(draftOk(rest), `missing ${key}`).toBe(false);
    }
  });

  it("rejects non-synthetic ids (real-looking names, uppercase, empty, too long)", () => {
    for (const id of ["Fund A", "FUND_A", "", "a".repeat(65), "한글", "fund-a", "1fund"]) {
      expect(draftOk(participate(id)), id).toBe(false);
      expect(draftOk(participate("fund_a", id)), id).toBe(false);
      expect(draftOk(participate("fund_a", "ipo_1", { actorId: id })), id).toBe(false);
    }
  });

  it("rejects bad signatures, schemes, nonces and times in authorization", () => {
    const base = auth();
    for (const a of [
      { ...base, signature: "0x" + "ab".repeat(64) },
      { ...base, signature: SIG.slice(2) },
      { ...base, signature: "unverified_demo_signature" },
      { ...base, scheme: "eip712" },
      { ...base, requestNonce: "has space" },
      { ...base, requestNonce: "" },
      { ...base, expiresAt: -1 },
      { ...base, expiresAt: 1.5 },
    ]) {
      expect(draftOk(participate("fund_a", "ipo_1", { authorization: a })), JSON.stringify(a)).toBe(false);
    }
  });

  it("rejects inconsistent payloads: wrong `to`, BIND_1 without bidId, INDEPENDENT with bidId, LOCKED with BIND_1, bad hash, bad reason", () => {
    expect(draftOk(participate("fund_a", "ipo_1", { payload: { from: "UNKNOWN", to: "NON_PARTICIPATION_LOCKED", origin: "INDEPENDENT" } }))).toBe(false);
    expect(draftOk(participate("fund_a", "ipo_1", { payload: { from: "UNKNOWN", to: "PARTICIPATING", origin: "BIND_1" } }))).toBe(false);
    expect(draftOk(participate("fund_a", "ipo_1", { payload: { from: "UNKNOWN", to: "PARTICIPATING", origin: "INDEPENDENT", bidId: "bid_1" } }))).toBe(false);
    expect(draftOk(lock("fund_a", "ipo_1", { payload: { from: "UNKNOWN", to: "NON_PARTICIPATION_LOCKED", origin: "BIND_1" } }))).toBe(false);
    expect(draftOk(participate("fund_a", "ipo_1", { payload: { from: "REMOVED", to: "PARTICIPATING", origin: "INDEPENDENT" } }))).toBe(false);
    const t = { seq: 1, eventHash: "a".repeat(64) };
    expect(draftOk(annul(t))).toBe(true);
    expect(draftOk(annul({ seq: 1, eventHash: "A".repeat(64) }))).toBe(false);
    expect(draftOk(annul({ seq: 0, eventHash: t.eventHash }))).toBe(false);
    expect(draftOk(annul(t, { reason: "WHATEVER" }))).toBe(false);
    expect(draftOk(annul(t, { replacement: "UNKNOWN" }))).toBe(false);
    expect(draftOk(annul(t, { reason: "BID_WITHDRAWN" }))).toBe(false); // bidId required
    expect(draftOk(annul(t, { bidId: "bid_1" }))).toBe(false); // bidId only for BID_WITHDRAWN
  });

  it("IPO_CLOSED has no subject fund; state events need one", () => {
    expect(draftOk({ ...close(0), subjectFundId: "fund_a" })).toBe(false);
    expect(draftOk({ ...participate(), subjectFundId: null })).toBe(false);
  });

  it("known-but-unsupported event types are rejected with their own reason, unknown names are malformed (fail closed)", () => {
    for (const t of ["IPO_FINALIZED", "FINDING_ANNOTATED", "MANAGER_KEY_REVOKED"]) {
      expect(parseLedgerEventDraft({ ...close(0), eventType: t })).toEqual({ ok: false, reasonCode: "EVENT_TYPE_NOT_SUPPORTED" });
      expect(newLedger().ledger.append({ ...close(0), eventType: t })).toEqual({ ok: false, reasonCode: "EVENT_TYPE_NOT_SUPPORTED" });
    }
    for (const t of ["ALLOW_ALL", "", "constructor", "__proto__", "toString"]) expect(parseLedgerEventDraft({ ...close(0), eventType: t }), t).toEqual(malformed);
  });

  it("rejects accessor properties, symbol keys, exotic prototypes and throwing proxies instead of crashing or passing them", () => {
    const withGetter = { ...participate() };
    Object.defineProperty(withGetter, "actorId", { enumerable: true, get: () => "manager_x" });
    expect(parseLedgerEventDraft(withGetter)).toEqual(malformed);
    expect(parseLedgerEventDraft({ ...participate(), [Symbol("x")]: 1 })).toEqual(malformed);
    expect(parseLedgerEventDraft(Object.assign(Object.create({ inherited: 1 }) as object, participate()))).toEqual(malformed);
    const proxy = new Proxy(participate(), {
      getOwnPropertyDescriptor() {
        throw new Error("boom");
      },
    });
    expect(parseLedgerEventDraft(proxy)).toEqual(malformed);
    expect(parseLedgerEventDraft(Object.assign(Object.create(null) as object, participate())).ok).toBe(true); // null-prototype plain data is fine
  });

  it("rejects sparse arrays and arrays with extra properties for coAuthorizations", () => {
    const rest: Record<string, unknown> = { ...annul({ seq: 1, eventHash: "a".repeat(64) }) };
    delete rest["coAuthorizations"];
    const co = annul({ seq: 1, eventHash: "a".repeat(64) }).coAuthorizations as unknown[];
    const sparse = new Array(1) as unknown[];
    const extra = [...co] as unknown[] & { x?: number };
    extra.x = 1;
    expect(draftOk({ ...rest, coAuthorizations: sparse })).toBe(false);
    expect(draftOk({ ...rest, coAuthorizations: extra })).toBe(false);
    expect(draftOk({ ...rest, coAuthorizations: co })).toBe(true);
  });

  it("parseLedgerEvent returns a frozen copy: mutating the input afterwards does not change it", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    const raw = def(plain(ledger.events())[0]);
    const parsed = parseLedgerEvent(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    (raw["payload"] as Record<string, unknown>)["to"] = "NON_PARTICIPATION_LOCKED";
    expect(parsed.value.payload).toMatchObject({ to: "PARTICIPATING" });
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.authorization)).toBe(true);
  });

  it("schemaVersion other than 1 is rejected in stored events", () => {
    const { ledger } = newLedger();
    must(ledger.append(participate("fund_a")));
    const raw = def(plain(ledger.events())[0]);
    raw["schemaVersion"] = 2;
    expect(parseLedgerEvent(raw)).toEqual(malformed);
    expect(HashChainedLedger.fromEvents([raw], () => 1, { ledgerId: TEST_CHAIN_ID })).toMatchObject({ ok: false, seq: 1 });
  });
});
