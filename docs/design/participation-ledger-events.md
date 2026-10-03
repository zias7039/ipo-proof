# 설계: 참여 원장 이벤트 스키마와 상태 전이 호출자 인증·인가 (이슈 #14)

> **면책 (Disclaimer)**
> 이 문서는 **리서치/설계 PoC 문서**이며 **법률/규제 자문이 아니고 보안 감사도 아닙니다**. 규정에는 "참여 원장"이라는 개념이 없고, 이 문서의 원장·권한 모델은 PoC가 만든 구조입니다(`REGULATORY_ASSUMPTIONS.md` A-026). **프로덕션 규칙으로 사용 금지**입니다. 규정 관련 서술은 [`REGULATORY_RESEARCH.md`](../REGULATORY_RESEARCH.md)·[`REGULATORY_ASSUMPTIONS.md`](../REGULATORY_ASSUMPTIONS.md)(확인일 2026-10-03)를 연결하며, 그 문서가 확인하지 못했다고 적은 것은 여기서도 **미확인**입니다.

- 작성: 리서치 봇. 이슈: #14 (`Refs #14`). 상태: **설계 제안 (코드 변경 없음)**. 구현은 'IPO Proof 구현' 봇(#15), 권한 모델 리뷰는 보안QA 몫입니다(§10).
- 선행: 이슈 #10 설계 문서 — PR #26의 `docs/design/snapshot-and-finalization.md`(병합 전이면 PR #26 참조). 이 문서의 `IPO_CLOSED` 컷오프, 접수 영수증, 단조성(해당 문서 §3.4)은 그 문서에 의존합니다. UNKNOWN은 **거부**로 결정되었습니다(이슈 #10 코멘트, 진영, 2026-10-03).
- 후행: 이슈 #15(영속성), #18(온체인 컨트랙트 설계), #13(어테스터·운용사 키 관리).
- 코드 기준: `main` 커밋 3fa59ef(2026-10-03 확인)의 `packages/domain/src/participation.ts`. PR #23(UNKNOWN 거부)과 PR #24(EIP-712 검증)는 이미 병합되어 있습니다. 초안은 커밋 8e1ab58 기준이었고, 두 PR은 `participation.ts`를 바꾸지 않았음을 확인했습니다.

## 0. 요약

