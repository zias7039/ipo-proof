# Architecture (first slice)

Scope: `packages/domain` only. Pure TypeScript, no I/O, no blockchain, no ZK, no UI, no persistence.

## Data flow

```
Attester ──> CapacityAttestation ──┐
Fund/IPO registries ───────────────┤
ParticipationLedger (lookup) ──────┼──> verifyBid({fundId, ipoId, bidAmount}) ──> BidVerification
Revocation list, nonce registry ───┤                                              {eligible, reasonCode,
AttestationVerifier, Clock ────────┘                                               ruleVersion, proofHash,
                                                                                   verifiedAt, flags}
```

`verifyBid` is pure: all state is injected through the `VerifyBidDeps` interfaces and nothing is mutated. Callers record outcomes (for example, requesting participation) separately.

## Modules (`packages/domain/src`)

| File | Responsibility |
| --- | --- |
| `money.ts` | KRW as non-negative `bigint`. Numbers are rejected. |
| `model.ts` | `Fund`, `IPO`, `CapacityAttestation`, `UnderlyingFundExposure`, `RuleVersion`, synthetic-id check |
| `participation.ts` | `ParticipationState`, pure `transition()`, in-memory append-only ledger |
| `rules.ts` | `DEMO_RULE_V1` and rule-version dispatch |
| `attestation.ts` | `AttestationVerifier` interface, allowlist verifier, in-memory attestation/revocation/nonce store |
| `registry.ts` | Fund and IPO registry interfaces, in-memory versions |
| `hash.ts` | Canonical JSON and SHA-256 |
| `verify.ts` | `verifyBid`, `BidVerification`, reason codes, receipt construction |

## Key decisions

**No capacity input path.** `BidRequest` has only `fundId`, `ipoId`, `bidAmount`. `verifyBid` rejects requests with any other key (`INVALID_BID_REQUEST`) before reading them. Gross capacity and exposures exist only inside `CapacityAttestation`.

**Participation state machine.** Allowed: `UNKNOWN -> PARTICIPATING`, `UNKNOWN -> NON_PARTICIPATION_LOCKED`. Everything else is rejected, including same-state repeats and any move to UNKNOWN. Participation for a locked fund gives `NON_PARTICIPATION_LOCK_ACTIVE`; locking a participating fund gives `PARTICIPATION_ALREADY_RECORDED`.

**UNKNOWN handling (conservative).**
- Absence from the ledger is `UNKNOWN`, never "non-participating".
- In `DEMO_RULE_V1`, UNKNOWN underlying exposure is **deducted** like PARTICIPATING and flagged `UNKNOWN_UNDERLYING_DEDUCTED`. We chose "deduct and flag" over "reject" so a bid is still evaluated, but only against the conservative number. The alternative (reject with a reason code) is a one-line change in `verifyBid`.
- For the **bidding fund's own** state: LOCKED rejects the bid; UNKNOWN or PARTICIPATING is allowed (a fund that has not yet been recorded can still be verified before it requests participation).

**Deduction can exceed gross.** Adjusted capacity is clamped to 0 and flagged `DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO`.

**Omitted deductions.** `Fund.underlyingFundIds` (registry view) must equal the set of funds in the attestation's exposures. Missing: `UNDERLYING_EXPOSURE_OMITTED`. Extra: `UNDERLYING_EXPOSURE_NOT_IN_REGISTRY`. Repeated: `DUPLICATE_UNDERLYING_EXPOSURE`. This assumes the registry is independent of the asset manager; that is an assumption, not something enforced here.

**Nonce replay.** A nonce, scoped per attester, is bound to the first attestation that used it. Reuse on a different `attestationId` is a replay. Re-verifying the same attestation (many bids) is allowed. Binding happens in `InMemoryAttestationStore.publish`; `verifyBid` only reads.

**Revocation** lives outside the signed object (`RevocationLookup`).

**Time.** Integer epoch milliseconds from an injected `Clock`. An attestation is valid for `issuedAt <= now < expiresAt`, and also must satisfy `now - issuedAt <= RuleVersion.maxAttestationAgeMs` (else `ATTESTATION_STALE`). `DEMO_RULE_V1` uses 24 hours, an arbitrary demo value.

**Signature verification is NOT IMPLEMENTED.** `AttestationVerifier` is the plug-in point. The only implementation, `AllowlistAttestationVerifier`, checks the attester id against an allowlist and does not look at `signature`. EIP-712 verification is planned for a later phase.

**Receipt hash.** `proofHash = sha256(canonicalJson(receipt))`, with `proofHashKind = "SHA256_RECEIPT_NOT_A_ZK_PROOF"`. The receipt contains: kind, version, fund id, IPO id, rule version, attestation id, attester id, eligibility, reason code, flags, verification time. It deliberately excludes bid amount, gross capacity, exposures, adjusted capacity and signature, because hashes of low-entropy amounts can be brute-forced. It is evidence of "this verifier reported this outcome", not proof the outcome is correct.

**Check order** (first failure wins) is documented on `verifyBid` in `verify.ts`.

## Not in this slice

Blockchain ledger, ZK proofs, EIP-712 signatures, persistence, API, UI, regulatory research.
