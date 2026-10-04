# 위협 모델 (초안)

이 문서는 초안(stub)이다. 위협 범주를 나열하고, **현재 `main`의 자동화 테스트가 다루는 것만** "현재까지 다루는 것"에 적는다. "아직 다루지 않음"은 문자 그대로 완화도 테스트도 되지 않았다는 뜻이다. 테스트 참조는 `packages/domain/test`를 기준으로 한다. 테스트가 없는 항목은 설계 문서(`docs/design`)에 계획이 있어도 "다룸"으로 적지 않는다.

- 기준 시점: `main` @ `0eb5d89`(PR #35까지 병합), 보안 리뷰 담당이 갱신. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 통과(테스트 325개).
- 속성 기반/퍼징 테스트는 PR #39에서 제안 중이며 **병합 전이므로 이 문서의 "다룸"에 넣지 않았다.** 병합되면 이 문서를 다시 갱신한다.
- 발견 사항 번호 `K-xx`는 아래 §2의 "알려진 한계" 목록과 대응한다.

## 1. 위협 범주별 현황

| 위협 범주 | 현재까지 다루는 것 (테스트 기준) | 아직 다루지 않는 것 |
| --- | --- | --- |
| 악의적 운용사 | 용량을 제공할 수 없다: `verifyBid`는 자기 신고 용량 같은 추가 필드가 있는 요청을 거부한다 (`verify.test.ts`, `scenarios.test.ts`). 어테스테이션에서 참여 중인 하위펀드를 빠뜨리면 거부된다 (`verify.test.ts`, `demo.test.ts`). 이미 참여 중인 펀드를 LOCKED로 바꾸는 것은 상태기계(`participation.test.ts`, `demo.test.ts`)와 원장의 정정 없는 전이(`ledger-state.test.ts`)에서 거부된다. | 어테스터와의 공모. 레지스트리 연결을 피하기 위한 펀드 조작·분할. 레지스트리의 독립성은 가정일 뿐 강제되지 않는다. **원장 경로에는 호출자 인증·인가가 없다**: `HashChainedLedger`는 서명을 형식만 검사하므로 호출자가 타 운용사 펀드의 허위 `LOCKED`/`PARTICIPATING` 기록, 하위펀드 `LOCKED` 선점(면제), 임의 시점의 `IPO_CLOSED`, 가짜 공동 서명으로 정정+재기록(PARTICIPATING→LOCKED, 상태기계 원칙 D 우회)을 할 수 있음을 재현했다 (K-01, 이슈 #37). 이 원장은 아직 `verifyBid`나 API에 연결되어 있지 않다. |
| 악의적/침해된 어테스터 | 허가되지 않은 어테스터 ID는 거부된다 (`attestation.test.ts`, `verify.test.ts`, `eip712.test.ts`). `Eip712AttestationVerifier` 사용 시: 해당 attesterId에 등록된 키로 서명되지 않은 어테스테이션은 거부되며, 다른 등록 어테스터의 키나 미등록 키로 서명한 것도 마찬가지다 (`eip712.test.ts`, `eip712-verifybid.test.ts`). | **침해된 허가 어테스터**(또는 유출된 등록 키)는 허위지만 유효하게 서명된 어테스테이션을 발급할 수 있고, 이를 탐지하는 장치가 없다. 다중 어테스터 쿼럼은 없다. 어테스터 레지스트리는 정적이다: 키 교체도 키 폐기도 없고, 누가 포함되는지에 대한 거버넌스도 없다. `AllowlistAttestationVerifier`는 여전히 서명을 무시한다(테스트/데모 전용). |
| 악의적 인수회사 | 없음. | 판정 무시, 선별적 공개, 프런트러닝. 영수증 해시는 구속력 있는 커밋먼트가 아니다. |
| 검증자 공모 | 해당 없음: 아직 블록체인이 없다. | 전부. |
| 자격증명 위조 / 재생 / 폐기 / stale | 폐기된 것 거부, 만료된 것 거부, 아직 유효하지 않은 것 거부, stale(규칙 한도 초과 경과)한 것 거부, 다른 어테스테이션에서의 nonce 재사용 거부, 잘못된 규칙 버전 거부, 잘못된 대상 거부 (`verify.test.ts`, `demo.test.ts`, 그리고 서명된 어테스테이션으로 다시 `eip712-verifybid.test.ts`). **위조 / 변조**(EIP-712): 잘못된 키의 서명, 서명된 필드(id, 규칙 버전, 총 용량, 노출, 시각, nonce, attesterId) 중 하나라도 바뀐 경우, 서명을 다른 어테스테이션에 복사한 경우, 서명이 없거나 잘못된 어테스테이션은 `InMemoryAttestationStore.publish`로 nonce를 선점하거나 진짜 어테스테이션을 덮어쓸 수 없음, 교체된(더 오래된) 어테스테이션은 새 id와 nonce로 다시 발급한 오래된 내용을 포함해 다시 게시해 자리를 되찾을 수 없고 `issuedAt`이 같아도 교체되지 않음 (`store-publish.test.ts`), 서명된 어테스테이션의 유효 기간 경계(`expiresAt - 1 ms`는 유효, `expiresAt`은 만료, 경과 시간 정확히 24시간은 유효, +1 ms는 stale), EIP-2098 압축 서명 거부, 빈 값·잘린 값·16진수가 아닌 값·잘못된 `v`·high-s(가변) 서명, 복구할 수 없는 서명, 다른 chainId·verifyingContract·name·version으로 서명한 어테스테이션 (`eip712.test.ts`, `eip712-verifybid.test.ts`). | 폐기 목록의 최신성/가용성. nonce 저장소의 내구성(인메모리뿐). 오래되었지만 유효하게 서명된 어테스테이션의 재생은 nonce 바인딩, 교체 순서(Fund·IPO별로 더 새로운 `issuedAt`), 만료/stale로 제한된다. 하지만 교체된 적 없는 유효 서명 어테스테이션이 만료될 때까지 사용되는 것은 막지 못하며, 정당하게 더 낮은 용량의 어테스테이션을 발급하는 어테스터도 그것이 효력을 가지려면 반드시 게시하거나 기존 것을 폐기해야 한다. 게시 관문과 그 순서 규칙은 인메모리 저장소에만 있으며 다른 저장소는 이를 다시 구현해야 한다. EIP-1271(컨트랙트 지갑 어테스터)과 키 교체는 지원하지 않는다. 도메인 분리는 `chainId`/`verifyingContract`의 올바른 배포 설정에 의존하며, 어떤 체인도 관여하지 않는다. EIP-712 인코딩은 다른 구현 하나(viem)와 교차 검증했을 뿐 독립 감사나 공식 테스트 벡터로 검증한 것은 아니다. 유효한 서명은 등록된 키가 서명했다는 뜻이지 데이터가 사실이라는 뜻이 아니다. 어테스테이션 객체를 검증·평가 과정에서 여러 번 읽으므로, 읽을 때마다 값이 바뀌는 접근자(getter)를 가진 객체는 서명 검증을 통과한 뒤 다른 값으로 평가될 수 있고(재현함, JSON 유래 객체에는 없는 입력), `verify()`가 접근자 예외를 던질 수 있다 (K-03, 이슈 #36). |
| 원장 해시 체인 무결성 (`HashChainedLedger`, `verifyChain`) | 변조 **탐지**(블록체인도 ZK도 아님): 필드 변경은 `LEDGER_EVENT_HASH_MISMATCH`로 그 위치에서 보고되고, 해시까지 다시 계산한 변조는 다음 이벤트의 `prevHash` 불일치로 잡힌다. 중간·첫 이벤트 삭제, 순서 교체, 복제, `seq`/`prevHash` 편집, 필드 추가·누락, 해시는 맞지만 상태 규칙을 어기는 체인 거부 (`ledger-chain.test.ts`). 해시는 도메인 태그가 붙은 정규화 JSON의 SHA-256이다 (`ledger-chain.test.ts`). 엄격 파서: 접근자·심볼 키·특이 프로토타입·희소 배열·추가 키 거부, 반환값은 동결된 복사본 (`ledger-events.test.ts`). 거부된 요청은 체인에 들어가지 않고, 호출자는 `seq`/`prevHash`/`recordedAt`/`eventHash`/`schemaVersion`을 지정할 수 없다 (`ledger-chain.test.ts`). 이벤트에 금액이 없다 (`ledger-events.test.ts`). 같은 입력은 같은 해시를 낸다 (`ledger-chain.test.ts`). | **끝부분 잘라내기와 마지막 이벤트의 자기 해시 재작성은 탐지되지 않는다**(`ledger-chain.test.ts`가 "탐지 안 됨"을 한계로 고정). `verifyChain`/`fromEvents`는 신뢰하는 `(길이, 머리 해시)`를 입력으로 받지 않아 외부 체크포인트(설계 §2.5)가 구현돼도 쓸 곳이 없고, 서명된 머리가 없어 전체 체인을 다시 계산해 쓰는 재작성도 탐지할 수 없다. 잘라내기는 항상 fail-closed가 아니다: 잘린 이벤트가 본인 펀드의 `LOCKED`나 `IPO_CLOSED`이면 본인 락이 풀리고(본인 UNKNOWN은 입찰 허용) 마감이 취소된 것처럼 보인다 (재현함). 원장/환경 식별자가 없고 genesis 이전 해시가 상수(`"0"×64`)라 같은 내용의 이벤트는 다른 인스턴스에서도 같은 해시를 가져 한 체인을 다른 원장에 그대로 넣을 수 있다 (K-05). `events()`가 내부 배열을 그대로 돌려주어 호출자가 로그만 바꾸면 파생 상태와 갈라진다 (K-04). `recordedAt` 단조성과 `registrySeq`는 검사하지 않는다(재현함). 서명이 이벤트 내용에 바인딩되지 않으며 `requestNonce` 중복 검사가 없다 (K-01). 체인은 기록된 사실의 진위를 보증하지 않는다. 이슈 #37. |
| 프라이버시 유출 | 영수증 해시에는 허용목록에 있는 민감하지 않은 필드만 들어가며 금액은 없다 (`verify.test.ts`). 결과가 같은 입찰 금액은 동일한 해시를 낸다. 원장 이벤트에도 금액이 없다 (`ledger-events.test.ts`). | `BidVerification`은 여전히 적격 여부와 reason code를 드러내며, 이는 경계에서 정보를 흘린다 (예: 입찰 크기의 반복 탐색). `UNDERLYING_ZERO_EXPOSURE_UNKNOWN`은 "노출이 0원인 하위펀드가 있다"는 사실을 드러낸다(금액 아님). 어테스테이션 내용은 평문 객체다. 접근 제어와 ZK는 없다. |
| 무단 상태 전이 | `UNKNOWN -> PARTICIPATING`과 `UNKNOWN -> NON_PARTICIPATION_LOCKED`만 받아들여지며, 전수 테스트되었고, 거부된 요청은 원장을 바꾸지 않는다 (`participation.test.ts`). 원장 이벤트는 같은 `transition()`을 거치고 UNKNOWN 복귀는 `EVENT_ANNULLED`로만 생기며 대상은 지워지지 않는다 (`ledger-state.test.ts`). 마감 후 상태 이벤트·정정은 거부된다 (`ledger-state.test.ts`). | 전이를 **누가** 요청할 수 있는지는 모델링되어 있지 않다. `InMemoryParticipationLedger`에는 호출자 인증·인가가 없고, `HashChainedLedger`는 서명을 형식만 검사한다(K-01). 인가 규칙 R1~R15, 키 폐기, 승인자 독립성(R14)은 구현되지 않았다. |
| 규칙 버전 조작 / 규칙 파라미터 | 활성 규칙과 다른 규칙 버전의 어테스테이션은 `RULE_VERSION_MISMATCH`로 거부되고(V1↔V2 양방향 포함), 지원되지 않는 활성 규칙 버전은 `RULE_VERSION_UNSUPPORTED`로 거부된다 (`verify.test.ts`, `rule-v2.test.ts`, `scenarios.test.ts`). `DEMO_RULE_V1`은 동결되어 테스트로 고정되고 V1과 V2 어테스테이션은 섞이지 않는다 (`rule-v2.test.ts`). `ruleVersion`은 서명 대상이라 서명된 어테스테이션의 라벨만 바꾸면 `SIGNATURE_INVALID`이고 영수증 해시에도 포함된다 (`rule-v2.test.ts`). | 대소문자·공백 변형이나 비문자열 `ruleVersion`의 거부, 더 허용적인 버전으로의 폴백이 없다는 점은 코드 읽기와 임시 PoC로만 확인했고 병합된 테스트는 없다(PR #39가 병합되면 속성 테스트로 고정). 활성 규칙 버전을 누가 정하는지에 대한 거버넌스. 버전은 변조 증거가 남는 어디에도 커밋되지 않는다. **`activeRuleVersion.maxAttestationAgeMs`는 호출자가 준 객체에서 그대로 읽히고 검증되지 않는다**: `NaN`/`Infinity`/`undefined`이면 stale 검사가 꺼지고(재현함), `id`가 `DEMO_RULE_V1`이어도 파라미터는 임의 값일 수 있다 (K-02, 이슈 #36). 본인 펀드의 락 조회는 정규화 없이 `=== NON_PARTICIPATION_LOCKED`로 비교하므로 락처럼 보이는 변형·`undefined`·`null`이면 통과하고 조회가 던지면 `verifyBid`가 예외로 끝난다 (K-06). `activeRuleVersion`이 `undefined`/`null`이거나 `id`가 `undefined`이면 reason code 대신 예외가 난다 (K-07). |

### 그 밖에 다루는 것

- **UNKNOWN 하위펀드**: UNKNOWN은 결코 면제되지 않으며 `UNDERLYING_PARTICIPATION_UNKNOWN`으로 거부된다(일부만 UNKNOWN인 혼합 경우 포함, `rules.test.ts`, `verify.test.ts`, `demo.test.ts`). `DEMO_RULE_V2`에서 노출액 0원인 UNKNOWN 하위펀드는 데이터 오류 `UNDERLYING_ZERO_EXPOSURE_UNKNOWN`으로 거부되고 일반 UNKNOWN 거부보다 우선하며, 0원이어도 PARTICIPATING/LOCKED면 정상 평가된다(`rule-v2.test.ts`, `scenarios.test.ts`). 이 우선순위는 **사유 코드만** 바꾸며 적격 여부는 어느 쪽이든 거부다.
- **참여 조회의 예상 밖 값**: 하위펀드 상태 조회가 `undefined`, `null`, 빈 문자열, 대소문자가 다른 문자열 등 예상 밖 값을 반환하거나 예외를 던지면 UNKNOWN으로 취급해 거부하며 면제하지 않는다 (`rules.test.ts`, `verify.test.ts`, `rule-v2.test.ts`). (본인 펀드의 락 조회는 예외, K-06.)
- 금액은 bigint만 허용한다 (`money.test.ts`).
- **원장과 `verifyBid`**: `HashChainedLedger`는 `ParticipationLookup`을 구현하며 기록이 없으면 UNKNOWN(= 거부)이다 (`ledger-state.test.ts`).

### 다루지 않는 것

- 판정 이후 펀드 상태가 바뀌는 경우: 판정 시점 스냅샷·마감 확정(finalization) 규칙은 [설계 문서](design/snapshot-and-finalization.md)에만 있고 구현되지 않았다.
- 하위펀드 기록의 지연을 서비스 거부 수단으로 쓰는 경우.
- 단일 원장 운영자(시퀀서)에 대한 신뢰, 순서·시간 조작, 운영자 키 탈취: 설계 문서([`participation-ledger-events.md`](design/participation-ledger-events.md) §6.4)에 한계로 명시되어 있고 코드에는 해당 개념이 없다.

## 2. 알려진 한계와 미해결 발견 사항

심각도는 "이 PoC를 인가 없는 호출자나 외부 입력에 연결했을 때"의 영향 기준이다. 모든 항목은 PoC로 재현했고(`임시 테스트`, 커밋하지 않음) 위치는 `main` @ `0eb5d89` 기준이다. K-02, K-03, K-04, K-05(원장 식별자), K-06의 재현 코드는 PR #39에서 `it.fails`로 고정되어 있다(K-01, K-07은 테스트 없음).

| ID | 심각도 | 내용 | 위치 | 상태 |
| --- | --- | --- | --- | --- |
| K-01 | 높음 (의도된 미구현, 신뢰할 수 없는 호출자에게 노출 금지) | 원장의 `authorization`/`coAuthorizations` 서명은 `0x`+130자리 16진수 **형식만** 검사한다. `scheme`/`requestNonce`/`approverId`/`actorId`도 형식만. 영향: 위 "악의적 운용사" 행. 어테스테이션 경로(`Eip712AttestationVerifier`)는 실제 secp256k1 복구로 검증하므로 해당하지 않는다. | `ledger/events.ts:155`(`SIGNATURE`), `:203` `authorization()`, `:214` `coAuthorization()`; 진입점 `parseLedgerEventDraft`, `parseLedgerEvent`, `HashChainedLedger.append`/`appendAtomic`/`fromEvents`, `verifyChain` | 열림. 후속 원장 PR ②③ 전까지 외부에 노출 금지. #37 §1, #14 |
| K-02 | 높음 (설정 오류 전제) | `maxAttestationAgeMs`가 `NaN`/`Infinity`/`undefined`이면 stale 검사 무력화. 한도가 `RULES`가 아니라 호출자 객체에서 읽힘 | `verify.ts:219`, `rules.ts:219-223` | 열림. #36 §1 |
| K-03 | 중간 (프로세스 내 호출자 전제) | 어테스테이션을 `isWellFormed`, 검증기, 규칙 평가에서 각각 읽음 → 접근자로 서명 검증을 통과시킨 뒤 규칙은 부풀린 값으로 평가(재현: 20bn 입찰 `ELIGIBLE`). `verify()`가 접근자 예외를 던짐 | `verify.ts:201-256`, `eip712.ts` `canonicalExposures` | 열림. #36 §2 |
| K-04 | 중간 | `HashChainedLedger.events()`가 내부 배열을 반환 → `pop()` 후 `verifyChain`은 ok인데 `getState`는 잘린 이벤트의 효과를 유지 | `ledger/chain.ts:160-162` | 열림. #37 §2 |
| K-05 | 중간 | 체크포인트 입력 API 없음, 원장 식별자 없음, genesis 상수, `recordedAt` 단조성 미검사. 잘라내기가 항상 fail-closed가 아님 | `ledger/chain.ts:48-70`, `ledger/events.ts:33` | 열림. #37 §3 |
| K-06 | 낮음~중간 | 본인 펀드 락 조회가 정규화되지 않음(하위펀드는 `lookupState`로 정규화) | `verify.ts:196` | 열림. #36 §3 |
| K-07 | 낮음 | `activeRuleVersion` 미설정/`id` 미정의 시 예외 | `verify.ts:139` | 열림. #36 §4 |
| K-08 | 정보 (테스트/데모 전용) | `AllowlistAttestationVerifier`는 서명을 무시한다. 이것으로 만든 `InMemoryAttestationStore`의 게시 관문은 인가만 검사한다 (`store-publish.test.ts`가 이를 명시). `deprecated`로 표시됨 | `attestation.ts:35-47` | 의도됨 |
| K-09 | 정보 | 침해된 **허가** 어테스터, 정적 레지스트리(키 교체·폐기·쿼럼 없음, #13), EIP-1271 미지원, 폐기 목록 최신성, nonce 저장소 내구성(인메모리, #15) | – | 의도됨/열림 |
| K-10 | 정보 | EIP-712 인코딩은 다른 구현 하나(viem)와 교차 검증했을 뿐 독립 감사나 공식 테스트 벡터 검증이 아니다 | `eip712.ts` | 열림 |

## 3. 이전 보안 리뷰(PR #23·#24) 발견 사항 처리 상태

| 발견 사항 | 상태 | 근거 |
| --- | --- | --- |
| #23 B1: 참여 조회가 예상 밖 값을 반환하면 면제(0 차감)로 처리 (fail-open 회귀) | **해결** | `rules.ts:188-217` `lookupState`+`failClosed`, `rules.test.ts`·`rule-v2.test.ts`·`verify.test.ts` |
| #23 R1: 이 문서의 "Not covered" 문장에 bigint 항목이 섞임 | **해결** | 이 문서 |
| #24 H1: `publish()`가 서명을 검증하지 않아 nonce 선점·덮어쓰기 가능 | **해결** | `attestation.ts:120-122`, `store-publish.test.ts` |
| #24 H2: 오래된(더 큰 용량) 어테스테이션 재게시로 신버전 대체 | **해결** | `attestation.ts:139-143`(`issuedAt` 엄격 증가), `store-publish.test.ts` |
| #24 R1~R5: Node 엔진, 영(0) 도메인, BOM, `verify(null)`, 압축 서명 | **해결** | 커밋 `37dcef7`, `eip712.test.ts` |
| #24 R6: 경계값 테스트(`expiresAt-1ms`, 정확히 24시간) | **해결** | `eip712-verifybid.test.ts` |
| #24 TOCTOU/접근자 입력 | **열림** (신규 확인) | K-03 |
| 본인 펀드 락 조회 정규화(#23에서 지적한 일관성의 잔여분) | **열림** | K-06 |

이 중 어느 것도 보안 감사가 아니다. 이 시스템은 개념 증명이다.
