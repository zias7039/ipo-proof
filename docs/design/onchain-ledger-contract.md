# 설계: 온체인 원장 컨트랙트 (이슈 #18)

> **면책 (Disclaimer)**
> 이 문서는 **리서치/설계 PoC 문서**이며 **법률/규제 자문이 아니고 보안 감사도 아닙니다**. 여기서 제안하는 온체인 구조는 설계 선택지와 PoC 기본값이며 **규정이 요구하는 것이 아닙니다**. 블록체인에 기록한다고 해서 데이터가 사실이 되거나 규제 당국이 수용하는 것이 아닙니다(README '해결하지 못하는 것').

- 작성: 리서치 봇. 이슈: #18 (`Refs #18`, 이슈를 닫지 않음). 상태: **설계 문서 (코드 변경 없음)**. 구현은 #19(구현 봇), 리뷰는 보안QA, 프라이버시·ZK는 #20입니다.
- 기준: `main` `0eb5d89`. 입력 설계: #10(`snapshot-and-finalization.md`), #11(`eip712-attestation-schema.md`, PR #28 병합), #14(`participation-ledger-events.md`, PR #27 병합), #13(어테스터 키 관리·쿼럼 — 별도 PR #44, **병합 전**이므로 이 문서는 그 내용을 "제안"으로만 참조).
- 외부 표준 확인일: 2026-10-04 (ERC-1271). 그 밖의 EIP/Solidity 사실은 #11 문서 §12의 열람 기록(2026-10-03)을 따릅니다.
- 형식: **설계 표기만** 사용합니다. 인터페이스는 이름·인자 타입·권한·불변식을 표로 적으며 구현 코드를 포함하지 않습니다. 이름은 모두 제안입니다.

---

## 0. 요약