1. 현재 원장은 **누가** 전이를 요청하는지 모른다(`requestParticipation(fundId, ipoId)`에 호출자가 없음). 따라서 누구든 타 운용사 펀드를 `NON_PARTICIPATION_LOCKED`(또는 `PARTICIPATING`)로 만들 수 있고, 상태기계가 되돌림을 금지하므로 **첫 잘못된 기록이 영구**하다. 이것이 "허위 LOCKED 선점"의 핵심이다(§6).
2. 제안: 원장을 **해시 체인으로 연결된 append-only 이벤트 로그**로 정의하고(§2), 상태 전이 요청에 **서명된 요청(EIP-712 `LedgerAction`)** 을 요구하며, 서명자를 **독립 레지스트리의 `Fund.managerId`** 와 대조한다(§3, §4). 운용사는 자기 펀드의 상태만 기록할 수 있다(타 펀드 대리 기록 금지).
3. 마감 확정(#10)은 원장에 `IPO_CLOSED` 이벤트로 들어간다. 이후 해당 IPO의 상태 이벤트는 거부되고, 컷오프 이전 순번만 확정 판정에 반영된다(§5).
4. `verifyBid` 통과가 참여 기록을 구속하지 않는 문제(ROADMAP 미결정 항목)는 **"접수된 입찰이 입찰 펀드의 PARTICIPATING을 원자적으로 기록"** 하는 규칙(BIND-1)으로 닫는 것을 제안한다(§7).
5. 이 설계로 막히지 않는 것은 §6.2에 따로 적었다: 운용사 키 탈취, 레지스트리 장악, 시퀀서의 순서 조작, 같은 운용사 내부 조작.
6. 소유자 결정이 필요한 열린 질문 4개(§9.3).

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
| `prevHash` | hex | 직전 이벤트의 `eventHash`. `seq = 1`은 고정 genesis 값 |
| `eventType` | enum | §2.3 |
| `ipoId` | 문자열 | 대상 IPO |
| `subjectFundId` | 문자열 \| null | 상태가 바뀌는 펀드. IPO 단위 이벤트는 `null` |
| `actorId` | 문자열 | 요청자(운용사 `managerId` 또는 운영자 역할 ID) |
| `authorization` | 객체 | `{scheme, requestNonce, expiresAt, signature}` (§3.2). 운용사 요청은 `scheme = EIP712_LEDGER_ACTION_V1`. 운영자 이벤트는 같은 규약의 별도 타입(`OperatorAction{action, ipoId, requestNonce, expiresAt}`)을 쓴다 |
| `payload` | 객체 | 이벤트 유형별(§2.3) |
| `registrySeq` | 정수 | 인가 판단에 사용한 레지스트리 버전(§4.3) |
| `requestedAt` | 정수(ms) | **요청자 주장 시각**. 신뢰하지 않음 |
| `recordedAt` | 정수(ms) | 시퀀서가 기록한 시각. 시퀀서 시계이며 참고용 |
| `eventHash` | hex | `sha256(canonicalJson(위 모든 필드, eventHash 제외, "ipo-proof/ledger-event/v1" 도메인 태그 포함))` |

서명은 감사용으로 이벤트에 보관하므로 체인 해시에 포함된다.

### 2.3 이벤트 유형

| `eventType` | 누가 | `payload` | 효과 |
| --- | --- | --- | --- |
| `PARTICIPATION_RECORDED` | 해당 펀드의 운용사 | `{from, to: "PARTICIPATING"}` | 상태 `UNKNOWN → PARTICIPATING` |
| `NON_PARTICIPATION_LOCKED_RECORDED` | 해당 펀드의 운용사 | `{from, to: "NON_PARTICIPATION_LOCKED"}` | 상태 `UNKNOWN → NON_PARTICIPATION_LOCKED` |
| `IPO_CLOSED` | 원장 운영자 | `{closesAt, ledgerSeqAtClose}` | 컷오프 확정. 이후 해당 IPO 상태 이벤트 거부(§5). `ledgerSeqAtClose`는 이 이벤트의 `seq - 1` |
| `IPO_FINALIZED` | 원장 운영자 | `{finalizationDigest}` | #10의 확정 레코드 다이제스트를 원장에 못박음 |
| `FINDING_ANNOTATED` | 운영자 또는 감사 역할 | `{targetSeq, kind, note}` | 사후 발견(폐기, 이의)을 **주석**으로만 기록. 상태에 영향 없음 |
| `MANAGER_KEY_REVOKED` | 키 관리 역할(#13) | `{managerId, revokedKeyId}` | 이 순번부터 해당 키로 서명된 새 요청 거부(§4.4) |

- 거부된 요청은 **체인에 넣지 않는다**. 거부 요청은 별도의 `RejectionAuditLog`(비권위, 용량 제한 가능)에 요청 해시, 사유 코드, 시각만 남긴다. 체인에 넣으면 스팸으로 체인이 부풀고, 감사 목적은 별도 로그로 충족된다.
- 현재 코드의 `LedgerEntry.{from,to}`는 `payload`로, `at`은 `recordedAt`으로 대응된다.

### 2.4 상태 도출

`state(fundId, ipoId, atSeq)` = `atSeq` 이하의 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED` 이벤트를 순서대로 `transition()`에 적용한 결과(없으면 `UNKNOWN`). `atSeq`를 받는 조회(`getStateAt`)가 #10의 컷오프 판정에 필요하다. 상태 전이 규칙 자체(`transition()`)는 변경하지 않는다.

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
| `FUND_MANAGER` (운용사) | **자기 `managerId`가 레지스트리상 운용사인 펀드**의 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED` 요청, 자기 펀드의 하위펀드 중 UNKNOWN 목록 조회 | 타 운용사 펀드 기록, 마감 처리, 레지스트리 수정 |
| `ATTESTER` | 증빙 발급(#11) | 원장 쓰기 |
| `LEDGER_OPERATOR` (시퀀서) | 순번 부여, `IPO_CLOSED`, `IPO_FINALIZED`, 체크포인트 서명 | 운용사 대신 상태 이벤트를 만드는 것(운용사 서명 없이는 거부) |
| `REGISTRY_ADMIN` | 펀드 레지스트리 변경 (§4.3) | 원장 상태 이벤트 |
| `AUDITOR` | 읽기 전용 | 쓰기 |

### 4.2 인가 규칙

| ID | 규칙 | 거부 코드(제안 이름) |
| --- | --- | --- |
| R1 | 서명자의 `actorId`는 레지스트리의 `Fund(subjectFundId).managerId`와 같아야 한다. **대리 기록은 없다**: 상위펀드 운용사도 하위펀드 상태를 기록할 수 없다 | `LEDGER_ACTOR_NOT_FUND_MANAGER` |
| R2 | `actorId`가 운용사 키 레지스트리에 있고 서명이 레지스트리 주소와 일치 | `LEDGER_ACTOR_UNKNOWN`, `LEDGER_SIGNATURE_INVALID` |
| R3 | `expiresAt` > 시퀀서의 현재 시각 | `LEDGER_REQUEST_EXPIRED` |
| R4 | `(actorId, requestNonce)`는 처음 보는 값. 동일한 서명 요청의 재전송은 **원래 결과를 그대로 돌려주고** 새 이벤트를 만들지 않는다(멱등). 같은 nonce에 다른 내용이면 거부 | `LEDGER_NONCE_REPLAY` |
| R5 | `fundId`, `ipoId`가 등록되어 있다 | `FUND_NOT_REGISTERED`, `IPO_NOT_FOUND` (기존 코드 재사용) |
| R6 | 해당 IPO에 `IPO_CLOSED`가 없다 | `IPO_ALREADY_CLOSED` |
| R7 | `transition()`이 허용한다 | 기존 `TransitionRejection` 그대로 |
| R8 | `IPO_CLOSED`/`IPO_FINALIZED`는 `LEDGER_OPERATOR` 서명이어야 하고, `IPO_CLOSED`는 시퀀서 시계가 `closesAt` 이상일 때만, IPO당 한 번만 | `LEDGER_OPERATOR_REQUIRED`, `IPO_NOT_YET_CLOSABLE`, `IPO_ALREADY_CLOSED` |
| R9 | 키 폐기 이벤트 순번 이후에는 그 키로 서명된 새 요청 거부 | `LEDGER_SIGNATURE_INVALID` (또는 전용 코드) |

판정 순서는 거부 사유가 정보 노출이 되지 않도록 인증(R2, R3, R4) → 인가(R1) → 도메인(R5~R7) 순을 제안한다. 서명이 유효하지 않은 호출자에게 펀드 등록 여부를 알려주지 않기 위해서다.

### 4.3 레지스트리 신뢰와 고정

R1은 레지스트리가 운용사–펀드 관계의 진실이라는 가정에 기댄다. 이 가정은 ARCHITECTURE에서도 "assumption, not enforced"로 적혀 있다. 이 문서의 제안:

- 레지스트리 변경도 **append-only 로그**(같은 봉투 형식, `REGISTRY_ADMIN` 서명)로 두고, 원장 이벤트가 인가 시 사용한 `registrySeq`를 기록한다. 사후에 "그 시점의 관계"를 재현할 수 있다.
- **`managerId` 변경은 해당 펀드가 연관된 IPO의 입찰 창이 열려 있는 동안 금지**(`REGISTRY_FROZEN_DURING_WINDOW`). 그렇지 않으면 공격자가 레지스트리를 바꾼 뒤 정당한 운용사로 행세해 기록할 수 있다.
- `underlyingFundIds` 변경은 창이 열려 있는 동안에도 허용하되 판정은 컷오프 시점의 값을 쓴다(이슈 #10 설계 E-10). 변경이 기록에 남는 것으로 충분하다고 본다.
- 레지스트리 관리자 자체가 악의적인 경우는 이 모델의 신뢰 범위 밖이다(T-04).

### 4.4 키 침해 대응 (최소)

- `MANAGER_KEY_REVOKED` 이벤트 순번 **이후** 새 요청을 거부한다. 이전에 기록된 이벤트는 그대로 유효하다(상태 되돌림 없음).
- 침해 시점과 폐기 시점 사이의 잘못된 기록은 되돌릴 수 없다. 대응책 후보(`EVENT_ANNULLED`)는 열린 질문으로 둔다(D14-Q1).

---

## 5. 마감 확정과의 연결

- `IPO_CLOSED`(R8)가 컷오프다. `ledgerSeqAtClose = 이벤트 seq - 1`. 이후 해당 IPO에 대한 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`는 R6으로 거부된다 → 마감 후 UNKNOWN은 영구 UNKNOWN(이슈 #10 설계 F2).
- `IPO_CLOSED`는 "시퀀서 시계 ≥ `closesAt`"에서만 추가될 수 있으나, 이 조건을 **제3자가 사후 검증할 수단은 약하다**(시퀀서 시계를 신뢰해야 함). 이것을 신뢰 가정 TA-1(= P14-A03)로 명시한다. 완화: 체크포인트와 접수 영수증, 그리고 온체인 이식 시 `block.timestamp` 기반 검사로 대체(#18). Solidity의 `block.timestamp`는 **초 단위**이며 현재 도메인 모델의 시각은 밀리초이므로 이식 시 단위 변환이 필요하다 〔Solidity docs · Units and Globally Available Variables · 2026-10-03〕.
- `IPO_FINALIZED`는 #10의 확정 레코드 다이제스트를 원장에 못박아, 확정 후 레코드가 바뀌면 탐지된다. 이 이벤트 이후에도 `FINDING_ANNOTATED`는 허용된다(상태에 영향 없음).
- 마감 후 증빙 폐기 등 사후 발견은 상태를 바꾸지 않고 주석으로만 남긴다(이슈 #10 설계 F5).

---

## 6. 위협 분석: 허위 LOCKED 선점과 인접 공격

### 6.1 영향 정리 (왜 심각한가)

원장 상태는 되돌릴 수 없고, 소비하는 쪽은 두 곳이다.

| 허위 기록 | 피해 펀드 `U` 자신 | `U`를 보유한 상위펀드 `P` |
| --- | --- | --- |
| 허위 `NON_PARTICIPATION_LOCKED` | 이 IPO 참여 불가 — `verifyBid`가 `NON_PARTICIPATION_LOCK_ACTIVE`로 거부(`verify.ts` 3단계). 되돌릴 수 없음 | `U`의 노출이 **면제**되어 `P`의 조정 용량이 부풀려짐. `U`가 실제로는 참여하고 `P`와 공모하면 용량 부풀리기가 됨 |
| 허위 `PARTICIPATING` | 이후 `NON_PARTICIPATION_LOCKED`를 기록할 수 없음(비참여 주장 불가) | `U`의 노출이 **차감**되어 `P`의 용량이 줄어듦(`P`에 대한 서비스 방해). 이슈 #10 설계의 E-07 |

### 6.2 공격 표

현재 코드에서는 T-01, T-02가 실제로 가능하다. "이 설계의 통제" 열은 이 문서의 설계가 적용된 뒤 상태다. (테스트 ID는 §8의 L-xx.)

| ID | 공격자 / 행동 | 현재 코드 | 이 설계의 통제 | 잔여 위험 |
| --- | --- | --- | --- | --- |
| T-01 | 인증 없는 호출자가 임의 펀드를 LOCKED/PARTICIPATING으로 만듦 | **가능** (호출자 개념 없음) | R1, R2: 서명과 `managerId` 대조 | – |
| T-02 | 인증된 **타 운용사**가 경쟁사 펀드를 선점 잠금(허위 LOCKED로 경쟁사 참여 봉쇄) | **가능** | R1: 서명자 ≠ 레지스트리 운용사이면 거부 (L-02) | 레지스트리가 틀리면 무력(T-04) |
| T-03 | 서명 요청 재사용(다른 IPO·펀드·시점) | – | 서명 대상에 `fundId`, `ipoId`, `targetState`, `requestNonce`, `expiresAt`, 도메인 분리 (L-03~L-08) | – |
| T-04 | 레지스트리의 `managerId`를 바꾼 뒤 정당한 운용사로 행세 | 레지스트리 독립성은 가정 | 입찰 창 중 `managerId` 변경 금지(§4.3), 레지스트리 변경 로그 | **레지스트리 관리자 자체가 악의적이면 막지 못함.** 독립성은 여전히 가정 |
| T-05 | 운용사 서명 키가 탈취되어 공격자가 그 운용사 펀드를 임의로 기록 | – | 폐기 후 새 요청 차단(R9) | 폐기 전 기록은 영구. 되돌림 수단 없음(D14-Q1) |
| T-06 | 시퀀서가 마감 직전 정당한 이벤트를 지연·검열하거나 순서를 바꿈 | 시퀀서 개념 없음 | 접수 영수증, 서명된 체크포인트, 해시 체인 | **시퀀서를 신뢰해야 함(TA-1).** 영수증으로 사후 분쟁 증거를 남길 뿐 강제하지 못함. 온체인에서는 블록 순서로 대체 |
| T-07 | 같은 운용사가 상·하위펀드를 모두 운용하며 자기편 상태를 유리하게 기록 | – | 없음(구조상 정당한 권한) | 이 모델의 신뢰 범위 밖. 레지스트리 `managerId` 동일 여부를 공개 데이터로 표시하는 정도만 가능 |
| T-08 | 운용사 담당자의 **오기록**(실수로 LOCKED) | – | 요청 전 `dry-run` 검증, 확인 단계(UI, #17) | 되돌림 불가 |
| T-09 | 거부 요청 대량 전송(스팸) | – | 거부는 체인에 안 들어감. 속도 제한은 구현 몫 | 가용성은 서비스 계층 이슈 |
| T-10 | 서명 요청을 가로채 먼저 제출(프런트러닝) | – | 같은 서명은 같은 효과(R4 멱등), 서명자 아닌 자가 내용을 바꿀 수 없음. EIP-712가 권장하는 "먼저 제출되어도 의도한 효과가 같음" 성질 (EIP-712 Frontrunning attacks 절) | – |
| T-11 | 사전 선점: IPO 등록 직후 자기 모든 펀드를 `PARTICIPATING`으로 일괄 기록해 경쟁사 상위펀드의 용량 축소 | – | R1은 막지 못함(자기 펀드 기록은 정당) | 열린 질문 D14-Q2(독립 참여 선언을 둘지) |

### 6.3 정리

허위 `NON_PARTICIPATION_LOCKED`의 두 갈래(경쟁사 봉쇄 / 용량 부풀리기) 중 **직접 통제되는 것은 호출자가 타 운용사일 때(T-01, T-02)뿐**이다. 해당 운용사가 스스로(또는 키 탈취로) 거짓 LOCKED를 기록하는 경우는 원장만으로는 막지 못한다. 규정은 소명 후 실제 참여한 경우의 효과를 정하지 않았으므로(A-028) 이 PoC도 사후 정정 효과를 모델링하지 않는다.

---

## 7. 입찰 접수와 원장의 결합 (BIND-1)

ROADMAP의 미결정 항목 "`verifyBid` 통과가 참여 기록을 구속하지 않는 점(검증 후 LOCKED 전환 가능)"에 대한 제안.

- **BIND-1**: 입찰 접수가 확정적으로 받아들여지는 순간(잠정 판정 `ELIGIBLE`)에 시스템이 **입찰 펀드의 `PARTICIPATING`을 원자적으로 기록**한다. 입찰 접수와 기록은 한 트랜잭션이다. 접수가 거부되면 기록하지 않는다.
- 효과: ① 입찰 후 자기 펀드 LOCKED 전환이 불가능(`PARTICIPATION_ALREADY_RECORDED`). ② 상위펀드는 하위펀드가 입찰한 사실을 `PARTICIPATING`으로 보게 된다(차감).
- 한계: 이벤트 서명은 운용사 서명이어야 하므로, BIND-1의 기록은 **입찰 요청에 `LedgerAction` 서명이 동봉되거나** 입찰 요청 자체가 `targetState = "PARTICIPATING"`을 서명 대상으로 포함해야 한다. 어느 쪽이 단순한지는 구현 시 결정(입찰 요청에 `LedgerAction` 서명을 동봉하는 쪽을 제안).
- 독립 참여 선언(`requestParticipation`)을 유지할지는 D14-Q2. 유지하면 이슈 #10 설계 E-06(서로 보유한 펀드 쌍)이 풀리지만 T-11이 열린다. 폐지하면 T-11이 닫히지만 E-06이 데드락이 된다.

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
| L-10 | 유효 서명으로 `PARTICIPATING → LOCKED`, `LOCKED → PARTICIPATING`, 동일 상태 반복 | 기존 `TransitionRejection`과 동일, 원장 불변 |
| L-11 | `IPO_CLOSED` 이후 상태 이벤트 | `IPO_ALREADY_CLOSED`, 원장 불변 |
| L-12 | 운영자 아닌 키로 `IPO_CLOSED` / 시퀀서 시계가 `closesAt` 이전 / 두 번째 `IPO_CLOSED` | `LEDGER_OPERATOR_REQUIRED` / `IPO_NOT_YET_CLOSABLE` / `IPO_ALREADY_CLOSED` |
| L-13 | 체인 중간 이벤트 변조, 삭제, 순서 교체 | 체인 검증이 최초 불일치 `seq`를 보고 |
| L-14 | `getStateAt(fund, ipo, seq)` | `seq` 이전 이벤트만 반영한 상태. 이후 이벤트가 있어도 불변 |
| L-15 | 입찰 창 중 `Fund.managerId` 변경 요청 / 마감 후 | `REGISTRY_FROZEN_DURING_WINDOW` / 허용되나 이미 기록된 이벤트·확정에는 영향 없음 |
| L-16 | 키 폐기 이벤트 `seq = n` 이후 해당 키 요청 / 그 이전에 기록된 이벤트 | 이후 요청 거부 / 이전 이벤트 상태 유지 |
| L-17 | BIND-1: 잠정 `ELIGIBLE` 입찰 접수 / 거부된 입찰 / 입찰 펀드가 이미 LOCKED | 입찰 펀드 PARTICIPATING 기록 / 기록 없음 / 접수 거부 |
| L-18 | BIND-1 이후 입찰 펀드가 LOCKED 요청 | `PARTICIPATION_ALREADY_RECORDED` |
| L-19 | `requestedAt`을 과거로 위조한 요청이 마감 이후 도착 | `IPO_ALREADY_CLOSED`. `requestedAt`은 판정에 쓰이지 않음 |
| L-20 | 거부 요청 100건 연속 | 체인 길이 불변, 거부 로그에만 기록 |
| L-21 | 같은 요청 데이터를 키 순서만 바꿔 직렬화 | 같은 `eventHash` (canonical JSON) |

공격 시나리오와의 대응: T-01, T-02 → L-02, T-03 → L-03~L-08, T-05 → L-16, T-06 → L-13(검출 한정), T-10 → L-04.

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
| (새) P14-A03 | 시퀀서(원장 운영자)는 단일 주체이며 `IPO_CLOSED`를 시계에 맞게 추가한다(TA-1) | 가정(신뢰) |

`P14-Axx`는 이 문서가 새로 두는 가정이며 ASSUMPTIONS에는 아직 없다.

### 9.2 미확인

- 규정상 정정·취소, 참여 취소 시 원장 효과: 확인하지 못함(RESEARCH §6, §8).
- 실무에서 하위 운용사가 상위 투자자에게 "IPO 비참여"를 증명하는 방법과 서류의 실제 형태: 확인하지 못함.
- `IPO_CLOSED` 시점의 실제 규정상 대응(수요예측 마감 시각): 확인하지 못함(#10 문서 P10-A09).

### 9.3 열린 질문 (소유자/리드 결정 필요)

| ID | 질문 | 선택지 | 기본 제안 |
| --- | --- | --- | --- |
| D14-Q1 | 잘못된 기록(키 탈취·오기록)을 마감 전에 정정할 수단을 둘 것인가? | (a) 없음(엄격). (b) 마감 전 한정 `EVENT_ANNULLED`: 운용사 키 + 레지스트리 관리자(또는 쿼럼) 공동 서명, 파생 상태를 UNKNOWN으로 되돌림, 마감 후 불가 | (a). (b)는 "되돌림 금지"라는 핵심 성질을 약화하므로 #13 쿼럼 설계 후 재검토 |
| D14-Q2 | 입찰과 독립인 `requestParticipation`을 유지할 것인가? | (a) 유지(현행, T-11 열림, E-06 해소). (b) 폐지하고 PARTICIPATING은 BIND-1로만 기록(T-11 닫힘, E-06 데드락) | (a) |
| D14-Q3 | 원장 운영자는 누구인가? | 단일 운영자 / 컨소시엄 / 온체인. README의 "Why not a central database" 논리와 직결 | 단일 운영자(PoC), 이식은 #18 |
| D14-Q4 | 시간 권위: 시퀀서 시계 vs 외부 시간 증명 | 시퀀서 시계(PoC) / 블록 시각(온체인) | 시퀀서 시계, 한계 명시 |

---

## 10. 후속 작업 (담당)

| 담당 | 작업 |
| --- | --- |
| 구현 봇 (#15 등) | 이벤트 봉투와 해시 체인, 서명된 요청 검증(#11의 서명 유틸 재사용), `getStateAt`, `IPO_CLOSED`/`IPO_FINALIZED`, 거부 로그, BIND-1, §8 시나리오 테스트. 이 PR은 구현을 포함하지 않음 |
| 보안QA | 이 문서 §4, §6의 권한 모델 리뷰(#14 리뷰 항목), `THREAT_MODEL.md`의 "Unauthorized state transition" 행 갱신(보안QA 담당 규칙) |
| 리서치 | #11 서명 스키마(별도 PR), #13 키 관리·쿼럼(D14-Q1 연동), #18 온체인 설계 |
| 소유자(진영) | D14-Q1 ~ Q4 |
| 리드 봇 | `ROADMAP.md` 미결정 항목(입찰 통과와 기록의 결합)과 `THREAT_MODEL.md`의 관련 서술 정리, P14-Axx의 ASSUMPTIONS 편입 여부 |

## 11. 출처

- EIP-712: Typed structured data hashing and signing — https://eips.ethereum.org/EIPS/eip-712 (domainSeparator 필드 정의, "It does not include replay protection", Frontrunning attacks 절; 2026-10-03 열람)
- Solidity 문서, Units and Globally Available Variables — https://docs.soliditylang.org/en/latest/units-and-global-variables.html (`block.timestamp`는 unix epoch 이후 초; 2026-10-03 열람)
- 규정 관련: 〔S1 · 제5조의3 ①1호 다목 단서, ② · 2026-10-03〕 — `REGULATORY_RESEARCH.md` §7 참조.
