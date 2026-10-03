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
| `attestation.ts` | `AttestationVerifier` interface, allowlist verifier (no signature check, deprecated), in-memory attestation/revocation/nonce store |
| `eip712.ts` | EIP-712 typed data for `CapacityAttestation`, `Eip712AttestationVerifier` (attester registry + signature check) |
| `registry.ts` | Fund and IPO registry interfaces, in-memory versions |
| `hash.ts` | Canonical JSON and SHA-256 |
| `verify.ts` | `verifyBid`, `BidVerification`, reason codes, receipt construction |

## Key decisions

**No capacity input path.** `BidRequest` has only `fundId`, `ipoId`, `bidAmount`. `verifyBid` rejects requests with any other key (`INVALID_BID_REQUEST`) before reading them. Gross capacity and exposures exist only inside `CapacityAttestation`.

**Participation state machine.** Allowed: `UNKNOWN -> PARTICIPATING`, `UNKNOWN -> NON_PARTICIPATION_LOCKED`. Everything else is rejected, including same-state repeats and any move to UNKNOWN. Participation for a locked fund gives `NON_PARTICIPATION_LOCK_ACTIVE`; locking a participating fund gives `PARTICIPATION_ALREADY_RECORDED`.

**UNKNOWN handling (reject).**
- Absence from the ledger is `UNKNOWN`, never "non-participating".
- In `DEMO_RULE_V1`, if **any** underlying fund is UNKNOWN for the IPO, the rule returns `determined: false` (no adjusted capacity) and `verifyBid` rejects with `UNDERLYING_PARTICIPATION_UNKNOWN`. UNKNOWN is neither exempt like LOCKED nor assumed to be PARTICIPATING: we do not guess a number. Decision recorded by the owner on issue #10 (2026-10-03), replacing the earlier "deduct and flag" behaviour; the `UNKNOWN_UNDERLYING_DEDUCTED` flag no longer exists. The check runs after attestation integrity and exposure-completeness checks and before the bid is compared with capacity.
- Known trade-off: a fund whose underlying fund's manager records late is blocked until that record exists, which a counterparty could exploit by delaying (availability/DoS). Snapshot-at-decision-time and finalization rules are still open in issue #10; a later record can also change the verdict of a bid that was verified earlier.
- For the **bidding fund's own** state: LOCKED rejects the bid; UNKNOWN or PARTICIPATING is allowed (a fund that has not yet been recorded can still be verified before it requests participation).

**Deduction can exceed gross.** Adjusted capacity is clamped to 0 and flagged `DEDUCTION_EXCEEDS_GROSS_CLAMPED_TO_ZERO`.

**Omitted deductions.** `Fund.underlyingFundIds` (registry view) must equal the set of funds in the attestation's exposures. Missing: `UNDERLYING_EXPOSURE_OMITTED`. Extra: `UNDERLYING_EXPOSURE_NOT_IN_REGISTRY`. Repeated: `DUPLICATE_UNDERLYING_EXPOSURE`. This assumes the registry is independent of the asset manager; that is an assumption, not something enforced here.

**Nonce replay.** A nonce, scoped per attester, is bound to the first attestation that used it. Reuse on a different `attestationId` is a replay. Re-verifying the same attestation (many bids) is allowed. Binding happens in `InMemoryAttestationStore.publish`; `verifyBid` only reads.

**Revocation** lives outside the signed object (`RevocationLookup`).

**Time.** Integer epoch milliseconds from an injected `Clock`. An attestation is valid for `issuedAt <= now < expiresAt`, and also must satisfy `now - issuedAt <= RuleVersion.maxAttestationAgeMs` (else `ATTESTATION_STALE`). `DEMO_RULE_V1` uses 24 hours, an arbitrary demo value.

