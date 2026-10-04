# ipo-proof

**Disclaimer**

This project is a technical proof of concept.

The included eligibility and payment-capacity rules are illustrative implementations and must not be treated as legal or regulatory advice or as a production implementation of Korean securities regulations.

> **면책 조항 (한국어 번역 — 위 영문이 원문입니다)**
>
> 이 프로젝트는 기술적 개념 증명(proof of concept)입니다.
>
> 포함된 참여 자격 및 주금납입능력 규칙은 예시용 구현이며, 법률·규제 자문이나 한국 증권 규제의 실서비스(프로덕션) 구현으로 취급해서는 안 됩니다.

`ipo-proof`는 (한국 IPO 수요예측 맥락에서) **기관이 스스로 신고하는 IPO 주금납입능력**을 **독립적으로 증빙된 원천 데이터(attestation)**, **결정적(deterministic) 규칙 엔진**, **공유 참여 원장**으로 대체하는 방안을 탐구합니다.

이 저장소에는 현재 첫 번째 조각만 들어 있습니다. 순수 TypeScript 도메인 로직(Phase 1~2), EIP-712 어테스테이션 서명 검증, 저장소 기본 구성입니다. 모든 식별자(`fund_a`, `ipo_1`, `attester_1` 등)와 금액은 합성(synthetic) 데이터입니다. 실제 펀드명, 운용규모(AUM), 개인정보는 이 저장소에 넣지 않습니다.

## 현황

