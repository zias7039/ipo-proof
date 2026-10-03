# 아키텍처 (첫 번째 조각)

범위: `packages/domain`만 다룬다. 순수 TypeScript이며 I/O, 블록체인, ZK, UI, 영속성은 없다.

## 데이터 흐름

```
Attester ──> CapacityAttestation ──┐
Fund/IPO registries ───────────────┤
ParticipationLedger (lookup) ──────┼──> verifyBid({fundId, ipoId, bidAmount}) ──> BidVerification
Revocation list, nonce registry ───┤                                              {eligible, reasonCode,
AttestationVerifier, Clock ────────┘                                               ruleVersion, proofHash,
                                                                                   verifiedAt, flags}
```

`verifyBid`는 순수 함수다. 모든 상태는 `VerifyBidDeps` 인터페이스로 주입되며 아무것도 변경하지 않는다. 결과의 기록(예: 참여 요청)은 호출자가 별도로 수행한다.

## 모듈 (`packages/domain/src`)

| 파일 | 책임 |
| --- | --- |
| `money.ts` | KRW를 음이 아닌 `bigint`로 표현. number는 거부 |
| `model.ts` | `Fund`, `IPO`, `CapacityAttestation`, `UnderlyingFundExposure`, `RuleVersion`, 합성 ID 검사 |
| `participation.ts` | `ParticipationState`, 순수 `transition()`, 인메모리 append-only 원장 |
| `rules.ts` | `DEMO_RULE_V1`과 규칙 버전 디스패치 |
| `attestation.ts` | `AttestationVerifier` 인터페이스, 허용목록 검증기, 인메모리 어테스테이션/폐기/nonce 저장소 |
| `registry.ts` | Fund·IPO 레지스트리 인터페이스와 인메모리 구현 |
| `hash.ts` | 정규화(canonical) JSON과 SHA-256 |
| `verify.ts` | `verifyBid`, `BidVerification`, reason code, 영수증 생성 |

## 주요 결정

**용량 입력 경로 없음.** `BidRequest`에는 `fundId`, `ipoId`, `bidAmount`만 있다. `verifyBid`는 다른 키가 하나라도 있는 요청을 읽기 전에 거부한다(`INVALID_BID_REQUEST`). 총 용량과 노출은 `CapacityAttestation` 안에만 존재한다.

**참여 상태기계.** 허용되는 전이는 `UNKNOWN -> PARTICIPATING`, `UNKNOWN -> NON_PARTICIPATION_LOCKED`뿐이다. 동일 상태 반복과 UNKNOWN으로의 이동을 포함한 그 밖의 모든 전이는 거부한다. 잠긴 펀드의 참여 요청은 `NON_PARTICIPATION_LOCK_ACTIVE`, 참여 중인 펀드를 잠그려는 요청은 `PARTICIPATION_ALREADY_RECORDED`가 된다.

