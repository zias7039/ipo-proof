/**
 * 속성 기반(property-based) 테스트: EIP-712 어테스테이션 검증기 (이슈 #22).
 *
 * 불변식: (1) 어떤 입력에서도 던지지 않는다. (2) 서명 바이트나 서명된 필드가 바뀐 어테스테이션은
 * 절대 통과하지 못한다. (3) 서명된 집합이 같으면 노출 순서는 결과에 영향이 없다.
 * 서명은 viem(독립 구현)으로 만든 합성 테스트 키 서명이며 개인키 리터럴은 없다.
 *
 * 알려진 결함(이슈 #36 §2)은 `it.fails`로 표시했다. 고쳐지면 `it`으로 바꾼다.
 */
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { Eip712AttestationVerifier } from "../src/eip712.js";
import type { CapacityAttestation } from "../src/model.js";
import { verifyBid } from "../src/verify.js";
import { attesterRegistry, makeEip712Verifier, makeSignedEnv, mustPublish, signedAtt } from "./fixtures.js";
import { TEST_DOMAIN } from "./signing.js";

const RUNS = { numRuns: 150 };
const verifier: Eip712AttestationVerifier = makeEip712Verifier();
let signed: CapacityAttestation;

beforeAll(async () => {
  signed = await signedAtt({
    underlyingExposures: [
      { fundId: "fund_b", exposureKrw: 6_000_000_000n },
      { fundId: "fund_c", exposureKrw: 4_000_000_000n },
      { fundId: "fund_d", exposureKrw: 1n },
    ],
  });
});

const HEX = "0123456789abcdef";
const anyString = fc.oneof(fc.string(), fc.string({ unit: "binary" }));

describe("서명 바이트 변조는 절대 통과하지 못하고 던지지도 않는다", () => {
  it("정상 서명은 통과한다 (이 파일의 모든 변조 테스트의 기준선)", () => {
    expect(verifier.verify(signed)).toEqual({ ok: true });
  });

  it("서명의 16진수 한 자리를 다른 값으로 바꾸면 항상 SIGNATURE_INVALID", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 131 }), fc.integer({ min: 1, max: 15 }), (index, delta) => {
        const original = Number.parseInt(signed.signature.charAt(index), 16);
        const replaced = HEX.charAt((original + delta) % 16); // 항상 다른 값(대소문자 차이가 아님)
        const signature = `${signed.signature.slice(0, index)}${replaced}${signed.signature.slice(index + 1)}`;
        expect(verifier.verify({ ...signed, signature })).toEqual({ ok: false, reasonCode: "SIGNATURE_INVALID" });
      }),
      RUNS,
    );
  });

  it("임의의 65바이트 값, 임의의 문자열, 임의의 값은 통과하지 못하고 던지지 않는다", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 65, maxLength: 65 }), (bytes) => {
        const signature = `0x${Buffer.from(bytes).toString("hex")}`;
        expect(verifier.verify({ ...signed, signature }).ok).toBe(false);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.oneof(anyString, fc.anything()), (signature) => {
        expect(verifier.verify({ ...signed, signature: signature as never }).ok).toBe(false);
      }),
      RUNS,
    );
  });
});

describe("서명된 필드 변조는 절대 통과하지 못한다 (서명은 그대로, 필드만 변경)", () => {
  const differentString = (original: string) => anyString.filter((s) => s !== original);
  const tampered: [keyof CapacityAttestation, fc.Arbitrary<unknown>][] = [
    ["attestationId", differentString("att_1")],
    ["fundId", differentString("fund_a")],
    ["ipoId", differentString("ipo_1")],
    ["ruleVersion", differentString("DEMO_RULE_V1")],
    ["nonce", differentString("nonce_1")],
    ["attesterId", anyString],
    ["grossCapacityKrw", fc.bigInt({ min: 0n, max: 2n ** 64n }).filter((v) => v !== 30_000_000_000n)],
    ["issuedAt", fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })],
    ["expiresAt", fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })],
  ];

  it.each(tampered.map(([field]) => field))("%s 를 바꾸면 항상 거부", (field) => {
    const entry = tampered.find(([f]) => f === field);
    if (entry === undefined) throw new Error("unreachable");
    fc.assert(
      fc.property(entry[1], (value) => {
        // 서명은 beforeAll에서 만들어지므로 "원래 값과 다른 값인지"는 실행 시점에 비교한다.
        fc.pre(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) !== JSON.stringify(signed[field], (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
        const result = verifier.verify({ ...signed, [field]: value } as CapacityAttestation);
        expect(result.ok).toBe(false);
      }),
      RUNS,
    );
  });

  const exposure = fc.record({ fundId: fc.constantFrom("fund_b", "fund_c", "fund_d", "fund_e"), exposureKrw: fc.bigInt({ min: 0n, max: 10n ** 12n }) });
  const canonicalKey = (xs: readonly { fundId: string; exposureKrw: bigint }[]) => JSON.stringify([...xs].map((x) => `${x.fundId}:${x.exposureKrw}`).sort());

  it("서명되지 않은 노출 집합(추가, 삭제, 금액 변경)은 항상 거부, 같은 집합의 순서 변경은 항상 통과", () => {
    fc.assert(
      fc.property(fc.array(exposure, { maxLength: 6 }), (exposures) => {
        const same = canonicalKey(exposures) === canonicalKey(signed.underlyingExposures);
        expect(verifier.verify({ ...signed, underlyingExposures: exposures }).ok).toBe(same);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        const exposures = signed.underlyingExposures;
        const k = seed % exposures.length;
        const rotated = [...exposures.slice(k), ...exposures.slice(0, k)];
        expect(verifier.verify({ ...signed, underlyingExposures: rotated })).toEqual({ ok: true });
        expect(verifier.verify({ ...signed, underlyingExposures: [...exposures].reverse() })).toEqual({ ok: true });
      }),
      RUNS,
    );
  });

  it("다른 도메인(chainId, verifyingContract, name, version 중 하나라도 다름)으로 만든 검증기는 같은 서명을 거부", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ chainId: fc.bigInt({ min: 1n, max: 2n ** 64n }).filter((v) => v !== TEST_DOMAIN.chainId) }),
          fc.record({ name: fc.string().filter((n) => n !== TEST_DOMAIN.name) }),
          fc.record({ version: fc.string().filter((v) => v !== TEST_DOMAIN.version) }),
          fc.record({
            verifyingContract: fc
              .uint8Array({ minLength: 20, maxLength: 20 })
              .map((b) => `0x${Buffer.from(b).toString("hex")}`)
              .filter((a) => a !== TEST_DOMAIN.verifyingContract && !/^0x0{40}$/.test(a)),
          }),
        ),
        (changed) => {
          const other = new Eip712AttestationVerifier({ domain: { ...TEST_DOMAIN, ...changed }, attesters: attesterRegistry() });
          expect(other.verify(signed)).toEqual({ ok: false, reasonCode: "SIGNATURE_INVALID" });
        },
      ),
      RUNS,
    );
  });
});

