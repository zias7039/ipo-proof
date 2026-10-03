# 시나리오 A~E

> 저장소에는 A~E 정의가 없었으므로, **현재 규칙 엔진(`DEMO_RULE_V1`, `verifyBid`, 참여 상태기계)이 실제로 지원하는 범위**로 5개를 정의한다. 모든 ID와 금액은 합성 데이터이며, 규칙은 예시일 뿐 실제 규정이나 법률 자문이 아니다. 테스트 경로는 `packages/domain/test/` 기준.

## 공통 사전조건 (`fixtures.ts`의 `makeEnv()`)

- `fund_a`: 입찰 펀드. 레지스트리상 하위펀드는 `fund_b`, `fund_c`.
- `ipo_1`: 청약 창 안(현재 시각 기준 −24h ~ +24h).
- `att_1`: `fund_a`/`ipo_1`용 어테스테이션. 총 용량 300억, 노출 `fund_b` 60억, `fund_c` 40억. 어테스터 `attester_1`(허용목록), 유효.
- 원장: `fund_b` = PARTICIPATING, `fund_c` = NON_PARTICIPATION_LOCKED (`recordStates: false`이면 둘 다 UNKNOWN).
- 조정 용량 = 300억 − 60억(참여 중) = **240억** (LOCKED인 `fund_c`는 면제).

---

## A. 정상 참여 통과

- **사전조건**: 공통 사전조건 그대로.
- **입력**: `verifyBid({fundId:"fund_a", ipoId:"ipo_1", bidAmount:200억})`. 경계값: 240억, 240억+1원.
- **기대 결과**: `eligible=true`, `reasonCode=ELIGIBLE`, `flags=[]`. 정확히 240억도 통과, 240억+1원은 `BID_EXCEEDS_ADJUSTED_CAPACITY`. `proofHash`는 결정적이며 금액을 포함하지 않는다.
- **커버하는 테스트**: `demo.test.ts` (조정 용량 240억, 200억 통과), `verify.test.ts` "accepts a bid exactly at adjusted capacity and rejects one KRW above", `verify.test.ts` "does not change the ledger or the store"(순수성), 영수증 해시 테스트들.
- **공백**: 통과 후 `fund_a`를 PARTICIPATING으로 기록하는 end-to-end 흐름 테스트 없음(`verifyBid`는 기록하지 않는다). 검증과 참여 기록 사이에 상태가 바뀌는 경쟁 상황은 모델링되지 않음.

## B. 주금납입능력 초과

- **사전조건**: 공통 사전조건. 변형: 차감액이 총 용량보다 큰 어테스테이션.
- **입력**: `bidAmount = 250억` (조정 용량 240억 초과). 변형: 총 용량 5, 노출 9(PARTICIPATING).
- **기대 결과**: 250억 → `eligible=false`, `BID_EXCEEDS_ADJUSTED_CAPACITY`. 변형 → 조정 용량 0으로 클램프, 플래그 `DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO`, 모든 양수 입찰 거부. 입찰자는 용량 값을 직접 넣을 수 없다(`INVALID_BID_REQUEST`).
- **커버하는 테스트**: `demo.test.ts` "bid 25,000,000,000 is REJECTED", `rules.test.ts` "clamps at zero and flags...", `verify.test.ts` "rejects a request that tries to supply a capacity value", 금액 형식 거부(number/음수/0/소수).
- **공백**: 클램프 상황을 `verifyBid` 수준에서 검증하는 테스트 없음(규칙 단위 테스트만 존재). 클램프 플래그가 `BidVerification.flags`로 전달되는지 미검증.

## C. UNKNOWN 하위펀드

- **사전조건**: `recordStates: false` — `fund_b`, `fund_c` 모두 원장에 기록 없음(= UNKNOWN). UNKNOWN은 비참여가 아니다.
- **입력**: `bidAmount = 200억`, 이어서 `240억`.
- **기대 결과(현행 정책: 차감+플래그)**: UNKNOWN 노출은 PARTICIPATING처럼 차감되어 조정 용량 = 300억 − 60억 − 40억 = **200억**. 200억은 통과하며 `flags=[UNKNOWN_UNDERLYING_DEDUCTED]`, 240억은 `BID_EXCEEDS_ADJUSTED_CAPACITY`. 입찰 펀드 자신이 UNKNOWN인 것은 허용(아직 기록 전).
- **정책 미결정**: UNKNOWN을 **거부**로 바꾸는 안이 이슈 #10에서 검토 중. 결정되면 이 시나리오의 기대 결과가 바뀐다(`eligible=false`, 새 reasonCode 필요).
- **커버하는 테스트**: `rules.test.ts` "UNKNOWN underlying exposure is NOT exempt...", "UNKNOWN is treated exactly like PARTICIPATING for the number...", `verify.test.ts` "deducts UNKNOWN underlying exposure (conservative) and flags it", "allows the bidding fund's own state to be UNKNOWN", `participation.test.ts` "treats absence as UNKNOWN".
- **공백**: 일부만 UNKNOWN인 혼합 케이스의 `verifyBid` 수준 테스트 없음. UNKNOWN이 나중에 LOCKED로 바뀌면 이미 내려간 판정이 달라지는 문제(검증 시점 스냅샷)는 미모델링.

