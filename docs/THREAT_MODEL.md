# Threat model (stub)

This is a stub. It lists threat categories and records **only what is covered by automated tests today**. "Not covered" means exactly that: not mitigated and not tested in this slice. Test references are in `packages/domain/test`.

| Threat category | Covered so far (by tests) | Not covered yet |
| --- | --- | --- |
| Malicious asset manager | Cannot supply capacity: `verifyBid` rejects requests with extra fields such as a self-declared capacity (`verify.test.ts`). Omitting a participating underlying fund from the attestation is rejected (`verify.test.ts`, `demo.test.ts`). Switching an already-participating fund to LOCKED is rejected (`participation.test.ts`, `demo.test.ts`). | Collusion with an attester. Manipulating or splitting funds to avoid registry linkage. Registry independence is assumed, not enforced. |
| Malicious / compromised attester | Unauthorized attester id is rejected (`attestation.test.ts`, `verify.test.ts`). | A **compromised authorized** attester can issue false attestations; nothing detects that. Signature verification is NOT IMPLEMENTED (the allowlist verifier ignores signatures). No multi-attester quorum, no attester key rotation. |
| Malicious underwriter | Nothing. | Ignoring verdicts, selective disclosure, front-running. Receipt hash is not a binding commitment. |
| Validator collusion | N/A: no blockchain yet. | Everything. |
| Credential forgery / replay / revocation / stale | Revoked rejected; expired rejected; not-yet-valid rejected; stale (age over rule limit) rejected; nonce reuse on a different attestation rejected; wrong rule version rejected; wrong subject rejected (`verify.test.ts`, `demo.test.ts`). | **Forgery**: no signature verification, so a forged attestation from an allowlisted attester id is accepted. Revocation list freshness/availability. Nonce store durability (in-memory only). |
| Privacy leakage | Receipt hash contains only an allowlisted set of non-sensitive fields; no amounts (`verify.test.ts`). Bid amounts with the same outcome yield identical hashes. | `BidVerification` still reveals eligibility and reason code, which leaks information at the boundary (e.g. repeated probing of bid sizes). Attestation contents are plain objects. No access control, no ZK. |
| Unauthorized state transition | Only `UNKNOWN -> PARTICIPATING` and `UNKNOWN -> NON_PARTICIPATION_LOCKED` are accepted; exhaustively tested; rejected requests leave the ledger unchanged (`participation.test.ts`). | **Who** may request a transition is not modeled: there is no caller authentication or authorization on the ledger. |
| Rule version manipulation | Attestation with a rule version different from the active one is rejected; unsupported active rule version is rejected (`verify.test.ts`). | Governance of who sets the active rule version. Versions are not committed anywhere tamper-evident. `DEMO_RULE_V1` parameters live in code. |

Also covered: UNKNOWN underlying participation is never exempt and causes rejection with `UNDERLYING_PARTICIPATION_UNKNOWN`, including mixed known/unknown cases (`rules.test.ts`, `verify.test.ts`, `demo.test.ts`). Not covered: a fund's state changing after a verdict (no decision-time snapshot or finalization rule yet), and delay of an underlying fund's record as a denial-of-service lever, and money is bigint-only (`money.test.ts`).

None of this is a security audit. The system is a proof of concept.
