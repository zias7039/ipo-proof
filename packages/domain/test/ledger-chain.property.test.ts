/**
 * 속성 기반(property-based) 테스트: 참여 원장 해시 체인 (이슈 #22).
 *
 * 불변식: (1) 유효한 체인의 어떤 한 이벤트의 어떤 필드를 바꿔도, 두 이벤트의 순서를 바꾸거나 이벤트를
 * 삭제·복제·삽입해도 verifyChain이 이를 탐지한다. (2) 끝부분 잘라내기는 외부 체크포인트(길이, 머리 해시) 없이는
 * 탐지되지 않지만, 체크포인트와 비교하면 항상 탐지된다. (3) 어떤 입력에서도 던지지 않고, 거부된 요청은
 * 체인을 바꾸지 않는다. (4) 결정적이며 fromEvents로 같은 상태가 복원된다.
 *
 * 범위 밖(구현되지 않음): 서명 검증, 호출자 인가, 원장 식별자(이슈 #37). 이 파일이 "다룬다"고 주장하지 않는다.
 * 알려진 결함은 `it.fails`로 표시했다. 고쳐지면 `it`으로 바꾼다.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HashChainedLedger, verifyChain } from "../src/ledger/chain.js";
import { parseLedgerEvent, parseLedgerEventDraft } from "../src/ledger/events.js";
import type { LedgerEvent } from "../src/ledger/events.js";
import { close, lock, newLedger, participate, plain } from "./ledger-fixtures.js";

const RUNS = { numRuns: 120 };
const FUNDS = ["fund_b", "fund_c", "fund_d"] as const;
const IPOS = ["ipo_1", "ipo_2"] as const;

type Op = { readonly kind: "participate" | "lock" | "close"; readonly fund: number; readonly ipo: number };
const op: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom("participate", "lock", "close"),
  fund: fc.integer({ min: 0, max: FUNDS.length - 1 }),
  ipo: fc.integer({ min: 0, max: IPOS.length - 1 }),
});
const ops = fc.array(op, { minLength: 1, maxLength: 12 });

/** 연산 목록을 순서대로 시도한다. 원장이 거부한 연산은 건너뛴다(거부는 체인을 바꾸지 않아야 한다). */
function build(list: readonly Op[]): HashChainedLedger {
  const { ledger } = newLedger();
  for (const o of list) {
    const fundId = FUNDS[o.fund] as string;
    const ipoId = IPOS[o.ipo] as string;
    const draft = o.kind === "participate" ? participate(fundId, ipoId) : o.kind === "lock" ? lock(fundId, ipoId) : close(ledger.events().length, ipoId);
    const before = ledger.headHash();
    const r = ledger.append(draft);
    if (!r.ok) expect(ledger.headHash()).toBe(before);
  }
  return ledger;
}
const chainOf = (list: readonly Op[]): Record<string, unknown>[] => plain(build(list).events());

const nonEmpty = ops.filter((list) => build(list).events().length > 0);

describe("정상 체인", () => {
  it("임의의 연산 열에서 만들어진 체인은 verifyChain을 통과하고, fromEvents로 같은 상태·머리 해시가 복원된다 (결정성)", () => {
    fc.assert(
      fc.property(ops, (list) => {
        const ledger = build(list);
        const v = verifyChain(ledger.events());
        expect(v).toEqual({ ok: true, length: ledger.events().length, headHash: ledger.headHash() });
        const again = build(list);
        expect(again.headHash()).toBe(ledger.headHash());
        const restored = HashChainedLedger.fromEvents(plain(ledger.events()), () => 1_800_000_000_000);
        expect(restored.ok).toBe(true);
        if (restored.ok) {
          expect(restored.ledger.headHash()).toBe(ledger.headHash());
          for (const f of FUNDS) for (const i of IPOS) expect(restored.ledger.getState(f, i)).toBe(ledger.getState(f, i));
        }
      }),
      RUNS,
    );
  });

  it("기록이 없는 (펀드, IPO)는 항상 UNKNOWN이다 (없음 != 미참여)", () => {
    fc.assert(
      fc.property(ops, fc.string(), (list, other) => {
        const ledger = build(list);
        expect(ledger.getState(`zz_${other.replace(/[^a-z0-9_]/g, "")}`, "ipo_1")).toBe("UNKNOWN");
      }),
      RUNS,
    );
  });
});

