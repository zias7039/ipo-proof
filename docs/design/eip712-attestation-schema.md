# 설계: EIP-712 어테스테이션 서명 스키마 (이슈 #11)

> **면책 (Disclaimer)**
> 이 문서는 **리서치/설계 PoC 문서**이며 **법률/규제 자문이 아니고 보안 감사도 아닙니다**. 서명은 어테스터가 이 데이터에 서명했다는 **출처 증거(provenance)** 일 뿐 데이터가 참이라는 보증이 아니며, **영지식 증명이 아닙니다(ZK STATUS: NOT IMPLEMENTED)**. 규정 관련 서술은 [`REGULATORY_RESEARCH.md`](../REGULATORY_RESEARCH.md)·[`REGULATORY_ASSUMPTIONS.md`](../REGULATORY_ASSUMPTIONS.md)(확인일 2026-10-03)를 연결하며, 확인하지 못한 것은 **미확인**입니다. **프로덕션 규칙으로 사용 금지**입니다.

- 작성: 리서치 봇. 이슈: #11 (`Refs #11`). 상태: **설계 문서 (코드 변경 없음)**. 구현은 이미 PR #24(이슈 #12, 'IPO Proof 구현' 봇)에 있고, 이 PR은 구현을 건드리지 않습니다.
- 기준 구현: PR #24 `feat/attestation-eip712-verifier`의 헤드 커밋 `75d71aa`. PR #24는 이후 `main`(병합 커밋 3fa59ef)에 병합되었고, `75d71aa`와 `main`의 `packages/` 아래 내용은 차이가 없음을 확인했습니다(2026-10-03). 따라서 이 문서의 "구현 현황"은 `main` 기준으로도 유효합니다.
- **결정 반영(2026-10-03, 리드 봇을 통해 전달된 진영 님 결정)**: **v2와 `blindingSalt`는 보류하고 현재 v1을 유지한다**(Q11-1, Q11-4). §7의 v2 제안은 삭제하지 않고 **'보류됨(추후 검토)'** 로 표시했다. 기본 결정은 v1 유지이며, #10·#14 설계 문서는 v2 필드에 기대던 서술의 v1 처리를 정리했다(PR #26 §2.3.1). 다이제스트 프라이버시 한계(§7.3)는 보류 중에도 잔여 위험으로 유지한다.
- 관련 설계 문서(별도 PR): 이슈 #10 스냅샷·마감 확정은 PR #26의 `docs/design/snapshot-and-finalization.md`, 이슈 #14 원장 이벤트·권한은 PR #27의 `docs/design/participation-ledger-events.md`. 병합 전에는 해당 PR을 참조합니다.

## 0. 요약

1. **v1 스키마**(PR #24가 구현)를 설계 근거와 함께 확정 문서로 남긴다(§2~§6). 이 문서가 v1에서 바꾸자고 제안하는 것은 **없다**. v1은 이미 병합되어 있고 이 문서는 변경을 요구하지 않는다.
2. 이슈 #10 설계가 목표로 삼은 것(증빙의 **기준일(as-of) 필드**, 공개 다이제스트의 **무차별 대입 방지**, 온체인 정렬 비용)은 v1에 없으므로 **v2 필드 제안**으로 따로 정리했다(§7). **결정: v2는 보류하고 v1을 유지한다.** 제안은 삭제하지 않고 '보류됨(추후 검토)'로 남긴다. v2가 도입되면 v1/v2 공존 없이 교체하는 것이 원래 제안이었다.
3. **도메인**: `{name, version, chainId, verifyingContract}`. 오프체인 PoC에서 `chainId`/`verifyingContract`는 **환경별로 다른 도메인 분리 라벨**이고, 온체인에서는 실제 체인 ID와 배포 주소다. 오프체인 도메인으로 한 서명은 온체인 도메인에서 **검증되지 않는다**(재서명 필요, §3).
4. **재생·가변성**: EIP-712 자체는 재생 방지를 포함하지 않는다. v1은 서명 대상에 `attestationId`, `nonce`, `issuedAt`, `expiresAt`, `fundId`, `ipoId`를 넣고 저장소가 nonce를 바인딩한다. 서명 가변성은 `v ∈ {27, 28}`, low-`s`, `r, s ∈ [1, n-1]`만 허용해 막는다(§5, §6). 서명 바이트를 식별자로 쓰지 않는다.
5. **새 발견(§7.3)**: v1의 서명 구조는 금액을 포함한다. 그 구조의 **다이제스트도 금액의 해시**이므로 공개하면 금액을 추측으로 확인할 수 있다. 이슈 #10 설계의 `attestationDigest`를 공개 영수증에 넣는 경우와 온체인 이식 모두에 영향이 있어 v2에 `blindingSalt`를 제안했으나 **보류**되었다. 따라서 **v1의 서명 구조·서명·다이제스트는 공개하지 않는 것이 현재의 규율이며, 이 한계는 잔여 위험으로 유지된다**(§7.0).
6. §9에 수용 기준(테스트 시나리오)과 **재현 가능한 테스트 벡터**(합성 데이터, 독립 구현 2종에서 일치 확인)를 둔다.

---

## 1. 구현 현황 (PR #24 헤드 `75d71aa` 기준 사실)

| 항목 | 내용 | 위치 |
| --- | --- | --- |
| 검증기 | `Eip712AttestationVerifier implements AttestationVerifier`. 어테스터 레지스트리(`attesterId → 서명 주소 1개`)와 EIP-712 서명 검증 | `src/eip712.ts` |
| 라이브러리 | `@noble/curves`(secp256k1 복구), `@noble/hashes`(keccak-256). EIP-712 바이트 배치는 `eip712.ts`에서 직접 구현하고, 테스트가 `viem`의 `hashTypedData`와 대조 | PR 본문, `test/eip712.test.ts` |
| 연결 위치 | `verifyBid`의 어테스터 권한 단계(서명 검증 포함). 요청 형식은 그대로(`{fundId, ipoId, bidAmount}`) | `src/verify.ts` |
| 저장소 | `InMemoryAttestationStore.publish`가 검증기 통과 → `attestationId` 충돌 → nonce 바인딩 → `(fundId, ipoId)`별 최신만 서빙(`issuedAt` 엄격 증가) 순으로 확인 | `src/attestation.ts` |
| 미지원(모두 `SIGNATURE_INVALID`로 닫힘) | EIP-2098 압축 서명, `v` = 0/1·EIP-155 형식, EIP-1271 컨트랙트 서명자 | `src/eip712.ts` 주석, ARCHITECTURE |
| 기타 | `chainId = 0`, `verifyingContract = 0x000…0`은 생성 시 거부. Node `>=20.19` | 같은 PR |
| 병합 전 리뷰 지적 | Codex 자동 리뷰가 (P1) PR #23에서 `DEMO_RULE_V1`의 의미를 같은 ID로 바꿔 재현성이 깨질 수 있다는 점, (P2) Node 최소 버전, (P2) 정렬 비교 중 예외 가능성을 지적함. 이후 커밋에서 `package.json`의 `engines.node`가 `>=20.19`로 올라가고 입력 방어 커밋이 추가된 것은 확인했으나, 세 지적 각각의 처리 여부는 이 문서에서 확인하지 않았음(PR 쪽 확인 필요) | PR #23, #24 리뷰 |

---

## 2. v1 서명 대상 (타입 정의)

### 2.1 EIP-712 타입

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)

