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
| `attestation.ts` | `AttestationVerifier` 인터페이스, 허용목록 검증기(서명 검사 없음, deprecated), 인메모리 어테스테이션/폐기/nonce 저장소 |
| `eip712.ts` | `CapacityAttestation`용 EIP-712 typed data, `Eip712AttestationVerifier`(어테스터 레지스트리 + 서명 검사) |
| `registry.ts` | Fund·IPO 레지스트리 인터페이스와 인메모리 구현 |
| `hash.ts` | 정규화(canonical) JSON과 SHA-256 |
| `verify.ts` | `verifyBid`, `BidVerification`, reason code, 영수증 생성 |

## 주요 결정

**용량 입력 경로 없음.** `BidRequest`에는 `fundId`, `ipoId`, `bidAmount`만 있다. `verifyBid`는 다른 키가 하나라도 있는 요청을 읽기 전에 거부한다(`INVALID_BID_REQUEST`). 총 용량과 노출은 `CapacityAttestation` 안에만 존재한다.

**참여 상태기계.** 허용되는 전이는 `UNKNOWN -> PARTICIPATING`, `UNKNOWN -> NON_PARTICIPATION_LOCKED`뿐이다. 동일 상태 반복과 UNKNOWN으로의 이동을 포함한 그 밖의 모든 전이는 거부한다. 잠긴 펀드의 참여 요청은 `NON_PARTICIPATION_LOCK_ACTIVE`, 참여 중인 펀드를 잠그려는 요청은 `PARTICIPATION_ALREADY_RECORDED`가 된다.