describe("변조 탐지", () => {
  const hexChange = (hex: string, index: number, delta: number): string => {
    const i = index % hex.length;
    const c = Number.parseInt(hex.charAt(i), 16);
    return `${hex.slice(0, i)}${((c + delta) % 16).toString(16)}${hex.slice(i + 1)}`;
  };

  /** 모든 이벤트 유형에 공통인 필드의 변경. 각각 원래 값과 반드시 다른 값을 만든다. */
  const mutations: readonly [string, (e: Record<string, unknown>, n: number) => void][] = [
    ["requestedAt", (e) => { e["requestedAt"] = (e["requestedAt"] as number) + 1; }],
    ["recordedAt", (e) => { e["recordedAt"] = (e["recordedAt"] as number) + 1; }],
    ["registrySeq", (e) => { e["registrySeq"] = (e["registrySeq"] as number) + 1; }],
    ["actorId", (e) => { e["actorId"] = `${e["actorId"] as string}_x`; }],
    ["ipoId", (e) => { e["ipoId"] = `${e["ipoId"] as string}_x`; }],
    ["seq", (e) => { e["seq"] = (e["seq"] as number) + 1; }],
    ["prevHash", (e, n) => { e["prevHash"] = hexChange(e["prevHash"] as string, n, 1 + (n % 15)); }],
    ["eventHash", (e, n) => { e["eventHash"] = hexChange(e["eventHash"] as string, n, 1 + (n % 15)); }],
    ["authorization.signature", (e, n) => { const a = e["authorization"] as Record<string, unknown>; a["signature"] = `0x${hexChange((a["signature"] as string).slice(2), n, 1 + (n % 15))}`; }],
    ["authorization.requestNonce", (e) => { const a = e["authorization"] as Record<string, unknown>; a["requestNonce"] = `${a["requestNonce"] as string}x`; }],
    ["authorization.expiresAt", (e) => { const a = e["authorization"] as Record<string, unknown>; a["expiresAt"] = (a["expiresAt"] as number) + 1; }],
    ["추가 필드(금액 등)", (e) => { e["bidAmount"] = 1; }],
    ["필드 삭제", (e) => { delete e["actorId"]; }],
  ];

  it("한 이벤트의 어떤 필드든 바꾸면 verifyChain은 ok가 아니다 (원본 위치 이전 이벤트는 영향 없음)", () => {
    fc.assert(
      fc.property(nonEmpty, fc.nat(), fc.integer({ min: 0, max: mutations.length - 1 }), fc.nat(), (list, pick, m, n) => {
        const events = chainOf(list);
        const i = pick % events.length;
        const target = events[i] as Record<string, unknown>;
        const mutate = (mutations[m] as (typeof mutations)[number])[1];
        mutate(target, n);
        const v = verifyChain(events);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.seq).toBe(i + 1);
      }),
      RUNS,
    );
  });

  it("payload의 값을 바꿔도 탐지된다 (해시가 payload 전체를 덮는다)", () => {
    fc.assert(
      fc.property(nonEmpty, fc.nat(), (list, pick) => {
        const events = chainOf(list);
        const i = pick % events.length;
        const payload = (events[i] as Record<string, unknown>)["payload"] as Record<string, unknown>;
        if ("closesAt" in payload) payload["closesAt"] = (payload["closesAt"] as number) + 1;
        else payload["origin"] = payload["origin"] === "INDEPENDENT" ? "BIND_1" : "INDEPENDENT";
        expect(verifyChain(events).ok).toBe(false);
      }),
      RUNS,
    );
  });

  it("두 이벤트의 순서 교체, 중간 이벤트 삭제, 이벤트 복제, 이벤트 삽입은 모두 탐지된다", () => {
    fc.assert(
      fc.property(
        ops.filter((list) => build(list).events().length >= 2),
        fc.nat(),
        fc.nat(),
        (list, a, b) => {
          const events = chainOf(list);
          const n = events.length;
          const i = a % n;
          const j = (i + 1 + (b % (n - 1))) % n; // i != j
          const swapped = [...events];
          swapped[i] = events[j] as Record<string, unknown>;
          swapped[j] = events[i] as Record<string, unknown>;
          expect(verifyChain(swapped).ok).toBe(false);

          const withoutMiddle = events.filter((_e, k) => k !== a % (n - 1)); // 마지막이 아닌 이벤트 삭제
          expect(verifyChain(withoutMiddle).ok).toBe(false);

          const duplicated = [...events.slice(0, i + 1), events[i] as Record<string, unknown>, ...events.slice(i + 1)];
          expect(verifyChain(duplicated).ok).toBe(false);

          const inserted = [...events.slice(0, i), events[(i + 1) % n] as Record<string, unknown>, ...events.slice(i)];
          expect(verifyChain(inserted).ok).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it("첫 이벤트를 제거(앞부분 잘라내기)하면 genesis와 맞지 않아 탐지된다", () => {
    fc.assert(
      fc.property(
        ops.filter((list) => build(list).events().length >= 2),
        (list) => {
          const v = verifyChain(chainOf(list).slice(1));
          expect(v.ok).toBe(false);
        },
      ),
      RUNS,
    );
  });
});

describe("끝부분 잘라내기: 체크포인트 없이는 탐지되지 않고, 있으면 탐지된다", () => {
  it("모든 접두(prefix)는 그 자체로 유효한 체인이다 — 알려진 한계(THREAT_MODEL에 기록)", () => {
    fc.assert(
      fc.property(ops, fc.nat(), (list, cut) => {
        const events = chainOf(list);
        const k = cut % (events.length + 1);
        const v = verifyChain(events.slice(0, k));
        expect(v.ok).toBe(true);
        if (v.ok) expect(v.length).toBe(k);
      }),
      RUNS,
    );
  });

  it("신뢰하는 체크포인트(길이, 머리 해시)와 비교하면 잘라내기는 항상 탐지된다", () => {
    fc.assert(
      fc.property(
        ops.filter((list) => build(list).events().length >= 1),
        fc.nat(),
        (list, cut) => {
          const events = chainOf(list);
          const full = verifyChain(events);
          if (!full.ok) throw new Error("fixture chain must verify");
          const k = cut % events.length; // 0..n-1: 최소 1개 이상 제거
          const truncated = verifyChain(events.slice(0, k));
          expect(truncated.ok).toBe(true);
          if (truncated.ok) {
            expect(truncated.length).not.toBe(full.length);
            expect(truncated.headHash).not.toBe(full.headHash);
          }
        },
      ),
      RUNS,
    );
  });
});

describe("어떤 입력에서도 던지지 않고, 거부된 요청은 체인을 바꾸지 않는다", () => {
  const junkList = fc.array(fc.oneof(fc.anything(), fc.anything({ withBigInt: true, withNullPrototype: true }), fc.constantFrom(null, undefined, Symbol("x"))), { maxLength: 6 });

  it("verifyChain / parseLedgerEvent / parseLedgerEventDraft 는 임의의 값에 대해 던지지 않고 ok=false를 돌려준다", () => {
    fc.assert(
      fc.property(junkList, (events) => {
        expect(verifyChain(events as never).ok).toBe(events.length === 0);
        for (const e of events) {
          expect(parseLedgerEvent(e).ok).toBe(false);
          expect(parseLedgerEventDraft(e).ok).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("HashChainedLedger.append / appendAtomic / fromEvents 는 쓰레기 입력에서 던지지 않고, 거부 시 머리 해시·길이가 그대로다", () => {
    fc.assert(
      fc.property(ops, junkList, (list, junk) => {
        const ledger = build(list);
        const head = ledger.headHash();
        const length = ledger.events().length;
        for (const draft of junk) {
          expect(ledger.append(draft).ok).toBe(false);
        }
        expect(ledger.appendAtomic(junk).ok).toBe(false);
        expect(ledger.headHash()).toBe(head);
        expect(ledger.events().length).toBe(length);
        expect(HashChainedLedger.fromEvents(junk, () => 1).ok).toBe(junk.length === 0);
      }),
      RUNS,
    );
  });

  it("호출자가 seq, prevHash, recordedAt, eventHash, schemaVersion을 지정한 초안은 항상 거부된다", () => {
    fc.assert(
      fc.property(fc.constantFrom("seq", "prevHash", "recordedAt", "eventHash", "schemaVersion"), fc.anything(), (key, value) => {
        const { ledger } = newLedger();
        const before = ledger.headHash();
        expect(ledger.append({ ...participate("fund_b"), [key]: value }).ok).toBe(false);
        expect(ledger.headHash()).toBe(before);
      }),
      RUNS,
    );
  });
});

describe("원장의 상태 전이 제약은 체인 위에서도 유지된다", () => {
  it("UNKNOWN에서 한 번 기록된 (펀드, IPO)에 다른 기록을 추가하려는 시도(참여<->락)는 항상 거부되고 상태가 바뀌지 않는다", () => {
    fc.assert(
      fc.property(fc.constantFrom("participate", "lock"), fc.constantFrom(...FUNDS), (first, fundId) => {
        const { ledger } = newLedger();
        ledger.append(first === "participate" ? participate(fundId) : lock(fundId));
        const state = ledger.getState(fundId, "ipo_1");
        const head = ledger.headHash();
        for (const draft of [participate(fundId), lock(fundId)]) {
          expect(ledger.append(draft).ok).toBe(false);
        }
        expect(ledger.getState(fundId, "ipo_1")).toBe(state);
        expect(ledger.headHash()).toBe(head);
      }),
      RUNS,
    );
  });

  it("IPO_CLOSED 이후에는 그 IPO의 어떤 상태 이벤트도 추가되지 않는다", () => {
    fc.assert(
      fc.property(ops, fc.constantFrom(...FUNDS), (list, fundId) => {
        const ledger = build(list);
        ledger.append(close(ledger.events().length, "ipo_1"));
        if (!ledger.isClosed("ipo_1")) return; // 이미 닫혀 있지 않은 경우만 의미 있음(위 append가 성공했거나 이미 닫힘)
        const head = ledger.headHash();
        expect(ledger.append(participate(fundId, "ipo_1")).ok).toBe(false);
        expect(ledger.append(lock(fundId, "ipo_1")).ok).toBe(false);
        expect(ledger.headHash()).toBe(head);
      }),
      RUNS,
    );
  });
});

/* ------------------------------------------------------------------------------------------
 * 알려진 결함 (이슈 #37). it.fails: 현재 main에서는 실패한다. 수정 후 it.fails -> it.
 * ---------------------------------------------------------------------------------------- */
describe("알려진 결함 (#37)", () => {
  // 한국어 설명: events()가 내부 배열을 그대로 돌려줘서, 호출자가 pop()하면 로그와 파생 상태가 갈라진다.
  it.fails("[#37 §2] events()가 돌려준 배열을 바꿔도 원장 내부 로그는 바뀌지 않아야 한다", () => {
    const { ledger } = newLedger();
    ledger.append(participate("fund_b"));
    ledger.append(lock("fund_c"));
    const head = ledger.headHash();
    try {
      (ledger.events() as LedgerEvent[]).pop();
    } catch {
      // 동결된 배열이면 예외가 날 수 있고, 그것도 올바른 동작이다.
    }
    expect(ledger.headHash()).toBe(head);
    expect(ledger.events().length).toBe(2);
  });

  // 한국어 설명: 서로 다른 원장(환경)에서 만든 같은 내용의 이벤트가 같은 해시를 가져 다른 원장에 그대로 넣을 수 있다. 원장 식별자가 필요하다.
  it.fails("[#37 §3] 다른 원장 인스턴스의 체인은 이 원장에 그대로 받아들여지지 않아야 한다 (원장 식별자)", () => {
    const a = newLedger().ledger;
    const b = newLedger().ledger;
    a.append(participate("fund_b"));
    b.append(participate("fund_b"));
    expect(a.headHash()).not.toBe(b.headHash());
  });
});