**UNKNOWN 처리.**
- 원장에 기록이 없는 것은 `UNKNOWN`이며, 절대 "비참여"가 아니다. UNKNOWN은 면제되지 않는다.
- **소유자 결정 (2026-10-03, 이슈 #10): UNKNOWN 하위펀드 노출은 거부(REJECT)한다.** 새 reason code `UNDERLYING_PARTICIPATION_UNKNOWN`으로 거부하며, 어떤 숫자도 추측하지 않는다(PARTICIPATING으로 가정해 차감하지도 않는다). 이 동작은 열린 PR #23에서 구현되었으며 **PR #23이 병합되기 전까지 `main` 코드에는 아직 반영되지 않았다.**
- 병합 전 `main` 코드의 `DEMO_RULE_V1`은 UNKNOWN 하위펀드 노출을 PARTICIPATING처럼 **차감**하고 `UNKNOWN_UNDERLYING_DEDUCTED` 플래그를 단다(차감+플래그). 처음에는 입찰을 보수적 숫자로나마 평가하기 위해 "거부"보다 이 방식을 택했으나, 위 결정으로 대체되었다.
- 거부 방식의 한계(#10에서 계속 논의): 하위펀드 운용사가 기록을 늦게 하면 상위펀드가 막히며 이를 DoS 수단으로 악용할 수 있고, 판정 시점 스냅샷·마감 확정(finalization) 규칙이 아직 없어 이후 기록이 앞선 판정을 바꿀 수 있다.
- **입찰 펀드 자신의** 상태는 다르다. LOCKED이면 입찰을 거부하고, UNKNOWN 또는 PARTICIPATING이면 허용한다(아직 기록되지 않은 펀드도 참여 요청 전에 검증받을 수 있다).

**차감이 총 용량을 넘는 경우.** 조정 용량은 0으로 클램프하고 `DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO` 플래그를 단다.

**차감 누락.** `Fund.underlyingFundIds`(레지스트리 관점)는 어테스테이션 노출에 있는 펀드 집합과 같아야 한다. 누락은 `UNDERLYING_EXPOSURE_OMITTED`, 초과는 `UNDERLYING_EXPOSURE_NOT_IN_REGISTRY`, 중복은 `DUPLICATE_UNDERLYING_EXPOSURE`이다. 이는 레지스트리가 운용사로부터 독립적이라고 가정하는 것이며, 여기서 강제되는 것이 아니다.

**Nonce 재생.** 어테스터별로 스코프가 정해진 nonce는 그것을 처음 사용한 어테스테이션에 바인딩된다. 다른 `attestationId`로 다시 쓰면 재생(replay)이다. 같은 어테스테이션을 다시 검증하는 것(여러 입찰)은 허용된다. 바인딩은 `InMemoryAttestationStore.publish`에서 일어나며 `verifyBid`는 읽기만 한다.

**폐기(Revocation)** 는 서명 대상 객체 밖(`RevocationLookup`)에 둔다.

**시간.** 주입된 `Clock`이 주는 정수 epoch 밀리초를 쓴다. 어테스테이션은 `issuedAt <= now < expiresAt`일 때 유효하며, `now - issuedAt <= RuleVersion.maxAttestationAgeMs`도 만족해야 한다(아니면 `ATTESTATION_STALE`). `DEMO_RULE_V1`은 24시간을 쓰며 임의의 데모 값이다.

**서명 검증은 미구현이다.** `AttestationVerifier`가 연결 지점이다. 유일한 구현인 `AllowlistAttestationVerifier`는 어테스터 ID를 허용목록과 대조할 뿐 `signature`는 보지 않는다. EIP-712 검증은 이후 단계에서 계획되어 있다.

**영수증 해시.** `proofHash = sha256(canonicalJson(receipt))`이고 `proofHashKind = "SHA256_RECEIPT_NOT_A_ZK_PROOF"`이다. 영수증에는 kind, version, fund id, IPO id, 규칙 버전, attestation id, attester id, 적격 여부, reason code, flags, 검증 시각이 들어간다. 입찰 금액, 총 용량, 노출, 조정 용량, 서명은 의도적으로 제외한다. 엔트로피가 낮은 금액의 해시는 무차별 대입으로 풀릴 수 있기 때문이다. 이것은 "이 검증자가 이 결과를 보고했다"는 증거일 뿐, 그 결과가 맞다는 증명이 아니다.

**검사 순서**(처음 실패한 것이 결정)는 `verify.ts`의 `verifyBid` 주석에 문서화되어 있다.

## 이번 조각에 없는 것

블록체인 원장, ZK 증명, EIP-712 서명, 영속성, API, UI. 규정 조사는 별도 문서로 정리했다([REGULATORY_RESEARCH.md](REGULATORY_RESEARCH.md), [REGULATORY_ASSUMPTIONS.md](REGULATORY_ASSUMPTIONS.md)). 이 문서들은 `DEMO_RULE_V1`이 실제 규정을 구현했다는 뜻이 아니다.
