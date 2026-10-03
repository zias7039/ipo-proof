# 설계: 참여 원장 이벤트 스키마와 상태 전이 호출자 인증·인가 (이슈 #14)

> **면책 (Disclaimer)**
> 이 문서는 **리서치/설계 PoC 문서**이며 **법률/규제 자문이 아니고 보안 감사도 아닙니다**. 규정에는 "참여 원장"이라는 개념이 없고, 이 문서의 원장·권한 모델은 PoC가 만든 구조입니다(`REGULATORY_ASSUMPTIONS.md` A-026). **프로덕션 규칙으로 사용 금지**입니다. 규정 관련 서술은 [`REGULATORY_RESEARCH.md`](../REGULATORY_RESEARCH.md)·[`REGULATORY_ASSUMPTIONS.md`](../REGULATORY_ASSUMPTIONS.md)(확인일 2026-10-03)를 연결하며, 그 문서가 확인하지 못했다고 적은 것은 여기서도 **미확인**입니다.

- 작성: 리서치 봇. 이슈: #14 (`Refs #14`). 상태: **설계 제안 (코드 변경 없음)**. 구현은 'IPO Proof 구현' 봇(#15), 권한 모델 리뷰는 보안QA 몫입니다(§10).
- 선행: 이슈 #10 설계 문서 — PR #26의 `docs/design/snapshot-and-finalization.md`(병합 전이면 PR #26 참조). 이 문서의 `IPO_CLOSED` 컷오프, 접수 영수증, 단조성(해당 문서 §3.4)은 그 문서에 의존합니다. UNKNOWN은 **거부**로 결정되었습니다(이슈 #10 코멘트, 진영, 2026-10-03).
- 후행: 이슈 #15(영속성), #18(온체인 컨트랙트 설계), #13(어테스터·운용사 키 관리).
- **결정 반영(2026-10-03, 리드 봇을 통해 전달된 진영 님 결정)**: ① D14-Q1: **마감 전 정정 허용, 마감 후 변경 불가.** `EVENT_ANNULLED` 이벤트로 append-only 해시 체인을 깨지 않고 정정한다(§2.3, §4.2 R10~R13, §5.1). ② D14-Q2: 독립 `requestParticipation` **유지**(§7). ③ D14-Q3/Q4: 진영 님이 임의 판단을 위임하여 **단일 원장 운영자가 순번과 시간 기준을 정하는 것**으로 확정(§6.4에 한계 명시). 규정이 요구하는 것이 아니라 PoC 단순화 선택입니다. ④ #11의 v2(`blindingSalt` 등)는 **보류**: 이 문서의 서명 규약은 v1과 같은 라이브러리·규칙을 쓰며 v2 필드에 의존하지 않습니다. ⑤ **마감 전 입찰 취소 가능, 마감 후 불가**(Q14-N4 해소): 취소는 입찰이 만든 BIND-1 기록만 되돌리며 운용사 단독 서명으로 처리한다(R15, §7). ⑥ **정정 승인자는 운용사 서명자와 독립된 주체여야 한다**(Q14-N1 해소): 동일 주체 서명은 거부하고, 레지스트리 관리자와 원장 운영자가 같은 주체이면 독립 승인으로 인정하지 않는다(R14, §4.5). 단일 운영자 선택(D14-Q3)과의 공존·한계는 §6.4.1에 있다.
- 코드 기준: `main` 커밋 3fa59ef(2026-10-03 확인)의 `packages/domain/src/participation.ts`. PR #23(UNKNOWN 거부)과 PR #24(EIP-712 검증)는 이미 병합되어 있습니다. 초안은 커밋 8e1ab58 기준이었고, 두 PR은 `participation.ts`를 바꾸지 않았음을 확인했습니다.

## 0. 요약

