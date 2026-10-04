# 설계: 참여 원장 이벤트 스키마와 상태 전이 호출자 인증·인가 (이슈 #14)

> **면책 (Disclaimer)**
> 이 문서는 **리서치/설계 PoC 문서**이며 **법률/규제 자문이 아니고 보안 감사도 아닙니다**. 규정에는 "참여 원장"이라는 개념이 없고, 이 문서의 원장·권한 모델은 PoC가 만든 구조입니다(`REGULATORY_ASSUMPTIONS.md` A-026). **프로덕션 규칙으로 사용 금지**입니다. 규정 관련 서술은 [`REGULATORY_RESEARCH.md`](../REGULATORY_RESEARCH.md)·[`REGULATORY_ASSUMPTIONS.md`](../REGULATORY_ASSUMPTIONS.md)(확인일 2026-10-03)를 연결하며, 그 문서가 확인하지 못했다고 적은 것은 여기서도 **미확인**입니다.

- 작성: 리서치 봇. 이슈: #14 (`Refs #14`). 상태: **설계 제안 (코드 변경 없음)**. 구현은 'IPO Proof 구현' 봇(#15), 권한 모델 리뷰는 보안QA 몫입니다(§10).
- 선행: 이슈 #10 설계 문서 `docs/design/snapshot-and-finalization.md`(PR #26, #30으로 `main`에 병합됨). 이 문서의 `IPO_CLOSED` 컷오프, 접수 영수증, 단조성(해당 문서 §3.4)은 그 문서에 의존합니다. UNKNOWN은 **거부**로 결정되었습니다(이슈 #10 코멘트, 진영, 2026-10-03).
- 후행: 이슈 #15(영속성), #18(온체인 컨트랙트 설계), #13(어테스터·운용사 키 관리).
- **결정 반영(2026-10-03, 리드 봇을 통해 전달된 진영 님 결정)**: ① D14-Q1: **마감 전 정정 허용, 마감 후 변경 불가.** `EVENT_ANNULLED` 이벤트로 append-only 해시 체인을 깨지 않고 정정한다(§2.3, §4.2 R10~R13, §5.1). ② D14-Q2: 독립 `requestParticipation` **유지**(§7). ③ D14-Q3/Q4: 진영 님이 임의 판단을 위임하여 **단일 원장 운영자가 순번과 시간 기준을 정하는 것**으로 확정(§6.4에 한계 명시). 규정이 요구하는 것이 아니라 PoC 단순화 선택입니다. ④ #11의 v2(`blindingSalt` 등)는 **보류**: 이 문서의 서명 규약은 v1과 같은 라이브러리·규칙을 쓰며 v2 필드에 의존하지 않습니다. ⑤ **마감 전 입찰 취소 가능, 마감 후 불가**(Q14-N4 해소): 취소는 입찰이 만든 BIND-1 기록만 되돌리며 운용사 단독 서명으로 처리한다(R15, §7). ⑥ **정정 승인자는 운용사 서명자와 독립된 주체여야 한다**(Q14-N1 해소): 동일 주체 서명은 거부하고, 레지스트리 관리자와 원장 운영자가 같은 주체이면 독립 승인으로 인정하지 않는다(R14, §4.5). 단일 운영자 선택(D14-Q3)과의 공존·한계는 §6.4.1에 있다.
- 코드 기준: `main` 커밋 `0eb5d89`(2026-10-04 확인). `packages/domain/src/participation.ts`(상태기계)는 초안 기준(3fa59ef)과 같고, 원장 PR ①(#35)이 `packages/domain/src/ledger/{events,chain,derive}.ts`(봉투·해시 체인·상태 도출, 서명 검증과 인가 제외)를 추가했습니다. §9.4에 구현 임시값과 이 문서의 확정값을 대조했습니다.
- **확정값 반영(2026-10-04, 리드 봇 배정)**: ⑦ PR ①이 설계가 정하지 않아 임시로 둔 항목을 확정했다: genesis `prevHash`, 해시 도메인 태그와 `canonicalJson` 정의(§2.2.1), `coAuthorizations[].approverId`, 서명 스킴 식별자(§2.2.2, R16), LOCKED의 `origin`(§2.3), R10/R12/R15의 BIND-1 정정 규칙(§4.2.1), 미지원 이벤트 3종 사양(§2.3.1~§2.3.3, R17~R19). 이 7번은 진영 님 결정이 아니라 **설계 확정**이며, 진영 님 확인이 필요한 갈래는 Q14-N7~N10(§9.3)으로 분리했다.

## 0. 요약

1. 현재 원장은 **누가** 전이를 요청하는지 모른다(`requestParticipation(fundId, ipoId)`에 호출자가 없음). 따라서 누구든 타 운용사 펀드를 `NON_PARTICIPATION_LOCKED`(또는 `PARTICIPATING`)로 만들 수 있고, 상태기계가 되돌림을 금지하므로 현재 코드에서는 **첫 잘못된 기록이 영구**하다. 이것이 "허위 LOCKED 선점"의 핵심이다(§6). 결정 D14-Q1에 따라 이 설계에서는 **마감 전에 한해** 공동 서명된 `EVENT_ANNULLED`로 되돌릴 수 있고, **마감 후에는 영구**하다.
2. 제안: 원장을 **해시 체인으로 연결된 append-only 이벤트 로그**로 정의하고(§2), 상태 전이 요청에 **서명된 요청(EIP-712 `LedgerAction`)** 을 요구하며, 서명자를 **독립 레지스트리의 `Fund.managerId`** 와 대조한다(§3, §4). 운용사는 자기 펀드의 상태만 기록할 수 있다(타 펀드 대리 기록 금지).
3. 마감 확정(#10)은 원장에 `IPO_CLOSED` 이벤트로 들어간다. 이후 해당 IPO의 상태 이벤트와 **정정 이벤트**는 거부되고, 컷오프 이전 순번만 확정 판정에 반영된다(§5).
4. `verifyBid` 통과가 참여 기록을 구속하지 않는 문제(ROADMAP 미결정 항목)는 **"접수된 입찰이 입찰 펀드의 PARTICIPATING을 원자적으로 기록"** 하는 규칙(BIND-1)으로 닫는 것을 제안한다(§7).
5. 이 설계로 막히지 않는 것은 §6.2에 따로 적었다: 운용사 키 탈취, 레지스트리 장악, 시퀀서의 순서 조작, 같은 운용사 내부 조작, 정정 공동 서명자(운용사–승인자)의 공모와 독립성 검사의 우회. 단일 운영자 선택의 한계는 §6.4에 모았다.
6. 소유자 결정 4개(D14-Q1~Q4)는 반영되었다(§9.3).
7. **정정 승인자는 독립 주체여야 한다**(R14). 시스템이 확인할 수 있는 것은 식별자·서명 키·신고된 `controllerId`의 상이함이고, 레지스트리 관리자와 원장 운영자가 같은 주체이면 정정 기능 자체를 끈다(fail closed). 실제 사람·조직의 독립성은 증명하지 못한다(§4.5, §6.4.1).
8. **마감 전 입찰 취소**(R15)는 입찰이 만든 `PARTICIPATING`만 되돌리고, 독립 승인 없이 운용사 서명만으로 처리한다. 대신 승인자의 속도 제한이 없다(T-17).
9. 구현 PR ①(#35) 이후 설계 확정값(§9.4): genesis는 `0`×64, 해시는 `sha256(canonicalJson({domain, event}))`, 서명 스킴 식별자 6종, LOCKED의 `origin`은 `INDEPENDENT`만, BIND-1 기록은 `BID_WITHDRAWN` + 같은 바인딩 `bidId`로만 정정(R12). 미지원이던 이벤트 3종(`FINDING_ANNOTATED`, `MANAGER_KEY_REVOKED`, `IPO_FINALIZED`)의 사양을 정했다.
10. 남은 열린 질문은 Q14-N2, N3, N5~N10이다(§9.3).

---

## 1. 현재 상태 (`main` 기준 사실)

| 항목 | 현재 | 근거 |
| --- | --- | --- |
| 상태 | `UNKNOWN`, `PARTICIPATING`, `NON_PARTICIPATION_LOCKED` | `participation.ts` |
| 허용 전이 | `UNKNOWN → PARTICIPATING`, `UNKNOWN → NON_PARTICIPATION_LOCKED`만. 동일 상태 반복, 상태 간 전환, `UNKNOWN`으로 복귀는 거부 | `transition()` |
| 원장 | `InMemoryParticipationLedger`: `Map`과 `LedgerEntry[]`(`seq`, `fundId`, `ipoId`, `from`, `to`, `at`) | 같은 파일 |
| 호출 | `requestParticipation(fundId, ipoId)`, `requestNonParticipationLock(fundId, ipoId)`, `apply(fundId, ipoId, target)` — **호출자 인자 없음** | 같은 파일 |
| 인증·인가 | 없음 | `docs/THREAT_MODEL.md` "Unauthorized state transition" 행 |
| 항목 해시·체인 | 없음. `at`은 주입된 시계 값 | 같은 파일 |
| IPO 상태 | 원장은 IPO 마감을 모른다. `verifyBid`가 `subscriptionClosesAt`으로 `IPO_NOT_OPEN`만 판단 | `verify.ts` |
| 입찰 펀드 자신의 상태 | `LOCKED`면 거부, `UNKNOWN`/`PARTICIPATING`은 허용 | `verify.ts` 3단계 |
| 입찰 통과와 기록 | 분리됨 ("Callers record outcomes … separately", ARCHITECTURE) | `docs/ARCHITECTURE.md` |
| 레지스트리 | `Fund.managerId`, `Fund.underlyingFundIds`를 가진 독립 레지스트리를 **가정** (강제 안 함) | `model.ts`, `registry.ts`, ARCHITECTURE "Omitted deductions" |
| 해시 체인 원장 (PR #35, `main` 병합) | `ledger/events.ts`(봉투·엄격한 파서·`computeEventHash`), `ledger/derive.ts`(`LedgerProjection` 접기), `ledger/chain.ts`(`verifyChain`, `HashChainedLedger`). 지원 이벤트는 `PARTICIPATION_RECORDED`, `NON_PARTICIPATION_LOCKED_RECORDED`, `EVENT_ANNULLED`, `IPO_CLOSED` 4종이고 `IPO_FINALIZED`, `FINDING_ANNOTATED`, `MANAGER_KEY_REVOKED`는 `EVENT_TYPE_NOT_SUPPORTED`로 거부(fail closed). 서명은 **형식만** 검사하고 검증하지 않는다. 기존 `InMemoryParticipationLedger`는 대체되지 않았다 | `packages/domain/src/ledger/*` (`0eb5d89`) |

위 표의 앞쪽 행(상태·허용 전이·호출·인증)은 `participation.ts` 기준이고, 해시 체인 행이 PR #35 이후의 사실이다.

---

## 2. 이벤트 스키마

### 2.1 원칙

- **append-only**, 순번 `seq`는 1부터 빈틈 없이 증가. 수정·삭제 없음.
- **해시 체인**: 각 이벤트가 직전 이벤트의 해시를 포함한다. 과거 이벤트의 변조·삭제·재정렬이 체인 검증에서 드러난다.
- **순번이 순서의 유일한 기준**. 시각 필드는 참고용이다(이슈 #10 설계의 컷오프 규칙 F1).
- **금액을 담지 않는다**. 원장은 펀드·IPO·상태만 다룬다(금액은 증빙과 비공개 입찰 레코드에 있다). 영수증 정책과 같은 이유다.
- 직렬화는 `hash.ts`의 canonical JSON(키 정렬, 안전한 정수만), 해시는 SHA-256(기존 `sha256CanonicalHex`). 온체인 이식 시 keccak-256과 ABI 인코딩으로 바꿀지는 #18에서 정한다(이 문서는 정하지 않음).

### 2.2 봉투(envelope) 필드

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `schemaVersion` | 정수 | 현재 `1`. 레이아웃이 바뀌면 올린다 |
| `seq` | 정수 | 시퀀서가 부여. 1부터 연속 |
| `prevHash` | hex(소문자 64자) | 직전 이벤트의 `eventHash`. `seq = 1`의 `prevHash`는 **`"0"`을 64번 반복한 문자열**(genesis 값, §2.2.1) |
| `eventType` | enum | §2.3 |
| `ipoId` | 문자열 \| null | 대상 IPO. **`MANAGER_KEY_REVOKED`만 전역 이벤트라 `null`**이고 다른 모든 유형은 필수(§2.3.2) |
| `subjectFundId` | 문자열 \| null | 상태가 바뀌는 펀드. IPO 단위 이벤트는 `null` |
| `actorId` | 문자열 | 요청자(운용사 `managerId` 또는 운영자 역할 ID) |
| `authorization` | 객체 | `{scheme, requestNonce, expiresAt, signature}` (§3.2). `scheme`은 이벤트 유형·`reason`에 대응하는 식별자 하나로 정해진다(§2.2.2 표, R16). 서명은 `0x` + 소문자 hex 130자(65바이트) |
| `coAuthorizations` | 객체 배열 | 공동 서명. `reason`이 `MISTAKEN_ENTRY`/`KEY_COMPROMISE`인 정정 이벤트에서만 비어 있지 않고, 정확히 **1건**이다: 독립된 승인자의 `AnnulmentApproval` 서명(§3.2, R10, R14). 항목 형식은 `{approverId, scheme, requestNonce, expiresAt, signature}`이며 `approverId`(승인자 principal ID)는 필수다. 다른 모든 이벤트(`BID_WITHDRAWN` 포함)에서는 빈 배열 |
| `payload` | 객체 | 이벤트 유형별(§2.3) |
| `registrySeq` | 정수 | 인가 판단에 사용한 레지스트리 버전(§4.3) |
| `requestedAt` | 정수(ms) | **요청자 주장 시각**. 신뢰하지 않음 |
| `recordedAt` | 정수(ms) | 시퀀서가 기록한 시각. 시퀀서 시계이며 참고용 |
| `eventHash` | hex(소문자 64자) | `sha256(canonicalJson({domain: "ipo-proof/ledger-event/v1", event: <eventHash를 제외한 위 모든 필드>}))` (§2.2.1) |

서명은 감사용으로 이벤트에 보관하므로 체인 해시에 포함된다.

### 2.2.1 직렬화와 해시 (확정)

규범 정의는 구현 `packages/domain/src/hash.ts`의 `canonicalJson`/`sha256CanonicalHex`(`main` `0eb5d89`)이다. 다른 언어·온체인 구현(#18)은 아래와 **같은 바이트열**을 만들어야 한다.

| 항목 | 규칙 |
| --- | --- |
| 허용 값 | `null`, 불리언, 안전한 정수, 문자열, 배열, 일반 객체뿐. 그 외는 직렬화 오류 |
| 객체 | 자기 소유의 열거 가능한 문자열 키를 **UTF-16 코드 유닛 순**(JS 기본 `sort()`)으로 정렬한다. `{"키":값,...}` 형태, 공백 없음. 키도 문자열과 같은 방식으로 직렬화 |
| 배열 | 순서 유지. `[값,...]`, 공백 없음 |
| 숫자 | `Number.isSafeInteger`를 만족하는 값만(절댓값 2^53−1 이하). 10진 정수 표기이고 지수·소수점·`+`·선행 0이 없다. `-0`은 `0`으로 쓴다. 실수·`NaN`·`Infinity`는 오류. 이 범위를 넘는 값(금액 등)은 **10진 문자열**로 넣는다 |
| 문자열 | JSON 문자열: `"`, `\`, U+0000~U+001F는 이스케이프(`\b \f \n \r \t`, 나머지는 소문자 hex `\u00xx`). 그 밖의 문자(U+007F 포함)는 이스케이프 없이 그대로이고 UTF-8로 인코딩한다. 짝이 없는 서로게이트는 `\udxxx`로 이스케이프. **유니코드 정규화(NFC 등)는 하지 않는다**. 원장 이벤트의 문자열 필드는 파서가 ASCII 토큰(식별자 `^[a-z][a-z0-9_]{0,63}$`, 열거형, hex, scheme)만 허용하므로 실제 입력에는 비-ASCII가 없다 |
| 선택 필드 | 없는 필드는 **키 자체를 뺀다**. 값이 `undefined`이거나 함수·심볼·`bigint`이면 생략하지 않고 오류로 처리한다 |
| 해시 | 위 문자열을 UTF-8로 SHA-256하고 소문자 hex 64자로 표기 |
| 대소문자 | `prevHash`, `eventHash`, 모든 다이제스트는 소문자 hex만. 서명은 `0x` + 소문자 hex 130자만 허용한다(같은 서명의 대소문자 변형이 서로 다른 `eventHash`를 만들지 않게 하기 위함) |

**도메인 태그.** `eventHash`의 입력은 이벤트를 그대로 직렬화한 것이 아니라 `{domain, event}` 객체이다. `domain`은 상수 `"ipo-proof/ledger-event/v1"`이고 `event`는 `eventHash`를 뺀 모든 필드(서명, `schemaVersion`, `seq`, `prevHash`, `recordedAt` 포함)이다. 같은 `canonicalJson`+SHA-256을 쓰는 다른 해시(#10의 `inputsDigest`/`finalVerdictDigest`, 영수증 `proofHash` 등)와 입력 공간을 분리하기 위한 것이다. 태그 이름은 `ipo-proof/<대상>/v<정수>` 형식이고, 대상의 구조가 바뀌면 버전을 올린다(원장 봉투는 `schemaVersion`도 함께). 이 해시 태그는 EIP-712 서명 도메인(`name`/`version`/`chainId`/`verifyingContract`, §3.2)과 **별개**이며 서로 대신하지 못한다.

**참조 벡터** (합성 값. 서명 바이트는 `ab`×65 자리표시자이고 이 문서는 서명을 검증하지 않는다). `seq = 1`, `PARTICIPATION_RECORDED`, `origin = INDEPENDENT`, `recordedAt = requestedAt = 1800000000000`, `registrySeq = 1`, `requestNonce = nonce_1`, `expiresAt = 2000000000000`, `scheme = EIP712_LEDGER_ACTION_V1`, `ipoId = ipo_1`, `subjectFundId = fund_x`, `actorId = manager_x`일 때 `hash.ts`와 같은 규칙으로 계산한 값:

```
canonicalJson({domain, event}) =
{"domain":"ipo-proof/ledger-event/v1","event":{"actorId":"manager_x","authorization":{"expiresAt":2000000000000,"requestNonce":"nonce_1","scheme":"EIP712_LEDGER_ACTION_V1","signature":"0xababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab"},"coAuthorizations":[],"eventType":"PARTICIPATION_RECORDED","ipoId":"ipo_1","payload":{"from":"UNKNOWN","origin":"INDEPENDENT","to":"PARTICIPATING"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000","recordedAt":1800000000000,"registrySeq":1,"requestedAt":1800000000000,"schemaVersion":1,"seq":1,"subjectFundId":"fund_x"}}
eventHash = 373ca33088d959d91cf00170355b706942609859defd2b8a5d35f12fd64f1967
```

도메인 태그 없이 `event`만 해시하면 `84485d9d…7d77`이 나와 위 값과 다르다(L-48에서 이 차이를 검사한다). 이 벡터는 `hash.ts`의 `canonicalJson`을 그대로 옮긴 스크립트로 계산했고 이 문서 작성 시점의 구현 테스트에는 아직 없다(구현 봇이 테스트로 고정). 이 직렬화가 RFC 8785(JCS)와 같은 바이트열을 내는지는 확인하지 않았다(미확인). 안전한 정수만 쓰므로 비슷하리라 추정할 뿐이다.

### 2.2.2 서명 스킴 식별자 (`scheme`, 확정)

`scheme`은 서명 한 건마다 붙는 라벨로, `authorization.scheme`(주 서명)과 `coAuthorizations[].scheme`(공동 서명)에 있다. 형식은 구현과 같은 `^[A-Z][A-Z0-9_]{0,63}$`이고, 이름은 `EIP712_LEDGER_<의미>_V<n>`이다. 아래 표가 규범이다.

| 대상 | `scheme` | EIP-712 `primaryType` (§3.2) | 서명자 | 위치 |
| --- | --- | --- | --- | --- |
| `PARTICIPATION_RECORDED`, `NON_PARTICIPATION_LOCKED_RECORDED` | `EIP712_LEDGER_ACTION_V1` | `LedgerAction` | 해당 펀드의 운용사 | `authorization` |
| `EVENT_ANNULLED` (`reason` = `MISTAKEN_ENTRY` / `KEY_COMPROMISE`) | `EIP712_LEDGER_ANNULMENT_V1` | `LedgerAnnulment` | 해당 펀드의 운용사 | `authorization` |
| 위 정정 이벤트의 승인자 | `EIP712_LEDGER_ANNULMENT_APPROVAL_V1` | `AnnulmentApproval` | 독립된 승인자(R14) | `coAuthorizations[0]` |
| `EVENT_ANNULLED` (`reason` = `BID_WITHDRAWN`) | `EIP712_LEDGER_BID_WITHDRAWAL_V1` | `BidWithdrawal` | 해당 펀드의 운용사 | `authorization` (`coAuthorizations`는 빈 배열) |
| `IPO_CLOSED`, `IPO_FINALIZED`, `FINDING_ANNOTATED` (운영자 이벤트) | `EIP712_LEDGER_OPERATOR_ACTION_V1` | `OperatorAction` | 원장 운영자 | `authorization` |
| `MANAGER_KEY_REVOKED` | `EIP712_LEDGER_KEY_REVOCATION_V1` | `KeyRevocation` | 레지스트리 관리자 | `authorization` |

- **정확 일치(R16)**: 이벤트 유형·`reason`·위치에 대응하는 값과 다르면 `LEDGER_SCHEME_MISMATCH`로 거부한다. 표에 없는 `scheme`은 형식이 맞아도 거부한다.
- **라벨은 서명 대상이 아니다**: `scheme`은 EIP-712 메시지에 들어가지 않는다. 서명 검증은 `scheme` 값이 아니라 이벤트 유형과 `reason`으로 `primaryType`을 정해 수행한다. 따라서 라벨만 바꿔 다른 구조의 서명을 재해석하게 만들 수 없다(T-21). `scheme` 검사는 구조 검사이므로 서명 검증보다 앞서 한다.
- 서명 구조(필드·`primaryType`)가 바뀌면 `_V<n>`을 올리고 EIP-712 도메인 `version`도 함께 올린다. 새 `scheme`은 이 표에 추가해야 유효하다.

### 2.3 이벤트 유형

| `eventType` | 누가 | `payload` | 효과 |
| --- | --- | --- | --- |
| `PARTICIPATION_RECORDED` | 해당 펀드의 운용사 | `{from, to: "PARTICIPATING", origin, bidId?}` — `origin`은 `INDEPENDENT`(독립 `requestParticipation`) 또는 `BIND_1`(입찰 접수로 기록, `bidId` 필수) | 상태 `UNKNOWN → PARTICIPATING` |
| `NON_PARTICIPATION_LOCKED_RECORDED` | 해당 펀드의 운용사 | `{from, to: "NON_PARTICIPATION_LOCKED", origin}` — **`origin`은 `INDEPENDENT`만 허용**. `BIND_1`은 입찰 접수가 `PARTICIPATING`을 기록하는 경로(§7)에만 있으므로 LOCKED에는 올 수 없다. `bidId`도 없다. 입찰 취소 후 `afterState`로 LOCKED를 재기록하는 경우도 `INDEPENDENT`이다(R15) | 상태 `UNKNOWN → NON_PARTICIPATION_LOCKED` |
| `IPO_CLOSED` | 원장 운영자 | `{closesAt, ledgerSeqAtClose}` | 컷오프 확정. 이후 해당 IPO 상태 이벤트 거부(§5). `ledgerSeqAtClose`는 이 이벤트의 `seq - 1` |
| `IPO_FINALIZED` | 원장 운영자 | `{ledgerSeqAtClose, ledgerHeadHashAtClose, finalizationDigest}` (§2.3.3) | `IPO_CLOSED` **이후에만**, IPO당 **1회**. #10의 확정 레코드 다이제스트를 원장에 못박음. 상태에는 영향 없음 |
| `FINDING_ANNOTATED` | 원장 운영자(`AUDITOR`는 읽기 전용이라 직접 쓰지 못함, §4.1) | `{targetSeq, targetEventHash, kind, evidenceDigest}` — **자유 서술 `note` 없음**, `kind`는 닫힌 목록 (§2.3.1) | 사후 발견(폐기, 이의)을 **주석**으로만 기록. 상태에 영향 없음 |
| `MANAGER_KEY_REVOKED` | 레지스트리 관리자(PoC 매핑. 키 관리 역할과 쿼럼은 #13) | `{managerId, revokedKeyId}` — **`ipoId = null`인 전역 이벤트** (§2.3.2) | 이 순번부터 **모든 IPO**에서 해당 키로 서명된 새 요청 거부(§4.4, R9) |
| `EVENT_ANNULLED` | `reason`이 `MISTAKEN_ENTRY`/`KEY_COMPROMISE`이면 해당 펀드의 운용사 + **독립된** 승인자(R10, R14). `reason = BID_WITHDRAWN`이면 운용사 단독(R15) | `{targetSeq, targetEventHash, reason, replacement, bidId?}` — `reason`은 `MISTAKEN_ENTRY` / `KEY_COMPROMISE` / `BID_WITHDRAWN`, `replacement`는 `null` 또는 `"PARTICIPATING"`/`"NON_PARTICIPATION_LOCKED"`, `bidId`는 `BID_WITHDRAWN`일 때만 | **마감 전에 한해** 대상 상태 이벤트를 무효로 표시하고 그 펀드의 **유효 상태**를 `UNKNOWN`으로 되돌린다. 대상 이벤트와 체인은 지워지지 않는다. `replacement`가 있으면 같은 요청이 바로 다음 순번에 해당 상태 이벤트(`origin = INDEPENDENT`)를 **원자적으로** 추가한다(사이에 다른 이벤트 없음) |

- **정정(annul)의 의미**: 정정은 과거 이벤트를 고치거나 지우지 않는다. 새 `EVENT_ANNULLED` 이벤트를 **뒤에 덧붙여** "순번 `targetSeq`의 이벤트는 더 이상 유효 상태를 만들지 않는다"고 선언한다. 해시 체인(§2.1)은 그대로 유지되고 `targetSeq`의 원래 이벤트도 감사용으로 남는다. 정정 이벤트를 다시 정정하는 이벤트는 없다. 되돌린 뒤 같은 상태나 다른 상태를 다시 기록하려면 새 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`를 추가한다.
- 거부된 요청은 **체인에 넣지 않는다**. 거부 요청은 별도의 `RejectionAuditLog`(비권위, 용량 제한 가능)에 요청 해시, 사유 코드, 시각만 남긴다. 체인에 넣으면 스팸으로 체인이 부풀고, 감사 목적은 별도 로그로 충족된다.
- 현재 코드의 `LedgerEntry.{from,to}`는 `payload`로, `at`은 `recordedAt`으로 대응된다.

### 2.3.1 `FINDING_ANNOTATED` 사양 (확정, PoC 정책)

사후 발견을 상태 변경 없이 체인에 남기는 이벤트이다. 규정에 이런 주석이나 원장 개념은 없다(A-026). 아래는 PoC 정책이며 규정 요구가 아니다.

**payload** (이 외의 필드가 있으면 `EVENT_MALFORMED`):

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `targetSeq` | 정수 ≥ 1 | 주석 대상 이벤트의 순번. 이 이벤트의 `seq`보다 작아야 한다 |
| `targetEventHash` | hex 64자 | 대상의 `eventHash`(다른 이벤트로 오인되지 않게) |
| `kind` | 열거형 | 닫힌 목록: `ATTESTATION_REVOKED_AFTER_CLOSE`(마감 후 증빙 폐기 발견, #10 F5), `DISPUTE_RAISED`(이의 제기 접수), `RECORD_ERROR_NOTED`(마감 후 오기록 의심 확인. 정정 불가이므로 주석만), `KEY_COMPROMISE_NOTED`(키 침해 확인 또는 의심). 목록 확장은 `schemaVersion` 개정으로 한다 |
| `evidenceDigest` | hex 64자 \| `null` | 원장 밖에 보관한 증빙 문서의 해시. 없으면 `null` |

봉투: `ipoId` 필수(대상과 같은 IPO), `subjectFundId = null`, `coAuthorizations = []`, `scheme = EIP712_LEDGER_OPERATOR_ACTION_V1`. 마감 전·후 모두 기록할 수 있고(이벤트는 상태에 영향이 없다), `IPO_FINALIZED` 이후에도 허용된다. 대상은 같은 IPO의 기존 이벤트이면 유형을 가리지 않는다. 단 `FINDING_ANNOTATED` 자체는 대상이 될 수 없다(주석 연쇄 방지).

**허용 형식 선택: 자유 서술을 허용하지 않고, 닫힌 코드와 증빙 다이제스트만 쓴다.**

| 안 | 내용 | 장점 | 단점 / 한계 | 판단 |
| --- | --- | --- | --- | --- |
| A. 자유 서술 `note` + 상한 | 예: 120자 이하, ASCII 출력 가능 문자 | 유연함. 설명을 바로 읽을 수 있음 | 체인은 **append-only라 한 번 쓴 개인정보·금액은 지울 수 없다**(원장은 금액을 담지 않는다는 원칙 §2.1과 충돌). 길이·문자 집합 제한으로는 내용(이름, 금액, 연락처)을 걸러내지 못한다(숫자·영문·한글이 모두 필요) | 채택 안 함 |
| **B. 닫힌 `kind` + `evidenceDigest`** | 의미는 코드로, 상세는 원장 밖 문서의 해시로 | 체인에는 금액·개인정보가 들어갈 수 없다. 문서는 원장 밖에서 삭제·접근 통제 가능. 구조가 고정되어 테스트가 쉬움 | 코드 목록이 필요하고 목록 밖 사정은 `RECORD_ERROR_NOTED` 등에 억지로 맞춰야 함. 증빙 문서가 원장 밖에 있어 사라지면 다이제스트만 남음 | **채택** |
| C. 다이제스트만 | `kind` 없이 `evidenceDigest`만 | 가장 단순 | 이벤트만 봐서는 무슨 일인지 알 수 없어 조회·필터가 불가능 | 채택 안 함 |

- 증빙 문서에 금액이나 개인정보가 들어 있으면 저엔트로피 값의 해시는 추측으로 확인할 수 있다(영수증 정책, #11 §7.3과 같은 이유). 그래서 증빙 문서에 무작위 `evidenceNonce`(128비트 이상)를 넣고 해시하는 것을 **운영 규약**으로 둔다. 시스템은 이를 검사하지 못한다.
- 길이 상한과 문자 집합은 `note`가 없으므로 해당 없다. 문자열 필드는 `kind`(열거형)뿐이다. 자유 서술이 꼭 필요하다는 판단이 서면 안 A를 개정 사양으로 다시 다룬다(Q14-N10).
- 쓰기 권한은 운영자뿐이다. `AUDITOR`가 발견한 사항은 운영자에게 전달해야 하고, 운영자가 주석을 달지 않을 수 있다는 검열 위험이 남는다(T-19, TA-1).

### 2.3.2 `MANAGER_KEY_REVOKED`의 IPO 범위 (확정: 전역 이벤트)

충돌: 봉투(§2.2)는 `ipoId`를 필수로 두지만 운용사 서명 키는 **IPO의 속성이 아니라 운용사의 속성**이고, R9도 폐기 순번 이후 새 요청을 모든 IPO에서 거부하라고 쓰고 있다.

| 안 | 내용 | 장점 | 단점 / 한계 | 판단 |
| --- | --- | --- | --- | --- |
| **A. 전역 이벤트** | `ipoId = null`, `subjectFundId = null`인 이벤트 1개. 폐기 집합은 체인 전체의 접기로 도출 | 키의 의미(운용사 단위)와 일치. 이벤트 1개로 원자적. 이후 새로 열리는 IPO에도 자동 적용. `revocationSeqAtClose`(#10)는 컷오프까지의 전역 폐기 이벤트 위치로 그대로 정의됨 | 봉투의 `ipoId` 필수 규칙에 **예외 1개**(이 유형만 `null`). IPO별로 체인을 분리하게 되면(#15, #18) 전역 이벤트를 복제하거나 별도 체인이 필요함. IPO별 감사 뷰는 전역 이벤트를 함께 보여줘야 함 | **채택** |
| B. IPO별 폐기 이벤트 | 폐기할 때 IPO마다 이벤트를 따로 낸다 | 봉투 규칙이 그대로 | 이후 열리는 IPO와 누락된 IPO에서는 키가 살아 있다. 일부 IPO에서만 폐기된 키가 생겨 R9(전역 거부)와 어긋난다. 마감된 IPO에는 의미가 없다(R6) | 채택 안 함 |
| C. 전역 요청을 열린 IPO에 팬아웃 | 한 요청이 열린 IPO마다 이벤트 N개를 원자적으로 추가 | 봉투 규칙이 그대로 | 이벤트 수가 열린 IPO 수에 비례. 팬아웃 시점 뒤에 열리는 IPO는 따로 규칙이 필요(결국 전역 폐기 집합이 필요해져 A와 같아짐). 원자성(`appendAtomic`) 의존 | 채택 안 함 |

선택 이유: 키 폐기는 한 키에 대한 하나의 사실이다. A는 그 사실을 한 번만 기록하고, B와 C는 같은 사실을 IPO 수만큼 복제하면서도 미래 IPO를 덮지 못한다. 대가로 봉투 예외 1개와 향후 IPO별 체인 분리 시 복제 문제를 진다. 후자는 #15/#18에서 다룬다.

- payload `{managerId, revokedKeyId}`: 둘 다 식별자 형식(`^[a-z][a-z0-9_]{0,63}$`)이다. 키 레지스트리의 형식은 #13이 정하며 그 전에는 `managerId`당 키가 하나라고 본다(§3.2).
- 봉투: `ipoId = null`, `subjectFundId = null`, `coAuthorizations = []`, `scheme = EIP712_LEDGER_KEY_REVOCATION_V1`. 서명자는 레지스트리 관리자 principal이다(R18). 폐기는 운용사 자신이 서명하지 않는다: 침해된 키 소유자가 침해된 키로 폐기를 서명하는 경로를 피하고, 새 키 발급을 관리자 절차와 묶기 위한 PoC 매핑이다(Q14-N9).
- `ipoId = null`은 이 유형에서만 허용되고 다른 유형에서는 `EVENT_MALFORMED`이다. 반대로 이 유형에 `ipoId`가 있어도 `EVENT_MALFORMED`이다.
- 효과: 순번 이후 모든 IPO에서 그 키의 새 요청 거부(R9). 이전 이벤트는 그대로이고(상태를 되돌리지 않음), 마감된 IPO는 R6으로 어차피 변하지 않는다.

### 2.3.3 `IPO_FINALIZED`의 선행 조건과 1회 규칙 (확정)

payload: `{ledgerSeqAtClose, ledgerHeadHashAtClose, finalizationDigest}`.

- `ledgerSeqAtClose`: 그 IPO의 `IPO_CLOSED` 이벤트의 `payload.ledgerSeqAtClose`와 같아야 한다.
- `ledgerHeadHashAtClose`: 순번 `ledgerSeqAtClose` 이벤트의 `eventHash`(= `IPO_CLOSED`의 `prevHash`)와 같아야 한다. #10의 스냅샷 레코드 필드와 같은 이름이다.
- `finalizationDigest`: hex 64자. #10 확정 함수가 **동결된 입력**(컷오프까지의 원장, 컷오프 시점 레지스트리, 접수된 활성 입찰, 규칙 버전)으로 계산한 확정 결과 전체의 해시. 제안 형태는 `sha256(canonicalJson({domain: "ipo-proof/ipo-finalization/v1", ipoId, ledgerSeqAtClose, ledgerHeadHashAtClose, verdictDigests: <bidId 순 정렬>}))`이고 규범은 #10 구현(`finalize`)에서 정한다. 원장은 **이 값의 내용을 검증하지 못한다**(시점, 컷오프 일치, 1회만 강제). 감사인이 같은 동결 입력으로 재계산해 확인한다. #10에 따라 `finalVerdictDigest`는 내부 전용이므로 원장 열람 범위가 내부를 넘으면 위험하다(잔여, 열람 범위는 #15/#18).
- 봉투: `ipoId` 필수, `subjectFundId = null`, `coAuthorizations = []`, `scheme = EIP712_LEDGER_OPERATOR_ACTION_V1`.

| 규칙 | 내용 | 거부 코드(제안 이름) |
| --- | --- | --- |
| 선행 | 같은 `ipoId`의 `IPO_CLOSED`가 이미 체인에 있어야 한다. 따라서 `IPO_FINALIZED`의 순번은 항상 `IPO_CLOSED`보다 크다. 다른 IPO가 마감된 것은 해당 없다 | `IPO_NOT_CLOSED` |
| 컷오프 일치 | 위 두 필드가 체인의 `IPO_CLOSED`와 일치 | `LEDGER_FINALIZATION_CUTOFF_MISMATCH` |
| 1회 | 같은 `ipoId`의 `IPO_FINALIZED`가 이미 있으면 `finalizationDigest`가 같든 다르든 거부한다. 덮어쓰기·재확정 경로는 없다 | `IPO_ALREADY_FINALIZED` |
| 멱등 | 같은 `requestNonce`의 같은 서명 요청 재전송은 R4에 따라 첫 결과를 돌려주고 새 이벤트를 만들지 않는다(`IPO_ALREADY_FINALIZED`가 아님) | R4 |
| 이후 | `IPO_FINALIZED` 뒤에도 `FINDING_ANNOTATED`와 `MANAGER_KEY_REVOKED`는 가능하다. 상태 이벤트·정정은 `IPO_CLOSED`부터 이미 거부된다(R6) | – |

대안: (a) 선행 조건 없이 언제든 기록, (b) `IPO_CLOSED` 선행만 요구하고 컷오프 필드는 생략, (c) 재확정 허용(마지막 값이 유효). (a)는 마감 전 확정 레코드를 못박을 수 있어 "동결된 입력" 의미가 사라진다. (b)는 다른 컷오프로 계산한 다이제스트를 못박아도 원장이 알아채지 못한다. (c)는 D14-Q1의 "마감 후 변경 불가"와 충돌한다. 그래서 선행 조건 + 컷오프 일치 + 1회를 택했다. 확정 기록 자체가 틀렸다고 나중에 판명되어도 정정 경로는 없고 `FINDING_ANNOTATED`(`RECORD_ERROR_NOTED` 등)로만 남긴다. 이는 마감 후 불변 원칙의 연장이며 규정 근거는 없다(P14-A10).

### 2.4 상태 도출

`state(fundId, ipoId, atSeq)` = `atSeq` 이하의 이벤트를 순서대로 처리한 **유효 상태**: `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`는 `transition()`을 적용하고, `EVENT_ANNULLED`는 그 펀드·IPO의 유효 상태를 `UNKNOWN`으로 되돌린다(없으면 `UNKNOWN`). `atSeq`를 받는 조회(`getStateAt`)가 #10의 컷오프 판정에 필요하다. 상태 전이 규칙 자체(`transition()`)는 변경하지 않는다. `UNKNOWN`으로의 복귀는 `transition()`이 허용하는 전이가 아니라 **정정 이벤트로만** 생긴다(구현: PR #35의 `LedgerProjection`이 이벤트 접기(fold)로 유효 상태를 도출한다). 상태와 별개로 접기는 IPO별 `마감`·`확정` 여부와 전역 `폐기된 키 집합`도 도출한다(§2.3.2, §2.3.3). 이 두 가지는 상태 `state(fundId, ipoId, atSeq)`에 영향을 주지 않는다.

### 2.5 체크포인트와 접수 영수증

- **서명된 체크포인트**: 운영자가 주기적으로(그리고 `IPO_CLOSED`/`IPO_FINALIZED` 직후) `{seq, eventHash}`에 서명해 공개한다. 운용사·감사인이 체인의 되감기(동일 `seq`에 다른 이벤트)를 탐지할 수 있다.
- **접수 영수증**: 시퀀서는 요청을 받는 즉시 `{requestHash, receivedAt, 시퀀서 서명}`을 요청자에게 돌려준다. 마감 직전에 제출했으나 순번이 뒤로 밀렸다는 주장을 증명하는 데 쓴다(검열·지연 분쟁용). 시퀀서가 이 영수증을 허위로 발급하거나 무시하는 것은 막지 못한다(T-06).

---

## 3. 호출자 인증

### 3.1 선택지 비교

| 방식 | 장점 | 단점 / 한계 | 판단 |
| --- | --- | --- | --- |
| API 키/세션 | 구현 단순 | 서명 증거가 없어 운영자가 위조 가능, 온체인 이식 시 의미 없음 | 채택 안 함 |
| **서명된 요청(EIP-712 `LedgerAction`)** | 이벤트에 서명이 남아 감사 가능, 요청을 다른 IPO·펀드에 재사용 못함, #11의 증빙 서명과 같은 방식·같은 라이브러리 | 키 관리 필요(#13), 운영 복잡도 | **제안** |
| 온체인 `msg.sender` | 서명 없이 호출자 인증 | 오프체인 PoC에서는 적용 불가 | #18에서 온체인 이식 시 사용 가능 |

### 3.2 서명 대상: `LedgerAction`

EIP-712 타입(제안, #11 설계 문서와 같은 규약):

```
Domain: { name: "ipo-proof ParticipationLedger", version: "1", chainId, verifyingContract }
LedgerAction {
  string  actorId;        // 운용사 managerId
  string  fundId;         // subjectFundId
  string  ipoId;
  string  targetState;    // "PARTICIPATING" | "NON_PARTICIPATION_LOCKED"
  string  requestNonce;   // actorId 범위에서 고유
  uint256 expiresAt;      // 이 시각(ms) 이후에는 기록 불가
}
```

정정 요청은 같은 도메인에서 별도 `primaryType`을 쓴다(기존 `LedgerAction`의 레이아웃은 바뀌지 않으므로 도메인 `version`은 `"1"` 그대로):

```
LedgerAnnulment {          // 운용사가 서명
  string  actorId;         // 운용사 managerId
  string  fundId;          // 대상 이벤트의 subjectFundId
  string  ipoId;
  uint256 targetSeq;       // 정정할 이벤트 순번
  bytes32 targetEventHash; // 그 이벤트의 eventHash (다른 이벤트로 오인되지 않게)
  string  reason;          // "MISTAKEN_ENTRY" | "KEY_COMPROMISE"
  string  replacementState;// "" (없음) | "PARTICIPATING" | "NON_PARTICIPATION_LOCKED"
  string  requestNonce;
  uint256 expiresAt;
}
AnnulmentApproval {        // 독립된 승인자가 서명 (R10, R14)
  string  approverId;      // actorId와 달라야 하고 운영자와도 달라야 한다 (R14)
  bytes32 annulmentDigest; // 위 LedgerAnnulment의 EIP-712 digest
  string  requestNonce;
  uint256 expiresAt;
}
BidWithdrawal {            // 입찰 취소: 입찰 펀드의 운용사가 서명 (R15, #10 §3.7)
  string  actorId;
  string  fundId;
  string  ipoId;
  string  bidId;
  string  afterState;      // "" (기본: 입찰 이전 상태 UNKNOWN) | "PARTICIPATING" | "NON_PARTICIPATION_LOCKED"
  string  requestNonce;
  uint256 expiresAt;
}
OperatorAction {           // 운영자 이벤트: IPO_CLOSED / IPO_FINALIZED / FINDING_ANNOTATED
  string  actorId;         // 운영자 principalId
  string  action;          // "IPO_CLOSED" | "IPO_FINALIZED" | "FINDING_ANNOTATED"
  string  ipoId;
  bytes32 payloadDigest;   // 아래 정의. payload를 서명에 묶는다
  string  requestNonce;
  uint256 expiresAt;
}
KeyRevocation {            // 키 폐기: 레지스트리 관리자가 서명 (R18). 전역 이벤트라 ipoId 없음
  string  actorId;         // 관리자 principalId
  string  managerId;
  string  revokedKeyId;
  string  requestNonce;
  uint256 expiresAt;
}
```

- **`payloadDigest`**: `sha256(canonicalJson({domain: "ipo-proof/ledger-operator-payload/v1", payload: P}))`의 32바이트이다. `P`는 이벤트 `payload`에서 **시퀀서가 채우는 필드를 뺀 것**이다: `IPO_CLOSED`는 `{closesAt}`(`ledgerSeqAtClose`는 순번에서 정해지므로 제외), `IPO_FINALIZED`와 `FINDING_ANNOTATED`는 `payload` 전체. 초안(`OperatorAction{action, ipoId, requestNonce, expiresAt}`)은 `payload`를 서명에 묶지 못해 같은 서명으로 다른 `finalizationDigest`나 `kind`를 붙일 수 있었기 때문에 이 필드를 추가했다(구현 전이라 코드 충돌은 없음).
- `LedgerAction`, `LedgerAnnulment`, `AnnulmentApproval`, `BidWithdrawal`, `OperatorAction`, `KeyRevocation`은 같은 EIP-712 도메인(`ipo-proof ParticipationLedger`, `version: "1"`)에서 `primaryType`으로만 구분한다. `scheme` 식별자와의 대응은 §2.2.2의 표가 규범이다.

- 도메인 `name`/`version`은 증빙 서명(`ipo-proof CapacityAttestation`)과 **달라야** 한다. 같은 키로 서명한 서로 다른 구조가 서로 대체되지 않도록 한다(EIP-712의 도메인 분리 취지).
- 서명 형식·정규성(65바이트, `v ∈ {27,28}`, low-`s`)은 #11 문서와 같은 규칙을 따른다.
- EIP-712는 **재생 방지를 포함하지 않는다**(표준 본문: "It does not include replay protection."). 재생 방지는 이 원장이 `requestNonce`와 `expiresAt`, 그리고 `fundId`·`ipoId` 바인딩으로 직접 해야 한다.
- 운용사 키 레지스트리: `managerId → 서명 주소 1개`. 증빙 어테스터 레지스트리(PR #24의 `Eip712AttestationVerifier`)와 같은 형태이며 키 회전·폐기·다중 서명은 #13에서 설계한다.

### 3.3 규정과의 연결 (참고)

규정의 표준 증빙(확약서)은 **기관 대표이사 또는 준법감시인이 서명 또는 기명날인**한다 〔S1 · 제5조의3 ② · 2026-10-03〕. 원장 기록을 이 서명권자에 대응시켜야 한다는 규정 요구는 **없다**(규정에 원장 없음, A-026). PoC에서는 운용사 서명 키의 보유자를 운용사가 지정한다고만 둔다. 어떤 직책을 지정해야 하는지는 미확인이며 정하지 않는다.

---

## 4. 인가 모델

### 4.1 역할

| 역할 | 할 수 있는 일 | 할 수 없는 일 |
| --- | --- | --- |
| `FUND_MANAGER` (운용사) | **자기 `managerId`가 레지스트리상 운용사인 펀드**의 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED` 요청, 자기 펀드 이벤트의 **정정 요청**(관리자 공동 서명 필요), 자기 펀드의 하위펀드 중 UNKNOWN 목록 조회 | 타 운용사 펀드 기록·정정, 단독 정정, 마감 처리, 레지스트리 수정 |
| `ATTESTER` | 증빙 발급(#11) | 원장 쓰기 |
| `LEDGER_OPERATOR` (시퀀서) | 순번 부여, `IPO_CLOSED`, `IPO_FINALIZED`, `FINDING_ANNOTATED`, 체크포인트 서명 | 운용사 대신 상태 이벤트를 만드는 것(운용사 서명 없이는 거부), 정정 승인 서명(R14: 승인자와 같은 주체이면 안 됨), 키 폐기 서명(R18) |
| `REGISTRY_ADMIN` | 펀드 레지스트리 변경 (§4.3), 정정 요청에 대한 **승인 서명** — 단, 운용사 서명자 및 원장 운영자와 독립된 주체일 때만 유효(R14), `MANAGER_KEY_REVOKED` 서명(R18, PoC 매핑) | 원장 상태 이벤트 생성, 단독 정정, 운영자 겸직 상태에서의 승인 |
| `AUDITOR` | 읽기 전용 | 쓰기. `FINDING_ANNOTATED`도 직접 쓰지 못하고 운영자에게 전달한다(§2.3.1) |

### 4.2 인가 규칙

| ID | 규칙 | 거부 코드(제안 이름) |
| --- | --- | --- |
| R1 | 서명자의 `actorId`는 레지스트리의 `Fund(subjectFundId).managerId`와 같아야 한다. **대리 기록은 없다**: 상위펀드 운용사도 하위펀드 상태를 기록할 수 없다 | `LEDGER_ACTOR_NOT_FUND_MANAGER` |
| R2 | `actorId`가 운용사 키 레지스트리에 있고 서명이 레지스트리 주소와 일치 | `LEDGER_ACTOR_UNKNOWN`, `LEDGER_SIGNATURE_INVALID` |
| R3 | `expiresAt` > 시퀀서의 현재 시각 | `LEDGER_REQUEST_EXPIRED` |
| R4 | `(actorId, requestNonce)`는 처음 보는 값. 동일한 서명 요청의 재전송은 **원래 결과를 그대로 돌려주고** 새 이벤트를 만들지 않는다(멱등). 같은 nonce에 다른 내용이면 거부 | `LEDGER_NONCE_REPLAY` |
| R5 | `fundId`, `ipoId`가 등록되어 있다 | `FUND_NOT_REGISTERED`, `IPO_NOT_FOUND` (기존 코드 재사용) |
| R6 | 해당 IPO에 `IPO_CLOSED`가 없다. 상태 이벤트와 **정정 이벤트** 모두에 적용 | `IPO_ALREADY_CLOSED` |
| R7 | `transition()`이 허용한다 | 기존 `TransitionRejection` 그대로 |
| R8 | `IPO_CLOSED`는 `LEDGER_OPERATOR` 서명(`OperatorAction`)이어야 하고, 시퀀서 시계가 `closesAt` 이상일 때만, IPO당 한 번만 추가된다. (`IPO_FINALIZED`는 R19, `FINDING_ANNOTATED`는 R17) | `LEDGER_OPERATOR_REQUIRED`, `IPO_NOT_YET_CLOSABLE`, `IPO_ALREADY_CLOSED` |
| R9 | `MANAGER_KEY_REVOKED`(전역 이벤트, R18) 순번 이후에는 **모든 IPO에서** 그 키로 서명된 새 요청 거부. 이미 체인에 있는 이벤트는 바뀌지 않는다 | `LEDGER_SIGNATURE_INVALID` (또는 전용 코드) |
| R10 | 정정 인증·인가: `LedgerAnnulment`는 대상 펀드의 현재 운용사 키로 서명(R1~R4 동일 적용), **그리고** `AnnulmentApproval`이 **독립된 승인자**(R14)의 키로 같은 `annulmentDigest`에 대해 서명되어 있어야 한다. 한쪽만으로는 정정 불가. `coAuthorizations`는 정확히 1건이고 `approverId`를 포함한다. `reason`은 `MISTAKEN_ENTRY`/`KEY_COMPROMISE`뿐이다. (`BID_WITHDRAWN`은 R15의 별도 경로이며 승인자 서명을 받지 않는다. 대상이 `origin = BIND_1`이면 R12가 우선해 거부한다) | `LEDGER_ANNUL_COSIGN_REQUIRED`, `LEDGER_ACTOR_NOT_FUND_MANAGER`, `LEDGER_SIGNATURE_INVALID` |
| R11 | 정정 대상 유효성: `targetSeq`의 이벤트가 **같은 IPO·같은 펀드**의 상태 이벤트(`PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`)이고 `targetEventHash`가 일치하며 아직 정정되지 않았다(현재 유효 상태를 만든 이벤트). 정정 이벤트 자체는 정정할 수 없다. `replacementState`가 있으면 정정 직후 상태(`UNKNOWN`)에서 `transition()`이 허용해야 하고, 하나라도 실패하면 요청 전체를 거부한다(원자성) | `LEDGER_ANNUL_TARGET_INVALID`, 기존 `TransitionRejection` |
| R12 | **BIND-1 기록의 정정 경로(확정)**: `origin = BIND_1`인 상태 이벤트는 `EVENT_ANNULLED(reason = BID_WITHDRAWN)`이고 `payload.bidId`가 그 이벤트의 `bidId`(바인딩 ID, §7)와 **같을 때에만** 정정할 수 있다. 반대로 `reason = BID_WITHDRAWN`은 `origin = BIND_1`인 상태 이벤트에만 쓸 수 있다. 이 규칙은 **원장 이벤트만으로 판정**한다(입찰 저장소를 보지 않는다). 유효한 BIND-1 기록이 있다는 것은 활성 입찰이 있다는 뜻이기 때문이다. 입찰 취소가 기록의 해소와 한 트랜잭션이므로(R15) 활성 입찰이 없는 BIND-1 기록은 생기지 않는다. 그래서 "활성 입찰이 있는 동안"이라는 조건은 별도 검사가 아니라 이 불변식의 다른 표현이다. 판정표는 §4.2.1. 정정 경로로 BIND-1을 우회해 입찰한 펀드를 잠그는 것(#10 E-09)을 막기 위함이다 | `LEDGER_ANNUL_BOUND_TO_BID`, `LEDGER_ANNUL_TARGET_INVALID` |
| R13 | 정정은 `IPO_CLOSED`보다 앞선 순번일 때만 효력이 있다. 같은 규칙의 반대면: 컷오프 이전에 정정된 상태는 확정 판정에 그대로 반영되고, 컷오프 이후의 정정 요청은 R6으로 거부된다 | `IPO_ALREADY_CLOSED` |
| R14 | **정정 승인자의 독립성**: 승인자는 운용사 서명자와 독립된 주체여야 하고, 레지스트리 관리자와 원장 운영자가 같은 주체이면 그 승인은 독립 승인으로 인정하지 않는다. 구체 검사(I1~I4, §4.5): ① `approverId ≠ actorId` ② 두 서명에서 복구한 주소가 서로 다르고 승인자 주소는 운용사·운영자 주소와도 다르다 ③ 신고된 `controllerId`가 운용사와 다르다 ④ 승인자 주체가 원장 운영자 주체와 같지 않다. **동일 주체 서명은 거부**한다. 설정이 ④를 만족하지 못하면(겸직) 정정 기능은 비활성(fail closed) | `LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT`, `LEDGER_ANNUL_DISABLED` |
| R15 | **입찰 취소 경로**(#10 §3.7): `BidWithdrawal`은 입찰 펀드의 현재 운용사 키로 서명(R1~R4 동일 적용)하고, `bidId`는 그 펀드·IPO의 **활성** 입찰이어야 하며(`BID_NOT_FOUND`, `BID_ALREADY_WITHDRAWN`), 마감 전이어야 한다(R6). 입찰이 BIND-1로 만든 `PARTICIPATING`(`origin = BIND_1`, `payload.bidId` = 바인딩 ID)이 유효 상태이면 `EVENT_ANNULLED(reason = BID_WITHDRAWN, bidId)`를 **운용사 서명만으로, 승인자 없이** 원자적으로 추가한다(입찰 이전 상태로 되돌릴 뿐 새 권한이 아니므로 R10·R14의 대상이 아님). `afterState`가 있으면 이어서 재기록한다. 유효 상태가 `origin = INDEPENDENT`이거나 바인딩이 없으면 원장 이벤트는 없다(입찰 저장소만 변경. 원장에 `BID_WITHDRAWN`을 직접 넣으려 하면 R12에 따라 `LEDGER_ANNUL_TARGET_INVALID`). 재제출로 대체된 입찰은 바인딩을 유지하고, 마지막 활성 입찰이 취소될 때에만 해소한다. 서명 대상 `BidWithdrawal.bidId`는 **현재 활성 입찰의 ID**이고 이벤트의 `payload.bidId`는 **바인딩 ID**(최초 BIND-1 기록을 만든 입찰의 ID, §7)이다. 접수 계층이 둘의 대응을 확인한다 | `LEDGER_ACTOR_NOT_FUND_MANAGER`, `IPO_ALREADY_CLOSED`, `BID_NOT_FOUND`, `BID_ALREADY_WITHDRAWN` |
| R16 | **서명 스킴 식별자**: `authorization.scheme`과 `coAuthorizations[].scheme`은 §2.2.2 표에서 이벤트 유형·`reason`·위치에 대응하는 값과 정확히 같아야 한다. 검증기는 `scheme`이 아니라 이벤트 유형·`reason`으로 `primaryType`을 정한다. 구조 검사이므로 서명 검증보다 먼저 한다 | `LEDGER_SCHEME_MISMATCH` |
| R17 | **`FINDING_ANNOTATED`**(§2.3.1): 운영자 서명(`OperatorAction`). `subjectFundId = null`, 공동 서명 없음. `payload`는 `{targetSeq, targetEventHash, kind, evidenceDigest}`뿐이고 `kind`는 닫힌 목록. `targetSeq`는 이 이벤트의 `seq`보다 작은 같은 IPO의 이벤트이고 `targetEventHash`가 일치하며 대상이 `FINDING_ANNOTATED`가 아니다. 마감 전후 모두 가능, 상태에 영향 없음 | `LEDGER_OPERATOR_REQUIRED`, `LEDGER_FINDING_TARGET_INVALID`, `EVENT_MALFORMED` |
| R18 | **`MANAGER_KEY_REVOKED`**(§2.3.2): 레지스트리 관리자 서명(`KeyRevocation`). `ipoId = null`, `subjectFundId = null`, 공동 서명 없음. `managerId`/`revokedKeyId`가 키 레지스트리에 있고 그 키가 아직 폐기되지 않았어야 한다. 효과는 R9 | `LEDGER_REGISTRY_ADMIN_REQUIRED`, `LEDGER_ACTOR_UNKNOWN`, `LEDGER_KEY_ALREADY_REVOKED` |
| R19 | **`IPO_FINALIZED`**(§2.3.3): 운영자 서명(`OperatorAction`). 같은 `ipoId`의 `IPO_CLOSED`가 선행해야 하고, `ledgerSeqAtClose`/`ledgerHeadHashAtClose`가 그 `IPO_CLOSED`와 일치해야 하며, IPO당 1회만 | `LEDGER_OPERATOR_REQUIRED`, `IPO_NOT_CLOSED`, `LEDGER_FINALIZATION_CUTOFF_MISMATCH`, `IPO_ALREADY_FINALIZED` |

판정 순서는 거부 사유가 정보 노출이 되지 않도록 구조(봉투·payload 형식, R16의 `scheme`) → 인증(R2, R3, R4, R10의 서명 검증) → 인가(R1, R10의 승인자 권한, R14 독립성, R17~R19의 서명자 역할) → 도메인(R5~R7, R11~R13, R15, R17~R19의 대상·선행 조건)순을 제안한다. 서명이 유효하지 않은 호출자에게 펀드 등록 여부를 알려주지 않기 위해서다.

### 4.2.1 BIND-1 기록의 정정 판정표 (R10 / R12 / R15)

R11(대상 유효성: 같은 IPO·펀드, `targetEventHash` 일치, 현재 유효 상태를 만든 이벤트, 미정정)을 먼저 만족해야 하고, 위반하면 아래 표보다 `LEDGER_ANNUL_TARGET_INVALID`가 우선한다. 그 뒤 대상의 `origin`과 요청의 `reason`을 본다.

| 대상 이벤트 | 요청 `reason` | `payload.bidId` | `coAuthorizations` | 결과 |
| --- | --- | --- | --- | --- |
| `origin = BIND_1`, `bidId = b1` | `BID_WITHDRAWN` | `b1` | 0건 | 허용 (R15). 승인자 없이 운용사 서명만 |
| `origin = BIND_1`, `bidId = b1` | `BID_WITHDRAWN` | `b1`이 아님 | 0건 | `LEDGER_ANNUL_TARGET_INVALID` |
| `origin = BIND_1` | `MISTAKEN_ENTRY` / `KEY_COMPROMISE` (독립 승인자 포함) | 없음 | 1건 | `LEDGER_ANNUL_BOUND_TO_BID` (R12) |
| `origin = INDEPENDENT` (PARTICIPATING 또는 LOCKED) | `BID_WITHDRAWN` | 무엇이든 | 0건 | `LEDGER_ANNUL_TARGET_INVALID` (R12: 취소는 BIND-1에만) |
| `origin = INDEPENDENT` | `MISTAKEN_ENTRY` / `KEY_COMPROMISE` | 없음 | 1건 | 허용 (R10, R14를 통과할 때) |
| 무엇이든 | `BID_WITHDRAWN` | – | 1건 이상 | `EVENT_MALFORMED` (취소는 공동 서명을 받지 않음) |
| 무엇이든 | `MISTAKEN_ENTRY` / `KEY_COMPROMISE` | – | 0건 또는 2건 이상 | `EVENT_MALFORMED` (원장 파서). 접수 계층은 사용자에게 `LEDGER_ANNUL_COSIGN_REQUIRED`로 돌려줄 수 있다 |

LOCKED 이벤트의 `origin`은 항상 `INDEPENDENT`이므로(§2.3) LOCKED 대상은 표의 `INDEPENDENT` 행만 해당한다.

**한계 (T-22, Q14-N8).** R12는 `origin = BIND_1`만 보호한다. 펀드가 먼저 독립 `requestParticipation`으로 `PARTICIPATING`(`INDEPENDENT`)을 기록한 뒤 입찰하면 BIND-1은 상태 전이가 없어 원장 이벤트를 만들지 않으므로(UNKNOWN → PARTICIPATING만 가능) 이 입찰에는 BIND_1 기록이 없다. 이 상태에서 R10 정정(독립 승인자 포함)과 `replacement = LOCKED`로 입찰한 펀드를 잠글 수 있다. 순수 원장 규칙(R12)으로는 막지 못하므로 접수 계층의 가드(활성 입찰이 있는 `(펀드, IPO)`의 R10 정정 요청 거부, `LEDGER_ANNUL_BOUND_TO_BID` 재사용)를 기본 제안으로 두되 진영 님 확인 전까지 규칙으로 확정하지 않는다.

### 4.3 레지스트리 신뢰와 고정

R1은 레지스트리가 운용사–펀드 관계의 진실이라는 가정에 기댄다. 이 가정은 ARCHITECTURE에서도 "assumption, not enforced"로 적혀 있다. 이 문서의 제안:

- 레지스트리 변경도 **append-only 로그**(같은 봉투 형식, `REGISTRY_ADMIN` 서명)로 두고, 원장 이벤트가 인가 시 사용한 `registrySeq`를 기록한다. 사후에 "그 시점의 관계"를 재현할 수 있다.
- **`managerId` 변경은 해당 펀드가 연관된 IPO의 입찰 창이 열려 있는 동안 금지**(`REGISTRY_FROZEN_DURING_WINDOW`). 그렇지 않으면 공격자가 레지스트리를 바꾼 뒤 정당한 운용사로 행세해 기록할 수 있다.
- `underlyingFundIds` 변경은 창이 열려 있는 동안에도 허용하되 판정은 컷오프 시점의 값을 쓴다(이슈 #10 설계 E-10). 변경이 기록에 남는 것으로 충분하다고 본다.
- 레지스트리 관리자 자체가 악의적인 경우는 이 모델의 신뢰 범위 밖이다(T-04).

### 4.4 키 침해 대응 (최소)

- `MANAGER_KEY_REVOKED`(전역 이벤트, R18) 순번 **이후** 모든 IPO에서 그 키의 새 요청을 거부한다. 폐기 이벤트 자체는 이전 이벤트의 상태를 되돌리지 않는다. 서명자는 레지스트리 관리자이며 운용사 자신이 아니다(Q14-N9).
- 침해 시점과 폐기 시점 사이의 잘못된 기록은 **마감 전이면** `EVENT_ANNULLED`(reason = `KEY_COMPROMISE`)로 정정할 수 있다(D14-Q1 결정). 순서는 ① 키 폐기(`MANAGER_KEY_REVOKED`), ② 새 키 등록(#13), ③ 새 키로 `LedgerAnnulment` 서명 + 레지스트리 관리자 승인, ④ 필요하면 `replacement`로 올바른 상태 재기록. 폐기 전에 침해 키로 정정 요청이 올 수 있으나 관리자 승인이 없으면 거부된다(R10).
- **마감 후**의 잘못된 기록은 정정할 수 없다. 사후 발견은 `FINDING_ANNOTATED` 주석으로만 남는다(§5).

### 4.5 정정 승인자의 독립성 (R14)

결정(2026-10-03, 진영 님): 정정 승인자가 운용사 서명자와 같은 사람·주체이면 안 된다. 레지스트리 관리자와 원장 운영자가 같은 주체인 경우에도 독립 승인으로 인정하지 않는다. 동일 주체 서명은 거부한다.

**등록 정보.** 서명 주체(principal)마다 `principalId`, 서명 주소, 신고된 `controllerId`(그 키를 실제로 통제하는 주체의 라벨)를 레지스트리에 둔다. `controllerId`는 **자기 신고 값**이며 시스템이 진위를 검증하지 못한다(P14-A06, Q14-N6).

| 검사 | 내용 | 막는 것 | 못 막는 것 |
| --- | --- | --- | --- |
| I1 식별자 | `approverId ≠ actorId` | 같은 ID로 두 서명 | 다른 ID를 같은 사람이 보유 |
| I2 서명 키 | 두 서명에서 복구한 주소가 다르고, 한 주소를 둘 이상의 principal에 등록하는 것을 거부(`PRINCIPAL_KEY_REUSE`). 승인자 주소는 운용사·운영자 주소와도 달라야 함 | 같은 키로 두 번 서명, 키 재사용 | 한 사람이 서로 다른 키를 여러 개 보유 |
| I3 통제 주체 | 승인자 `controllerId` ≠ 운용사 `controllerId` | 신고가 같은 경우 | 허위 신고 |
| I4 운영자 분리 | 승인자 principal ≠ 원장 운영자 principal (주소와 `controllerId` 모두). 레지스트리 관리자와 운영자가 같은 주체이면 승인을 인정하지 않음 | 운영자가 승인자를 겸직 | 운영자 측의 우회 설정(설정 신뢰) |
| I5 설정 시점 | 설정이 I2~I4를 만족하지 못하면 정정 기능을 끈다(`LEDGER_ANNUL_DISABLED`). 다른 기능(기록·마감·입찰 취소)은 정상 | 독립 승인자 없이 정정이 켜지는 것 | – |

**동일 주체 서명 거부의 의미**: I1~I4 중 하나라도 위반하면 그 정정 요청은 `LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT`로 거부되고 원장은 변하지 않는다. 시스템이 보증하는 것은 **등록된 식별자·키·신고 라벨의 상이함**까지이다.

---

## 5. 마감 확정과의 연결

- `IPO_CLOSED`(R8)가 컷오프다. `ledgerSeqAtClose = 이벤트 seq - 1`. 이후 해당 IPO에 대한 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`/`EVENT_ANNULLED`는 R6으로 거부된다 → 마감 후 UNKNOWN은 영구 UNKNOWN(이슈 #10 설계 F2). 컷오프 **이전**에 정정된 상태는 확정 판정에 정정이 반영된 유효 상태로 쓰인다(R13).
- `IPO_CLOSED`는 "시퀀서 시계 ≥ `closesAt`"에서만 추가될 수 있으나, 이 조건을 **제3자가 사후 검증할 수단은 약하다**(시퀀서 시계를 신뢰해야 함). 이것을 신뢰 가정 TA-1(= P14-A03)로 명시한다. 완화: 체크포인트와 접수 영수증, 그리고 온체인 이식 시 `block.timestamp` 기반 검사로 대체(#18). Solidity의 `block.timestamp`는 **초 단위**이며 현재 도메인 모델의 시각은 밀리초이므로 이식 시 단위 변환이 필요하다 〔Solidity docs · Units and Globally Available Variables · 2026-10-03〕.
- `IPO_FINALIZED`는 #10의 확정 레코드 다이제스트를 원장에 못박아, 확정 후 레코드가 바뀌면 탐지된다. **`IPO_CLOSED`가 선행해야 하고**, 컷오프 필드(`ledgerSeqAtClose`, `ledgerHeadHashAtClose`)가 `IPO_CLOSED`와 일치해야 하며, **IPO당 1회**만 기록된다(R19, §2.3.3). 확정 입력이 컷오프에 동결된다는 점은 #10의 F3(확정은 동결 입력만의 순수 함수)이 보증하고, 원장은 그 시점·일치·1회만 강제한다. 이 이벤트 이후에도 `FINDING_ANNOTATED`는 허용된다(상태에 영향 없음).
- 마감 후 증빙 폐기 등 사후 발견은 상태를 바꾸지 않고 주석으로만 남긴다(이슈 #10 설계 F5).

### 5.1 정정이 다른 규칙과 만나는 지점

| 상대 | 상호작용 | 근거 |
| --- | --- | --- |
| UNKNOWN 거부(#10) | 정정으로 하위펀드가 `UNKNOWN`으로 돌아가면 그 하위펀드를 보유한 상위펀드의 잠정 판정은 거부로 바뀐다. 마감까지 재기록이 없으면 확정도 거부(UNKNOWN-FINAL). 정정+재기록 원자 처리(R11)로 중간 `UNKNOWN` 구간을 없앨 수 있다 | #10 E-16, E-18, S-22, S-24 |
| `LOCKED` 면제 | 허위 `LOCKED`를 마감 전에 정정하면 상위펀드의 면제가 사라져 용량이 줄어든다(원래 값으로 복귀). 마감 후에는 정정할 수 없다 | §6.1, #10 E-08 |
| BIND-1 | R12: 입찰 접수로 기록된 `PARTICIPATING`은 R10 정정(운용사 + 승인자)으로 되돌릴 수 없다. **입찰 취소(R15)** 만이 그 기록을 해소하며, 해소 후 상태는 입찰 이전인 `UNKNOWN`(또는 `afterState`) | #10 E-19, E-21, S-25, S-28 |
| 확정 규칙(#10) | 확정 판정은 컷오프까지의 유효 상태의 함수이다. 정정이 있어도 같은 컷오프면 같은 결과(결정성). 마감 전에는 `결정된 판정 → 다른 결정된 판정`이 가능해졌고(단조성 약화), 마감 후에는 불변 | #10 §3.4, S-23, S-27 |
| 입찰 취소(R15) | 입찰 펀드의 `PARTICIPATING`(`origin = BIND_1`)이 `UNKNOWN`으로 돌아가므로 그 펀드를 보유한 상위펀드의 잠정 판정이 UNKNOWN 거부로 바뀔 수 있다(승인자의 속도 제한 없음, T-17). `afterState`로 원자 재기록하면 중간 UNKNOWN이 없다. `origin = INDEPENDENT`인 상태는 취소가 건드리지 않는다. 마감 후 취소는 `IPO_ALREADY_CLOSED` | #10 E-25, S-32 |
| 정정 승인자 독립성(R14) | 정정은 독립 승인자가 있어야만 가능하므로 승인자 구성이 불가능한 배치에서는 마감 전 오기록도 정정할 수 없다(fail closed, §6.4.1) | §4.5 |
| 독립 `requestParticipation`(D14-Q2) | 유지. 자기 펀드의 `PARTICIPATING` 선점(T-11)은 여전히 정당한 권한이고, 마감 전에는 운용사가 관리자 승인을 받아 정정할 수 있다 | §7 |
| 입찰 접수 순서 | 정정 요청도 `IPO_CLOSED`와의 순번 경합 대상이다(T-13). 접수 영수증(§2.5)이 정정 요청에도 발급된다 | §6.2 |

---

## 6. 위협 분석: 허위 LOCKED 선점과 인접 공격

### 6.1 영향 정리 (왜 심각한가)

상태기계는 되돌림을 금지한다. 정정 이벤트(마감 전 한정)가 없다면 첫 잘못된 기록은 영구하고, 정정이 있어도 **마감 후**의 잘못된 기록은 영구하다. 소비하는 쪽은 두 곳이다.

| 허위 기록 | 피해 펀드 `U` 자신 | `U`를 보유한 상위펀드 `P` |
| --- | --- | --- |
| 허위 `NON_PARTICIPATION_LOCKED` | 이 IPO 참여 불가 — `verifyBid`가 `NON_PARTICIPATION_LOCK_ACTIVE`로 거부(`verify.ts` 3단계). **마감 전**에는 공동 서명된 정정으로 되돌릴 수 있고(R10), **마감 후**에는 되돌릴 수 없음 | `U`의 노출이 **면제**되어 `P`의 조정 용량이 부풀려짐. `U`가 실제로는 참여하고 `P`와 공모하면 용량 부풀리기가 됨 |
| 허위 `PARTICIPATING` | 정정 없이는 이후 `NON_PARTICIPATION_LOCKED`를 기록할 수 없음(비참여 주장 불가). 마감 전에는 정정 후 재기록 가능 | `U`의 노출이 **차감**되어 `P`의 용량이 줄어듦(`P`에 대한 서비스 방해). 이슈 #10 설계의 E-07 |

### 6.2 공격 표

현재 코드에서는 T-01, T-02가 실제로 가능하다(T-12~T-15는 정정 도입 후 새로 생기는 공격면이다). "이 설계의 통제" 열은 이 문서의 설계가 적용된 뒤 상태다. (테스트 ID는 §8의 L-xx.)

| ID | 공격자 / 행동 | 현재 코드 | 이 설계의 통제 | 잔여 위험 |
| --- | --- | --- | --- | --- |
| T-01 | 인증 없는 호출자가 임의 펀드를 LOCKED/PARTICIPATING으로 만듦 | **가능** (호출자 개념 없음) | R1, R2: 서명과 `managerId` 대조 | – |
| T-02 | 인증된 **타 운용사**가 경쟁사 펀드를 선점 잠금(허위 LOCKED로 경쟁사 참여 봉쇄) | **가능** | R1: 서명자 ≠ 레지스트리 운용사이면 거부 (L-02) | 레지스트리가 틀리면 무력(T-04) |
| T-03 | 서명 요청 재사용(다른 IPO·펀드·시점) | – | 서명 대상에 `fundId`, `ipoId`, `targetState`, `requestNonce`, `expiresAt`, 도메인 분리 (L-03~L-08) | – |
| T-04 | 레지스트리의 `managerId`를 바꾼 뒤 정당한 운용사로 행세 | 레지스트리 독립성은 가정 | 입찰 창 중 `managerId` 변경 금지(§4.3), 레지스트리 변경 로그 | **레지스트리 관리자 자체가 악의적이면 막지 못함.** 독립성은 여전히 가정 |
| T-05 | 운용사 서명 키가 탈취되어 공격자가 그 운용사 펀드를 임의로 기록 | – | 폐기 후 새 요청 차단(R9). **마감 전**이면 폐기·새 키·관리자 승인으로 정정(R10, §4.4) | 마감 전: 정정까지의 시간 동안 판정이 흔들림. **마감 후** 기록은 영구(주석만). 탈취된 키로 정정 요청을 해도 관리자 승인이 필요 |
| T-06 | 시퀀서가 마감 직전 정당한 이벤트를 지연·검열하거나 순서를 바꿈 | 시퀀서 개념 없음 | 접수 영수증, 서명된 체크포인트, 해시 체인 | **시퀀서를 신뢰해야 함(TA-1).** 영수증으로 사후 분쟁 증거를 남길 뿐 강제하지 못함. 온체인에서는 블록 순서로 대체 |
| T-07 | 같은 운용사가 상·하위펀드를 모두 운용하며 자기편 상태를 유리하게 기록 | – | 없음(구조상 정당한 권한) | 이 모델의 신뢰 범위 밖. 레지스트리 `managerId` 동일 여부를 공개 데이터로 표시하는 정도만 가능 |
| T-08 | 운용사 담당자의 **오기록**(실수로 LOCKED) | – | 요청 전 `dry-run` 검증, 확인 단계(UI, #17). **마감 전**이면 정정(R10, `MISTAKEN_ENTRY`) | 마감 후에는 되돌림 불가. 정정에 관리자 협조가 필요(운영 비용) |
| T-09 | 거부 요청 대량 전송(스팸) | – | 거부는 체인에 안 들어감. 속도 제한은 구현 몫 | 가용성은 서비스 계층 이슈 |
| T-10 | 서명 요청을 가로채 먼저 제출(프런트러닝) | – | 같은 서명은 같은 효과(R4 멱등), 서명자 아닌 자가 내용을 바꿀 수 없음. EIP-712가 권장하는 "먼저 제출되어도 의도한 효과가 같음" 성질 (EIP-712 Frontrunning attacks 절) | – |
| T-11 | 사전 선점: IPO 등록 직후 자기 모든 펀드를 `PARTICIPATING`으로 일괄 기록해 경쟁사 상위펀드의 용량 축소 | – | R1은 막지 못함(자기 펀드 기록은 정당). D14-Q2 결정으로 독립 참여 선언을 **유지**하므로 이 경로는 열려 있다 | **잔여 위험(수용)**. 마감 전에는 같은 운용사가 관리자 승인으로 정정할 수 있으나 경쟁사에게 보장되는 것은 아님 |
| T-12 | 정정 승인자가 운용사와 같은 주체·같은 키이거나, 승인자가 운영자를 겸하는 상태에서 정정을 사용 | – | R14: 식별자·키·`controllerId`·운영자 분리 검사로 **거부**(I1~I4), 겸직이면 정정 기능 비활성(I5). 정정은 체인에 남고 마감 후 불가(R6) | **서로 다른 키·허위 `controllerId`로 같은 사람이 두 역할을 하는 경우(T-16)와 운용사–승인자의 실제 공모는 막지 못함** |
| T-13 | 정정과 `IPO_CLOSED`의 경합: 정정만 하고 재기록 전에 마감되거나, 시퀀서가 정정/재기록 순번을 `IPO_CLOSED` 뒤로 밀어 영구 UNKNOWN을 만듦 | – | 정정+재기록 원자 처리(R11), 접수 영수증, 체크포인트 | 시퀀서의 순서 조작은 막지 못함(TA-1, §6.4) |
| T-14 | 정정으로 BIND-1을 우회해 입찰 후 자기 펀드를 잠금(#10 E-09) | – | R12: 입찰 접수로 기록된 `PARTICIPATING`은 R10 정정 대상이 아님. 해소는 입찰 취소(R15)뿐이고 취소 후 잠금은 UNKNOWN → LOCKED 일반 전이 | 취소 후 잠금은 정당한 경로(우회가 아님). 허위 LOCKED 위험은 E-08과 같음 |
| T-15 | 마감 직전 반복 정정으로 상위펀드의 판정을 흔듦(예측 불가, 가용성) | – | 각 정정에 **독립 승인자** 서명이 필요하므로 속도 제한 역할. 모든 정정이 체인과 UNKNOWN 가시성 조회에 남음 | 승인자가 공모하거나 승인 비용이 낮으면 제한이 없음. 횟수·시간 상한은 두지 않음(Q14-N2) |
| T-16 | 독립성 요건 우회: 한 주체가 서로 다른 ID·키·`controllerId`로 운용사와 승인자를 겸함, 또는 최초 설정(genesis)·principal 레지스트리를 오염 | – | I1~I5는 식별자·키·신고 라벨의 상이함만 확인. 키 재사용 거부(`PRINCIPAL_KEY_REUSE`) | **막지 못함.** 실제 독립성은 운영 규약과 외부 신원 확인에 의존(Q14-N6). 최초 설정은 신뢰 지점 |
| T-17 | 입찰-취소 반복(또는 마감 직전 취소)으로 상위펀드를 UNKNOWN 상태로 흔듦 | – | `afterState` 원자 재기록, UNKNOWN 가시성 조회, 모든 취소가 체인에 남음 | 취소(R15)는 운용사 **단독 서명**이라 승인자 속도 제한이 없고 반복 상한도 두지 않음(Q14-N2, #10 Q10-N5). 잔여 위험 |
| T-18 | 키 폐기 남용·지연: 레지스트리 관리자(또는 탈취된 관리자 키)가 타 운용사 키를 `MANAGER_KEY_REVOKED`로 폐기해 그 운용사의 모든 IPO 요청을 막음(가용성). 반대로 폐기가 늦으면 침해 키 창이 길어짐 | – | 폐기는 관리자 서명만 가능(R18), 전역 이벤트 하나가 체인에 남고 가시적, 폐기 후 새 키 등록·정정 절차(§4.4) | **관리자 신뢰(T-04).** 운용사 자기 폐기 경로 없음(Q14-N9). 폐기 시점은 운영 절차에 의존. 키 관리·쿼럼은 #13 |
| T-19 | `FINDING_ANNOTATED` 남용: 체인에 개인정보·금액을 영구 기록, 허위·악의적 주석, 운영자의 주석 누락(검열) | – | 자유 서술 불허(닫힌 `kind` + `evidenceDigest`), 상태에 영향 없음, 운영자 서명만 가능(R17) | 증빙 다이제스트의 저엔트로피 추측(`evidenceNonce`는 운영 규약), 운영자가 주석을 달지 않거나 허위 주석을 다는 것은 막지 못함(TA-1) |
| T-20 | `IPO_FINALIZED` 위조·중복: 마감 전 확정 기록, 다른 컷오프로 계산한 다이제스트, 재확정으로 덮어쓰기 | – | `IPO_NOT_CLOSED`, `LEDGER_FINALIZATION_CUTOFF_MISMATCH`, `IPO_ALREADY_FINALIZED`(R19), 체크포인트(§2.5) | 원장은 `finalizationDigest`의 내용을 검증하지 못함. 운영자가 틀린 다이제스트를 1회 기록하면 정정 경로가 없다(주석만). 운영자 키 탈취 |
| T-21 | `scheme` 라벨 변조·교차 해석: 라벨을 바꿔 다른 구조(예: `LedgerAction` ↔ `BidWithdrawal`)의 서명을 재해석하게 함, 모르는 라벨 삽입 | – | R16 정확 일치, 라벨이 아니라 이벤트 유형으로 `primaryType` 선택, EIP-712 `primaryType` 분리 | 서명 검증 구현의 정확성(서명 검증 PR에서 검증할 것) |
| T-22 | 독립 선언 `PARTICIPATING` + 활성 입찰 상태에서 R10 정정 + `replacement = LOCKED`로 BIND-1 우회(#10 E-09의 변형) | – | 정정에 독립 승인자 필요(R14), 모든 정정이 체인에 남음. 접수 계층 가드는 기본 제안(Q14-N8) | **가드를 확정하기 전에는 열려 있음.** R12는 `origin = BIND_1`만 보호 |
| T-23 | 구현 간 직렬화 차이로 같은 이벤트가 다른 `eventHash`를 가짐(체인 검증 오탐, 분쟁) | – | §2.2.1의 바이트 수준 정의(정수만, 소문자 hex, 정규화 없음, 키 정렬), 참조 벡터(L-48) | 온체인 이식(#18) 시 재정의. RFC 8785와의 동일성은 미확인 |

### 6.3 정리

허위 `NON_PARTICIPATION_LOCKED`의 두 갈래(경쟁사 봉쇄 / 용량 부풀리기) 중 **예방으로 직접 통제되는 것은 호출자가 타 운용사일 때(T-01, T-02)뿐**이다. 해당 운용사가 스스로(또는 키 탈취로) 거짓 LOCKED를 기록하는 경우는 원장만으로는 막지 못한다.

D14-Q1 결정으로 달라진 점: ① **마감 전**에는 허위 LOCKED/PARTICIPATING을 운용사+독립 승인자 공동 서명으로 **되돌릴 수 있게** 되었다(예방이 아니라 사후 복구). ② 대가로 마감 전 판정이 흔들릴 수 있고(T-13, T-15) 정정 공동 서명자라는 새 신뢰 지점이 생겼다(T-12). ③ **마감 후**에는 이전과 같이 되돌릴 수 없다. 규정은 소명 후 실제 참여한 경우의 효과를 정하지 않았으므로(A-028) 이 PoC도 마감 후 사후 정정 효과를 모델링하지 않는다.

### 6.4 단일 원장 운영자 선택의 한계와 잔여 위험 (D14-Q3/Q4)

**선택**: 진영 님이 임의 판단을 위임했고, PoC에서는 **단일 원장 운영자(시퀀서)가 순번과 시간 기준을 정한다**(P14-A03). 이것은 **규정이 요구하는 것이 아니라 PoC 단순화 선택**이다(규정에 원장·시퀀서 개념이 없다, A-026). 시간 권위는 시퀀서 시계이고 외부 시간 증명은 쓰지 않는다. 온체인 이식 시의 대체(블록 순서, `block.timestamp`)는 #18에서 정한다.

| 한계 / 잔여 위험 | 내용 | 이 설계로 막히는가 |
| --- | --- | --- |
| 운영자 신뢰 | 순번 부여, 요청 접수·검열, `IPO_CLOSED` 시점을 운영자가 정한다. 정직하다고 가정한다(TA-1) | 아니오 (가정) |
| 순서 조작 | 마감 직전 이벤트(정정 포함)를 뒤로 밀어 UNKNOWN-FINAL을 만들거나 면제를 앞당길 수 있다. 접수 영수증·서명된 체크포인트·해시 체인은 사후 분쟁 증거일 뿐 강제하지 못한다(T-06, T-13) | 부분(탐지 한정) |
| 시간 조작 | 시퀀서 시계가 요청 만료(R3), `IPO_CLOSED` 허용 시점(R8), `recordedAt`을 정한다. `requestedAt`은 신뢰하지 않지만 시퀀서 시계를 제3자가 검증할 수는 없다. #10의 `submittedAt`/참여일 D 판정도 같은 시계에 의존한다 | 아니오 |
| `IPO_CLOSED` 지연으로 창 연장 | R8은 시계가 `closesAt` 이상일 때에만 `IPO_CLOSED`를 허용하지만, **그 이후에도 `IPO_CLOSED`가 추가되기 전까지의 상태·정정 이벤트는 거부 규칙이 없어** 컷오프 앞에 들어간다. 운영자가 `IPO_CLOSED` 추가를 미루면 창이 사실상 길어진다. 완화안(시퀀서 시계 ≥ `closesAt`이면 상태·정정 이벤트 거부)은 #10의 F1(순번 기준)·S-06과 충돌하므로 채택하지 않고 열린 질문으로 둔다(Q14-N3) | 아니오 |
| 운영자 키 탈취 | 탈취한 키로 `IPO_CLOSED`/`IPO_FINALIZED`/체크포인트를 위조하거나 순번을 임의 부여할 수 있다. 외부에 보관된 체크포인트가 없으면 이력 되감기도 탐지하기 어렵다. 키 관리는 #13 | 아니오 |
| 운영자와 승인자의 겹침 | 레지스트리 관리자(정정 승인자)와 원장 운영자가 같은 주체이면 독립 승인으로 인정하지 않는다(R14, I4). 겹치면 정정 기능을 끄므로(fail closed) 겹침 자체가 부정 정정으로 이어지지는 않지만, 마감 전 오기록을 되돌릴 수 없게 된다 | 예 (검사 범위: 식별자·키·신고 라벨) |
| 단일 장애점 | 운영자가 멈추면 기록·정정·마감·확정이 모두 멈춘다 | 아니오 |

이 표의 항목은 완화책으로 해결됐다고 주장하지 않는다. 다수 운영자·합의 기반 구조는 이 문서의 범위 밖이다.

### 6.4.1 독립 주체 요건과 단일 운영자 한계의 공존

**충돌 지점.** D14-Q3는 원장 운영자를 **한 주체**로 두기로 했다. 정정 승인(R14)은 **운용사·운영자와 독립된 별도 주체**를 요구한다. 두 결정은 운영자를 늘리지 않고도 양립한다: 순번·시간·`IPO_CLOSED`는 계속 단일 운영자가 정하고, 독립성은 **정정 승인이라는 별도 역할**에만 요구한다. 그러나 PoC에서는 레지스트리 관리자와 운영자를 한 주체가 겸하기 쉬워서, 겸하면 R14가 정정을 막는다.

**PoC에서 독립 주체를 확보하는 방법**

| 수단 | 내용 | 시스템이 확인하는가 |
| --- | --- | --- |
| 별도 역할·별도 서명 키 | 정정 승인 전용 키를 두고(`AnnulmentApproval`), 운용사·운영자 키와 주소를 겹치지 않게 등록 | 예 (I2, `PRINCIPAL_KEY_REUSE`) |
| 별도 `controllerId` 신고 | 승인자·운용사·운영자의 통제 주체 라벨을 서로 다르게 신고 | 신고값의 상이함만 확인(I3, I4). 진위는 확인 못 함 |
| 별도 보관·별도 담당자 | 키를 서로 다른 호스트·HSM·담당자가 보관 | 아니오 (운영 규약) |
| 확보 불가 시 | 정정 기능을 끈다(fail closed, I5). 마감 전 오기록·키 탈취 후 복구가 불가능해지고, 이는 정정 도입 이전의 동작과 같다 | 예 |

**테스트 환경**에서는 합성 키 3종(운용사, 승인자, 운영자)으로 규칙의 동작을 검증한다. 이는 규칙이 작동함을 보이는 것이지 실제 독립성의 증명이 아니다.

**남는 한계**
- 한 사람이 여러 키와 서로 다른 `controllerId`를 가질 수 있다(T-16). 시스템은 막지 못한다.
- 운용사와 승인자의 실제 공모는 막지 못한다(T-12).
- 최초 설정과 principal 레지스트리 변경의 신뢰: 이를 바꿀 수 있는 주체가 독립성 검사를 무력화할 수 있다.
- 운영자와 **운용사**의 독립(운영자가 운용사를 겸하는 경우, 같은 그룹 계열)은 이번 결정 범위 밖이며 검사하지 않는다(Q14-N5).
- 입찰 취소(R15)는 승인자가 필요 없으므로 독립 요건의 대상이 아니다. 대신 속도 제한이 없다(T-17).

---

## 7. 입찰 접수와 원장의 결합 (BIND-1)

ROADMAP의 미결정 항목 "`verifyBid` 통과가 참여 기록을 구속하지 않는 점(검증 후 LOCKED 전환 가능)"에 대한 제안.

- **BIND-1**: 입찰 접수가 확정적으로 받아들여지는 순간(잠정 판정 `ELIGIBLE`)에 시스템이 **입찰 펀드의 `PARTICIPATING`을 원자적으로 기록**한다. 입찰 접수와 기록은 한 트랜잭션이다. 접수가 거부되면 기록하지 않는다.
- 효과: ① 입찰 후 자기 펀드 LOCKED 전환이 불가능(`PARTICIPATION_ALREADY_RECORDED`). 단 **입찰을 마감 전에 취소하면**(R15) 유효 상태가 입찰 이전인 `UNKNOWN`으로 돌아가고 그 뒤에는 일반 전이로 잠글 수 있다. ② 상위펀드는 하위펀드가 입찰한 사실을 `PARTICIPATING`으로 보게 된다(차감).
- 한계: 이벤트 서명은 운용사 서명이어야 하므로, BIND-1의 기록은 **입찰 요청에 `LedgerAction` 서명이 동봉되거나** 입찰 요청 자체가 `targetState = "PARTICIPATING"`을 서명 대상으로 포함해야 한다. 어느 쪽이 단순한지는 구현 시 결정(입찰 요청에 `LedgerAction` 서명을 동봉하는 쪽을 제안).
- **D14-Q2 결정: 독립 `requestParticipation`을 유지한다.** 입찰과 무관하게 자기 펀드의 `PARTICIPATING`을 기록할 수 있다. 이로써 이슈 #10 설계 E-06(서로 보유한 펀드 쌍)이 풀린다(먼저 참여를 기록한 뒤 입찰). 대가로 T-11(사전 선점)이 열려 있다(잔여 위험으로 수용). 독립 선언도 서명된 `LedgerAction`이어야 하고(R1~R4), 마감 전에는 정정할 수 있다(R10, 단 R12가 보호하는 BIND-1 기록은 제외).
- **입찰 취소와의 관계(결정: 마감 전 가능, 후 불가)**: 취소는 `BidWithdrawal` 서명(운용사 단독, R15)으로 입찰이 만든 `PARTICIPATING`(`origin = BIND_1`)만 `EVENT_ANNULLED(BID_WITHDRAWN)`로 되돌린다. 독립 선언(`origin = INDEPENDENT`) 상태에서 한 입찰의 취소는 원장을 바꾸지 않는다. 입찰의 생애주기(`BID_SUBMITTED`/`BID_REPLACED`/`BID_WITHDRAWN`)와 확정·영수증 처리는 #10 §3.7이 정한다.
- **정정과의 관계(확정)**: BIND-1이 기록한 `PARTICIPATING`(`origin = BIND_1`)은 `BID_WITHDRAWN` + 같은 바인딩 `bidId`의 `EVENT_ANNULLED`로만 정정할 수 있고(R12), `BID_WITHDRAWN`은 `origin = BIND_1`인 기록에만 쓸 수 있다(§4.2.1). 독립 선언(`origin = INDEPENDENT`)으로 기록한 `PARTICIPATING`은 R10 정정(운용사 + 독립 승인자)으로 정정할 수 있다. `origin`은 이벤트 `payload`에 남아 R12가 구분한다(`PARTICIPATING`에서만 `BIND_1` 가능, LOCKED는 항상 `INDEPENDENT`).
- **바인딩 `bidId`의 정의(설계 파생, Q14-N7)**: BIND-1 이벤트의 `payload.bidId`는 그 `(펀드, IPO)`에서 **바인딩을 만든 최초 입찰의 ID**(바인딩 ID)이다. #10 §3.7 C4에 따라 마감 전 재제출(`BID_REPLACED`)은 원장 이벤트 없이 바인딩을 유지하므로, 입찰이 `bid_1` → `bid_2`로 대체된 뒤에도 원장 기록의 `bidId`는 `bid_1`로 남는다. 입찰 저장소는 입찰마다 바인딩 ID를 승계해 가지고, 취소 때 `BidWithdrawal`(현재 활성 입찰 `bid_2`에 대한 서명)을 바인딩 ID(`bid_1`)로 해소해 `EVENT_ANNULLED.payload.bidId = bid_1`을 만든다. 취소 후 재제출은 새 입찰이자 **새 바인딩**이다(#10 C6). 구현 PR #35는 `payload.bidId`가 기록의 `bidId`와 같은지만 비교하므로 이 정의와 호환된다. #10 문서가 이 승계를 명시하지 않아 후속 문장 보강이 필요하다(§10).

---

## 8. 수용 기준 (테스트 가능한 시나리오)

모든 ID·키·금액은 합성이다. "원장 불변"은 체인의 `seq`·`eventHash`가 변하지 않는 것을 뜻한다. 현재 코드에는 이 기능이 없으므로 구현 후 테스트 대상이다.

| ID | 사전조건 / 단계 | 기대 |
| --- | --- | --- |
| L-01 | `manager_x`가 레지스트리상 `fund_x`의 운용사. 유효 서명으로 `PARTICIPATING` 요청 | `PARTICIPATION_RECORDED` 이벤트 추가, `seq` +1, `prevHash` 일치, 상태 PARTICIPATING |
| L-02 | `manager_y`(유효 키)가 `fund_x`에 `NON_PARTICIPATION_LOCKED` 요청 | `LEDGER_ACTOR_NOT_FUND_MANAGER`, 원장 불변, 거부 로그에만 기록 (T-02) |
| L-03 | L-01 서명 후 `targetState`를 바꿔 제출 | `LEDGER_SIGNATURE_INVALID`, 원장 불변 |
| L-04 | 동일 서명 요청을 두 번 제출 | 두 번째는 첫 결과를 그대로 반환, 이벤트 1개 (멱등) |
| L-05 | 같은 `requestNonce`, 다른 `targetState`로 서명한 요청 | `LEDGER_NONCE_REPLAY` |
| L-06 | `ipo_1`용 서명을 `ipo_2` 요청에 사용 | `LEDGER_SIGNATURE_INVALID` |
| L-07 | 서명 시 도메인(`chainId`, `verifyingContract`, `name`, `version`)이 다른 요청 | `LEDGER_SIGNATURE_INVALID` |
| L-08 | `expiresAt` 이후에 도착한 요청 | `LEDGER_REQUEST_EXPIRED` |
| L-09 | 레지스트리에 없는 `actorId` / 없는 펀드 | `LEDGER_ACTOR_UNKNOWN` / `FUND_NOT_REGISTERED`. 서명 무효인 호출자에게는 펀드 존재 여부를 드러내지 않음 |
| L-10 | 유효 서명으로 `PARTICIPATING → LOCKED`, `LOCKED → PARTICIPATING`, 동일 상태 반복 (정정 없이 직접 요청) | 기존 `TransitionRejection`과 동일, 원장 불변. 상태를 바꾸려면 정정(L-22~)을 거쳐야 함 |
| L-11 | `IPO_CLOSED` 이후 상태 이벤트 | `IPO_ALREADY_CLOSED`, 원장 불변 |
| L-12 | 운영자 아닌 키로 `IPO_CLOSED` / 시퀀서 시계가 `closesAt` 이전 / 두 번째 `IPO_CLOSED` | `LEDGER_OPERATOR_REQUIRED` / `IPO_NOT_YET_CLOSABLE` / `IPO_ALREADY_CLOSED` |
| L-13 | 체인 중간 이벤트 변조, 삭제, 순서 교체 | 체인 검증이 최초 불일치 `seq`를 보고 |
| L-14 | `getStateAt(fund, ipo, seq)` | `seq` 이전 이벤트만 반영한 상태. 이후 이벤트가 있어도 불변 |
| L-15 | 입찰 창 중 `Fund.managerId` 변경 요청 / 마감 후 | `REGISTRY_FROZEN_DURING_WINDOW` / 허용되나 이미 기록된 이벤트·확정에는 영향 없음 |
| L-16 | 키 폐기 이벤트 `seq = n` 이후 해당 키 요청 / 그 이전에 기록된 이벤트 | 이후 요청 거부 / 이전 이벤트 상태 유지(폐기 자체는 상태를 되돌리지 않음. 되돌림은 L-22~L-33의 정정) |
| L-17 | BIND-1: 잠정 `ELIGIBLE` 입찰 접수 / 거부된 입찰 / 입찰 펀드가 이미 LOCKED | 입찰 펀드 PARTICIPATING 기록 / 기록 없음 / 접수 거부 |
| L-18 | BIND-1 이후 입찰 펀드가 LOCKED 요청 | `PARTICIPATION_ALREADY_RECORDED` |
| L-19 | `requestedAt`을 과거로 위조한 요청이 마감 이후 도착 | `IPO_ALREADY_CLOSED`. `requestedAt`은 판정에 쓰이지 않음 |
| L-20 | 거부 요청 100건 연속 | 체인 길이 불변, 거부 로그에만 기록 |
| L-21 | 같은 요청 데이터를 키 순서만 바꿔 직렬화 | 같은 `eventHash` (canonical JSON) |
| L-22 | (사전조건: 운용사, 승인자, 운영자의 키·`controllerId`가 서로 다름) 마감 전. `manager_x`가 `fund_x`를 `PARTICIPATING`으로 기록(seq=5). `manager_x` 서명(`LedgerAnnulment`, `targetSeq=5`, `targetEventHash` 일치)과 레지스트리 관리자 `AnnulmentApproval`로 정정 | `EVENT_ANNULLED` 추가(seq=6). 유효 상태 `UNKNOWN`. seq=5 이벤트와 체인은 그대로(해시 검증 통과). `getStateAt(fund_x, ipo, 5)`=PARTICIPATING, `getStateAt(..., 6)`=UNKNOWN |
| L-23 | L-22에서 승인자 서명 없이 운용사 서명만 / 승인만 있고 운용사 서명 없음 | `LEDGER_ANNUL_COSIGN_REQUIRED` / `LEDGER_ACTOR_NOT_FUND_MANAGER` 또는 `LEDGER_SIGNATURE_INVALID`. 원장 불변 |
| L-24 | `manager_y`(타 운용사)가 `fund_x` 이벤트의 정정 요청(유효 서명, 관리자 승인 포함) | `LEDGER_ACTOR_NOT_FUND_MANAGER`, 원장 불변 (T-02의 정정판) |
| L-25 | `IPO_CLOSED` 이후 정정 요청 (공동 서명 모두 유효) | `IPO_ALREADY_CLOSED`, 원장 불변. 마감 후 허위 LOCKED는 `FINDING_ANNOTATED`만 가능 |
| L-26 | 정정 후 같은 요청을 다시 제출 (재전송) / 같은 `requestNonce`에 다른 `targetSeq` | 첫 결과 그대로 반환, 이벤트 1개 / `LEDGER_NONCE_REPLAY` |
| L-27 | 이미 정정된 이벤트(seq=5)를 다시 정정 / 정정 이벤트(seq=6)를 대상으로 지정 / `targetEventHash` 불일치 / 다른 펀드·IPO의 이벤트 지정 | 모두 `LEDGER_ANNUL_TARGET_INVALID`, 원장 불변 |
| L-28 | `replacementState = "NON_PARTICIPATION_LOCKED"`로 정정 | `EVENT_ANNULLED`(seq=6) 직후 `NON_PARTICIPATION_LOCKED_RECORDED`(seq=7)가 연속 순번으로 추가됨(사이에 다른 이벤트 없음). 최종 유효 상태 LOCKED |
| L-29 | L-28에서 `replacementState`가 허용 목록(빈 문자열, `PARTICIPATING`, `NON_PARTICIPATION_LOCKED`) 밖의 값 | 요청 전체 거부, `EVENT_ANNULLED`도 추가되지 않음 (원자성) |
| L-30 | BIND-1로 기록된 `PARTICIPATING`(활성 입찰 있음, `origin = BIND_1`)을 R10 정정(독립 승인자 포함)으로 되돌리려는 요청 / 독립 `requestParticipation`으로 기록된 `PARTICIPATING`의 R10 정정 요청 | `LEDGER_ANNUL_BOUND_TO_BID` / 정상 정정. 전자의 해소는 입찰 취소(L-39) |
| L-31 | 정정 요청 이벤트가 `IPO_CLOSED` 직전 순번 / 직후 순번 | 직전: 반영, `ledgerSeqAtClose` 시점 유효 상태가 정정 결과. 직후: `IPO_ALREADY_CLOSED` |
| L-32 | 키 침해 시나리오: 침해 키로 허위 LOCKED(seq=5) → `MANAGER_KEY_REVOKED`(seq=6) → 새 키 등록 → 새 키 + 관리자 승인으로 정정(마감 전) → 침해 키로 정정 시도 | 정정 성공 후 유효 상태 UNKNOWN. 폐기 이후 침해 키의 새 요청은 `LEDGER_SIGNATURE_INVALID`. 마감 후였다면 정정 불가(L-25) |
| L-33 | 정정이 포함된 이력에서 임의 시점 `atSeq`별 `getStateAt`, 같은 이력을 키 순서만 바꿔 직렬화 | 정정 반영 전/후 상태가 `atSeq`에 따라 일관. 같은 `eventHash`(canonical JSON, L-21과 동일) |
| L-34 | 정정 요청에서 `approverId == actorId` (같은 ID가 두 서명) | `LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT`, 원장 불변 (I1) |
| L-35 | 서로 다른 ID로 서명했으나 복구한 주소가 같음 (같은 키로 두 서명) | `LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT`, 원장 불변 (I2) |
| L-36 | 승인자 `controllerId`가 운용사 `controllerId`와 같음 | `LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT`, 원장 불변 (I3) |
| L-37 | 승인자 principal이 원장 운영자 principal과 같음(주소 또는 `controllerId`가 같음, 즉 레지스트리 관리자와 운영자가 같은 주체). 설정 로드 시 / 정정 요청 시 | 설정이 I4를 위반하면 정정 기능 비활성: 요청은 `LEDGER_ANNUL_DISABLED`. 다른 기능(L-01, L-11, L-39)은 정상. 승인자만 운영자와 같은 요청이 들어오면 `LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT` (I4, I5) |
| L-38 | 같은 서명 주소를 두 principal에 등록하려는 시도 | `PRINCIPAL_KEY_REUSE`, 등록 거부 |
| L-39 | 입찰 취소(정상): `fund_x`가 입찰로 `PARTICIPATING`(`origin = BIND_1`, `bidId = bid_1`), `manager_x`가 `BidWithdrawal` 서명(`afterState = ""`)만 제출. **승인자 서명 없음** | 성공. `EVENT_ANNULLED(reason = BID_WITHDRAWN, bidId = bid_1)` 추가, 유효 상태 `UNKNOWN`, 입찰 `WITHDRAWN` (R15) |
| L-40 | L-39에서 `afterState = "NON_PARTICIPATION_LOCKED"` / 서명 후 `afterState`를 바꿔 제출 | 성공 시 `EVENT_ANNULLED` 직후 연속 순번으로 `NON_PARTICIPATION_LOCKED_RECORDED`(`origin = INDEPENDENT`), 유효 상태 `LOCKED` / 변조 시 `LEDGER_SIGNATURE_INVALID`, 원장 불변 |
| L-41 | `IPO_CLOSED` 이후 취소 요청 | `IPO_ALREADY_CLOSED`, 원장·입찰 불변 |
| L-42 | 타 운용사 서명으로 취소 요청 | `LEDGER_ACTOR_NOT_FUND_MANAGER`, 원장·입찰 불변 |
| L-43 | `origin = INDEPENDENT`인 `PARTICIPATING` 펀드의 입찰 취소 / 바인딩 없는 입찰의 취소 | 원장 이벤트 없음. 입찰만 `WITHDRAWN` |
| L-44 | 취소 요청이 `IPO_CLOSED` 직전 순번 / 직후 순번 | 직전: 반영, 컷오프 유효 상태 `UNKNOWN`. 직후: `IPO_ALREADY_CLOSED` |
| L-45 | 같은 취소 요청 재전송 / 이미 취소된 `bidId`를 새 nonce로 취소 | 첫 결과 그대로, 이벤트 1개 / `BID_ALREADY_WITHDRAWN`, 새 이벤트 없음 |
| L-46 | 재제출(대체)이 있은 뒤 취소 | 대체 때 원장 이벤트 없음. 취소 때 `EVENT_ANNULLED(BID_WITHDRAWN)` 한 번 |
| L-47 | 빈 체인의 `headHash`. 첫 이벤트(`seq = 1`)의 `prevHash` | 둘 다 `"0"`×64(`0000…0000`). 첫 이벤트의 `prevHash`가 63자·65자·대문자·전부 `f`·빈 문자열이면 `LEDGER_PREV_HASH_MISMATCH` 또는 `EVENT_MALFORMED`(형식 오류), 원장 불변 |
| L-48 | §2.2.1 참조 벡터의 이벤트 `eventHash` 계산 / 도메인 태그 없이 `event`만 해시 / 다른 태그(`ipo-proof/ledger-event/v2`)로 해시한 값을 `eventHash`로 가진 이벤트 | `373ca330…1967`과 일치 / `84485d9d…7d77`이 나오며 저장된 값과 다르면 `LEDGER_EVENT_HASH_MISMATCH` / 마찬가지로 `LEDGER_EVENT_HASH_MISMATCH` (T-23) |
| L-49 | `canonicalJson` 단위 검사: 같은 객체를 키 순서만 바꿔 직렬화, 중첩 객체, 제어문자·비-BMP 문자·짝 없는 서로게이트, `-0`, 2^53 이상의 정수, 실수, `NaN`, `undefined` 값, `bigint` | 키 순서와 무관하게 같은 문자열. 제어문자는 소문자 `\u00xx`, `-0`은 `0`. 정수 범위 밖·실수·`NaN`·`undefined`·`bigint`는 직렬화 오류(이벤트 파서에서는 `EVENT_MALFORMED`) |
| L-50 | 서명의 `0x` 뒤 hex에 대문자가 섞인 이벤트 / 130자가 아닌 서명 | `EVENT_MALFORMED`. 소문자 서명만 수용 |
| L-51 | `coAuthorizations[0]`에서 `approverId` 누락, 식별자 형식 위반, 알 수 없는 추가 필드 / 정상 | `EVENT_MALFORMED` / 수용. 서명 검증 단계에서는 `approverId`가 서명된 `AnnulmentApproval.approverId`와 다르면 `LEDGER_SIGNATURE_INVALID`, 그 `approverId`로 R14 검사(L-34~L-38)를 수행 |
| L-52 | 6가지 대상(§2.2.2 표)에 각각 맞는 `scheme`을 붙인 이벤트 | 모두 구조 검사 통과. `EVENT_ANNULLED`(MISTAKEN_ENTRY/KEY_COMPROMISE)는 `authorization.scheme = EIP712_LEDGER_ANNULMENT_V1`이고 `coAuthorizations[0].scheme = EIP712_LEDGER_ANNULMENT_APPROVAL_V1` |
| L-53 | `IPO_CLOSED`에 `EIP712_LEDGER_ACTION_V1` / `BID_WITHDRAWN` 정정에 `EIP712_LEDGER_ANNULMENT_V1` / 상태 이벤트에 `EIP712_LEDGER_OPERATOR_ACTION_V1` / 승인자 `scheme`에 `EIP712_LEDGER_ANNULMENT_V1` / 표에 없는 `EIP712_LEDGER_FOO_V1` / 소문자 `scheme` | 앞의 다섯은 `LEDGER_SCHEME_MISMATCH`, 마지막(형식 위반)은 `EVENT_MALFORMED`. 원장 불변. 라벨만 올바르게 고치고 서명은 다른 `primaryType`으로 한 경우는 `LEDGER_SIGNATURE_INVALID`(T-21) |
| L-54 | `NON_PARTICIPATION_LOCKED_RECORDED`에 `origin = BIND_1` / `origin` 누락 / `bidId` 포함 / `origin = INDEPENDENT` / 입찰 취소 `afterState = LOCKED`의 재기록 이벤트 | 앞의 셋은 `EVENT_MALFORMED`, 원장 불변 / 수용 / `origin = INDEPENDENT`로 수용 |
| L-55 | `PARTICIPATING`(`origin = BIND_1`, `bidId = bid_1`)에 `EVENT_ANNULLED(reason = BID_WITHDRAWN, bidId = bid_1)`, 승인자 없음 | 수용. 유효 상태 `UNKNOWN` |
| L-56 | L-55의 대상에 `reason = MISTAKEN_ENTRY` 또는 `KEY_COMPROMISE` + 독립 승인자 서명 1건 | `LEDGER_ANNUL_BOUND_TO_BID`, 원장 불변 |
| L-57 | L-55의 대상에 `reason = BID_WITHDRAWN`, `bidId = bid_2` | `LEDGER_ANNUL_TARGET_INVALID`, 원장 불변 |
| L-58 | `origin = INDEPENDENT`인 `PARTICIPATING` / `NON_PARTICIPATION_LOCKED` 이벤트에 `reason = BID_WITHDRAWN` | 둘 다 `LEDGER_ANNUL_TARGET_INVALID`, 원장 불변 |
| L-59 | `BID_WITHDRAWN`에 `coAuthorizations` 1건 / `MISTAKEN_ENTRY`에 0건 또는 2건 | 모두 `EVENT_MALFORMED`(원장 파서). 접수 계층 테스트에서는 뒤의 경우를 `LEDGER_ANNUL_COSIGN_REQUIRED`로 돌려줄 수 있다(L-23과 같은 상황이며 어느 계층의 코드를 검사하는지 테스트에 명시) |
| L-60 | `bid_1`로 BIND-1 기록 후 `bid_2`로 대체(원장 이벤트 없음), `BidWithdrawal`(`bidId = bid_2`) 서명 | `EVENT_ANNULLED.payload.bidId = bid_1`(바인딩 ID)로 기록. 서명 대상은 `bid_2`. 취소 후 재제출은 새 바인딩(새 `bidId`)으로 새 BIND-1 기록 (Q14-N7) |
| L-61 | (조건부: Q14-N8 기본안 채택 시) `origin = INDEPENDENT`인 `PARTICIPATING` + 같은 `(펀드, IPO)`의 활성 입찰 + R10 정정(독립 승인자 포함, `replacement = LOCKED`) / 활성 입찰 없음 | 접수 계층이 `LEDGER_ANNUL_BOUND_TO_BID`로 거부(순수 원장 파서·접기 자체는 수용) / 정상 정정 (T-22) |
| L-62 | 운영자 서명 `FINDING_ANNOTATED`(`kind` 4종 각각, `evidenceDigest`는 hex 또는 `null`), 마감 전과 `IPO_FINALIZED` 후 | 수용. 모든 `(펀드, IPO)`의 `getState`/`getStateAt`가 추가 전후 동일. `IPO_FINALIZED` 후에도 수용 |
| L-63 | `FINDING_ANNOTATED`에 `note` 문자열 필드 / 금액 필드 / 목록에 없는 `kind` / `evidenceDigest`가 hex 64자 아님 / 알 수 없는 추가 필드 | 모두 `EVENT_MALFORMED`, 원장 불변 (T-19) |
| L-64 | `targetSeq` 없는 순번 / `targetSeq ≥ seq` / `targetEventHash` 불일치 / 다른 IPO의 이벤트 / 대상이 `FINDING_ANNOTATED` | 모두 `LEDGER_FINDING_TARGET_INVALID`, 원장 불변 |
| L-65 | 운용사·`AUDITOR` 서명으로 `FINDING_ANNOTATED` / `subjectFundId`가 `null`이 아님 / `coAuthorizations` 비어 있지 않음 | `LEDGER_OPERATOR_REQUIRED` / `EVENT_MALFORMED` / `EVENT_MALFORMED` |
| L-66 | 레지스트리 관리자 서명 `MANAGER_KEY_REVOKED`(`ipoId = null`)를 `ipo_1`, `ipo_2`가 열려 있을 때 기록. 이후 폐기된 키로 두 IPO에 새 요청 | 이벤트 1개 추가. 두 IPO 모두에서 새 요청이 `LEDGER_SIGNATURE_INVALID`(R9) (T-18) |
| L-67 | L-66 이후 (a) 폐기 이전에 기록된 그 키의 이벤트의 유효 상태 (b) 폐기 이후에 새로 등록된 `ipo_3`의 요청 (c) 이미 `IPO_CLOSED`인 IPO의 `getStateAt` | (a) 유지 (b) 거부 (c) 불변 |
| L-68 | `MANAGER_KEY_REVOKED`에 `ipoId`가 있는 이벤트 / `MANAGER_KEY_REVOKED`가 아닌 유형에 `ipoId = null` | 둘 다 `EVENT_MALFORMED` |
| L-69 | 운용사 자신 또는 운영자 서명으로 폐기 요청 / 이미 폐기된 키를 다시 폐기 / 레지스트리에 없는 `managerId`·`revokedKeyId` | `LEDGER_REGISTRY_ADMIN_REQUIRED` / `LEDGER_KEY_ALREADY_REVOKED`, 이벤트 추가 없음 / `LEDGER_ACTOR_UNKNOWN` |
| L-70 | `IPO_CLOSED` 없이 `IPO_FINALIZED` / 다른 IPO(`ipo_2`)만 마감된 상태에서 `ipo_1`의 `IPO_FINALIZED` | 둘 다 `IPO_NOT_CLOSED`, 원장 불변 (T-20) |
| L-71 | `IPO_CLOSED` 후 컷오프 필드가 일치하는 운영자 서명 `IPO_FINALIZED` | 수용. 이후 상태 이벤트와 정정은 `IPO_ALREADY_CLOSED`, `FINDING_ANNOTATED`는 수용 |
| L-72 | `ledgerSeqAtClose` 또는 `ledgerHeadHashAtClose`가 `IPO_CLOSED`와 다름 | `LEDGER_FINALIZATION_CUTOFF_MISMATCH`, 원장 불변 |
| L-73 | 같은 IPO에 두 번째 `IPO_FINALIZED`: (a) 같은 `finalizationDigest`, 새 `requestNonce` (b) 다른 `finalizationDigest` (c) 같은 `requestNonce`의 동일 요청 재전송 | (a) (b) `IPO_ALREADY_FINALIZED`, 원장 불변 (c) 첫 결과 그대로, 이벤트 1개(R4) |
| L-74 | 운용사·레지스트리 관리자 서명 `IPO_FINALIZED` / `finalizationDigest`가 hex 64자 아님 / `subjectFundId`가 `null`이 아님 / 공동 서명 있음 | `LEDGER_OPERATOR_REQUIRED` / `EVENT_MALFORMED` / `EVENT_MALFORMED` / `EVENT_MALFORMED` |
| L-75 | 운영자 서명(`payloadDigest`가 `finalizationDigest = X` 기준)을 받은 요청에서 `finalizationDigest`를 `Y`로 바꿔 제출 / `FINDING_ANNOTATED`의 `kind`를 바꿔 제출 | `LEDGER_SIGNATURE_INVALID`, 원장 불변 (`payloadDigest` 바인딩) |
| L-76 | 구현 PR ① 이전에 `EVENT_TYPE_NOT_SUPPORTED`를 기대하던 테스트 3종(`IPO_FINALIZED`, `FINDING_ANNOTATED`, `MANAGER_KEY_REVOKED`) | 이 사양 구현 후에는 위 L-62~L-75로 대체. 목록에 없는 `eventType`은 계속 `EVENT_MALFORMED` |

공격 시나리오와의 대응: T-01, T-02 → L-02, T-03 → L-03~L-08, T-05 → L-16, L-32, T-06 → L-13(검출 한정), T-08 → L-22, T-10 → L-04, T-12 → L-34~L-37(동일 주체 거부, 공모는 막지 못함을 문서화), T-16 → L-38(키 재사용만 검출, 나머지는 한계), T-17 → L-39~L-46(속도 제한 없음을 문서화), T-13 → L-28, L-31, T-14 → L-30, L-39. T-15는 시나리오로 검증할 수 없고 체인 가시성(L-22, L-33)에만 의존한다. 확정값 반영분: T-18 → L-66~L-69, T-19 → L-62~L-65, T-20 → L-70~L-75, T-21 → L-52, L-53, T-22 → L-61(조건부, Q14-N8), L-58, T-23 → L-48, L-49.

---

## 9. 가정, 미확인, 열린 질문

### 9.1 규정 관련 (ASSUMPTIONS 연결)

| ID | 이 설계와의 관계 | 선택 |
| --- | --- | --- |
| A-024 ~ A-027 | 면제는 규정상 기관투자자가 집합투자규약·투자설명서 등으로 대표주관회사에 하는 소명이다 〔S1 · 제5조의3 ①1호 다목 단서 · 2026-10-03〕. 원장 `LOCKED`는 이에 대한 PoC 매핑이며 규정의 "소명 수용"과 다르다 | 이 문서는 매핑을 유지하되 "누가 기록하는가"만 정한다 |
| A-026 | 원장·잠금은 규정 개념이 아님 | §0, 면책 문구에 반영 |
| A-028 | 소명 후 실제 참여한 경우의 효과는 모델링하지 않음 | 허위 LOCKED의 사후 정정 효과를 정하지 않음(§6.3) |
| A-033 | 규정의 표준 증빙은 대표이사 또는 준법감시인이 서명한 확약서. 독립 증빙은 PoC 선택 | §3.3: 원장 서명권자 지정은 규정 요구가 아님 |
| (새) P14-A01 | 레지스트리의 운용사–펀드 관계가 독립적이며 정확하다. 이 문서는 변경 로그와 창 중 고정으로 위험을 줄일 뿐 독립성을 강제하지 않는다 | 가정 |
| (새) P14-A02 | 하위펀드 상태를 **하위펀드 운용사**가 기록한다(규정은 상위 기관투자자가 소명). 규정과 다른 PoC 선택 | 가정 |
| (새) P14-A03 | 시퀀서(원장 운영자)는 단일 주체이며 순번과 시간 기준을 정하고 `IPO_CLOSED`를 시계에 맞게 추가한다(TA-1). **결정됨(진영 님 위임 판단, 2026-10-03)**. 규정 요구가 아닌 PoC 단순화이며 한계는 §6.4 | PoC 단순화 (결정) |
| (새) P14-A04 | 마감 전 원장 정정을 허용하고 마감 후에는 허용하지 않는다(D14-Q1 결정). 규정상 정정·취소 규칙은 확인하지 못했다(#10 P10-A10과 같은 미확인 영역) | PoC 정책 (결정), 규정 미확인 |
| (새) P14-A05 | 정정 승인자는 레지스트리 관리자 역할이며 **운용사 서명자 및 원장 운영자와 독립된 주체**여야 한다(결정, 2026-10-03). 독립성은 식별자·키·신고된 `controllerId` 수준에서만 시스템이 확인한다(§4.5) | PoC 통제 (결정) |
| (새) P14-A06 | `controllerId`는 자기 신고 값이며 외부에서 검증되지 않는다. 최초 설정(genesis)의 principal 등록은 신뢰한다 | 가정 |
| (새) P14-A07 | 마감 전 입찰 취소 가능, 마감 후 불가(결정, 2026-10-03). 규정상 참여 후 취소 가능 여부는 확인하지 못했다(#10 P10-A10, P10-A14) | PoC 정책 (결정), 규정 미확인 |

| (새) P14-A08 | `FINDING_ANNOTATED`는 자유 서술 없이 닫힌 `kind`와 증빙 다이제스트만 갖는다. 운영자만 기록한다. 규정 근거가 없는 PoC 정책이며 `kind` 목록은 제안이다(§2.3.1) | PoC 정책 |
| (새) P14-A09 | `MANAGER_KEY_REVOKED`는 `ipoId = null`인 전역 이벤트이고 서명자는 레지스트리 관리자이다. 키 관리 역할은 #13 전의 PoC 매핑이다(§2.3.2) | PoC 정책, #13 대기 |
| (새) P14-A10 | `IPO_FINALIZED`는 `IPO_CLOSED` 선행·컷오프 필드 일치·IPO당 1회이며 확정 기록의 사후 정정 경로가 없다. D14-Q1(마감 후 불변)의 연장이며 규정에서 확인하지 못했다 | PoC 정책, 규정 미확인 |
| (새) P14-A11 | BIND-1 이벤트의 `bidId`는 바인딩을 만든 최초 입찰의 ID(바인딩 ID)이고 재제출로 승계된다. #10 §3.7 C4에서 파생한 해석이며 #10 문서에 명시되어 있지 않다 | 가정, 확인 필요(Q14-N7) |

`P14-Axx`는 이 문서가 새로 두는 가정이며 ASSUMPTIONS에는 아직 없다.

### 9.2 미확인

- 규정상 정정·취소, 참여 취소 시 원장 효과: 확인하지 못함(RESEARCH §6, §8).
- 실무에서 하위 운용사가 상위 투자자에게 "IPO 비참여"를 증명하는 방법과 서류의 실제 형태: 확인하지 못함.
- `IPO_CLOSED` 시점의 실제 규정상 대응(수요예측 마감 시각): 확인하지 못함(#10 문서 P10-A09).

### 9.3 소유자 결정 반영과 새 열린 질문

**반영된 결정 (2026-10-03, 리드 봇 경유 진영 님)**

| ID | 결정 | 반영 위치 |
| --- | --- | --- |
| D14-Q1 | 마감 전 정정 **허용**, 마감 후 변경 불가. `EVENT_ANNULLED`로 해시 체인을 깨지 않고 정정(이전 제안 (b)를 확정). 공동 서명은 운용사 키 + 레지스트리 관리자 역할의 승인자(운용사·운영자와 독립된 주체여야 함, R14)(쿼럼은 #13에서) | §2.3, §3.2, §4.2 R10~R13, §4.4, §5.1, §6, §8 L-22~L-33 |
| D14-Q2 | 독립 `requestParticipation` **유지** (T-11은 잔여 위험으로 수용, E-06 해소) | §7, §6.2 T-11 |
| D14-Q3 | 원장 운영자: 진영 님 임의 판단 위임 → **단일 운영자(PoC 단순화)** | §6.4, P14-A03 |
| D14-Q4 | 시간 권위: 위임 → **시퀀서 시계, 외부 시간 증명 없음** (한계 명시) | §6.4, P14-A03 |
| (#11) | v2와 `blindingSalt` 보류. 이 문서는 v2 필드에 의존하지 않음 | 헤더 |
| Q14-N1 (추가 결정) | 정정 승인자는 운용사 서명자와 **독립된 주체**여야 함. 동일 주체 서명은 거부, 레지스트리 관리자와 원장 운영자가 같은 주체여도 독립 승인으로 인정 불가 | §4.2 R14, §4.5, §6.4.1, L-34~L-38 |
| Q14-N4 (추가 결정) | **마감 전 입찰 취소 가능**, 마감 후 불가 | §4.2 R15, §7, L-39~L-46 |

**결정 반영 중 생긴 새 열린 질문**

| ID | 질문 | 기본 제안 |
| --- | --- | --- |
| Q14-N1 | ~~정정 공동 서명자를 누구로 할 것인가?~~ | **결정됨**: 독립된 주체(R14). 쿼럼 구성은 여전히 #13 |
| Q14-N2 | 정정·입찰 취소의 횟수나 마감 임박 시간대에 상한을 둘 것인가? 정정은 독립 승인자가 속도 제한 역할을 하지만 **입찰 취소는 운용사 단독 서명이라 제한이 없다**(T-17, #10 Q10-N5) | 두지 않는다. 수치 근거가 없으므로 값을 정하지 않는다. 보안QA 검토 항목 |
| Q14-N3 | `IPO_CLOSED` 지연으로 창이 연장되는 공백(§6.4)을 막기 위해 "시퀀서 시계 ≥ `closesAt`이면 상태·정정 이벤트 거부" 규칙을 둘 것인가? #10의 F1(순번 기준)·S-06을 바꿔야 한다 | 이 문서는 채택하지 않고 한계로 기록. 보안QA 검토 후 결정 |
| Q14-N4 | ~~마감 전 입찰 취소를 허용할 것인가?~~ | **결정됨**: 마감 전 가능, 후 불가(R15) |
| Q14-N5 | 독립 요건을 **운영자와 운용사**(운영자가 운용사를 겸하거나 같은 그룹 계열인 경우)에도 확장할 것인가? 이번 결정은 정정 승인자와 운용사 서명자, 그리고 승인자와 운영자의 분리까지다 | 확장하지 않음(범위 밖). 소유자 판단 |
| Q14-N6 | `controllerId`의 진위를 확인할 외부 수단(법인 확인, 별도 증명)이 필요한가? 현재는 자기 신고(P14-A06)이고 T-16은 막지 못한다 | PoC에서는 자기 신고 + 운영 규약. 실제 확인 수단은 미확인 |
| Q14-N7 | BIND-1 이벤트의 `payload.bidId`를 **바인딩 ID**(최초 입찰의 ID, 재제출로 승계)로 정의하는 해석(§7, P14-A11)이 맞는가? #10 §3.7 C4/S-38은 대체 후 취소를 다루지만 어떤 `bidId`가 원장에 남는지 쓰지 않았다. 대안: 대체 시 원장에 이벤트를 추가해 `bidId`를 갱신(바인딩 유지 원칙과 충돌) | 바인딩 ID(승계). 구현 PR #35와 호환. #10 문서에 한 문장 보강 필요(리서치 후속) |
| Q14-N8 | 독립 선언 `PARTICIPATING` + 활성 입찰 상태에서 R10 정정(`replacement = LOCKED`)으로 입찰한 펀드를 잠그는 경로(T-22)를 막을 것인가? | 막는다: 접수 계층에서 활성 입찰이 있는 `(펀드, IPO)`의 R10 정정을 `LEDGER_ANNUL_BOUND_TO_BID`로 거부. 순수 원장 규칙(R12)은 바꾸지 않음. 확정 전까지 L-61은 조건부 |
| Q14-N9 | `MANAGER_KEY_REVOKED`의 서명자: 레지스트리 관리자만(기본)으로 둘 것인가, 운용사 자신(새 키·별도 복구 키)의 자기 폐기도 허용할 것인가? 쿼럼은 #13 | 관리자만. 운용사 자기 폐기는 불허(침해된 키로 폐기를 서명하는 경로를 피함) |
| Q14-N10 | `FINDING_ANNOTATED`에 자유 서술을 허용할 것인가, `AUDITOR`에게 쓰기 권한을 줄 것인가? | 둘 다 불허(닫힌 `kind` + `evidenceDigest`, 운영자만). 허용한다면 사양안: 120자 이하, ASCII 출력 가능 문자만, 금액·식별정보 금지는 운영 규약(시스템은 막지 못함) |


### 9.4 구현 임시값과 설계 확정값 (원장 PR ①, `main` `0eb5d89`)

PR #35는 설계가 정하지 않은 항목을 임시값으로 두었다. 아래는 구현의 실제 코드와 이 문서의 확정값을 대조한 것이다(코드는 읽기만 했고 이 문서는 구현을 바꾸지 않는다).

| # | 항목 | 구현 임시값 | 설계 확정값 | 차이 | 구현 변경 |
| --- | --- | --- | --- | --- | --- |
| 1 | genesis `prevHash` | `"0".repeat(64)` (`LEDGER_GENESIS_PREV_HASH`) | `"0"` 64자 (§2.2) | 같음 | 없음. L-47 테스트 추가 |
| 2 | 해시 도메인 태그 | `sha256CanonicalHex({domain: "ipo-proof/ledger-event/v1", event})` | 같음, `canonicalJson` 정의와 참조 벡터 명시 (§2.2.1) | 해시 구조는 같음. 서명 hex: 구현은 대소문자 모두 허용(`/^0x[0-9a-fA-F]{130}$/`), 확정은 소문자만 | 서명 정규식을 소문자로 제한(L-50). 참조 벡터 테스트 추가(L-48) |
| 3 | `coAuthorizations` 항목 | `{approverId, scheme, requestNonce, expiresAt, signature}` | 같음 (§2.2) | 같음 | 없음. L-51 |
| 4 | `scheme` 식별자 | 형식 `^[A-Z][A-Z0-9_]{0,63}$`만 검사, 유형별 대응 없음. 픽스처가 `EIP712_LEDGER_ACTION_V1`을 모든 `authorization`(운영자 이벤트, 정정, 취소 포함)에 사용. 운영자 이벤트와 `BidWithdrawal`의 이름 없음 | 6종 이름과 유형별 정확 일치 (§2.2.2, R16). 운영자: `EIP712_LEDGER_OPERATOR_ACTION_V1`, 취소: `EIP712_LEDGER_BID_WITHDRAWAL_V1`, 정정: `EIP712_LEDGER_ANNULMENT_V1`, 승인자(픽스처가 이미 쓴 이름): `EIP712_LEDGER_ANNULMENT_APPROVAL_V1`, 키 폐기: `EIP712_LEDGER_KEY_REVOCATION_V1` | **다름**: 구현이 더 느슨함 | 유형별 대응 검사와 `LEDGER_SCHEME_MISMATCH` 추가(L-52, L-53). `IPO_CLOSED`, 정정, 취소 픽스처의 `scheme` 수정 |
| 5 | LOCKED의 `origin` | `INDEPENDENT`만 허용, 그 외 `EVENT_MALFORMED` | 같음 (§2.3). 문서의 일반 `origin` 서술을 고쳤다 | 같음 | 없음. L-54 |
| 6 | R10/R12/R15 BIND-1 정정 | `BID_WITHDRAWN`: 대상이 `BIND_1`이고 `bidId` 일치가 아니면 `LEDGER_ANNUL_TARGET_INVALID`. 그 밖의 `reason`에서 대상이 `BIND_1`이면 `LEDGER_ANNUL_BOUND_TO_BID`. `BID_WITHDRAWN`은 공동 서명 0건, 그 외 정확히 1건 | 같음, 판정표 (§4.2.1), `bidId`는 바인딩 ID (§7). 문서의 "활성 입찰이 있는 동안" 표현을 불변식으로 정리 | 같음 (문서가 구현을 따름) | 없음. L-55~L-60 |
| 7 | 미지원 이벤트 3종 | 세 유형 모두 `EVENT_TYPE_NOT_SUPPORTED`로 거부, 형태는 검사하지 않음. `ipoId`는 모든 유형에서 필수 | 사양 확정 (§2.3.1~§2.3.3, R17~R19). `MANAGER_KEY_REVOKED`만 `ipoId = null` | 구현 전 | 후속 PR에서 구현 (L-62~L-76). 파서의 `ipoId`는 이 유형에서만 `null` 허용 |

여기서 "확정"은 설계 문서 안의 확정이며 진영 님의 결정이 아니다. 진영 님 확인이 필요한 갈래는 Q14-N7~N10이다.

---

## 10. 후속 작업 (담당)

| 담당 | 작업 |
| --- | --- |
| 구현 봇 (#15 등) | 이벤트 봉투와 해시 체인, 서명된 요청 검증(#11의 서명 유틸 재사용, v1 규칙 그대로), 이벤트 접기(fold)로 유효 상태 도출과 `getStateAt`, `IPO_CLOSED`/`IPO_FINALIZED`, **`EVENT_ANNULLED`와 공동 서명 검증(R10~R13), 승인자 독립성 검사 R14(I1~I5, `PRINCIPAL_KEY_REUSE`, 설정 시 `LEDGER_ANNUL_DISABLED`), 입찰 취소 경로 R15(`BidWithdrawal` 서명, `afterState`, 입찰 저장소 연동), 정정+재기록 원자 처리**, `payload.origin` 구분, 거부 로그, BIND-1, §8 시나리오(L-01~L-46) 테스트. 이 PR은 구현을 포함하지 않음 |
| 보안QA | 이 문서 §4, §6의 권한 모델 리뷰(#14 리뷰 항목), 정정 도입에 따른 새 공격면(T-12~T-17)과 확정값 반영분(T-18~T-23: 전역 키 폐기, 주석 남용, 확정 위조, `scheme` 라벨, 독립 선언+입찰 정정, 직렬화 불일치), 독립성 검사(R14)의 우회 가능성과 최초 설정 신뢰(T-16), 입찰 취소 반복(T-17)과 §6.4 단일 운영자 한계 검토, Q14-N3(`IPO_CLOSED` 지연) 판단, `THREAT_MODEL.md`의 "Unauthorized state transition" 행 갱신(보안QA 담당 규칙) |
| 구현 봇 (원장 PR ② 이후, 확정값 반영) | ① 서명 정규식을 소문자 hex로 제한하고 `scheme` 유형별 대응 검사(`LEDGER_SCHEME_MISMATCH`)와 픽스처 `scheme` 수정(§9.4 #2, #4). ② 참조 벡터(§2.2.1)와 genesis 값 테스트(L-47~L-51). ③ `FINDING_ANNOTATED`, `MANAGER_KEY_REVOKED`(`ipoId = null`, 전역 폐기 집합), `IPO_FINALIZED`(선행·컷오프 일치·1회)의 파서와 접기 구현, 기존 `EVENT_TYPE_NOT_SUPPORTED` 테스트 교체(L-62~L-76). ④ `OperatorAction.payloadDigest`와 `KeyRevocation` 서명 구조를 서명 검증 PR에 포함. ⑤ 서명 검증 PR에서 `primaryType`을 `scheme`이 아니라 이벤트 유형·`reason`으로 선택. 이 PR은 구현을 포함하지 않음 |
| 리서치 | #11 서명 스키마(별도 PR), #13 키 관리·쿼럼(D14-Q1 연동), #18 온체인 설계, **#10 문서 §3.7 C4에 바인딩 ID 승계 한 문장 보강**(Q14-N7. 이 PR은 #14 문서만 수정하므로 별도 PR) |
| 소유자(진영) | 반영된 결정 확인(Q14-N1, N4 해소). 남은 열린 질문 Q14-N2, N3, N5, N6, **N7~N10**(§9.3, 각 기본값 있음) |
| 리드 봇 | `ROADMAP.md` 미결정 항목(입찰 통과와 기록의 결합)과 `THREAT_MODEL.md`의 관련 서술 정리, P14-Axx의 ASSUMPTIONS 편입 여부 |

## 11. 출처

- EIP-712: Typed structured data hashing and signing — https://eips.ethereum.org/EIPS/eip-712 (domainSeparator 필드 정의, "It does not include replay protection", Frontrunning attacks 절; 2026-10-03 열람)
- Solidity 문서, Units and Globally Available Variables — https://docs.soliditylang.org/en/latest/units-and-global-variables.html (`block.timestamp`는 unix epoch 이후 초; 2026-10-03 열람)
- 규정 관련: 〔S1 · 제5조의3 ①1호 다목 단서, ② · 2026-10-03〕 — `REGULATORY_RESEARCH.md` §7 참조.