describe("검증기는 어떤 (데이터) 입력에서도 던지지 않고 통과시키지 않는다", () => {
  const junk = fc.oneof(fc.anything(), fc.anything({ withBigInt: true, withNullPrototype: true }), fc.constantFrom(null, undefined, 0, "", [], Symbol("x")));
  const junkField = fc.oneof(fc.anything({ withBigInt: true }), anyString, fc.bigInt(), fc.constant(Symbol("s")), fc.constant(Number.NaN));

  it("완전히 임의의 값", () => {
    fc.assert(
      fc.property(junk, (value) => {
        expect(verifier.verify(value as never).ok).toBe(false);
      }),
      RUNS,
    );
  });

  it("등록된 attesterId + 필드마다 쓰레기 값 (Symbol, NaN, bigint, 배열 등 포함) — 노출 항목 안의 쓰레기 포함", () => {
    fc.assert(
      fc.property(
        fc.record({
          attestationId: junkField,
          fundId: junkField,
          ipoId: junkField,
          ruleVersion: junkField,
          grossCapacityKrw: junkField,
          underlyingExposures: fc.oneof(junkField, fc.array(fc.record({ fundId: junkField, exposureKrw: junkField }), { maxLength: 4 })),
          issuedAt: junkField,
          expiresAt: junkField,
          nonce: junkField,
          attesterId: fc.constantFrom("attester_1", "attester_2"),
          signature: junkField,
        }),
        (value) => {
          expect(verifier.verify(value as never).ok).toBe(false);
        },
      ),
      RUNS,
    );
  });
});

/* ------------------------------------------------------------------------------------------
 * 알려진 결함 (이슈 #36 §2): 필드를 접근자(getter)로 읽는 입력. JSON 유래 객체에는 없는 입력이므로
 * 외부 입력만으로는 재현되지 않고, 프로세스 내 호출자가 전제다. it.fails: 현재 main에서 실패한다.
 * ---------------------------------------------------------------------------------------- */
describe("알려진 결함 (#36 §2)", () => {
  // 한국어 설명: 예외를 던지는 getter가 있으면 verify()가 SIGNATURE_INVALID 대신 예외를 던진다.
  it.fails("[#36 §2] 접근자가 예외를 던져도 verify()는 던지지 않고 거부해야 한다", () => {
    const evil = { ...signed, underlyingExposures: [{ fundId: "fund_b", get exposureKrw(): bigint { throw new Error("boom"); } }] };
    expect(verifier.verify(evil as never).ok).toBe(false);
  });

  // 한국어 설명: 읽을 때마다 값이 바뀌는 getter로, 서명 검증은 서명된 값(10억)을 보고 규칙 평가는 부풀린 값을 읽어 20bn 입찰이 적격이 된다.
  it.fails("[#36 §2] 서명 검증과 규칙 평가가 서로 다른 값을 읽는 어테스테이션(TOCTOU)으로 적격이 되면 안 된다", async () => {
    const small = await signedAtt({ grossCapacityKrw: 1_000_000_000n });
    const env = makeSignedEnv({ recordStates: true });
    mustPublish(env.store, small);
    let reads = 0;
    const evil = {
      ...small,
      get grossCapacityKrw() {
        reads++;
        return reads <= 2 ? small.grossCapacityKrw : 900_000_000_000n;
      },
    };
    const deps = { ...env.deps, attestations: { getAttestation: () => evil as never } };
    expect(verifyBid({ fundId: "fund_a", ipoId: "ipo_1", bidAmount: 20_000_000_000n }, deps).eligible).toBe(false);
  });
});