| 영역 | 상태 |
| --- | --- |
| 도메인 모델 (Fund, IPO, CapacityAttestation, UnderlyingFundExposure, ParticipationState, RuleVersion, BidVerification) | 구현됨 (인메모리, bigint KRW) |
| 참여 상태기계 (UNKNOWN / PARTICIPATING / NON_PARTICIPATION_LOCKED) | 구현됨, 테스트됨 |
| 규칙 엔진 `DEMO_RULE_V1`(동결)·`DEMO_RULE_V2`(노출 0원 UNKNOWN을 데이터 오류로 거부) | 구현됨, 테스트됨 (예시용 규칙일 뿐) |
| 만료/stale, 폐기, 규칙 버전, nonce 재생, 어테스터 권한 검사를 포함한 `verifyBid` | 구현됨, 테스트됨 (허용목록 검증기와 EIP-712 검증기 모두로 테스트) |
| 어테스테이션 **서명 검증** (EIP-712, secp256k1) | **구현됨** (`Eip712AttestationVerifier`): 복구한 서명자가 attesterId에 등록된 주소와 같은지 확인하며, 도메인 분리(name/version/chainId/verifyingContract)를 적용합니다. 위조, 필드 변조, 형식이 잘못되었거나 high-s인 서명, 잘못된 도메인, 미등록 어테스터를 테스트로 다룹니다. 이는 어테스터의 *출처*(누가 서명했는가)를 증명할 뿐 데이터가 *사실*임을 증명하지 않으며, 일반적인 ECDSA 복구이지 영지식 증명이 **아닙니다**. 키 교체/폐기와 어테스터 거버넌스는 **구현되지 않았습니다.** `AllowlistAttestationVerifier`(서명 검사 없음)는 테스트용으로 남아 있으며 deprecated입니다. 보안 감사가 아닙니다. |
| 영수증 해시 (`proofHash`, 정규화 JSON의 SHA-256) | 구현됨. 영수증 해시일 뿐 **증명이 아님** |
| **ZK 상태: 미구현** | 어떤 종류의 영지식 증명도 없음 |
| 참여 원장 이벤트 봉투 + 해시 체인 + 상태 도출 (`packages/domain/src/ledger`, 설계 이슈 #14의 1단계) | 구현됨, 테스트됨. 해시 체인은 변조 **탐지**일 뿐 블록체인도 영지식 증명도 아니며, 체인 끝부분 잘라내기는 외부 체크포인트 없이는 탐지하지 못합니다. **2단계(`AuthorizedLedger`)에서 `LedgerAction` EIP-712 서명 검증과 호출자 인증·인가(R1~R5, R6b, R8, R10, R14)를 구현했습니다. 내부 상태는 `#private`+동결로 런타임 변경이 불가능하고, 서명 도메인과 genesis에 `ledgerId`가 들어가며, 요청 최대 유효기간(`maxRequestTtlMs`)을 강제하고, 인증을 통과한 요청은 도메인 규칙으로 거부돼도 nonce가 소비됩니다. 무인증 쓰기 경로인 `HashChainedLedger`는 패키지 배럴에서 내렸습니다. R9(키 폐기), R15(입찰 취소), BIND-1 origin, 레지스트리 변경 로그, 영속 nonce 저장소, 마감 확정은 구현되지 않았습니다.** 서명은 출처 증명일 뿐 데이터가 참이라는 보증이 아닙니다 기존 `InMemoryParticipationLedger`는 그대로이며 아직 대체되지 않았습니다 |
| 블록체인 / 온체인 원장 | **아직 미구현**. '공유 원장'은 인메모리 클래스임 (위 해시 체인도 인메모리) |
| 영속성 | 미구현 |
| UI / API 서버 | 미구현 |

## 어떤 문제를 풀려는가

이 PoC가 가정하는 시나리오에서 기관투자자의 IPO 배정분 납입 능력은 운용사가 스스로 신고합니다. 이 전제에서 두 가지 약점이 생깁니다.

1. **자기 신고 용량은 검증할 수 없습니다.** 숫자가 클수록 이득을 보는 쪽이 그 숫자를 직접 보고합니다.
2. **중복 노출을 놓치기 쉽습니다.** 한 펀드가 같은 IPO에 입찰할 수 있는 다른 펀드에 투자하면, 같은 돈이 여러 입찰을 뒷받침하는 것처럼 보일 수 있고, 이런 차감을 일관되게 적용하도록 강제하는 장치가 없습니다.

이 전제는 프로젝트 브리프에서 나왔습니다. 이 저장소에서 실제 규정과 대조해 확인한 것은 아니며, 규정 조사 결과와 PoC 가정은 별도 문서에 정리했습니다. [docs/REGULATORY_RESEARCH.md](docs/REGULATORY_RESEARCH.md)(규정 조사)와 [docs/REGULATORY_ASSUMPTIONS.md](docs/REGULATORY_ASSUMPTIONS.md)(규칙엔진 PoC 가정 목록)를 참고하세요. 두 문서는 리서치 목적이며 법률·규제 자문이 아니고, 현재 `DEMO_RULE_V1`이 그 내용을 구현했다는 뜻도 아닙니다.

## 이 프로토콜은 무엇을 바꾸는가

- 총 용량(gross capacity)은 **입찰자가 제공할 수 있는 입력이 아닙니다.** `verifyBid`는 `{fundId, ipoId, bidAmount}`만 받으며, 그 외 추가 필드(예: 자기 신고 용량)는 거부합니다. 용량은 어테스터가 발급한 `CapacityAttestation`에서만 얻습니다. `Eip712AttestationVerifier`를 주입하면, 그 어테스테이션은 해당 어테스터에 등록된 키의 유효한 EIP-712 서명도 갖춰야 합니다.
- 조정은 **버전이 있는 결정적 순수 규칙**(`DEMO_RULE_V1`)으로 계산합니다: `조정 용량 = 총 용량 - sum(PARTICIPATING인 하위펀드에 대한 노출)`. 잠금(LOCKED)된 펀드는 면제됩니다.
- 참여 여부는 엄격한 상태기계를 갖춘 **Fund+IPO 단위 공유 원장**에 기록하므로, '참여'와 '비참여'를 사후에 뒤집을 수 없습니다 (`PARTICIPATING <-> NON_PARTICIPATION_LOCKED`는 금지).
- 레지스트리에 알려진 하위펀드를 빠뜨린 어테스테이션은 거부합니다.
- 각 검증은 민감하지 않은 필드에 대한 **영수증 해시**를 만들어, 이후 당사자들이 같은 결과를 보았는지 확인할 수 있게 합니다.

### UNKNOWN은 비참여가 아니다

원장에 기록이 없는 것은 `UNKNOWN`입니다. `UNKNOWN`은 면제를 받지 않습니다. `DEMO_RULE_V1`에서는 하위펀드 중 하나라도 `UNKNOWN`이면 입찰을 `UNDERLYING_PARTICIPATION_UNKNOWN`으로 **거부(REJECT)** 합니다. 용량 수치는 산출하지 않으며, 그 펀드에 대해 아무것도 가정하지 않습니다. 해당 펀드의 상태가 기록된 뒤에는 같은 입찰을 다시 검증할 수 있습니다. 소유자가 2026-10-03 이슈 #10에서 결정했고 PR #23으로 병합되었습니다(이전의 '차감+플래그' 동작과 `UNKNOWN_UNDERLYING_DEDUCTED` 플래그는 사라졌습니다). `DEMO_RULE_V2`는 여기에 더해, 노출액이 0원인 하위펀드가 `UNKNOWN`이면 데이터 오류로 보고 `UNDERLYING_ZERO_EXPOSURE_UNKNOWN`으로(일반 거부보다 우선) 거부합니다. reason code가 달라지므로 `DEMO_RULE_V1`을 고치지 않고 새 규칙 버전으로 냈습니다(같은 규칙 ID는 같은 의미).

판정 시점 스냅샷과 마감 확정(finalization) 규칙의 설계안([docs/design/snapshot-and-finalization.md](docs/design/snapshot-and-finalization.md))은 PR #26~#30으로 병합되었습니다(구현은 아직입니다). 자세한 내용은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)를 참고하세요.

## 블록체인이 해결하는 것 / 해결하지 못하는 것

블록체인은 **아직 구현되지 않았습니다.** 이 절은 블록체인이 무엇을 도울 것으로 기대되는지, 그리고 무엇을 해결하지 못하는지를 설명합니다.

**도움이 될 수 있는 것**
- 서로 신뢰하지 않는 여러 당사자가, 한 운영자가 이력을 정직하게 유지해 주리라 믿지 않고도 읽을 수 있는, 변조 증거가 남는 추가 전용(append-only) 참여 전이 기록.
- 규칙 버전과 어테스터 집합에 대한 공개 커밋. 몰래 바꾸면 드러납니다.

**해결하지 못하는 것**
- **쓰레기 입력(Garbage in).** 원장은 어테스터의 데이터가 사실인지 알 수 없습니다. 침해되었거나 거짓말하는 어테스터는 형식상 올바른 허위 어테스테이션을 만들어 냅니다.
- **프라이버시.** 공개 데이터는 공개입니다. 온체인에 올리는 것은 민감한 금액이 새지 않도록 설계해야 합니다.
- 어떤 규칙이나 기록의 **법적 유효성 또는 규제 당국의 수용**.
- **오프체인 집행.** 원장의 어떤 것도 인수회사가 판정을 따르도록 강제하지 못합니다.
- **거버넌스.** 규칙 버전이나 어테스터 집합을 누가 갱신할 수 있는지는 여전히 사람/기관의 결정입니다.

## 왜 중앙 데이터베이스가 아닌가

모든 참여자가 한 운영자(예: 규제기관이나 거래소가 운영하는 단일 시스템)를 신뢰한다면, **일반 데이터베이스가 더 단순하고 저렴하며 나을 가능성이 큽니다.** 이 PoC는 그 반대를 주장하지 않습니다. 이 PoC의 전제는 단지, 참여자들이 단일 운영자를 완전히 신뢰하지 않거나 이력과 규칙 버전의 독립적 검증 가능성을 원하는 경우, 독립적으로 증빙된 입력을 가진 공유 원장이 평가해 볼 만하다는 것입니다. 현재 코드는 블록체인을 전혀 사용하지 않으며, 참여 원장은 데이터베이스로도 똑같이 뒷받침할 수 있는 인메모리 클래스입니다.

## 저장소 구성

```
packages/domain      도메인 모델, 상태기계, DEMO_RULE_V1, verifyBid (TypeScript, strict)
docs/ARCHITECTURE.md 짧은 아키텍처 노트와 설계 결정
docs/THREAT_MODEL.md 위협 범주와 현재까지 테스트가 다루는 범위
docs/REGULATORY_RESEARCH.md     규정 조사 (리서치 목적, 법률 자문 아님)
docs/REGULATORY_ASSUMPTIONS.md  규칙엔진 PoC 가정 목록
docs/scenarios.md    시나리오 A~E
docs/ROADMAP.md      로드맵과 봇 배정
.github/workflows    CI (install, lint, typecheck, test, build)
```

## 개발

Node 20.19 이상(`@noble/*` 의존성이 요구합니다)과 pnpm 10이 필요합니다.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 라이선스

MIT. [LICENSE](LICENSE)를 참고하세요.