1. 현재 원장은 **누가** 전이를 요청하는지 모른다(`requestParticipation(fundId, ipoId)`에 호출자가 없음). 따라서 누구든 타 운용사 펀드를 `NON_PARTICIPATION_LOCKED`(또는 `PARTICIPATING`)로 만들 수 있고, 상태기계가 되돌림을 금지하므로 현재 코드에서는 **첫 잘못된 기록이 영구**하다. 이것이 "허위 LOCKED 선점"의 핵심이다(§6). 결정 D14-Q1에 따라 이 설계에서는 **마감 전에 한해** 공동 서명된 `EVENT_ANNULLED`로 되돌릴 수 있고, **마감 후에는 영구**하다.
2. 제안: 원장을 **해시 체인으로 연결된 append-only 이벤트 로그**로 정의하고(§2), 상태 전이 요청에 **서명된 요청(EIP-712 `LedgerAction`)** 을 요구하며, 서명자를 **독립 레지스트리의 `Fund.managerId`** 와 대조한다(§3, §4). 운용사는 자기 펀드의 상태만 기록할 수 있다(타 펀드 대리 기록 금지).
3. 마감 확정(#10)은 원장에 `IPO_CLOSED` 이벤트로 들어간다. 이후 해당 IPO의 상태 이벤트와 **정정 이벤트**는 거부되고, 컷오프 이전 순번만 확정 판정에 반영된다(§5).
4. `verifyBid` 통과가 참여 기록을 구속하지 않는 문제(ROADMAP 미결정 항목)는 **"접수된 입찰이 입찰 펀드의 PARTICIPATING을 원자적으로 기록"** 하는 규칙(BIND-1)으로 닫는 것을 제안한다(§7).
5. 이 설계로 막히지 않는 것은 §6.2에 따로 적었다: 운용사 키 탈취, 레지스트리 장악, 시퀀서의 순서 조작, 같은 운용사 내부 조작, 정정 공동 서명자(운용사–승인자)의 공모와 독립성 검사의 우회. 단일 운영자 선택의 한계는 §6.4에 모았다.
6. 소유자 결정 4개(D14-Q1~Q4)는 반영되었다(§9.3).
7. **정정 승인자는 독립 주체여야 한다**(R14). 시스템이 확인할 수 있는 것은 식별자·서명 키·신고된 `controllerId`의 상이함이고, 레지스트리 관리자와 원장 운영자가 같은 주체이면 정정 기능 자체를 끈다(fail closed). 실제 사람·조직의 독립성은 증명하지 못한다(§4.5, §6.4.1).
8. **마감 전 입찰 취소**(R15)는 입찰이 만든 `PARTICIPATING`만 되돌리고, 독립 승인 없이 운용사 서명만으로 처리한다. 대신 승인자의 속도 제한이 없다(T-17).
9. 남은 열린 질문은 Q14-N2, N3, N5, N6이다(§9.3).

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
| `authorization` | 객체 | `{scheme, requestNonce, expiresAt, signature}` (§3.2). 운용사 요청은 `scheme = EIP712_LEDGER_ACTION_V1`. 운영자 이벤트는 같은 규약의 별도 타입(`OperatorAction{action, ipoId, requestNonce, expiresAt}`)을 쓴다. 정정 이벤트는 `scheme = EIP712_LEDGER_ANNULMENT_V1` |
| `coAuthorizations` | 객체 배열 | 공동 서명. 정정 이벤트에서만 비어 있지 않다: 독립된 승인자의 `AnnulmentApproval` 서명 1건(§3.2, R10, R14). 다른 이벤트에서는 빈 배열 |
| `payload` | 객체 | 이벤트 유형별(§2.3) |
| `registrySeq` | 정수 | 인가 판단에 사용한 레지스트리 버전(§4.3) |
| `requestedAt` | 정수(ms) | **요청자 주장 시각**. 신뢰하지 않음 |
| `recordedAt` | 정수(ms) | 시퀀서가 기록한 시각. 시퀀서 시계이며 참고용 |
| `eventHash` | hex | `sha256(canonicalJson(위 모든 필드, eventHash 제외, "ipo-proof/ledger-event/v1" 도메인 태그 포함))` |

서명은 감사용으로 이벤트에 보관하므로 체인 해시에 포함된다.

### 2.3 이벤트 유형

| `eventType` | 누가 | `payload` | 효과 |
| --- | --- | --- | --- |
| `PARTICIPATION_RECORDED` | 해당 펀드의 운용사 | `{from, to: "PARTICIPATING", origin, bidId?}` — `origin`은 `INDEPENDENT`(독립 `requestParticipation`) 또는 `BIND_1`(입찰 접수로 기록, `bidId` 필수) | 상태 `UNKNOWN → PARTICIPATING` |
| `NON_PARTICIPATION_LOCKED_RECORDED` | 해당 펀드의 운용사 | `{from, to: "NON_PARTICIPATION_LOCKED", origin}` | 상태 `UNKNOWN → NON_PARTICIPATION_LOCKED` |
| `IPO_CLOSED` | 원장 운영자 | `{closesAt, ledgerSeqAtClose}` | 컷오프 확정. 이후 해당 IPO 상태 이벤트 거부(§5). `ledgerSeqAtClose`는 이 이벤트의 `seq - 1` |
| `IPO_FINALIZED` | 원장 운영자 | `{finalizationDigest}` | #10의 확정 레코드 다이제스트를 원장에 못박음 |
| `FINDING_ANNOTATED` | 운영자 또는 감사 역할 | `{targetSeq, kind, note}` | 사후 발견(폐기, 이의)을 **주석**으로만 기록. 상태에 영향 없음 |
| `MANAGER_KEY_REVOKED` | 키 관리 역할(#13) | `{managerId, revokedKeyId}` | 이 순번부터 해당 키로 서명된 새 요청 거부(§4.4) |
| `EVENT_ANNULLED` | `reason`이 `MISTAKEN_ENTRY`/`KEY_COMPROMISE`이면 해당 펀드의 운용사 + **독립된** 승인자(R10, R14). `reason = BID_WITHDRAWN`이면 운용사 단독(R15) | `{targetSeq, targetEventHash, reason, replacement, bidId?}` — `reason`은 `MISTAKEN_ENTRY` / `KEY_COMPROMISE` / `BID_WITHDRAWN`, `replacement`는 `null` 또는 `"PARTICIPATING"`/`"NON_PARTICIPATION_LOCKED"`, `bidId`는 `BID_WITHDRAWN`일 때만 | **마감 전에 한해** 대상 상태 이벤트를 무효로 표시하고 그 펀드의 **유효 상태**를 `UNKNOWN`으로 되돌린다. 대상 이벤트와 체인은 지워지지 않는다. `replacement`가 있으면 같은 요청이 바로 다음 순번에 해당 상태 이벤트(`origin = INDEPENDENT`)를 **원자적으로** 추가한다(사이에 다른 이벤트 없음) |

- **정정(annul)의 의미**: 정정은 과거 이벤트를 고치거나 지우지 않는다. 새 `EVENT_ANNULLED` 이벤트를 **뒤에 덧붙여** "순번 `targetSeq`의 이벤트는 더 이상 유효 상태를 만들지 않는다"고 선언한다. 해시 체인(§2.1)은 그대로 유지되고 `targetSeq`의 원래 이벤트도 감사용으로 남는다. 정정 이벤트를 다시 정정하는 이벤트는 없다. 되돌린 뒤 같은 상태나 다른 상태를 다시 기록하려면 새 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`를 추가한다.
- 거부된 요청은 **체인에 넣지 않는다**. 거부 요청은 별도의 `RejectionAuditLog`(비권위, 용량 제한 가능)에 요청 해시, 사유 코드, 시각만 남긴다. 체인에 넣으면 스팸으로 체인이 부풀고, 감사 목적은 별도 로그로 충족된다.
- 현재 코드의 `LedgerEntry.{from,to}`는 `payload`로, `at`은 `recordedAt`으로 대응된다.

### 2.4 상태 도출

`state(fundId, ipoId, atSeq)` = `atSeq` 이하의 이벤트를 순서대로 처리한 **유효 상태**: `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`는 `transition()`을 적용하고, `EVENT_ANNULLED`는 그 펀드·IPO의 유효 상태를 `UNKNOWN`으로 되돌린다(없으면 `UNKNOWN`). `atSeq`를 받는 조회(`getStateAt`)가 #10의 컷오프 판정에 필요하다. 상태 전이 규칙 자체(`transition()`)는 변경하지 않는다. `UNKNOWN`으로의 복귀는 `transition()`이 허용하는 전이가 아니라 **정정 이벤트로만** 생긴다(구현: 현재 가변 `Map` 대신 이벤트 접기(fold)로 유효 상태를 도출하는 구조가 필요하다).

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
| `FUND_MANAGER` (운용사) | **자기 `managerId`가 레지스트리상 운용사인 펀드**의 `PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED` 요청, 자기 펀드 이벤트의 **정정 요청**(관리자 공동 서명 필요), 자기 펀드의 하위펀드 중 UNKNOWN 목록 조회 | 타 운용사 펀드 기록·정정, 단독 정정, 마감 처리, 레지스트리 수정 |
| `ATTESTER` | 증빙 발급(#11) | 원장 쓰기 |
| `LEDGER_OPERATOR` (시퀀서) | 순번 부여, `IPO_CLOSED`, `IPO_FINALIZED`, 체크포인트 서명 | 운용사 대신 상태 이벤트를 만드는 것(운용사 서명 없이는 거부), 정정 승인 서명(R14: 승인자와 같은 주체이면 안 됨) |
| `REGISTRY_ADMIN` | 펀드 레지스트리 변경 (§4.3), 정정 요청에 대한 **승인 서명** — 단, 운용사 서명자 및 원장 운영자와 독립된 주체일 때만 유효(R14) | 원장 상태 이벤트 생성, 단독 정정, 운영자 겸직 상태에서의 승인 |
| `AUDITOR` | 읽기 전용 | 쓰기 |

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
| R8 | `IPO_CLOSED`/`IPO_FINALIZED`는 `LEDGER_OPERATOR` 서명이어야 하고, `IPO_CLOSED`는 시퀀서 시계가 `closesAt` 이상일 때만, IPO당 한 번만 | `LEDGER_OPERATOR_REQUIRED`, `IPO_NOT_YET_CLOSABLE`, `IPO_ALREADY_CLOSED` |
| R9 | 키 폐기 이벤트 순번 이후에는 그 키로 서명된 새 요청 거부 | `LEDGER_SIGNATURE_INVALID` (또는 전용 코드) |
| R10 | 정정 인증·인가: `LedgerAnnulment`는 대상 펀드의 현재 운용사 키로 서명(R1~R4 동일 적용), **그리고** `AnnulmentApproval`이 **독립된 승인자**(R14)의 키로 같은 `annulmentDigest`에 대해 서명되어 있어야 한다. 한쪽만으로는 정정 불가. (`reason = BID_WITHDRAWN`은 R15의 별도 경로) | `LEDGER_ANNUL_COSIGN_REQUIRED`, `LEDGER_ACTOR_NOT_FUND_MANAGER`, `LEDGER_SIGNATURE_INVALID` |
| R11 | 정정 대상 유효성: `targetSeq`의 이벤트가 **같은 IPO·같은 펀드**의 상태 이벤트(`PARTICIPATION_RECORDED`/`NON_PARTICIPATION_LOCKED_RECORDED`)이고 `targetEventHash`가 일치하며 아직 정정되지 않았다(현재 유효 상태를 만든 이벤트). 정정 이벤트 자체는 정정할 수 없다. `replacementState`가 있으면 정정 직후 상태(`UNKNOWN`)에서 `transition()`이 허용해야 하고, 하나라도 실패하면 요청 전체를 거부한다(원자성) | `LEDGER_ANNUL_TARGET_INVALID`, 기존 `TransitionRejection` |
| R12 | BIND-1(§7)이 입찰 접수로 기록한 `PARTICIPATING`(`origin = BIND_1`)은 R10 정정(운용사 + 승인자)의 대상이 될 수 없다. 해소하는 정식 경로는 **입찰 취소(R15)** 하나뿐이다. 정정 경로로 BIND-1을 우회해 입찰한 펀드를 잠그는 것(#10 E-09)을 막기 위함이다 | `LEDGER_ANNUL_BOUND_TO_BID` |
| R13 | 정정은 `IPO_CLOSED`보다 앞선 순번일 때만 효력이 있다. 같은 규칙의 반대면: 컷오프 이전에 정정된 상태는 확정 판정에 그대로 반영되고, 컷오프 이후의 정정 요청은 R6으로 거부된다 | `IPO_ALREADY_CLOSED` |
| R14 | **정정 승인자의 독립성**: 승인자는 운용사 서명자와 독립된 주체여야 하고, 레지스트리 관리자와 원장 운영자가 같은 주체이면 그 승인은 독립 승인으로 인정하지 않는다. 구체 검사(I1~I4, §4.5): ① `approverId ≠ actorId` ② 두 서명에서 복구한 주소가 서로 다르고 승인자 주소는 운용사·운영자 주소와도 다르다 ③ 신고된 `controllerId`가 운용사와 다르다 ④ 승인자 주체가 원장 운영자 주체와 같지 않다. **동일 주체 서명은 거부**한다. 설정이 ④를 만족하지 못하면(겸직) 정정 기능은 비활성(fail closed) | `LEDGER_ANNUL_APPROVER_NOT_INDEPENDENT`, `LEDGER_ANNUL_DISABLED` |
| R15 | **입찰 취소 경로**(#10 §3.7): `BidWithdrawal`은 입찰 펀드의 현재 운용사 키로 서명(R1~R4 동일 적용)하고, `bidId`는 그 펀드·IPO의 **활성** 입찰이어야 하며(`BID_NOT_FOUND`, `BID_ALREADY_WITHDRAWN`), 마감 전이어야 한다(R6). 입찰이 BIND-1로 만든 `PARTICIPATING`(`origin = BIND_1`, 같은 `bidId`)이 유효 상태이면 `EVENT_ANNULLED(reason = BID_WITHDRAWN, bidId)`를 **운용사 서명만으로, 승인자 없이** 원자적으로 추가한다(입찰 이전 상태로 되돌릴 뿐 새 권한이 아니므로 R10·R14의 대상이 아님). `afterState`가 있으면 이어서 재기록한다. 유효 상태가 `origin = INDEPENDENT`이거나 바인딩이 없으면 원장 이벤트는 없다(입찰 저장소만 변경). 재제출로 대체된 입찰은 바인딩을 유지하고, 마지막 활성 입찰이 취소될 때에만 해소한다 | `LEDGER_ACTOR_NOT_FUND_MANAGER`, `IPO_ALREADY_CLOSED`, `BID_NOT_FOUND`, `BID_ALREADY_WITHDRAWN` |

판정 순서는 거부 사유가 정보 노출이 되지 않도록 인증(R2, R3, R4, R10의 서명 검증) → 인가(R1, R10의 승인자 권한, R14 독립성) → 도메인(R5~R7, R11~R13, R15)순을 제안한다. 서명이 유효하지 않은 호출자에게 펀드 등록 여부를 알려주지 않기 위해서다.

### 4.3 레지스트리 신뢰와 고정

R1은 레지스트리가 운용사–펀드 관계의 진실이라는 가정에 기댄다. 이 가정은 ARCHITECTURE에서도 "assumption, not enforced"로 적혀 있다. 이 문서의 제안:

- 레지스트리 변경도 **append-only 로그**(같은 봉투 형식, `REGISTRY_ADMIN` 서명)로 두고, 원장 이벤트가 인가 시 사용한 `registrySeq`를 기록한다. 사후에 "그 시점의 관계"를 재현할 수 있다.
- **`managerId` 변경은 해당 펀드가 연관된 IPO의 입찰 창이 열려 있는 동안 금지**(`REGISTRY_FROZEN_DURING_WINDOW`). 그렇지 않으면 공격자가 레지스트리를 바꾼 뒤 정당한 운용사로 행세해 기록할 수 있다.
- `underlyingFundIds` 변경은 창이 열려 있는 동안에도 허용하되 판정은 컷오프 시점의 값을 쓴다(이슈 #10 설계 E-10). 변경이 기록에 남는 것으로 충분하다고 본다.
- 레지스트리 관리자 자체가 악의적인 경우는 이 모델의 신뢰 범위 밖이다(T-04).

### 4.4 키 침해 대응 (최소)

- `MANAGER_KEY_REVOKED` 이벤트 순번 **이후** 새 요청을 거부한다. 폐기 이벤트 자체는 이전 이벤트의 상태를 되돌리지 않는다.
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
- `IPO_FINALIZED`는 #10의 확정 레코드 다이제스트를 원장에 못박아, 확정 후 레코드가 바뀌면 탐지된다. 이 이벤트 이후에도 `FINDING_ANNOTATED`는 허용된다(상태에 영향 없음).
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
- **정정과의 관계**: BIND-1이 기록한 `PARTICIPATING`은 활성 입찰이 있는 동안 정정할 수 없다(R12). 독립 선언으로 기록한 `PARTICIPATING`은 정정할 수 있다. 같은 상태가 어떤 경로로 기록되었는지 이벤트의 `payload`에 `origin`(`INDEPENDENT` | `BIND_1`, 제안)을 남겨 R12가 구분할 수 있게 한다.

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

공격 시나리오와의 대응: T-01, T-02 → L-02, T-03 → L-03~L-08, T-05 → L-16, L-32, T-06 → L-13(검출 한정), T-08 → L-22, T-10 → L-04, T-12 → L-34~L-37(동일 주체 거부, 공모는 막지 못함을 문서화), T-16 → L-38(키 재사용만 검출, 나머지는 한계), T-17 → L-39~L-46(속도 제한 없음을 문서화), T-13 → L-28, L-31, T-14 → L-30, L-39. T-15는 시나리오로 검증할 수 없고 체인 가시성(L-22, L-33)에만 의존한다.

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

---

## 10. 후속 작업 (담당)

| 담당 | 작업 |
| --- | --- |
| 구현 봇 (#15 등) | 이벤트 봉투와 해시 체인, 서명된 요청 검증(#11의 서명 유틸 재사용, v1 규칙 그대로), 이벤트 접기(fold)로 유효 상태 도출과 `getStateAt`, `IPO_CLOSED`/`IPO_FINALIZED`, **`EVENT_ANNULLED`와 공동 서명 검증(R10~R13), 승인자 독립성 검사 R14(I1~I5, `PRINCIPAL_KEY_REUSE`, 설정 시 `LEDGER_ANNUL_DISABLED`), 입찰 취소 경로 R15(`BidWithdrawal` 서명, `afterState`, 입찰 저장소 연동), 정정+재기록 원자 처리**, `payload.origin` 구분, 거부 로그, BIND-1, §8 시나리오(L-01~L-46) 테스트. 이 PR은 구현을 포함하지 않음 |
| 보안QA | 이 문서 §4, §6의 권한 모델 리뷰(#14 리뷰 항목), 정정 도입에 따른 새 공격면(T-12~T-17), 독립성 검사(R14)의 우회 가능성과 최초 설정 신뢰(T-16), 입찰 취소 반복(T-17)과 §6.4 단일 운영자 한계 검토, Q14-N3(`IPO_CLOSED` 지연) 판단, `THREAT_MODEL.md`의 "Unauthorized state transition" 행 갱신(보안QA 담당 규칙) |
| 리서치 | #11 서명 스키마(별도 PR), #13 키 관리·쿼럼(D14-Q1 연동), #18 온체인 설계 |
| 소유자(진영) | 반영된 결정 확인(Q14-N1, N4 해소). 남은 열린 질문 Q14-N2, N3, N5, N6 |
| 리드 봇 | `ROADMAP.md` 미결정 항목(입찰 통과와 기록의 결합)과 `THREAT_MODEL.md`의 관련 서술 정리, P14-Axx의 ASSUMPTIONS 편입 여부 |

## 11. 출처

- EIP-712: Typed structured data hashing and signing — https://eips.ethereum.org/EIPS/eip-712 (domainSeparator 필드 정의, "It does not include replay protection", Frontrunning attacks 절; 2026-10-03 열람)
- Solidity 문서, Units and Globally Available Variables — https://docs.soliditylang.org/en/latest/units-and-global-variables.html (`block.timestamp`는 unix epoch 이후 초; 2026-10-03 열람)
- 규정 관련: 〔S1 · 제5조의3 ①1호 다목 단서, ② · 2026-10-03〕 — `REGULATORY_RESEARCH.md` §7 참조.