1. **무엇을 온체인에 둘까**: 이 문서는 **3단계(Tier)** 로 나눕니다(§2, §3).
   - **Tier 1 (권고 최소)**: 원장 본체는 오프체인(#14)에 두고, 온체인에는 ① 서명된 **체크포인트 앵커** `{ledgerId, seq, eventHash}`, ② **규칙 버전 커밋**, ③ **어테스터 집합 커밋**, ④ **IPO 생애주기 앵커**(개설 파라미터 고정, `IPO_CLOSED`, `IPO_FINALIZED`)만 둔다.
   - **Tier 2 (선택)**: 펀드별 참여 상태(`UNKNOWN → PARTICIPATING | NON_PARTICIPATION_LOCKED`)와 마감 불변식을 온체인 상태기계로. 펀드 ID·참여 사실이 공개된다는 비용이 있어 소유자 결정이 필요하다(Q18-1).
   - **Tier 3 (범위 밖)**: 입찰 금액·증빙·판정 계산·전체 이벤트를 온체인에. 금액 비노출 원칙과 충돌한다.
2. **금액은 어떤 경우에도 온체인에 올리지 않는다**(원칙). 금액이 든 EIP-712 서명 메시지·서명·다이제스트도 calldata로 올리지 않는다(#11 §3.2, §7.0). 해시 앵커링은 금액 비노출이지만 **다이제스트 프라이버시 한계**가 있다(§5.2).
3. **해시 앵커링**: 원장의 SHA-256 해시 체인은 그대로 두고, 온체인에는 `eventHash`(32바이트)를 **값으로 저장만** 한다. 온체인에서 체인을 재계산하지 않으면 SHA-256 ↔ keccak-256 통일이 필요 없다(§4).
4. **시간**: 정본은 오프체인 정수 epoch ms. 온체인 앵커 대상 시각은 **1000의 배수 ms만 허용**해 초 변환의 손실·반올림 문제를 없앤다(§6). 마감의 권위는 시각이 아니라 `IPO_CLOSED`의 **순번**(F1)이므로 온체인 시각은 **증거**이지 판정이 아니다.
5. **업그레이드·관리자**: Tier 1 컨트랙트는 **업그레이드 불가(immutable)** 를 기본값으로 하고, 교체는 새 배포 + 후계 포인터 이벤트로 한다. 소유자는 멀티시그 컨트랙트(권고). 관리자가 **할 수 없는 일** 목록을 불변식으로 둔다(§8).
6. **상태 전이 불변식 목록**(이슈 인수 기준)은 §7, **구분표**(인수 기준)는 §2, **README와의 일치**는 §10, **위협 분석**은 §9, **수용 기준**은 §11, **열린 질문**은 §12(Q18-1~Q18-12)입니다.

---

## 1. 입력: 이미 결정된 것과 이 문서가 새로 정하는 것

| 출처 | 이미 결정/사실 | 이 문서의 사용 |
| --- | --- | --- |
| #14 (병합) | 원장 = 오프체인 append-only 해시 체인(SHA-256, canonical JSON), 단일 운영자(TA-1, P14-A03), 서명된 체크포인트 `{seq, eventHash}`, 이벤트 유형(`IPO_CLOSED`, `IPO_FINALIZED`, `EVENT_ANNULLED` 등), 마감 후 변경 불가(D14-Q1) | 앵커 대상. 원장 본체를 바꾸지 않음 |
| #10 (병합) | 마감 컷오프 = **원장 순번**(F1), 확정 = 동결 입력의 순수 함수(F3), 확정 레코드 불변(F4), 시간은 운영자 시계, `inputsDigest`/`finalVerdictDigest`는 **내부 전용** | 앵커링할 확정 다이제스트의 선택(§5.2, Q18-4) |
| #11 (병합) | v1 유지(v2·`blindingSalt` 보류). 서명 메시지·다이제스트는 금액 포함 → 공개 금지. 온체인 이식 결정 목록(§8) | §3~§6에서 항목별로 답함 |
| #13 (PR #44, 병합 전) | 어테스터 집합에 `attesterSetSeq`, `threshold`, 키 폐기 효력, ERC-1271은 PoC 오프체인 미지원이 기본 | 어테스터 집합 커밋(§3.2)과 서명 검증 위치(§3.4)를 이 제안에 맞춤. 채택 전에는 변동 가능 |
| README | 블록체인은 **아직 구현되지 않음**. 해결하는 것: 변조 증거가 남는 append-only 전이 기록, 규칙 버전·어테스터 집합의 공개 커밋. 해결 못하는 것: 쓰레기 입력, 프라이버시, 법적 유효성, 오프체인 집행, 거버넌스 | §10 정합 표 |
| 이 문서가 정함(제안) | 온체인/오프체인 구분, 앵커 형식, 시간 변환 규칙, 컨트랙트 구성, 권한, 불변식, 위협, 수용 기준 | – |

기준 시점에 Solidity 구현은 없습니다(`main`에 `.sol` 파일 없음; 2026-10-04 확인).

---

## 2. 온체인 / 오프체인 구분표 (이슈 인수 기준)

범례: **ON** = 온체인에 저장/이벤트, **OFF** = 오프체인, **HASH** = 해시(또는 다이제스트)만 온체인, **NEVER** = 어떤 경우에도 온체인에 올리지 않음.

| 항목 | Tier 1 | Tier 2 | 금액 포함? | 이유 |
| --- | --- | --- | --- | --- |
| 참여 원장 이벤트 본문(봉투, payload) | OFF | OFF | 아니오(#14는 금액 미포함) | 크기·가스, 펀드 ID·시각 공개 방지 |
| 원장 체크포인트 `{ledgerId, seq, eventHash}` | **ON** (서명 검증 후 저장) | ON | 아니오 | 되감기·잘라내기 탐지(#14 §2.5, 보안QA #37) |
| `IPO_CLOSED` 앵커 `{ipoId, closesAtSec, ledgerSeqAtClose, eventHash}` | **ON** | ON | 아니오 | 마감 컷오프의 공개 증거. `ledgerSeqAtClose`는 활동량 단서(§5.3) |
| `IPO_FINALIZED` 앵커 `{ipoId, finalizationDigest}` | **ON**(**공개용** 다이제스트만, §5.2) | ON | 아니오여야 함 | 내부 전용 `finalVerdictDigest`는 금액 추측 위험(#10 §2.4) |
| IPO 개설 파라미터 고정 `{ipoId, closesAtSec, ruleVersionId, attesterSetSeq}` | **ON** | ON | 아니오 | 창 중 변경 금지의 공개 증거 |
| 규칙 버전 커밋 `{ruleVersionId, ruleSpecDigest}` | **ON** | ON | 아니오 | README의 공개 커밋. 규칙 명세 본문은 OFF |
| 어테스터 집합 커밋 `{attesterSetSeq, setDigest, threshold}` | **ON** | ON | 아니오 | README의 공개 커밋. 집합 본문(주소 목록)을 ON으로 할지 HASH로 할지는 Q18-6 |
| 어테스터 키 폐기 | ON(집합 커밋의 일부, #13 제안) | ON | 아니오 | 열린 IPO에 소급(제안) |
| 펀드별 참여 상태 `(fundId, ipoId) → state` | OFF | **ON** | 아니오 | Tier 2에서만. 참여 사실·펀드 ID가 공개됨(§5.3) |
| 펀드–운용사 관계(레지스트리) | OFF | OFF(또는 HASH) | 아니오 | 개인정보성·변경 잦음 |
| 입찰 금액 `bidAmount` | **NEVER** | **NEVER** | **예** | 금액 비노출 원칙 |
| 어테스테이션 본문(`grossCapacityKrw`, `underlyingExposures`) | **NEVER** | **NEVER** | **예** | 〃 |
| 어테스테이션 서명·EIP-712 다이제스트 | **NEVER**(calldata 포함) | **NEVER** | 간접(무차별 대입) | #11 §7.0, §7.3: 공개하면 금액 추측 확인 가능 |
| `inputsDigest`, `attestationDigest`, `finalVerdictDigest` | **NEVER** | NEVER | 간접 | #10 §2.4: 내부 전용 |
| 판정 계산(`verifyBid`/`finalize`) | OFF | OFF | – | 결정론적 TypeScript 엔진. 온체인 재계산은 금액 필요 → 범위 밖 |
| 접수 영수증, 거부 요청 감사 로그 | OFF | OFF | 아니오 | 용량·스팸 |
| 서명 검증 증거(ERC-1271 등, #13 §6.4) | OFF | OFF | 아니오 | 어댑터 소관 |
| 운영자(앵커 서명자) 키 목록, 소유자 | **ON** | ON | 아니오 | 앵커 서명 검증 필요 |

원칙: **판정과 금액은 오프체인, 변조 증거와 공개 커밋은 온체인**. 이 구분이 README의 "해결하는 것/하지 못하는 것"과 일치하는지는 §10에서 대조합니다.

---

## 3. 구성과 인터페이스 스케치

### 3.1 컨트랙트 구성 (제안)

| 컨트랙트(이름 제안) | Tier | 책임 |
| --- | --- | --- |
| `Commitments` | 1 | 규칙 버전 커밋, 어테스터 집합 커밋 저장·조회. 덮어쓰기 금지 |
| `LedgerAnchor` | 1 | 체크포인트 앵커, IPO 개설 파라미터 고정, `IPO_CLOSED`/`IPO_FINALIZED` 앵커. `Commitments`를 참조 |
| `ParticipationRegistry` | 2 (선택) | 펀드별 상태 전이와 마감 불변식. `LedgerAnchor`의 IPO 상태를 참조 |
| (온체인 서명 검증 로직) | 1 내장 | 체크포인트 서명 검증(운영자 EOA 또는 ERC-1271 소유 컨트랙트). 라이브러리/내부 함수 |

한 컨트랙트로 합칠지 여러 개로 나눌지는 구현 선택입니다. 나누는 이유는 (a) 커밋은 영구 불변, 앵커는 교체 가능이라는 수명 차이, (b) 업그레이드 표면 축소(§8)입니다.

### 3.2 `Commitments` (설계 표기)

| 연산 (이름: 인자 → 반환) | 호출 권한 | 사전조건 | 효과/이벤트 | 불변식 |
| --- | --- | --- | --- | --- |
| `commitRuleVersion(ruleVersionId: bytes32, ruleSpecDigest: bytes32)` | `OWNER` | 같은 ID가 없음 | `RuleVersionCommitted(ruleVersionId, ruleSpecDigest, byWho)` | INV-C1 덮어쓰기 금지 |
| `commitAttesterSet(attesterSetSeq: uint64, setDigest: bytes32, threshold: uint16)` | `OWNER`(또는 #13의 승인 구조를 반영한 컨트랙트 소유자) | `attesterSetSeq == 직전 + 1` | `AttesterSetCommitted(attesterSetSeq, setDigest, threshold)` | INV-C2 순번 단조 |
| `revokeAttesterKey(keyDigest: bytes32, atSetSeq: uint64)` (선택) | #13 제안: 어테스터 본인 서명 또는 관리자 | 아직 폐기되지 않음 | `AttesterKeyRevoked(...)` | INV-C3 되돌림 없음 |
| `getRuleVersion(ruleVersionId)` → `ruleSpecDigest` | 누구나 | – | – | – |
| `getAttesterSet(attesterSetSeq)` → `{setDigest, threshold}` | 누구나 | – | – | – |

- `ruleVersionId`/`ruleSpecDigest`의 해시 함수와 `ruleSpecDigest`가 덮는 직렬화는 오프체인 정의(#10 `ruleSpecDigest`)를 그대로 쓴다. 온체인은 32바이트를 저장만 한다.
- `setDigest`가 덮는 내용(주소·`controllerId`·상태)은 #13이 확정되기 전이므로 이 문서는 정하지 않는다(Q18-6).

### 3.3 `LedgerAnchor` (설계 표기)

| 연산 (이름: 인자 → 반환) | 호출 권한 | 사전조건 | 효과/이벤트 | 불변식 |
| --- | --- | --- | --- | --- |
| `openIpo(ipoId: bytes32, closesAtSec: uint64, ruleVersionId: bytes32, attesterSetSeq: uint64)` | `OWNER` | `ipoId` 신규, 규칙 버전·집합이 `Commitments`에 존재, `closesAtSec > block.timestamp`(초) | `IpoOpened(...)`, 상태 `NONE → OPEN` | INV-A1 파라미터 불변, INV-A2 단방향 |
| `anchorCheckpoint(ledgerId: bytes32, seq: uint64, eventHash: bytes32, operatorSig: bytes)` | **누구나**(서명이 유효해야 함) | `seq > 마지막 앵커 seq`(같은 `ledgerId`), 서명자가 현재 허용된 운영자 | `CheckpointAnchored(ledgerId, seq, eventHash, anchoredAtSec)` | INV-A3 seq 단조, INV-A4 같은 seq 재앵커 금지 |
| `anchorClose(ipoId: bytes32, ledgerSeqAtClose: uint64, eventHash: bytes32, operatorSig: bytes)` | 누구나(서명 유효) | 상태 `OPEN`, 해당 seq의 체크포인트가 이미 앵커되었거나 이 호출이 함께 앵커 | `IpoCloseAnchored(ipoId, ledgerSeqAtClose, eventHash, anchoredAtSec)`, 상태 `OPEN → CLOSED` | INV-A2, INV-A5 |
| `anchorFinalization(ipoId: bytes32, publicFinalizationDigest: bytes32, eventHash: bytes32, operatorSig: bytes)` | 누구나(서명 유효) | 상태 `CLOSED`, 아직 확정 앵커 없음 | `IpoFinalizationAnchored(...)`, 상태 `CLOSED → FINALIZED` | INV-A2, INV-A6 한 번만 |
| `reportEquivocation(ledgerId: bytes32, seq: uint64, eventHashA: bytes32, sigA: bytes, eventHashB: bytes32, sigB: bytes)` | 누구나 | 같은 `seq`에 서로 다른 해시에 대한 **유효한 운영자 서명 두 개** | `EquivocationProven(ledgerId, seq, hashA, hashB)` | INV-A7 증거는 영구 기록 |
| `setOperatorSigner(newSigner: address)` / `retireOperatorSigner(...)` | `OWNER` | – | `OperatorSignerChanged(...)` | 이전 서명자 앵커는 유효 유지(§8) |
| `getAnchor(ledgerId, seq)` → `eventHash` | 누구나 | – | – | – |
| `getIpo(ipoId)` → `{status, closesAtSec, ruleVersionId, attesterSetSeq, closeSeq, finalizationDigest}` | 누구나 | – | – | – |

- **누구나 게시 가능 + 운영자 서명 필수**: 서명된 체크포인트(#14 §2.5)를 운용사·감사인이 대신 올릴 수 있어 운영자 검열/지연에 대한 내성이 생긴다. 반면 운영자 서명이 없는 앵커는 거부한다. 운영자가 서명 자체를 거부(미발행)하면 이 구조로도 막지 못한다(§9 B-T05).
- 체크포인트 서명의 EIP-712 타입(이름 제안: `LedgerCheckpoint{ledgerId, seq, eventHash}`)은 **v1 증빙 도메인과 분리된 별도 도메인**(예: `ipo-proof LedgerAnchor`)을 쓴다. 증빙 서명과 체크포인트 서명이 서로 재사용되지 않게 한다.
- 운영자가 컨트랙트 지갑(멀티시그)이면 ERC-1271로 검증하게 할 수 있다(Q18-8).

### 3.4 `ParticipationRegistry` (Tier 2, 선택, 설계 표기)

| 연산 (이름: 인자 → 반환) | 호출 권한 | 사전조건 | 효과/이벤트 | 불변식 |
| --- | --- | --- | --- | --- |
| `recordParticipation(ipoId, fundKey: bytes32, managerSig)` | 해당 펀드의 운용사 서명 | IPO `OPEN`, 상태 `UNKNOWN` | 상태 `UNKNOWN → PARTICIPATING`, `ParticipationRecorded(ipoId, fundKey)` | INV-P1 전이 제한, INV-P2 마감 후 불가 |
| `recordLocked(ipoId, fundKey, managerSig)` | 〃 | IPO `OPEN`, 상태 `UNKNOWN` | `UNKNOWN → NON_PARTICIPATION_LOCKED` | 〃 |
| `annul(ipoId, fundKey, targetSeq, managerSig, independentApproverSig)` | 운용사 + **독립 승인자**(#14 R14) | IPO `OPEN`(마감 전) | 유효 상태를 `UNKNOWN`으로 되돌림(이벤트로 추가) | INV-P3 마감 후 불가, INV-P4 승인자 독립 |
| `getState(ipoId, fundKey)` → state | 누구나 | – | – | – |

- `fundKey`: 펀드 ID의 해시. **펀드 ID 목록은 공개 정보이므로 해시는 비밀을 지키지 못한다**(사전 대입). Tier 2는 "참여 사실 공개"를 전제로 한다(§5.3).
- Tier 2는 #14의 인가 규칙 R1~R15 전부를 온체인에서 재현하지 못한다(순번 기반 `registrySeq`, `controllerId` 독립성 등). 어디까지 온체인에서 강제하고 어디부터 오프체인 규약에 맡길지는 Q18-1과 함께 결정해야 한다.

### 3.5 서명 검증 위치 (#11 §8 결정 항목)

| 서명 | 검증 위치(제안) | 이유 |
| --- | --- | --- |
| 체크포인트(운영자) | **온체인**(컨트랙트가 `ecrecover` 또는 ERC-1271) | 앵커의 신뢰는 서명자 신원에 달림. 메시지에 금액 없음 |
| 증빙(어테스터, `CapacityAttestation`) | **오프체인**(엔진). 온체인에 올리지 않음 | calldata로 올리면 금액 공개(#11 §3.2). 온체인 재서명 이식도 같은 문제 |
| 운용사 요청(`LedgerAction`) | Tier 1: 오프체인. Tier 2: 온체인(금액 없음) | Tier 2에서만 |
| 정정 승인(`AnnulmentApproval`) | 〃 | 〃 |

ERC-1271(확인일 2026-10-04): 컨트랙트 서명자는 `isValidSignature(bytes32 hash, bytes signature)`가 매직 값 `0x1626ba7e`를 반환해야 하며 `view`여야 합니다. 외부 호출 시 **가스량을 하드코딩하지 말라**고 합니다. 온체인 검증에서 컨트랙트 서명자를 허용하면 호출 가스와 재진입 표면이 생기므로 Tier 1은 **EOA 운영자 서명자를 기본**으로 하고, 멀티시그 운영자는 Q18-8로 둡니다.

---

## 4. 원장 해시 앵커링

### 4.1 선택지

| 안 | 내용 | 온체인 저장 | 장점 | 단점 |
| --- | --- | --- | --- | --- |
| H1 매 이벤트 앵커 | 모든 이벤트의 `eventHash`를 온체인에 | 이벤트 수 × 32바이트 | 가장 강한 되감기 탐지 | 가스·지연, **이벤트별 해시 공개로 추측 확인 위험**(§5.2) |
| H2 **주기·마일스톤 앵커(권고)** | `IPO_CLOSED`/`IPO_FINALIZED` 직후와 주기적으로 `{seq, eventHash}` | 체크포인트 수 × 32바이트 | 가스 낮음, 중간 해시 비공개 | 앵커 사이 구간은 되감기 탐지 불가(운영자 서명 체크포인트가 있으면 증거) |
| H3 Merkle 루트 | 구간 이벤트의 루트를 앵커 | 구간당 32바이트 | 중간 해시 숨김, 포함 증명 가능 | Merkle 구성·증명 도입(해시 체인과 이중 구조) |
| H4 앵커 없음 | 오프체인 체크포인트만 | 0 | 가장 단순 | 외부 체크포인트가 없으면 끝부분 잘라내기 탐지 불가(보안QA #37) |

**권고(PoC 기본): H2.** 보안QA 이슈 #37이 지적한 "체크포인트 없는 끝부분 잘라내기"를 막으려면 최소한 `IPO_CLOSED`와 `IPO_FINALIZED` 시점의 `{seq, eventHash}`를 외부에 둬야 하고, 온체인 앵커가 그 외부 저장소 역할을 합니다.

### 4.2 해시 함수

| 항목 | 현재 | 온체인 앵커링에서 |
| --- | --- | --- |
| 원장 해시 체인 | SHA-256, canonical JSON(#14 §2.1) | 온체인은 32바이트를 **저장만** 하고 체인을 재계산하지 않으므로 변경 불필요 |
| EIP-712 | keccak-256 | 체크포인트 서명 검증에만 사용 |
| 온체인에서 체인 재계산이 필요해지는 경우 | – | canonical JSON은 온체인에서 구현이 비현실적이므로 **대상 아님**. 필요하면 별도 설계(이벤트 봉투를 바이너리 고정 레이아웃으로)가 먼저 필요 |

결론: **해시 함수 통일은 Tier 1에서 필요 없습니다.** #11 §8의 "해시 함수 통일 여부" 질문에 대한 답은 "앵커 용도에서는 불필요, 온체인 재검증을 요구하는 Tier에서 재논의"입니다(Q18-5).

### 4.3 ID 표현

- `ipoId`, `ledgerId`: 오프체인 `string`. 온체인은 `bytes32 = keccak256(utf8(id))` 제안. 이 ID들은 공개 정보이므로 해시의 목적은 비밀이 아니라 고정 길이다.
- #11 §7.4의 `bytes32` ID(v2 보류)와 별개입니다. 증빙 ID는 온체인에 올리지 않으므로 이 질문은 Tier 1에서 발생하지 않습니다.

---

## 5. 가스와 프라이버시

### 5.1 가스

| 항목 | 설계가 가스에 미치는 영향 | 측정/미확인 |
| --- | --- | --- |
| 체크포인트 앵커(H2) | 앵커당 저장 1~2슬롯 + 서명 검증 1회 + 이벤트 1개 | 정확한 가스는 구현 후 측정 필요(#19). 이 문서는 수치를 주장하지 않음 |
| 서명 검증 | EOA는 `ecrecover` 1회. 컨트랙트 서명자는 임의 코드(가스 상한 설정 필요, §3.5) | 〃 |
| 이벤트 vs 저장 | 조회가 중요한 값(`eventHash`, IPO 상태)은 저장, 이력은 이벤트 | 선택은 #19 |
| 배치 | H3처럼 루트만 올리면 이벤트 수와 무관하게 비용이 일정 | 도입 여부는 Q18-2 |
| 최종성 | 앵커를 "확정"으로 간주하기까지 대기하는 블록 수는 **체인별 정책 설정값** | 이 문서는 수치를 정하지 않음 |

### 5.2 프라이버시 원칙과 다이제스트 프라이버시 한계

**원칙(재확인)**: 공개 체인에 **평문 금액을 올리지 않는다.** 금액이 든 서명 메시지, 서명, 그 EIP-712 다이제스트도 올리지 않는다(#11 §7.0, §7.3).

**다이제스트 한계**: "해시니까 안전하다"는 가정은 성립하지 않습니다. 해시는 **입력 공간이 작을 때 추측으로 확인**됩니다.

| 대상 | 온체인에 올리나 | 한계 |
| --- | --- | --- |
| EIP-712 다이제스트 / `attestationDigest` / `inputsDigest` / `finalVerdictDigest` | **올리지 않음** | 금액·다른 필드가 알려진 경우 금액 추측을 해시로 확인 가능(#10 §2.4, #11 §7.3). `blindingSalt`는 보류 중이라 완화책이 없음 |
| 원장 `eventHash`(앵커) | 올림 | 이벤트는 금액이 없지만 **저엔트로피**(펀드 ID는 공개 목록, `eventType`·상태는 소수, 시각은 ms지만 범위가 좁음). **H1처럼 모든 `eventHash`를 공개하면** 관찰자가 "펀드 X가 순번 n에서 PARTICIPATING" 같은 후보 이벤트를 재구성해 해시로 확인할 수 있다. `eventHash`는 `prevHash`를 덮으므로 `prevHash`가 비공개인 한 후보 이벤트만으로는 확인하기 어렵다. H2/H3은 중간 해시를 공개하지 않아 이 점에서 완화되지만, **인접한 두 순번이 모두 앵커되면**(앞 이벤트의 해시가 곧 `prevHash`로 공개됨) 뒤 이벤트의 후보 확인이 가능하다(예: `IPO_CLOSED` 직후 이벤트가 곧바로 `IPO_FINALIZED`인 경우) |
| `IPO_FINALIZED.finalizationDigest` | **공개용 변형만** | #14는 `IPO_FINALIZED` payload를 `{finalizationDigest}`로 정의하고 "#10 확정 레코드 다이제스트"라 부른다. #10은 `finalVerdictDigest`(내부 전용)와 별도의 **공개 영수증 해시(금액·`attestationDigest` 제외)** 를 구분한다. 어느 쪽이 `finalizationDigest`인지 두 문서가 명시하지 않으므로 **확인 필요**(Q18-4). 내부용이 원장 이벤트에 들어 있으면 `eventHash`가 그 다이제스트를 덮으므로 온체인 `eventHash`가 간접적으로 금액 추측의 확인 수단이 될 수 있다(모든 다른 필드가 알려진 경우) |
| 공개 확정 영수증 해시 | 올릴 수 있음(Tier 1 `publicFinalizationDigest`) | 금액·증빙 다이제스트를 뺀 필드만 덮어야 함. 어떤 필드를 덮는지는 #10 영수증 정책을 따름 |
| 체크포인트 서명 | 올림 | 운영자 서명. 금액 없음 |

완화 선택지(결정 필요, Q18-3):

1. **중간 해시 비공개**: H2/H3 사용, 이벤트별 해시를 공개하지 않는다(권고).
2. **솔트 커밋**: 이벤트 또는 확정 다이제스트에 운영자만 아는 솔트를 포함하고 감사 시 공개. 원장 봉투 변경이 필요해 #14 변경 사항이 되므로 이 문서는 제안만 한다.
3. **ZK/커밋–리빌**: #20 범위.

### 5.3 앵커·상태 자체가 드러내는 정보

금액이 없어도 다음은 공개됩니다.

| 정보 | Tier 1 | Tier 2 | 설명 |
| --- | --- | --- | --- |
| IPO 존재·마감 시각·규칙 버전·어테스터 집합 | 공개 | 공개 | 의도된 공개 커밋 |
| 활동량 | **단서 공개**: `ledgerSeqAtClose`, 체크포인트 `seq` | 공개 | 이벤트 총수에서 참여 활동의 규모를 추정 가능. 금액은 아님 |
| 타이밍 | 앵커 트랜잭션 시각 | 이벤트별 트랜잭션 시각 | 트랜잭션 메타데이터(송신 주소, 가스, 블록 시각)는 해시와 무관하게 공개 |
| 펀드별 참여 여부 | 비공개(원장 OFF) | **공개**(`PARTICIPATING`/`LOCKED`) | 어떤 펀드가 어떤 IPO에 참여/잠금했는지가 드러남. 펀드 ID 해시는 사전 대입으로 복원 가능 |
| 송신 주소와 운용사 연결 | 운영자 주소만 | 운용사 키 주소 | 주소–운용사 연결 가능성 |

Tier 2는 이 정보 공개가 PoC 목적에 허용되는지 소유자 확인이 필요합니다(Q18-1). Tier 1은 펀드별 정보를 올리지 않습니다.

---

## 6. 시간 단위 (ms vs `block.timestamp` 초)

사실(#11 §3.2가 인용한 Solidity 문서): `block.timestamp`는 unix epoch **초 단위**입니다. 오프체인 PoC의 시각은 정수 epoch **밀리초**(`issuedAt`, `expiresAt`, `closesAt`, `submittedAt`, `recordedAt`)입니다.

| 질문 | 제안 |
| --- | --- |
| 정본은? | **오프체인 ms가 정본.** 온체인은 파생 사본 |
| 변환 | 온체인 앵커 대상 시각(`closesAt`)은 **1000의 배수 ms만 허용**한다(설정 시 검증). 그러면 `closesAtSec = closesAtMs / 1000`이 정확하고 반올림 규칙이 필요 없다. 1000의 배수가 아닌 `closesAt`은 `openIpo` 전에 오프체인에서 거부한다 |
| 증빙(`issuedAt`, `expiresAt`) | 온체인에 올리지 않음(§2). 따라서 ms→s 변환이 필요 없음. 온체인 검증을 도입하려면 재서명 필요(#11 §3.2) |
| 판정의 시각 기준 | 마감의 권위는 **`IPO_CLOSED`의 순번**(F1)이다. 온체인 `closesAtSec`와 `block.timestamp`는 **증거**이며 판정을 바꾸지 않는다 |
| 증거로서의 사용 | `anchorClose`의 `anchoredAtSec`(= `block.timestamp`)과 `closesAtSec`의 차이를 이벤트에 남겨, 운영자가 늦게 닫거나 늦게 앵커했는지를 공개 증거로 쓴다. **시퀀서 시계 신뢰 가정(TA-1)을 없애지는 못한다** |
| `block.timestamp`의 정확도 | 블록 생산자가 정하는 값이며 정확한 벽시계가 아니다. 초 이하 정밀도를 가정하지 않는다. 체인별 규칙은 **이 조사에서 확인하지 못함**(대상 체인이 정해지지 않음) |
| 비교 방향 | 온체인 사전조건은 `closesAtSec > block.timestamp`(개설 시)처럼 **엄격 부등호**만 사용하고, 동일 초 경계의 모호성을 서술하지 않는다. 경계 동작은 수용 기준에서 고정(OC-12) |
| 시간 연산 | 시각 차이는 초 단위 정수. 부호 있는 계산 금지(언더플로 방지는 구현 관심사) |

---

## 7. 상태 전이와 불변식 목록 (이슈 인수 기준)

### 7.1 IPO 상태기계 (온체인, Tier 1)

```
NONE --openIpo--> OPEN --anchorClose--> CLOSED --anchorFinalization--> FINALIZED
```

(위는 상태 이름을 나타낸 도식이며 코드가 아닙니다.) 역방향 전이와 건너뛰기는 없습니다.

### 7.2 불변식

| ID | 불변식 | 대응(오프체인/문서) | 위반 시 |
| --- | --- | --- | --- |
| INV-C1 | 한번 커밋된 `ruleVersionId → ruleSpecDigest`는 바뀌지 않는다 | #10 규칙 버전 고정 | revert |
| INV-C2 | `attesterSetSeq`는 단조 증가하며 건너뛰지 않는다 | #13 `attesterSetSeq` | revert |
| INV-C3 | 폐기된 어테스터 키는 되돌아오지 않는다 | #13 `REVOKED` 종단 | revert |
| INV-A1 | 개설된 IPO의 `closesAtSec`, `ruleVersionId`, `attesterSetSeq`는 바뀌지 않는다 | 창 중 변경 금지(#13, #14 §4.3) | revert |
| INV-A2 | IPO 상태는 `NONE → OPEN → CLOSED → FINALIZED`로만 진행한다(역행·건너뛰기 없음) | #14 `IPO_CLOSED` → `IPO_FINALIZED` 선행 관계 | revert |
| INV-A3 | 같은 `ledgerId`의 앵커된 `seq`는 엄격 증가한다 | #14 순번 | revert |
| INV-A4 | 한번 앵커된 `(ledgerId, seq) → eventHash`는 바뀌지 않는다. 같은 `seq`에 다른 해시를 앵커하려는 시도는 거부되고, 두 서명이 모두 유효하면 `reportEquivocation`으로 증거화할 수 있다 | #14 체크포인트 | revert / 증거 이벤트 |
| INV-A5 | `anchorClose`가 앵커하는 `ledgerSeqAtClose`는 서명된 마감 체크포인트 메시지의 값과 일치해야 한다(#14: `IPO_CLOSED` 이벤트 순번 − 1). 컨트랙트가 직접 검증하는 범위는 서명된 메시지 내용과의 일치까지이며, 오프체인 원장과의 일치는 감사 몫이다 | #14 `ledgerSeqAtClose` | revert |
| INV-A6 | 확정 앵커는 IPO당 한 번이며 `CLOSED` 이후에만 가능하다. 확정 후 덮어쓰기 없음 | #10 F4, #14 D14-Q1 | revert |
| INV-A7 | 앵커·증거 이벤트는 삭제되지 않는다(관리자도 불가) | append-only | 구조상 불가 |
| INV-A8 | 앵커에는 **금액·증빙·내부 다이제스트가 포함되지 않는다**(저장·이벤트·calldata 모두) | 금액 비노출 원칙 | 설계 위반(테스트로 점검) |
| INV-A9 | 체크포인트는 현재 또는 이전에 허용된 운영자 서명자의 유효 서명을 가져야 한다 | #14 체크포인트 | revert |
| INV-A10 | `CLOSED` 이후 해당 IPO의 `openIpo` 파라미터를 바꾸는 호출이 없다 | – | revert |
| INV-P1 | (Tier 2) 펀드 상태 전이는 `UNKNOWN → PARTICIPATING` 또는 `UNKNOWN → NON_PARTICIPATION_LOCKED`만. `PARTICIPATING ↔ LOCKED`, 같은 상태 반복, `UNKNOWN`으로의 직접 복귀는 없음 | `packages/domain/src/participation.ts` `transition()` | revert |
| INV-P2 | (Tier 2) IPO 상태가 `CLOSED` 이후이면 상태 이벤트 거부 | #14 마감 후 변경 불가, F1 | revert |
| INV-P3 | (Tier 2) 정정(annul)은 마감 전에만. 마감 후 불가 | D14-Q1 | revert |
| INV-P4 | (Tier 2) 정정 승인자는 운용사 서명자·운영자와 독립(주소 수준 확인) | R14 | revert. `controllerId` 수준은 온체인에서 강제 불가(P14-A06) |
| INV-P5 | (Tier 2) 정정은 유효 상태를 `UNKNOWN`으로 되돌리는 **이벤트 추가**이며 과거 이벤트를 지우지 않는다 | #14 §2.3 | – |

---

## 8. 업그레이드와 관리자 권한

### 8.1 선택지

| 안 | 내용 | 장점 | 단점 |
| --- | --- | --- | --- |
| U1 **불변(immutable)** | 업그레이드 불가. 변경은 새 배포 + 후계 포인터 | 관리자가 로직을 바꿔 과거 앵커를 훼손할 수 없음. 감사 표면 작음 | 버그 수정 시 마이그레이션 필요 |
| U2 프록시 업그레이드 | 관리자가 구현을 교체 | 버그 수정 용이 | 관리자 키가 모든 불변식을 우회할 수 있는 단일 실패점. 타임락·거버넌스 필요 |
| U3 모듈형 | 커밋은 불변, 앵커/등록 컨트랙트는 교체 가능, 교체 이력은 이벤트 | 수명이 다른 부분을 분리 | 구성 복잡 |

**권고(PoC 기본): U1 (Tier 1 불변) + U3 요소**: `Commitments`는 불변, `LedgerAnchor`도 불변이되 새 버전은 새로 배포하고 `Successor(newAddress)` 이벤트로 알린다. 과거 앵커는 옛 컨트랙트에 남는다.

### 8.2 역할

| 역할 | 할 수 있는 일 | 할 수 없는 일 | 키 보관 권고 |
| --- | --- | --- | --- |
| `OWNER` | 규칙 버전·어테스터 집합 커밋, 운영자 서명자 교체, IPO 개설, 후계 선언 | 기존 커밋·앵커 수정/삭제, 확정 후 IPO 변경, 금액 열람(없음), 이벤트 삭제 | 멀티시그 컨트랙트(권고) + 타임락(길이는 정책, 이 문서는 수치 미정) |
| `OPERATOR_SIGNER` | 체크포인트·마감·확정 메시지 서명 | 온체인 상태를 직접 변경(서명 메시지만 만들고 누구나 게시) | 별도 키. #13 §3 보관 권고 |
| 임의 호출자 | 유효 서명이 있는 앵커 게시, 증거 게시, 조회 | 서명 없는 앵커 | – |
| (Tier 2) 운용사 키 | 자기 펀드의 상태 기록 | 타 펀드 기록 | #13/#14 |
| (Tier 2) 독립 승인자 | 정정 승인 | 단독 정정 | #14 R14 |

- **일시 정지(pause)** 기능은 두지 않는 것을 기본값으로 합니다. 정지 권한은 관리자가 앵커 게시를 막는 검열 수단이 되고, 앵커는 이미 서명 검증이 있어 정지의 이점이 작기 때문입니다(Q18-9).
- **운영자 서명자 교체**: 교체 후에도 이전 서명자로 서명된 **기존 앵커는 유효**합니다. 교체 이후의 새 앵커만 새 서명자를 요구합니다. 교체 시점은 `block.number`/이벤트로 남깁니다.
- **소유자 = 운영자 겸직 금지**(권고): 같은 키가 앵커 서명과 설정 변경을 모두 가지면 운영자 침해가 곧 파라미터 변경이 됩니다. #14의 독립성 사고방식을 따릅니다.
- 거버넌스는 사람/기관의 결정이며(README), 이 문서는 권한 분리와 증거만 제공합니다.

### 8.3 관리자 침해 시 한계

- `OWNER` 키가 탈취되면 새 규칙 버전 커밋·새 어테스터 집합 커밋·운영자 서명자 교체·IPO 개설이 가능합니다. **과거 커밋·앵커는 바꿀 수 없습니다.** 열린 IPO의 파라미터는 INV-A1로 고정됩니다.
- 이 문서는 소유자 변경(`transferOwnership`)의 타임락·2단계 절차를 권고하되 세부는 #19에서 정합니다.

---

## 9. 위협 분석

| ID | 위협 | 영향 | 완화 | 잔여 위험 |
| --- | --- | --- | --- | --- |
| B-T01 | 소유자 키 탈취 | 새 커밋·서명자 교체·IPO 개설 | 멀티시그+타임락, INV-A1/C1 불변, 열린 IPO 보호, 이벤트 공개 | 신규 IPO에 대한 악의적 파라미터 개설은 막지 못함 |
| B-T02 | 운영자 서명자 키 탈취 | 허위 체크포인트·허위 마감/확정 앵커 | INV-A4(같은 seq 재앵커 금지)로 **먼저 앵커된 값이 우선**, `reportEquivocation`으로 이중 서명 증거화, 서명자 교체. 탈취자가 **먼저 올리면** 정당한 앵커가 거부될 수 있음 | 앵커 경합: 허위 앵커가 선점하는 경우 회복 절차가 필요(Q18-10). 현재 설계는 선점을 막지 못함 |
| B-T03 | 운영자가 서명을 지연·미발행·선택 발행 | 마감 증거 지연, 일부 구간 비앵커 | 누구나 게시 가능(서명된 체크포인트가 있다면). 접수 영수증(#14)을 증거로 | 운영자가 서명 자체를 안 하면 막지 못함(TA-1) |
| B-T04 | 되감기/끝부분 잘라내기 | 마감 이후 이벤트 삭제 후 새 체인 제시 | `IPO_CLOSED`/`IPO_FINALIZED` 앵커. 감사인이 오프체인 원장과 앵커를 대조 | 앵커 이후 구간의 되감기는 다음 앵커 전까지 증거 없음(H2) |
| B-T05 | 금액 누출(calldata, 이벤트, 다이제스트) | 원칙 위반 | INV-A8, 구분표(§2) NEVER 항목, 코드리뷰·테스트로 점검(OC-20) | 개발 중 실수는 막을 수 없음(보안QA) |
| B-T06 | 다이제스트 추측 확인(§5.2) | 참여/비참여·금액 후보 확인 | 중간 해시 비공개(H2), 공개용 다이제스트만, 솔트(제안) | 저엔트로피 이벤트의 잔여 노출. 완전 해결 불가 |
| B-T07 | 메타데이터 분석(주소, 시각, 가스) | 참여 시점·활동량 추정 | Tier 1은 운영자 주소만, 배치 앵커 | Tier 2에서 심화 |
| B-T08 | 서명 재생(체크포인트가 다른 체인/컨트랙트에서 재사용) | 타 환경 위조 | EIP-712 도메인에 `chainId`, `verifyingContract`, 전용 이름(`ipo-proof LedgerAnchor`) 포함 | 도메인 설정 규율(#11 §3.3과 같은 한계) |
| B-T09 | 서명 가변성·형식 혼용 | 같은 서명의 다른 표현으로 중복/우회 | 앵커 키는 **서명 바이트가 아니라 `(ledgerId, seq)`**. EOA 서명은 low-`s`, `v∈{27,28}`만 허용(#11 §6과 같은 규칙) | 라이브러리 선택 오류 |
| B-T10 | ERC-1271 운영자(멀티시그) 호출의 가스 소진·재진입 | 앵커 DoS | Tier 1 기본은 EOA. 허용 시 가스 상한 설정값, 읽기 전용 호출, 실패는 거부 | 한도 과소 설정 시 정당한 앵커 거부(ERC-1271 보안 고려사항) |
| B-T11 | 재구성(reorg)·최종성 | 앵커가 사라지거나 순서가 바뀜 | 앵커를 "확정"으로 쓰기 전 **체인별 최종성 정책** 대기, 재게시 가능(같은 서명 재사용 가능) | 정책 값은 대상 체인이 정해져야 확정 |
| B-T12 | `block.timestamp` 조작/부정확 | 마감 증거의 신뢰 저하 | 시각은 증거일 뿐 판정은 순번(F1). 초 이하 정밀도를 가정하지 않음 | TA-1 유지 |
| B-T13 | 후계 컨트랙트 전환 중 앵커 공백 | 증거 단절 | `Successor` 이벤트, 새 컨트랙트가 옛 마지막 앵커를 첫 앵커로 재게시 | 운영 절차 |
| B-T14 | 컨트랙트 버그 | 불변식 위반 | 불변 배포 전 보안QA, 수용 기준(§11), 속성 기반 테스트(#22) | 불변 배포이므로 수정=재배포 |
| B-T15 | 쓰레기 입력(침해/거짓 어테스터) | 허위 증빙이 정상 판정 | 해결 못함(README). #13이 완화 | 구조적 한계 |
| B-T16 | 이벤트 로그 의존(RPC가 로그를 누락/위조) | 조회 오류 | 중요 값은 저장소에서도 조회 가능하게 설계, 여러 RPC 교차 확인 권고 | 클라이언트 책임 |
| B-T17 | 규칙 버전 사칭(같은 ID, 다른 명세) | 판정 기준 혼동 | INV-C1(덮어쓰기 금지) | 오프체인에서 `ruleSpecDigest` 대조 필요 |
| B-T18 | Tier 2 인가 우회(온체인에서 `controllerId` 독립성 미확인) | 승인자 독립성 약화 | 주소 수준 독립만 강제, 나머지는 운영 규약 | P14-A05/A06 |

---

## 10. README '블록체인이 해결하지 못하는 것'과의 정합

| README 항목 | 이 설계에서의 위치 | 일치 여부 |
| --- | --- | --- |
| 쓰레기 입력 — 원장은 어테스터 데이터가 사실인지 모른다 | 어테스트 본문은 온체인에 없고, 앵커·커밋은 데이터 진위를 보증하지 않는다고 명시(B-T15, 면책) | 일치 |
| 프라이버시 — 공개 데이터는 공개, 금액 비노출 설계 | 금액 NEVER 구분(§2), INV-A8, 다이제스트 한계(§5.2), Tier 2 공개 정보(§5.3) | 일치(한계 명시) |
| 법적 유효성/규제 수용 | 면책, 규정 근거 없음 | 일치 |
| 오프체인 집행 — 인수회사가 판정을 따르게 강제 못함 | 판정은 오프체인, 온체인은 증거만. 집행 주체 없음 | 일치 |
| 거버넌스 — 규칙 버전·어테스터 집합 갱신 권한은 사람/기관 결정 | `OWNER`/멀티시그, 권한 분리, 관리자가 못 하는 일 목록(§8). 거버넌스 자체는 해결하지 않음 | 일치 |
| 해결하는 것: 변조 증거가 남는 append-only 전이 기록 | 체크포인트·마감·확정 앵커(H2), 이벤트 삭제 불가(INV-A7) | 일치(앵커 사이 구간 한계 명시) |
| 해결하는 것: 규칙 버전·어테스터 집합 공개 커밋 | `Commitments`, INV-C1/C2, INV-A1 | 일치 |

---

## 11. 수용 기준 (테스트 가능한 시나리오)

전제: `OWNER`(멀티시그 모사), 운영자 서명자 `op1`, `ledger_x`, `ipo_1`(`closesAtSec = T`), 규칙 버전 `rv1`, 어테스터 집합 `set1`. 금액은 어디에도 등장하지 않는다. 이름은 제안입니다.

| ID | 시나리오 | 기대 |
| --- | --- | --- |
| OC-01 | `rv1` 커밋 후 같은 ID로 다른 digest 커밋 시도 | revert (INV-C1) |
| OC-02 | `attesterSetSeq`를 건너뛰어 커밋(예: 1 다음 3) | revert (INV-C2) |
| OC-03 | `OWNER`가 아닌 계정이 규칙 버전 커밋 | revert |
| OC-04 | 존재하지 않는 `rv`로 `openIpo` | revert |
| OC-05 | `openIpo` 후 같은 `ipo_1`을 다른 파라미터로 다시 개설 | revert (INV-A1) |
| OC-06 | 개설 후 `closesAtSec`/`attesterSetSeq` 변경 시도 | 변경 호출이 존재하지 않거나 revert |
| OC-07 | `op1` 유효 서명으로 `anchorCheckpoint(ledger_x, 10, h10)` | 성공, 이벤트 발생 |
| OC-08 | 임의 계정이 `op1`의 서명된 체크포인트를 대신 게시 | 성공 (누구나 게시 가능) |
| OC-09 | `op1`이 아닌 서명으로 체크포인트 게시 | revert (INV-A9) |
| OC-10 | `seq=10` 앵커 후 `seq=9` 게시 | revert (INV-A3) |
| OC-11 | `seq=10`에 다른 `eventHash`로 재앵커 | revert (INV-A4) |
| OC-12 | `closesAtSec`와 같은 초에 개설/앵커 호출(경계) | 문서화된 한쪽 동작으로 고정(엄격 부등호). 테스트가 경계 결과를 명시 |
| OC-13 | 같은 `seq`에 서로 다른 해시에 대한 `op1` 유효 서명 둘로 `reportEquivocation` | 성공, `EquivocationProven` 이벤트 |
| OC-14 | 한쪽 서명이 무효인 `reportEquivocation` | revert |
| OC-15 | `OPEN` 아님(`NONE`)에서 `anchorClose` | revert (INV-A2) |
| OC-16 | `anchorClose` 후 다시 `anchorClose` | revert |
| OC-17 | `CLOSED`에서 `anchorFinalization` | 성공 → `FINALIZED` |
| OC-18 | `OPEN`에서 `anchorFinalization`(마감 앵커 없이) | revert (INV-A2) |
| OC-19 | `FINALIZED` 후 다시 확정 앵커 | revert (INV-A6) |
| OC-20 | 모든 공개 호출의 calldata·이벤트·저장소에 금액 필드가 없음을 인터페이스 검토/ABI 점검으로 확인 | 금액·증빙·내부 다이제스트를 받는 인자가 없음 (INV-A8) |
| OC-21 | `closesAtMs`가 1000의 배수가 아닌 값으로 개설 준비 | 오프체인 변환 단계에서 거부(컨트랙트는 초 값만 받음) |
| OC-22 | 운영자 서명자 교체 후, 교체 전 서명자 서명의 기존 앵커 | 유효 유지 |
| OC-23 | 운영자 서명자 교체 후, 이전 서명자 서명으로 새 앵커 게시 | revert |
| OC-24 | `OWNER`가 기존 앵커를 삭제/수정하려는 호출 | 해당 호출이 존재하지 않음 (INV-A7) |
| OC-25 | 도메인(`chainId`/`verifyingContract`)이 다른 환경용 체크포인트 서명 제출 | revert |
| OC-26 | 서명 가변성 변형(high-`s`, `v` 0/1) 제출 | revert |
| OC-27 | 컨트랙트 서명자 운영자(허용한 경우): `0x1626ba7e` 외 반환/revert/가스 초과 | 앵커 거부 |
| OC-28 | (Tier 2) `UNKNOWN → PARTICIPATING` 후 `LOCKED` 시도 | revert (INV-P1) |
| OC-29 | (Tier 2) `CLOSED` 후 상태 기록 | revert (INV-P2) |
| OC-30 | (Tier 2) 승인자 주소 = 운용사 서명자 주소 | revert (INV-P4) |
| OC-31 | 오프체인 원장 100개 이벤트를 임의 체크포인트 간격으로 앵커하고 감사 스크립트가 온체인 `eventHash`와 오프체인 체인을 대조 | 일치. 한 이벤트를 변조하면 불일치 탐지 |
| OC-32 | 오프체인 원장 끝부분 10개를 삭제한 사본 vs 앵커 | 앵커된 `seq`보다 짧으면 탐지. 앵커 이후만 삭제되면 탐지 불가(H2 한계를 테스트로 문서화) |
| OC-33 | `OWNER` 키 탈취 모의: 새 `rv2`와 새 집합 커밋 후 열린 `ipo_1`의 파라미터 변경 시도 | 열린 IPO 파라미터는 불변 (INV-A1) |
| OC-34 | 후계 컨트랙트 선언 후 옛 컨트랙트의 앵커 조회 | 계속 조회 가능 |

---

## 12. 열린 질문과 기본값 (진영 님 결정 필요)

| ID | 질문 | 기본값(제안) | 이유/대안 |
| --- | --- | --- | --- |
| Q18-1 | 온체인 범위: Tier 1만 vs Tier 2(펀드별 참여 상태)까지 | **Tier 1만** | Tier 2는 참여 사실·펀드 ID 공개(§5.3). 이슈 #18 제목은 "참여 상태기계를 온체인에"이므로 소유자가 Tier 2 필요성을 판단 |
| Q18-2 | 앵커 방식 | **H2**(마일스톤+주기). 주기 값은 정책(수치 미정) | H1은 해시 공개 위험, H3은 구성 복잡 |
| Q18-3 | 다이제스트 프라이버시 완화 | **중간 해시 비공개(H2)**. 솔트 커밋은 후속 | 솔트는 #14 봉투 변경 필요 |
| Q18-4 | `IPO_FINALIZED.finalizationDigest`가 내부용인가 공개용인가 | **공개용(금액·`attestationDigest` 제외) 변형만 온체인**. #14/#10 어느 쪽이 정의하는지 문서가 명시하지 않아 확인 필요 | 내부용이 원장 이벤트에 있으면 `eventHash`가 간접 노출 경로 |
| Q18-5 | 해시 함수 통일 | **통일하지 않음**(SHA-256 체인 유지, 앵커는 값 저장) | 온체인 재검증이 필요해지면 재논의 |
| Q18-6 | 어테스터 집합을 `setDigest`만 올릴지 주소 목록까지 올릴지 | **`setDigest`+`threshold`만** | 주소 목록 공개의 이점(투명성) vs 기관 식별 노출. #13 확정 후 재검토 |
| Q18-7 | 대상 체인(퍼블릭/L2/프라이빗) | **미정**(PoC는 로컬 EVM 가정) | 최종성·시간·가스·프라이버시가 체인에 의존. 이 문서는 체인별 사실을 주장하지 않음 |
| Q18-8 | 운영자 서명자를 멀티시그(ERC-1271)로 허용할지 | **Tier 1은 EOA 기본**, 멀티시그는 후속 | 가스·재진입 표면(§3.5) |
| Q18-9 | 일시 정지(pause) | **두지 않음** | 검열 수단화 위험 |
| Q18-10 | 허위 앵커 선점(B-T02) 회복 절차 | 서명자 교체 + 후계 컨트랙트 + 허위 앵커는 `EquivocationProven`로 표시. 자동 회복은 없음 | 완전한 해법은 이 문서에 없음. 대안: 앵커에 대기 기간(challenge window) 도입 |
| Q18-11 | 업그레이드 방식 | **불변(U1) + 후계 포인터** | 프록시는 관리자 단일 실패점 |
| Q18-12 | 소유자 구성 | **멀티시그+타임락**(길이는 정책값) | 운영자와 소유자 분리 |

---

## 13. 가정, 미확인, 후속

### 13.1 새 가정 (`REGULATORY_ASSUMPTIONS.md` 편입은 후속 PR)

- (새) P18-A01: 온체인 앵커링은 **규정 요구가 아닌 PoC 설계**다. 규정이 거래 기록의 블록체인 보관을 요구하거나 인정한다는 근거는 찾지 못했다.
- (새) P18-A02: 대상 체인은 미정이며 로컬 EVM을 가정한다. 최종성, `block.timestamp` 정확도, 가스는 체인에 의존한다.
- (새) P18-A03: 오프체인 원장의 `finalizationDigest`가 공개용인지 내부용인지는 #10/#14에 명시되지 않았다(Q18-4). 공개용이라고 가정한다.
- (새) P18-A04: 시퀀서(운영자) 시계 신뢰(TA-1)는 온체인에서도 사라지지 않는다.
- (새) P18-A05: 앵커 서명자는 단일 운영자 키(EOA)다(P14-A03의 연장).

### 13.2 미확인

- 대상 체인의 최종성·타임스탬프 규칙·가스 비용(수치 주장 없음).
- 앵커 이후 구간의 되감기를 증명하는 데 필요한 체크포인트 간격(정책 값).
- #13 PR #44 채택 후 `setDigest`가 덮는 필드와 키 폐기의 온체인 표현.
- 실제 기관이 온체인 기록을 수용하는지(규제 수용은 README상 해결하지 못함).

### 13.3 후속 담당

| 담당 | 작업 |
| --- | --- |
| 진영 님 | §12 Q18-1~Q18-12 결정(기본값 제시됨). 특히 Q18-1(Tier), Q18-4(공개/내부 다이제스트) |
| 리드 봇 | PR #44(#13) 병합 순서 조율. ROADMAP/README/ARCHITECTURE 갱신(이 PR은 수정하지 않음). #14/#10 문서의 `finalizationDigest` 정의 명확화 필요 여부 판단 |
| 구현 봇(#19) | Tier 1 구현: `Commitments`, `LedgerAnchor`(서명 검증, 단조성, 불변식 INV-C*, INV-A*). §11 OC-01~OC-26, OC-31~OC-34 중심 테스트(Foundry/Hardhat). Solidity 구현은 #11 §9.2 벡터와 같은 다이제스트를 내야 함(체크포인트 타입은 새 벡터 필요) |
| 보안QA | 위협 B-T01~B-T18 검토, 앵커 선점(B-T02), 다이제스트 추측 확인(B-T06), 금액 NEVER 점검(INV-A8), 불변 배포 전 감사, `THREAT_MODEL.md` 편입 |
| 리서치(#20) | 프라이버시·ZK: 금액 비공개 증명, 다이제스트 한계 완화(솔트/커밋–리빌), Tier 2 공개 정보 평가 |
| 리서치(후속) | P18-Axx의 ASSUMPTIONS 편입, 대상 체인 결정 후 최종성·시간 사실 확인 |

---

## 14. 출처

- ERC-1271 — https://eips.ethereum.org/EIPS/eip-1271 (확인일 2026-10-04): `isValidSignature(bytes32 hash, bytes signature)`, 매직 값 `0x1626ba7e`, `view`, 가스 하드코딩 금지 권고.
- EIP-712, EIP-2, Solidity 문서(`block.timestamp` 초 단위, `ecrecover` 경고): [`eip712-attestation-schema.md`](./eip712-attestation-schema.md) §3.2, §12의 열람 기록(2026-10-03)을 따름.
- 저장소 문서(`main` `0eb5d89`, 2026-10-04 열람): `README.md`('블록체인이 해결하는 것 / 해결하지 못하는 것'), `docs/design/{snapshot-and-finalization,eip712-attestation-schema,participation-ledger-events}.md`, `packages/domain/src/participation.ts`(`transition()`).
- 보안QA 이슈 #37(체크포인트 없는 끝부분 잘라내기)와 이슈 #18/#13의 본문(2026-10-04 열람).
- 규정 자료는 이 문서에서 새로 주장하지 않습니다.