## D. 참여/비참여 상태 충돌 및 노출 누락·중복

- **사전조건**: 공통 사전조건.
- **입력**: (1) `fund_c`(LOCKED)에 참여 요청, (2) `fund_b`(PARTICIPATING)에 LOCKED 요청, (3) LOCKED인 펀드가 직접 입찰, (4) `fund_b` 노출을 뺀 어테스테이션, (5) 레지스트리에 없는 펀드 노출 / 같은 펀드 노출 중복.
- **기대 결과**: (1) `NON_PARTICIPATION_LOCK_ACTIVE`, 원장 불변. (2) `PARTICIPATION_ALREADY_RECORDED`, 상태 PARTICIPATING 유지. (3) `NON_PARTICIPATION_LOCK_ACTIVE`. (4) `UNDERLYING_EXPOSURE_OMITTED`(250억 입찰이어도 거부). (5) 각각 `UNDERLYING_EXPOSURE_NOT_IN_REGISTRY`, `DUPLICATE_UNDERLYING_EXPOSURE`.
- **커버하는 테스트**: `demo.test.ts` ("fund_c participation request is REJECTED...", "setting LOCKED on an already PARTICIPATING fund...", "omitting a PARTICIPATING deduction..."), `participation.test.ts` (전이 전수 검사, 거부 시 불변), `verify.test.ts` "rejects a bid from a NON_PARTICIPATION_LOCKED fund", "underlying exposure completeness" 3건, `rules.test.ts` "only participation of the same IPO counts".
- **공백**: 이 시나리오는 "여러 하위펀드에 걸친 중복 배정/초과 배정"을 다루지 않는다 — 배정 수량 개념이 모델에 없다. 상태 전이를 **누가** 요청할 수 있는지(인증/인가)는 미구현이라, 타 운용사 펀드를 대신 LOCKED로 만드는 공격은 막지 못한다(이슈 #14). 레지스트리 독립성은 가정일 뿐 강제되지 않는다. `verifyBid` 통과가 참여 기록을 구속하지 않으므로, 통과한 펀드가 기록 전에 LOCKED로 전환하는 경우의 정합성은 정의되어 있지 않다.

## E. 어테스테이션 무효·재사용 (폐기/만료/오래됨/재생/권한)

- **사전조건**: 공통 사전조건에서 어테스테이션 또는 시계를 조작.
- **입력**: 폐기된 `att_1`; 만료 이후 시점; 발급 후 24시간 초과(만료 전); 발급 이전 시점; 같은 어테스터·nonce를 다른 `attestationId`가 재사용; 규칙 버전 불일치; 허용목록에 없는 어테스터; 청약 창 밖 시점.
- **기대 결과**: 각각 `ATTESTATION_REVOKED`, `ATTESTATION_EXPIRED`(만료 시각 경계 배타적), `ATTESTATION_STALE`, `ATTESTATION_NOT_YET_VALID`, `ATTESTATION_NONCE_REPLAY`, `RULE_VERSION_MISMATCH`, `ATTESTER_UNAUTHORIZED`, `IPO_NOT_OPEN`. 동일 어테스테이션의 재검증은 재생이 아니다.
- **커버하는 테스트**: `demo.test.ts` (폐기, 만료, 규칙 버전), `verify.test.ts` "attestation integrity checks" 전체(권한, 폐기, 만료 경계, not-yet-valid, stale, nonce 재생, 재검증), "rejects unregistered fund, unknown IPO, IPO outside window", `attestation.test.ts`.
- **공백**: **서명 위조**: `Eip712AttestationVerifier`를 주입하면 등록된 키가 아닌 서명·필드 변조·가변(high-s) 서명·다른 도메인 서명은 `SIGNATURE_INVALID`로 거부된다(`eip712.test.ts`, `eip712-verifybid.test.ts`). 단, 허용목록 검증기(`AllowlistAttestationVerifier`)는 여전히 `signature`를 무시하며, 침해된 허가 어테스터가 서명한 허위 데이터·키 교체/폐기는 막지 못한다. 폐기 목록의 최신성/가용성, nonce 저장소 영속성(재시작 시 소실) 미검증. 동시에 둘 이상의 사유가 해당될 때의 우선순위는 `verifyBid` 주석의 검사 순서에만 문서화되어 있고 조합 테스트 없음.

---

## 범위 밖 (현 엔진이 모델링하지 않음)

- 마감 후 취소/정정, **납입 실패**, 배정 후 초과 배정: 상태기계가 3상태(UNKNOWN/PARTICIPATING/NON_PARTICIPATION_LOCKED)뿐이고 취소·납입 이벤트가 없다. 조사와 정의는 이슈 #21.
- 위 모든 시나리오를 하나의 파일로 묶은 회귀 스위트는 이슈 #9.