CapacityAttestation(
  string  attestationId,
  string  fundId,
  string  ipoId,
  string  ruleVersion,
  uint256 grossCapacityKrw,
  UnderlyingExposure[] underlyingExposures,
  uint256 issuedAt,
  uint256 expiresAt,
  string  nonce,
  string  attesterId
)
UnderlyingExposure(string fundId, uint256 exposureKrw)
```

- 서명 대상은 `CapacityAttestation`의 **`signature`를 제외한 모든 필드**다. 폐기 상태는 서명 밖(변하는 상태)이다.
- EIP-712의 `encodeType`은 "참조되는 구조체 타입을 이름순으로 정렬해 뒤에 붙인다"고 정한다 〔EIP-712 · Definition of encodeType〕. 구현의 타입 문자열은 이 규칙을 따른다.
- `string`은 `keccak256(utf8)`, 배열은 요소 `encodeData`를 이어붙인 것의 `keccak256`, 구조체는 `hashStruct`로 인코딩된다 〔EIP-712 · Definition of encodeData〕.
- 최종 서명 대상: `digest = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))` 〔EIP-712 · Specification〕.

### 2.2 필드별 선택과 근거

| 필드 | 타입 | 선택 근거 / 주의 |
| --- | --- | --- |
| `attestationId` | string | 증빙 식별자(어테스터가 부여). 서명에 포함되어 같은 서명이 다른 ID로 옮겨갈 수 없다. 같은 ID에 다른 내용은 저장소가 `ATTESTATION_ID_CONFLICT`로 거부 |
| `fundId`, `ipoId` | string | 주체 바인딩. 다른 펀드/IPO로 재사용 불가. ID는 합성 문자열(`^[a-z][a-z0-9_]{0,63}$`) |
| `ruleVersion` | string | 증빙이 전제로 하는 규칙 버전. `verifyBid`가 활성 버전과 대조(`RULE_VERSION_MISMATCH`) |
| `grossCapacityKrw` | uint256 | `bigint` KRW. `uint256` 범위 밖·음수는 인코딩 불가 → `SIGNATURE_INVALID`. 의미는 A-007/A-008(자산총액 일평균 입력값) |
| `underlyingExposures` | `UnderlyingExposure[]` | 하위펀드별 노출(A-019: 참여일 전일 보유 평가액). **집합으로 서명**(§4) |
| `issuedAt`, `expiresAt` | uint256 | 정수 epoch **밀리초**. 서명에 포함되어 만료 연장을 서명 후에 할 수 없다 |
| `nonce` | string | 어테스터 범위의 고유값. 서명에 포함. 저장소가 최초 사용 `attestationId`에 바인딩 |
| `attesterId` | string | 서명에 포함. 레지스트리의 `attesterId → 주소`와 대조되므로 서명이 다른 어테스터 ID로 옮겨갈 수 없다 |

**ID를 `string`으로 둔 이유와 대가**: 사람이 읽을 수 있고 기존 도메인 모델과 같다. 온체인에서는 호출 데이터로 전체 문자열을 넘겨야 하므로 비용이 든다. `bytes32`(ID의 해시)로 바꿀지는 #18/#19에서 정한다(§8).

### 2.3 JSON 전송 형식

`hash.ts`의 canonical JSON은 `bigint`를 받지 않고(`unsupported type`) 숫자는 안전한 정수만 받는다. 따라서 오프체인 전송·저장에서 `uint256` 값은 **십진 문자열**로 직렬화하는 것을 제안한다(JSON number는 2^53을 넘으면 정밀도를 잃는다). 서명 대상 해시 계산(위 §2.1)은 이 JSON 표현과 무관하게 정수 값으로 한다. `eth_signTypedData` 계열 JSON-RPC는 `types`, `primaryType`, `domain`, `message`를 받는다 〔EIP-712 · eth_signTypedData〕. 구현은 `EIP712_TYPES`를 이 형식으로 내보낸다.

---

## 3. 도메인 분리

### 3.1 필드 의미 〔EIP-712 · Definition of domainSeparator〕

| 필드 | EIP-712의 정의 | 이 프로젝트에서의 값 |
| --- | --- | --- |
| `name` | 서명 도메인의 사용자 가독 이름 | `"ipo-proof CapacityAttestation"` (증빙 전용. 원장 요청 서명은 `ipo-proof ParticipationLedger` 등 **다른 이름**, #14) |
| `version` | 서명 도메인의 현재 **메이저 버전**. 버전이 다르면 서명은 호환되지 않음 | `"1"`. 구조체 레이아웃이나 인코딩이 바뀌면 올림 |
| `chainId` | EIP-155 체인 ID. 사용자 에이전트(지갑)는 활성 체인과 다르면 서명을 거부해야 함("should refuse") | 배포 설정값 |
| `verifyingContract` | 서명을 검증할 컨트랙트 주소 | 배포 설정값 |
| `salt` | 마지막 수단의 도메인 구분자 | **사용하지 않음** |

`name`과 `version`은 서명이 무엇에 대한 것인지를 정하고, `chainId`/`verifyingContract`는 **어디에서 유효한지**를 정한다.

### 3.2 오프체인 전용 PoC와 온체인 검증의 차이

| 항목 | 오프체인 PoC (현재) | 온체인 검증 (#18/#19 이후) |
| --- | --- | --- |
| `chainId` | 아무 체인과도 통신하지 않음. **환경별 라벨**로 사용(개발·시연·운영 등 서로 다른 값). 0은 거부 | 실제 체인 ID. 컨트랙트가 `block.chainid`로 확인하거나 도메인 구분자에 반영 |
| `verifyingContract` | 실제 컨트랙트 없음. 환경별 **의사 주소**를 배포 설정으로 고정. 0 주소는 거부 | 실제 배포 주소 |
| 같은 서명의 이식 | – | **이식되지 않는다.** 오프체인 도메인으로 서명한 증빙은 온체인 도메인에서 서명자 복구가 달라져 검증 실패. 온체인 전환 시 증빙을 **재서명(재발급)** 해야 함 |
| 지갑 사용 | 어테스터가 라이브러리/HSM으로 직접 서명하면 지갑 체인 검사와 무관. 지갑 UI로 서명하면 활성 체인과 `chainId`가 달라 서명이 거부될 수 있음(EIP-712 문구). 기관 어테스터의 서명 수단은 **미확인**(#13) | 지갑/HSM이 실제 체인에 맞는 `chainId`로 서명 |
| 시각 단위 | 정수 epoch **밀리초** | Solidity `block.timestamp`는 **초 단위**(unix epoch). 서명 필드를 초로 바꾸거나 비교 시 변환해야 함 〔Solidity docs · Block and Transaction Properties〕 |
| 서명 복구 | `@noble/curves` 복구 + 레지스트리 주소 비교 | `ecrecover` 또는 검증된 ECDSA 라이브러리. Solidity 문서는 `ecrecover`가 오류 시 0 주소를 반환하고, 서명 가변성에 주의해야 하며 OpenZeppelin ECDSA 래퍼를 쓸 수 있다고 안내한다 〔Solidity docs · Mathematical and Cryptographic Functions〕. 구현은 레지스트리에 0 주소 등록을 금지함 |
| 어테스터 레지스트리 | 설정 객체 | 컨트랙트 저장소(키 회전·폐기는 #13) |
| nonce·폐기 저장소 | 메모리(재시작 시 소실) | 컨트랙트 저장소 또는 이벤트 로그 기반 |
| 개인정보 | 서명 메시지에 금액이 있지만 오프체인 자격증명으로만 취급 | **금액이 든 서명 메시지를 calldata로 올리면 공개된다.** 공개 체인에는 평문 금액을 올리지 않는다는 원칙과 충돌 → §7.3, #18, #20 |

### 3.3 환경 분리 권고

두 환경이 같은 `{name, version, chainId, verifyingContract}`를 쓰면 한 환경의 서명이 다른 환경에서 유효하다(도메인 분리가 작동하지 않음). 개발·시연·운영은 서로 다른 `chainId`/`verifyingContract`를 배포 설정으로 가져야 한다. 이것은 설정 규율이며 코드가 강제하지 못한다.

---

## 4. 직렬화 결정

### 4.1 `bigint` ↔ `uint256`

KRW는 비음수 `bigint`다(`money.ts`). 서명 인코딩은 `uint256` 범위(0 ~ 2^256-1)로 제한하고 범위 밖은 인코딩 실패 → 검증 실패로 처리한다. JS `number`는 안전한 정수만 `uint256`으로 받는다(시각 필드용). 금액에 `number`를 허용하지 않는 도메인 규칙은 서명 계층 이전에 이미 적용된다.

### 4.2 `underlyingExposures`: 집합으로 서명

- **결정(v1)**: 노출 배열을 `fundId`(UTF-16 코드 단위 순서), 동률은 `exposureKrw` 오름차순으로 **정렬한 뒤** 인코딩한다. 같은 집합이면 배열 순서가 달라도 같은 다이제스트가 나온다.
- **근거**: 규칙 엔진은 합산만 하므로 순서가 결과에 영향이 없다. 어테스터 도구와 소비자가 배열 순서를 합의할 필요가 없어진다.
- **중복**: `fundId` 중복은 병합·거부하지 않고 **주어진 대로 서명**한다. `verifyBid`가 사후에 `DUPLICATE_UNDERLYING_EXPOSURE`로 거부한다.
- **ID 정렬의 범위**: 정렬은 UTF-16 코드 단위 순서다. `verifyBid` 경로에서는 서명 검증 전에 노출의 `fundId`가 합성 ID 형식(ASCII 소문자·숫자·밑줄)인지 확인하므로(`isWellFormed`가 어테스터 단계 앞에 있음) UTF-8 바이트 순서와 같다. `eip712.ts`를 단독으로 쓰면 임의 문자열이 들어갈 수 있으나 이 프로젝트의 사용 경로에서는 해당하지 않는다.
- **온체인 비용**: 컨트랙트가 같은 정렬을 재현하려면 가스가 든다. v2(보류됨)에서는 "어테스터가 **정렬된 배열**로 서명하고 검증기는 엄격 오름차순(중복 없음)인지 확인한다"로 바꿔, 정렬 연산을 없애는 방안을 제안한다(§7.2). 중복 거부도 서명 계층으로 올라온다.

### 4.3 문자열

`string` 인코딩은 `keccak256(utf8)`이며 짝이 없는 서로게이트는 U+FFFD로 바뀌어 충돌하므로 인코딩 단계에서 거부한다. 구현은 선행 U+FEFF(BOM)가 있는 정상 문자열도 허용하도록 디코더 옵션을 지정했다(헤드 `75d71aa`).

---

## 5. 재생(replay)과 바인딩

EIP-712는 **재생 방지를 포함하지 않으며**(표준 본문: "It does not include replay protection."), 같은 서명 메시지를 두 번 보았을 때 거부하거나 멱등으로 처리하는 것은 애플리케이션 책임이라고 명시한다 〔EIP-712 · Replay attacks〕.

| 시도 | 막는 수단 | 어디에서 | 비고 |
| --- | --- | --- | --- |
| 같은 서명을 다른 `attestationId`에 사용 | `attestationId`가 서명 대상 | 서명 검증 | – |
| 다른 펀드·IPO·규칙 버전·어테스터 ID로 이동 | 각 필드가 서명 대상 | 서명 검증 | – |
| 다른 체인·컨트랙트·프로토콜 버전·이름의 서명 | 도메인 분리 | 서명 검증 | 환경 분리는 설정 규율(§3.3) |
| 서명 후 `expiresAt`/`issuedAt` 변조 | 두 필드가 서명 대상 | 서명 검증 | – |
| 서명 후 금액·노출 변조 | 해당 필드가 서명 대상 | 서명 검증 | – |
| 같은 어테스터·nonce를 다른 `attestationId`로 | 저장소의 nonce 바인딩(첫 `attestationId`에 영구 바인딩) | `publish` / `verifyBid`(`ATTESTATION_NONCE_REPLAY`) | 바인딩은 교체된 증빙의 것도 해제되지 않음 |
| 교체된 옛 증빙(더 큰 용량일 수 있음)을 되살림 | `ATTESTATION_SUPERSEDED`, `NOT_NEWER_THAN_CURRENT`(`issuedAt` 엄격 증가) | `publish` | `verifyBid`는 저장소가 내주는 증빙을 다시 검증하므로 이 관문은 이중 방어 |
| 같은 증빙으로 여러 입찰 | **재생이 아님**: 허용 | `verifyBid` | "재사용"과 "재생"을 구분. 동일 `attestationId` 재검증은 정상 |
| 유효기간 안에서 오래된 증빙 재사용 | `expiresAt`, `maxAttestationAgeMs`(stale)로 상한 | `verifyBid` | v1에는 **참여일에 대한 바인딩이 없다.** v2의 `participationDate`가 이 틈을 닫지만 v2는 보류되었다(§7.1). 보류 중에는 #10 설계의 V1-1(`issuedAt >= 참여일 00:00 KST` 검사, PR #26 §2.3.1)로 일부만 제한하고 나머지는 어테스터 책임이라는 제약으로 남는다 |
| 온체인에서의 프런트러닝(서명 가로채 먼저 제출) | 서명자만 내용 결정 가능, 먼저 제출되어도 효과가 같게 설계 | 컨트랙트 설계 | EIP-712가 권고하는 성질 〔EIP-712 · Frontrunning attacks〕 |

남는 위험: nonce 저장소의 영속성 없음(재시작 시 소실), 폐기 목록의 최신성, 어테스터 키가 탈취되었을 때 유효한 서명이 허위 데이터에 대해 만들어지는 것(서명은 데이터 진실성을 보증하지 않음).

---

## 6. 서명 가변성(malleability)과 서명 형식

- ECDSA에서는 `s`를 `n - s`로 바꾸고 `v`를 뒤집어도 유효한 서명이 된다. 이더리움은 EIP-2에서 **트랜잭션 서명**에 대해 `s > secp256k1n/2`를 무효로 했지만 ECDSA 복구 프리컴파일은 그대로여서 높은 `s`도 계속 받는다 〔EIP-2 · Specification 2〕. Solidity 문서는 `ecrecover`를 쓸 때 유효한 서명이 키 지식 없이 다른 유효한 서명으로 바뀔 수 있고, 서명이 유일해야 하거나 항목의 식별자로 쓰는 경우에 문제가 된다고 경고한다 〔Solidity docs · Mathematical and Cryptographic Functions〕.
- **v1 규칙**: `0x` + 130 hex(65바이트 `r ‖ s ‖ v`), `v ∈ {27, 28}`, `r, s ∈ [1, n-1]`, **low-`s`만** 허용(높은 `s` 쌍둥이는 거부), 대소문자 무관. 한 서명당 하나의 표현만 받는다. 복구 실패는 예외가 아니라 실패 결과.
- **서명 바이트를 식별자나 중복 방지 키로 쓰지 않는다.** 증빙의 정체성은 `attestationId`와 **다이제스트**(§2.1의 `digest`)다. 서명이 가변이어도 다이제스트는 변하지 않는다.
- **미지원 형식**: EIP-2098 압축 서명(64바이트), `v` = 0/1·EIP-155 형식. 서명 도구가 이런 값을 내면 27/28로 정규화해서 제출해야 한다.
- **컨트랙트 서명자(EIP-1271)**: 미지원. ERC-1271은 컨트랙트가 `isValidSignature(hash, signature)`로 서명 유효성을 답하는 표준이며 서명 방식(ECDSA, 다중서명, BLS 등)은 컨트랙트가 정한다 〔ERC-1271 · Specification〕. 기관이 다중서명 지갑으로 서명하려면 이 경로가 필요하나 v1의 레지스트리는 EOA 주소 하나만 등록한다. 어테스터 키 형태·쿼럼은 #13에서 정하고, 그때 서명 검증기의 확장(컨트랙트 서명자 호출 시 가스 제한, 상태 의존 유효성 등)을 설계한다. ERC-1271 본문은 서명 검증 호출에 임의의 가스 한도를 하드코딩하지 말라고 경고한다.
- **라이브러리**: 서명 복구·keccak은 검증된 라이브러리(`@noble/*`)에 위임하고, 이 프로젝트가 직접 쓰는 암호 코드는 EIP-712 바이트 배치뿐이다. 그 배치는 `viem` 대조 테스트로 보호된다(§9). 감사가 아니다.

---

## 7. v2 제안 — **보류됨 (추후 검토)**

> **상태: 보류됨.** 2026-10-03 결정(리드 봇 경유 진영 님)으로 v2와 `blindingSalt`는 도입하지 않고 **v1을 유지**한다. 이 절은 삭제하지 않고 추후 검토용으로 남긴다. 아래 어떤 항목도 현재 구현 대상이 아니며, 구현 봇은 이 절을 근거로 코드를 바꾸지 않는다. 다시 검토할 계기 후보(결정 아님): 온체인 설계(#18) 착수, 공개 영수증에 증빙 다이제스트를 넣어야 하는 요구, 기준일 위반을 엔진이 잡아야 한다는 요구.

### 7.0 보류 중의 v1 운영 규율과 잔여 위험

| 항목 | v1 유지 시 처리 | 상태 |
| --- | --- | --- |
| 서명 구조·서명·다이제스트(`digest`)의 공개 | 금액이 들어 있으므로 **공개하지 않는다.** 내부(운영자·감사인) 전용. 공개 영수증은 금액과 `attestationDigest`를 뺀 별도 해시만 쓴다 (PR #26 §2.3.1) | **잔여 위험 유지** (§7.3의 무차별 대입 위험) |
| 기준일 정합성 | 증빙에 기준일 필드가 없다. 엔진은 `issuedAt >= 참여일 00:00 KST`만 검사하고 나머지는 어테스터 책임(제약)이다. 참여일은 어테스터 입력이 아니라 운영자가 기록한 입찰 제출 시각에서 계산한다 (PR #26 §2.3.1) | 제약 (명시) |
| `ruleSpecDigest` | 증빙 필드가 아니라 IPO 레코드에 고정한다. 증빙은 `ruleVersion` 문자열만 가진다 | 서명 계층 상호 확인 없음 (절차로 통제) |
| 노출 정렬 | v1 검증기가 집합으로 정렬해 인코딩 (§4.2). 변경 없음 | 해당 없음 |
| 온체인 이식 | v1 그대로는 calldata 공개(§3.2)와 정렬 비용(§4.2) 문제가 남는다. #18에서 v2 재검토 계기가 된다 | 보류 (#18) |

v1/v2 공존 여부: v2 도입이 결정되면 PoC에 배포된 증빙이 없다는 전제에서 공존 없이 도메인 `version`을 `"2"`로 올려 교체하는 것이 원래 제안이었다(공존하면 검증기가 두 도메인 구분자와 두 타입 문자열을 지원해야 한다).

### 7.1 기준일(as-of) 필드 — #10 설계 M3 (보류됨)

이슈 #10 설계는 증빙이 데이터의 기준일을 명시해야 엔진이 구조적으로 정합성을 검사할 수 있다고 본다(해당 문서 §2.3). 날짜는 KST 달력일 문자열 `YYYY-MM-DD`로 제안한다(형식 엄수, 그 외 거부). 규정상 기준 시점은 〔S1 · 제5조의3 ①1호 가·나·다목 · 2026-10-03〕에 있다.

| 필드(제안) | 타입 | 의미 |
| --- | --- | --- |
| `participationDate` | string | 참여일 D (A-003, P10-A01). 증빙이 이 날짜에만 유효. v1의 "유효기간 안의 오래된 증빙 재사용" 틈을 닫음 |
| `capacityBasis` | uint8 | 1 = 위탁재산 일평균(`FUND_ASSET_AVERAGE`), 2 = 고유재산 자기자본(`OWN_EQUITY`) (A-006, A-010) |
| `baseWindowStart`, `baseWindowEnd` | string | 일평균 구간(A-008, A-009). `end = D-1`, `start`는 D에서 3개월 전 또는 설정·설립일 |
| `holdingsAsOf` | string | 노출 평가 기준일. `D-1` (A-019) |
| `equityAsOf` | string | 자기자본 기준 분기말(고유재산 경로). 분기말 정의는 미확인(P10-A06) |
| `averagingMethodId` | string | 일평균 산식 식별자. 엔진은 검증하지 않고 고정만 함(P10-A05, 규정 미확인) |
| `ruleSpecDigest` | bytes32 | 증빙이 전제하는 규칙 명세·파라미터 해시. `ruleVersion` 문자열만으로는 같은 ID의 의미 변경을 못 잡는다는 지적(PR #23 리뷰)에 대한 서명 계층의 대응 |

- 위 날짜의 일관성(예: `baseWindowEnd == D-1`)은 **서명이 아니라 규칙 엔진**이 검사한다(이슈 #10 설계). 서명은 어테스터가 이 값에 서명했다는 사실만 묶는다.
- `capacityBasis = OWN_EQUITY`일 때 `underlyingExposures`는 비어야 하는지(다목 미적용, A-010), 현재 `Fund` 모델에서 고유재산 경로를 어떻게 표현할지는 **열린 질문**이다(§10).

### 7.2 노출 배열: 사전 정렬 강제 (보류됨)

v2에서는 노출을 `fundId` 엄격 오름차순(중복 불가)으로 **서명하고**, 검증기는 정렬·중복 여부를 확인만 한다(정렬 연산 없음). v1의 "집합으로 서명" 편의는 어테스터 도구 쪽 정렬 책임으로 옮겨간다. 중복·비정렬 증빙은 `ATTESTATION_MALFORMED`(또는 전용 코드)로 처리한다.

### 7.3 공개 다이제스트의 무차별 대입 위험과 `blindingSalt` (`blindingSalt` 제안은 보류됨, 위험은 유지)

- v1 `digest`는 `grossCapacityKrw`와 노출 금액을 포함한 구조의 해시다. 영수증 정책이 "낮은 엔트로피의 금액 해시는 무차별 대입에 취약하므로 포함하지 않는다"고 한 것과 같은 이유로, **다이제스트를 공개하면 금액을 추측해 확인할 수 있다**(나머지 필드가 알려져 있거나 짐작 가능한 경우). 그리고 서명 자체도 공개하면 다이제스트 확인에 쓸 수 있다.
- 이슈 #10 설계가 `attestationDigest`를 스냅샷 입력 해시에 넣고 그 해시를 공개 영수증에 쓰는 구조이므로, 이 위험은 그 설계와 직접 연결된다. #10 설계 문서는 이를 반영해 `attestationDigest`를 "비공개로 취급"하도록 수정되었고(PR #26), `blindingSalt`가 보류된 현재도 이 취급이 유지된다.
- **제안(보류됨)**: v2 서명 구조에 `bytes32 blindingSalt`(어테스터가 증빙마다 난수로 생성, 증빙과 함께 비공개 보관)를 넣는다. 그러면 다이제스트는 숨김 성질을 가진 커밋먼트가 되고, 공개 영수증이나 온체인에는 다이제스트만 올릴 수 있다. 현 `nonce`(string)가 충분한 엔트로피의 난수라는 보장은 없으므로 별도 필드로 둔다.
- 온체인에서 **서명 검증을 컨트랙트가 하려면** 원본 메시지(금액 포함)를 calldata로 넘겨야 하므로 `blindingSalt`로도 금액 공개는 막지 못한다. 온체인에서는 (a) 서명 검증은 오프체인에서 하고 온체인에는 커밋먼트만 올리거나, (b) 영지식 방식으로 증명하는 방향을 #18/#20에서 평가한다. 이 문서는 정하지 않는다. 현재 ZK는 구현되어 있지 않다.

### 7.4 이식 시 `bytes32` ID (선택, 보류됨)

온체인 비용을 줄이려면 `fundId`/`ipoId`/`attesterId`/`ruleVersion`/`nonce`를 `bytes32`(문자열의 해시)로 바꿀 수 있다. 이는 사람이 읽는 값이 서명 대상에서 빠지는 대가가 있어(지갑 표시 불가) #18/#19에서 비용과 함께 결정한다.

### 7.5 이행 (v2는 보류)

| 단계 | 내용 | 상태 |
| --- | --- | --- |
| 1 | PR #24를 v1로 병합 | **완료**(`main` 3fa59ef) |
| 2 | v2 타입 문자열, 도메인 `version = "2"`, `blindingSalt`, 기준일 필드, 정렬 강제 추가와 테스트 벡터(§9.2) 재생성 | **보류됨** (구현하지 않음) |
| 3 | 규칙 엔진 쪽 기준일 검사 | v1 범위의 `issuedAt >= 참여일 00:00 KST` 검사만 #10 설계의 구현 항목. v2 필드 기반 검사는 보류 |

---

## 8. 온체인 이식(#18/#19)에서 이 스키마와 관련된 결정 목록

| 결정 | 내용 | 참고 |
| --- | --- | --- |
| 시각 단위 | ms → s 변환 또는 필드 단위 변경 | §3.2 |
| ID 형식 | `string` 유지 vs `bytes32` | §7.4 |
| 노출 정렬 | 사전 정렬 강제(v2 보류, v1은 검증기 정렬) | §7.2, #18에서 재검토 |
| 서명 검증 위치 | 컨트랙트 vs 오프체인 검증 + 커밋먼트. `blindingSalt` 보류 중이라 v1 다이제스트는 커밋먼트로 쓰기에 부적합(금액 추측 가능) | §7.3 |
| 해시 함수 | 영수증·원장 체인은 현재 SHA-256, EIP-712는 keccak-256. 온체인에서는 keccak-256이 자연스러움. 통일 여부는 #18 | #14 문서 §2.1 |
| 서명자 | EOA 한정 vs ERC-1271 | §6, #13 |
| 도메인 값 | 실제 `chainId`, 배포 주소. 재서명 필요 | §3.2 |
| 폐기·nonce 저장소 | 컨트랙트 상태 | §3.2 |
| 구현 교차 검증 | Solidity 구현이 §9.2의 벡터와 같은 다이제스트를 내야 함 | #19 |

---

## 9. 수용 기준

### 9.1 시나리오 (v1 기준, PR #24 테스트와의 대응은 PR 본문 표를 참조)

| ID | 단계 | 기대 |
| --- | --- | --- |
| G-01 | 등록된 키로 정상 서명 | 검증 통과 |
| G-02 | 서명 후 각 필드(`attestationId`, `fundId`, `ipoId`, `ruleVersion`, `grossCapacityKrw`, `issuedAt`, `expiresAt`, `nonce`, `attesterId`)를 하나씩 변경 | 각각 `SIGNATURE_INVALID` |
| G-03 | 서명 후 노출 금액 변경 / 노출 추가 / 삭제 / 하나를 바꿔치기 | `SIGNATURE_INVALID` |
| G-04 | 같은 노출 집합의 배열 순서만 변경 | 통과(같은 다이제스트) |
| G-05 | 다른 `chainId`, `verifyingContract`, `version`, `name`으로 서명한 증빙 | `SIGNATURE_INVALID` |
| G-06 | 레지스트리에 없는 `attesterId` / 다른 어테스터 키로 서명 | `ATTESTER_UNAUTHORIZED` / `SIGNATURE_INVALID` |
| G-07 | 서명 길이 오류, 비 hex, 접두사 없음, 빈 문자열 | `SIGNATURE_INVALID`, 예외 없음 |
| G-08 | `v` ∈ {0, 1, 2, 26, 29, 35, 37, 255} | `SIGNATURE_INVALID` |
| G-09 | 유효 서명의 high-`s` 쌍둥이 | `SIGNATURE_INVALID` (같은 서명자로 복구됨을 보이되 거부) |
| G-10 | `r` 또는 `s`가 0 또는 ≥ n | `SIGNATURE_INVALID` |
| G-11 | `uint256` 범위 밖 금액, 음수, 소수, NaN, 짝 없는 서로게이트 문자열 | `SIGNATURE_INVALID`, 예외 없음 |
| G-12 | 같은 어테스터·nonce를 다른 `attestationId`로 발행 | `publish`는 `NONCE_ALREADY_BOUND`, `verifyBid`는 `ATTESTATION_NONCE_REPLAY` |
| G-13 | 서명 복사본을 새 `attestationId`에 붙임 | `SIGNATURE_INVALID` |
| G-14 | 교체된 옛 증빙 재게시 / `issuedAt`이 같거나 이전인 교체 | `ATTESTATION_SUPERSEDED` / `NOT_NEWER_THAN_CURRENT` |
| G-15 | 같은 증빙으로 여러 입찰 | 통과 (재생 아님) |
| G-16 | 검증기 설정: 0 주소 서명자, 체크섬 오류 주소, 중복 어테스터/주소, `chainId = 0`, 0 `verifyingContract` | 생성 시 `TypeError` |
| G-17 (v2, **보류**) | `participationDate`가 다른 날의 입찰에 사용 | 규칙 엔진이 `ATTESTATION_AS_OF_MISMATCH` (#10 설계 S-11의 v2 열). **현재 구현 대상 아님** |
| G-18 (v2, **보류**) | 같은 내용, 다른 `blindingSalt` | 다른 다이제스트. 다이제스트만으로 금액 추정 불가(엔트로피는 salt에 의존). **현재 구현 대상 아님** |
| G-19 (v2, **보류**) | 비정렬·중복 노출 배열 | `ATTESTATION_MALFORMED`. **현재 구현 대상 아님** (v1은 G-04처럼 집합으로 통과) |
| G-20 | `attestationDigest`로 스냅샷 입력 고정(#10) | 증빙이 이후 교체되어도 확정에는 고정된 다이제스트의 증빙을 사용. 교체된 증빙도 `attestationId`/다이제스트로 조회 가능해야 함 |
| G-21 (v1 유지) | `issuedAt`이 참여일 00:00 KST 이전인 v1 증빙으로 입찰 | 규칙 엔진이 `ATTESTATION_AS_OF_MISMATCH` (#10 설계 S-11, S-18의 v1 열). 서명 검증과는 별개의 규칙 검사 |
| G-22 (v1 유지) | v1 `digest`·서명을 공개 영수증 필드로 사용하려는 경우 | 사용하지 않는다: 영수증에는 금액과 `attestationDigest`가 없어야 함 (§7.0 잔여 위험). 테스트: 공개 영수증 직렬화에 `digest`·`signature`·금액이 없음 |

G-20 주: PR #24의 저장소는 내부 `byId` 맵에 교체된 증빙도 보존하지만(`current`는 최신만 서빙) 외부에 노출된 조회 메서드는 `getAttestation(fundId, ipoId)`뿐이다. #10 설계가 요구하는 "다이제스트(또는 `attestationId`)로 조회"는 구현 몫이다.

### 9.2 테스트 벡터 (v1, 합성 데이터)

PR #24 헤드 `75d71aa`의 `eip712.ts`와 `viem`의 `hashTypedData`(독립 구현) **둘 다**에서 같은 값을 얻었다(2026-10-03, 이 문서 작성 중 임시 테스트로 계산, 저장소에는 커밋하지 않음). 합성 값이며 실제 펀드·금액이 아니다. Solidity 구현(#19)과 향후 다른 구현의 교차 검증에 쓸 수 있다.

도메인: `{name: "ipo-proof CapacityAttestation", version: "1", chainId: 31337, verifyingContract: 0x00000000000000000000000000000000000a11ce}`

메시지:

| 필드 | 값 |
| --- | --- |
| `attestationId` | `att_1` |
| `fundId` | `fund_a` |
| `ipoId` | `ipo_1` |
| `ruleVersion` | `DEMO_RULE_V1` |
| `grossCapacityKrw` | `30000000000` |
| `underlyingExposures` | `[{fund_b, 6000000000}, {fund_c, 4000000000}]` (역순 입력도 동일 결과) |
| `issuedAt` | `1780000000000` |
| `expiresAt` | `1780086400000` |
| `nonce` | `nonce_1` |
| `attesterId` | `attester_1` |

| 값 | 결과 |
| --- | --- |
| `typeHash(EIP712Domain)` | `0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f` |
| `typeHash(UnderlyingExposure)` | `0xd53eb7c875d664a48fb73e4177ba12ec4f7ba7260889d372a118fc8e7e31ef47` |
| `typeHash(CapacityAttestation)` (참조 타입 포함 문자열) | `0x342de85576f693e80b16fd16b5a4b46d8acd5909ce05af248b72f5e742ebbcc8` |
| `domainSeparator` | `0xc76909d8a8a6a35895ab467edc54cd9f3a5c6b185c7636db3d195703659fabf4` |
| `hashStruct(message)` | `0xfda2e5269d82eb2bbabf8be8fcc6696fa36eacfd1d8c5d14affe1f59dd11a95c` |
| `digest` (`keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)`) | `0xb0c574855912b97f9d99c08d052f74a5ec2cf14dfb4f2d33e1d93df236249137` |

한계: 서명값(`r, s, v`)은 벡터에 넣지 않았다(서명 키는 테스트 전용 합성 키이며 문서에 키를 두지 않기 위함). 두 구현의 일치가 감사나 외부 공인 벡터를 대신하지 않는다. `typeHash(EIP712Domain)` 값은 EIP-712 도메인 타입 문자열의 해시이다.

---

## 10. 가정, 미확인, 열린 질문

### 10.1 규정 관련 (ASSUMPTIONS 연결)

| ID | 관계 |
| --- | --- |
| A-033 | 규정의 표준 증빙은 기관 대표이사 또는 준법감시인이 서명 또는 기명날인한 **확약서**다 〔S1 · 제5조의3 ② · 2026-10-03〕. 독립 어테스터의 EIP-712 서명 증빙은 규정이 요구하는 것이 아닌 PoC 설계 선택이며, 확약서를 대체한다는 규정상 근거는 없다 |
| A-034 | 어테스터가 제공해야 하는 입력(기준금액, 보유 평가액, 소명 수용 여부, 증권신고서 최초 제출일). v1은 앞의 둘만 담는다. v2 제안(§7.1)이 기준일을 더하지만 **보류**되어 기준일은 엔진 검사 대상이 아니다(§7.0). **소명 수용 여부와 증권신고서 최초 제출일(규칙 버전 선택용)은 v1/v2 어디에도 아직 없다** |
| A-001, A-002 | 규칙 버전은 증권신고서 최초 제출일 기준. 증빙 필드가 아니라 IPO 레코드의 고정 값으로 두는 것이 #10 설계의 제안 |
| A-008, A-009, A-010, A-019, A-020 | §7.1 필드의 의미 근거 |

### 10.2 새 가정 / 미확인

- (새) P11-A01: 어테스터가 secp256k1/keccak 기반 서명 수단(소프트웨어 키 또는 HSM)을 사용할 수 있다. 기관의 실제 서명 인프라는 **미확인**.
- (새) P11-A02: 날짜 필드는 KST 달력일 문자열 `YYYY-MM-DD` (A-003의 연장).
- 규정이 증빙의 형식·보관을 달리 요구하는지(전자서명 요건 등)는 확인하지 못함(RESEARCH §8 범위 밖).

### 10.3 열린 질문

| ID | 질문 | 기본 제안 |
| --- | --- | --- |
| Q11-1 | ~~v2를 먼저 병합할지~~ | **결정됨(2026-10-03): v1 유지, v2 보류.** v1은 이미 병합됨. v2 재검토 시기는 열려 있음 |
| Q11-2 | 날짜 필드: 문자열 `YYYY-MM-DD` vs `uint32 YYYYMMDD` | **보류**(v2 도입 시 판단). 기본 제안은 문자열(가독성), 온체인 비용은 #18에서 재평가 |
| Q11-3 | 고유재산 경로(`OWN_EQUITY`)를 `Fund` 모델에서 어떻게 표현할지 | **보류** (v2의 `capacityBasis`와 함께). 이 문서 범위 밖, 구현 봇과 리드 봇 |
| Q11-4 | ~~`blindingSalt`를 v2에 넣을지~~ | **결정됨(2026-10-03): 보류.** 다이제스트 프라이버시 한계는 잔여 위험으로 유지(§7.0). 재검토 계기는 §7 머리말 |

---

## 11. 후속 작업 (담당)

| 담당 | 작업 |
| --- | --- |
| 구현 봇 | (PR #24는 병합됨) **v2 필드·`blindingSalt`·테스트 벡터 갱신은 하지 않는다(보류).** 교체된 증빙의 다이제스트 조회(G-20)는 v1에서도 필요. v1 범위의 `issuedAt` 기준일 검사(G-21)는 #10 설계의 구현 항목. 이 PR은 구현을 포함하지 않음 |
| 보안QA | §5, §6의 재생·가변성 서술 리뷰, 독립 벡터 확보, 다이제스트 비공개 규율(§7.0)이 지켜지는지 영수증·로그 경로 점검. v2 설계 리뷰는 v2 재개 시 |
| 리서치 | #13(키 관리·쿼럼, ERC-1271 필요성), #18(온체인 설계, §8 결정 목록) |
| 소유자(진영) | 반영된 결정 확인(v2·`blindingSalt` 보류). v2 재개 시점은 미정 |
| 리드 봇 | `ARCHITECTURE.md`의 EIP-712 서술(PR #24)과 이 문서의 관계 정리, `P11-Axx`의 ASSUMPTIONS 편입 여부 |

## 12. 출처

모두 2026-10-03 열람.

- EIP-712 — https://eips.ethereum.org/EIPS/eip-712 (encodeType, encodeData, domainSeparator 필드, eth_signTypedData, Replay attacks, Frontrunning attacks)
- EIP-2 — https://eips.ethereum.org/EIPS/eip-2 (Specification 2: 트랜잭션 서명의 high-`s` 무효, 복구 프리컴파일은 불변)
- ERC-1271 — https://eips.ethereum.org/EIPS/eip-1271 (`isValidSignature`)
- Solidity 문서, Units and Globally Available Variables — https://docs.soliditylang.org/en/latest/units-and-global-variables.html (`block.timestamp` 초 단위, `ecrecover` 경고)
- 규정: 〔S1 · 제5조의3 ①1호 가·나·다목, ② · 2026-10-03〕 — `REGULATORY_RESEARCH.md` §7.