**Signature verification (EIP-712).** `Eip712AttestationVerifier` (`eip712.ts`) implements `AttestationVerifier` and runs at the attester-authorization step of `verifyBid`. It is pure and stateless and never throws on malformed attestations.
- *Registry = allowlist + key binding.* `attesterId -> one signer address`. Unknown attesterId: `ATTESTER_UNAUTHORIZED`. Recovered signer differs from the registered address (forgery, wrong attester's key, any tampered field, wrong domain): `SIGNATURE_INVALID`. Config rules (checked at construction, which may throw): addresses are valid (mixed case must be a valid EIP-55 checksum), non-zero, and each attesterId and each address appears once, so one key cannot speak for two attesters.
- *Domain separation.* Domain = `{name: "ipo-proof CapacityAttestation", version: "1", chainId, verifyingContract}`. `chainId` and `verifyingContract` are supplied by deployment configuration. In this repo they are only domain-separation labels: nothing talks to a chain (tests use synthetic placeholder values). An attestation signed for another chain, contract, name or version does not verify.
- *Signed message.* Every `CapacityAttestation` field except `signature`: `attestationId, fundId, ipoId, ruleVersion` (string), `grossCapacityKrw` (uint256, from bigint), `underlyingExposures` (`UnderlyingExposure{string fundId, uint256 exposureKrw}[]`), `issuedAt, expiresAt` (uint256, integer epoch ms), `nonce, attesterId` (string). Revocation is not signed (it lives outside the object). Values outside uint256, non-integers, wrong types and strings with lone surrogates cannot be encoded and yield `SIGNATURE_INVALID`.
- *Exposure ordering and duplicates.* The exposures are signed as a set in canonical order: ascending `fundId` (UTF-16 code-unit order), ties by ascending `exposureKrw`. Any array order of the same exposures therefore verifies; any change to the set does not. Duplicate `fundId` entries are signed as given (not merged) and are rejected afterwards by `verifyBid` as `DUPLICATE_UNDERLYING_EXPOSURE`. We chose normalization over order-dependent signing so that attester tooling and consumers do not need to agree on array order; the rule engine sums exposures, so order never affected results.
- *Signature format.* `0x` + 130 hex chars (`r || s || v`, 65 bytes). Accepted only if `v` is 27 or 28 (no 0/1 or EIP-155 forms), `r` and `s` are in `[1, n-1]`, and `s` is in the lower half (`s <= n/2`), so the malleable "high-s twin" of a valid signature is rejected. Hex letter case is not significant.
- *Libraries (no hand-rolled cryptography).* `@noble/curves` (secp256k1 public-key recovery) and `@noble/hashes` (keccak-256): small, dependency-light (curves depends only on hashes), pure TypeScript, widely used. We considered `viem`, which provides `hashTypedData`/`recoverTypedDataAddress`, but it pulls in a much larger tree (ox, abitype, @scure/*, ws, isows) for a package meant to stay light. The cost is that `eip712.ts` contains the small EIP-712 byte layout (type strings, 32-byte words). That layout is verified in tests against `viem` (a devDependency used only under `test/`, which also produces the test signatures), so an encoding mistake would show up as a digest mismatch. `@noble/*` 2.x requires Node >= 20.19.
- *Off-chain PoC vs on-chain.* Today the verifier runs off-chain and `chainId`/`verifyingContract` are only labels agreed in configuration. If verification later moves on-chain, the same domain would carry the real chain id and the deployed contract address, and the struct layout above (including the sorted-exposures rule) would have to be reproduced byte for byte in the contract. Changing the struct or its encoding requires a new domain `version`.
- *What a signature is, and is not.* It is attester **provenance**: evidence that the registered key signed these exact bytes. It is not a guarantee that the data is true (the attester is the source of truth for the underlying data; neither a signature nor a blockchain makes real-world data true). It is **not** a zero-knowledge proof and must not be described as one: **ZK STATUS: NOT IMPLEMENTED**. Signature checking is ordinary ECDSA recovery.
- *Privacy.* The signed message contains KRW amounts (gross capacity, exposures) so the signature binds them. That is a property of the off-chain credential only. It is **not** meant to be published in plaintext on a public chain; anything put on-chain must follow the existing rule (pseudonymous ids, commitments/credential hashes, rule version, revocation, timestamps, receipt hash only). The receipt hash still excludes amounts and the signature. All identifiers and amounts in this repo (including test keys, derived at runtime from labels) are synthetic.
- *Limits.* A valid signature proves that the registered key signed these bytes under this domain. It does not prove the numbers are correct, that the key is uncompromised, or that the registry itself is governed well. The registry is static configuration: no rotation, no key revocation. The legacy `AllowlistAttestationVerifier` still ignores signatures and exists only for tests and demos of the other checks.

**Receipt hash.** `proofHash = sha256(canonicalJson(receipt))`, with `proofHashKind = "SHA256_RECEIPT_NOT_A_ZK_PROOF"`. The receipt contains: kind, version, fund id, IPO id, rule version, attestation id, attester id, eligibility, reason code, flags, verification time. It deliberately excludes bid amount, gross capacity, exposures, adjusted capacity and signature, because hashes of low-entropy amounts can be brute-forced. It is evidence of "this verifier reported this outcome", not proof the outcome is correct.

**Check order** (first failure wins) is documented on `verifyBid` in `verify.ts`.

## Not in this slice

Blockchain ledger, ZK proofs, attester key rotation/revocation and governance, persistence, API, UI, regulatory research.