**UNKNOWN 처리 (거부).**
- 원장에 기록이 없는 것은 `UNKNOWN`이며, 절대 "비참여"가 아니다.
- `DEMO_RULE_V1`에서는 해당 IPO에 대해 하위펀드 **중 하나라도** UNKNOWN이면 규칙이 `determined: false`(조정 용량 없음)를 반환하고, `verifyBid`는 `UNDERLYING_PARTICIPATION_UNKNOWN`으로 거부한다. UNKNOWN은 LOCKED처럼 면제되지도, PARTICIPATING으로 가정되지도 않는다. 즉 숫자를 추측하지 않는다. 소유자가 이슈 #10에서 결정했고(2026-10-03) 이전의 "차감+플래그" 동작을 대체했으며, `UNKNOWN_UNDERLYING_DEDUCTED` 플래그는 더 이상 존재하지 않는다. 이 검사는 어테스테이션 무결성 검사와 노출 완전성 검사 뒤, 입찰액을 용량과 비교하기 전에 실행된다.
- 알려진 트레이드오프: 하위펀드의 운용사가 기록을 늦게 하면 상위펀드는 그 기록이 생길 때까지 막히며, 상대방이 기록을 지연시켜 이를 악용할 수 있다(가용성/DoS). 판정 시점 스냅샷과 마감 확정(finalization) 규칙은 아직 정해지지 않았으며 [PR #26 설계안](design/snapshot-and-finalization.md)이 검토 중이다(미병합). 이후의 기록이 앞서 검증된 입찰의 판정을 바꿀 수도 있다.
- **입찰 펀드 자신의** 상태: LOCKED이면 입찰을 거부하고, UNKNOWN 또는 PARTICIPATING이면 허용한다(아직 기록되지 않은 펀드도 참여 요청 전에 검증받을 수 있다).

**차감이 총 용량을 넘는 경우.** 조정 용량은 0으로 클램프하고 `DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO` 플래그를 단다.

**차감 누락.** `Fund.underlyingFundIds`(레지스트리 관점)는 어테스테이션 노출에 있는 펀드 집합과 같아야 한다. 누락은 `UNDERLYING_EXPOSURE_OMITTED`, 초과는 `UNDERLYING_EXPOSURE_NOT_IN_REGISTRY`, 중복은 `DUPLICATE_UNDERLYING_EXPOSURE`이다. 이는 레지스트리가 운용사로부터 독립적이라고 가정하는 것이며, 여기서 강제되는 것이 아니다.

**게시(publish), nonce 재생, 교체.** `InMemoryAttestationStore`는 생성자에서 `AttestationVerifier`를 받으며, `publish(attestation)`은 `{ok: true}` 또는 `{ok: false, reasonCode}`를 반환한다(이전에는 boolean). `revoke`를 제외하면 상태를 바꾸는 유일한 경로이며 `verifyBid`는 읽기만 한다. 규칙은 다음 순서로 적용되고, 어떤 거부에서도 상태는 바뀌지 않는다. (1) 검증기가 어테스테이션을 받아들여야 한다(`ATTESTER_UNAUTHORIZED` / `SIGNATURE_INVALID`). 서명이 없거나 잘못된 입력은 nonce를 선점하지도, 진짜 어테스테이션을 교체하지도 못한다. (2) 현재 어테스테이션과 동일한 것을 다시 게시하면 상태 변화 없는 성공이다. 이미 교체된 `attestationId`는 다시 돌아올 수 없고(`ATTESTATION_SUPERSEDED`), 같은 id를 다른 내용으로 재사용하면 거부된다(`ATTESTATION_ID_CONFLICT`). (3) 어테스터별로 스코프가 정해진 nonce는 그것을 처음 사용한 어테스테이션에 바인딩되며, 다른 `attestationId`가 쓰면 거부된다(`NONCE_ALREADY_BOUND`). 교체된 어테스테이션의 바인딩을 포함해 바인딩은 절대 해제되지 않는다. (4) `(fundId, ipoId)`마다 가장 새로운 어테스테이션만 제공되며, 새 어테스테이션은 `issuedAt`이 엄격히 더 클 때만 현재 것을 교체한다(`NOT_NEWER_THAN_CURRENT`). 따라서 더 오래되고 용량이 큰 어테스테이션을 다시 올릴 수 없다. `verifyBid`는 읽은 것의 서명을 여전히 검사하고, 다른 어테스테이션에 바인딩된 nonce는 `ATTESTATION_NONCE_REPLAY`로 보고한다. 게시 관문은 다층 방어(defence in depth)다. 폐기된 현재 어테스테이션은 진짜로 더 새로운 것으로 교체할 수 있다. 같은 어테스테이션을 다시 검증하는 것(여러 입찰)은 허용된다.

**폐기(Revocation)** 는 서명 대상 객체 밖(`RevocationLookup`)에 둔다.

**시간.** 주입된 `Clock`이 주는 정수 epoch 밀리초를 쓴다. 어테스테이션은 `issuedAt <= now < expiresAt`일 때 유효하며, `now - issuedAt <= RuleVersion.maxAttestationAgeMs`도 만족해야 한다(아니면 `ATTESTATION_STALE`). `DEMO_RULE_V1`은 24시간을 쓰며 임의의 데모 값이다.

**서명 검증 (EIP-712).** `Eip712AttestationVerifier`(`eip712.ts`)는 `AttestationVerifier`를 구현하며 `verifyBid`의 어테스터 권한 검사 단계에서 실행된다. 순수하고 상태가 없으며, 형식이 잘못된 어테스테이션에도 예외를 던지지 않는다.
- *레지스트리 = 허용목록 + 키 바인딩.* `attesterId -> 서명자 주소 1개`. 알 수 없는 attesterId는 `ATTESTER_UNAUTHORIZED`. 복구한 서명자가 등록된 주소와 다르면(위조, 다른 어테스터의 키, 변조된 필드, 잘못된 도메인) `SIGNATURE_INVALID`. 설정 규칙(생성 시 검사하며 예외를 던질 수 있음): 주소는 유효해야 하고(대소문자가 섞였다면 올바른 EIP-55 체크섬), 0 주소가 아니어야 하며, 각 attesterId와 각 주소는 한 번만 나타나야 한다. 따라서 하나의 키가 두 어테스터를 대변할 수 없다.
- *도메인 분리.* 도메인 = `{name: "ipo-proof CapacityAttestation", version: "1", chainId, verifyingContract}`. `chainId`와 `verifyingContract`는 배포 설정으로 주입한다. 이 저장소에서는 도메인 분리용 라벨일 뿐이며 체인과 통신하는 것은 없다(테스트는 합성 자리표시 값을 쓴다). 다른 체인, 컨트랙트, name, version으로 서명된 어테스테이션은 검증되지 않는다.
- *서명 대상 메시지.* `signature`를 제외한 `CapacityAttestation`의 모든 필드: `attestationId, fundId, ipoId, ruleVersion`(string), `grossCapacityKrw`(uint256, bigint에서 변환), `underlyingExposures`(`UnderlyingExposure{string fundId, uint256 exposureKrw}[]`), `issuedAt, expiresAt`(uint256, 정수 epoch ms), `nonce, attesterId`(string). 폐기는 서명하지 않는다(객체 밖에 있음). uint256 범위를 벗어난 값, 정수가 아닌 값, 잘못된 타입, 짝 없는 서로게이트가 있는 문자열은 인코딩할 수 없으며 `SIGNATURE_INVALID`가 된다.
- *노출 정렬과 중복.* 노출은 정규 순서의 집합으로 서명한다: `fundId` 오름차순(UTF-16 코드 유닛 순서), 동률이면 `exposureKrw` 오름차순. 따라서 같은 노출의 어떤 배열 순서도 검증되며, 집합이 바뀌면 검증되지 않는다. 중복된 `fundId` 항목은 합치지 않고 주어진 그대로 서명되며, 이후 `verifyBid`가 `DUPLICATE_UNDERLYING_EXPOSURE`로 거부한다. 순서 의존적 서명 대신 정규화를 택한 것은 어테스터 도구와 소비자가 배열 순서에 합의할 필요가 없도록 하기 위해서이며, 규칙 엔진은 노출을 합산하므로 순서는 결과에 영향을 준 적이 없다.
- *서명 형식.* `0x` + 16진수 130자(`r || s || v`, 65바이트). `v`가 27 또는 28이고(0/1이나 EIP-155 형식은 불가), `r`과 `s`가 `[1, n-1]` 범위이며, `s`가 하반부(`s <= n/2`)일 때만 받아들인다. 따라서 유효한 서명의 가변(malleable) "high-s 쌍둥이"는 거부된다. 16진수 문자의 대소문자는 구분하지 않는다.
- *라이브러리 (암호 직접 구현 없음).* `@noble/curves`(secp256k1 공개키 복구)와 `@noble/hashes`(keccak-256): 작고 의존성이 적으며(curves는 hashes에만 의존) 순수 TypeScript이고 널리 쓰인다. `hashTypedData`/`recoverTypedDataAddress`를 제공하는 `viem`도 검토했지만, 가볍게 유지하려는 패키지에 비해 훨씬 큰 의존성 트리(ox, abitype, @scure/*, ws, isows)를 끌어온다. 그 대가로 `eip712.ts`에 EIP-712 바이트 레이아웃(타입 문자열, 32바이트 워드)이 직접 들어 있다. 이 레이아웃은 테스트에서 `viem`(`test/`에서만 쓰는 devDependency이며 테스트 서명도 생성한다)과 대조해 검증하므로 인코딩 실수는 다이제스트 불일치로 드러난다. `@noble/*` 2.x는 Node >= 20.19를 요구한다.
- *오프체인 PoC vs 온체인.* 현재 검증기는 오프체인에서 실행되며 `chainId`/`verifyingContract`는 설정으로 합의한 라벨일 뿐이다. 나중에 검증을 온체인으로 옮기면 같은 도메인에 실제 체인 id와 배포된 컨트랙트 주소가 들어가고, 위 구조체 레이아웃(정렬된 노출 규칙 포함)을 컨트랙트에서 바이트 단위로 똑같이 재현해야 한다. 구조체나 그 인코딩을 바꾸려면 새 도메인 `version`이 필요하다.
- *서명이 무엇이고 무엇이 아닌가.* 서명은 어테스터 **출처(provenance)** 다. 등록된 키가 정확히 이 바이트에 서명했다는 증거일 뿐, 데이터가 사실이라는 보장이 아니다(기초 데이터의 진실 원천은 어테스터이며, 서명도 블록체인도 현실 세계의 데이터를 참으로 만들지 못한다). 이것은 영지식 증명이 **아니며** 그렇게 표현해서도 안 된다: **ZK 상태: 미구현**. 서명 검사는 일반적인 ECDSA 복구다.
- *프라이버시.* 서명 대상 메시지에는 서명이 구속하도록 KRW 금액(총 용량, 노출)이 들어 있다. 이는 오프체인 자격증명의 속성일 뿐이며, 공개 체인에 평문으로 게시하라는 뜻이 **아니다**. 온체인에 올리는 것은 기존 규칙(가명 id, 커밋먼트/자격증명 해시, 규칙 버전, 폐기, 타임스탬프, 영수증 해시만)을 따라야 한다. 영수증 해시는 여전히 금액과 서명을 제외한다. 이 저장소의 모든 식별자와 금액(레이블에서 런타임에 파생하는 테스트 키 포함)은 합성이다.
- *지원하지 않는 형식 (모두 fail-closed로 `SIGNATURE_INVALID`).* EIP-2098 압축 64바이트 서명, `v` = 0/1 또는 EIP-155 형식 값(이를 내는 서명자는 27/28로 정규화해야 함), EIP-1271 컨트랙트 지갑 서명자: 일반 secp256k1 키(EOA) 주소만 등록할 수 있고, 컨트랙트 주소는 복구된 서명자와 절대 일치할 수 없다. `chainId`가 0이거나 `verifyingContract`가 0 주소인 설정은 생성 시 거부된다. `verify()`는 객체가 아닌 입력에 대해 예외를 던지는 대신 `SIGNATURE_INVALID`를 반환한다.
- *한계.* 유효한 서명은 등록된 키가 이 도메인에서 이 바이트에 서명했음을 증명할 뿐이다. 숫자가 맞다는 것, 키가 침해되지 않았다는 것, 레지스트리 자체가 잘 거버넌스되고 있다는 것은 증명하지 않는다. 레지스트리는 정적 설정이며 키 교체도 키 폐기도 없다. 기존 `AllowlistAttestationVerifier`는 여전히 서명을 무시하며 다른 검사들의 테스트·데모용으로만 존재한다.

**영수증 해시.** `proofHash = sha256(canonicalJson(receipt))`이고 `proofHashKind = "SHA256_RECEIPT_NOT_A_ZK_PROOF"`이다. 영수증에는 kind, version, fund id, IPO id, 규칙 버전, attestation id, attester id, 적격 여부, reason code, flags, 검증 시각이 들어간다. 입찰 금액, 총 용량, 노출, 조정 용량, 서명은 의도적으로 제외한다. 엔트로피가 낮은 금액의 해시는 무차별 대입으로 풀릴 수 있기 때문이다. 이것은 "이 검증자가 이 결과를 보고했다"는 증거일 뿐, 그 결과가 맞다는 증명이 아니다.

**검사 순서**(처음 실패한 것이 결정)는 `verify.ts`의 `verifyBid` 주석에 문서화되어 있다.

## 이번 조각에 없는 것

블록체인 원장, ZK 증명, 어테스터 키 교체/폐기와 거버넌스, 영속성, API, UI. 규정 조사는 별도 문서로 정리했다([REGULATORY_RESEARCH.md](REGULATORY_RESEARCH.md), [REGULATORY_ASSUMPTIONS.md](REGULATORY_ASSUMPTIONS.md)). 이 문서들은 `DEMO_RULE_V1`이 실제 규정을 구현했다는 뜻이 아니다.
