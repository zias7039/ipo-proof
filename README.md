# ipo-proof

**Disclaimer**

This project is a technical proof of concept.

The included eligibility and payment-capacity rules are illustrative implementations and must not be treated as legal or regulatory advice or as a production implementation of Korean securities regulations.

`ipo-proof` explores replacing **self-declared institutional IPO payment capacity** (in the context of Korean IPO demand forecasting) with **independently attested source data**, a **deterministic rule engine**, and a **shared participation ledger**.

This repository currently contains only the first slice: the pure TypeScript domain logic (Phases 1-2) and repo scaffolding. All identifiers (`fund_a`, `ipo_1`, `attester_1`, ...) and amounts are synthetic. No real fund names, AUM, or personal data belong in this repo.

## Status

| Area | Status |
| --- | --- |
| Domain model (Fund, IPO, CapacityAttestation, UnderlyingFundExposure, ParticipationState, RuleVersion, BidVerification) | Implemented (in-memory, bigint KRW) |
| Participation state machine (UNKNOWN / PARTICIPATING / NON_PARTICIPATION_LOCKED) | Implemented, tested |
| Rule engine `DEMO_RULE_V1` | Implemented, tested (illustrative rule only) |
| `verifyBid` with expiry/stale, revocation, rule-version, nonce-replay, attester-authorization checks | Implemented, tested |
| Attestation **signature verification** (EIP-712 or other) | **NOT IMPLEMENTED** (interface `AttestationVerifier` only; the provided verifier checks an attester allowlist and ignores `signature`) |
| Receipt hash (`proofHash`, SHA-256 of canonical JSON) | Implemented. It is a receipt hash, **not** a proof |
| **ZK STATUS: NOT IMPLEMENTED** | No zero-knowledge proofs of any kind |
| Blockchain / on-chain ledger | **NOT IMPLEMENTED yet**. The "shared ledger" is an in-memory class |
| Persistence | Not implemented |
| UI / API server | Not implemented |

## What problem are we solving

In the scenario this PoC assumes, an institutional investor's ability to pay for an IPO allocation is declared by the asset manager itself. Two weaknesses follow from that premise:

1. **Self-declared capacity is unverifiable.** The party that benefits from a larger number is the party that reports it.
2. **Overlapping exposure is easy to miss.** If one fund invests in other funds that may also bid on the same IPO, the same money can appear to back several bids, and nothing forces those deductions to be applied consistently.

This premise comes from the project brief. It has not been checked against actual rules in this repository, and no regulatory research is included here.

## What does the protocol change

- Gross capacity is **not an input a bidder can provide**. `verifyBid` accepts only `{fundId, ipoId, bidAmount}`; any extra field (such as a self-declared capacity) is rejected. Capacity comes only from a `CapacityAttestation` issued by an attester.
- The adjustment is computed by a **versioned, deterministic, pure rule** (`DEMO_RULE_V1`): `Adjusted Capacity = Gross Capacity - sum(exposure to underlying funds that are PARTICIPATING)`. Locked funds are exempt.
- Participation is recorded in a **shared per-Fund+IPO ledger** with a strict state machine, so "participating" and "not participating" cannot be flipped after the fact (`PARTICIPATING <-> NON_PARTICIPATION_LOCKED` is forbidden).
- Attestations that omit an underlying fund known to the registry are rejected.
- Each verification yields a **receipt hash** over non-sensitive fields so parties can later check they saw the same outcome.

### UNKNOWN is not non-participation

Absence from the ledger is `UNKNOWN`. `UNKNOWN` never receives the exemption. In `DEMO_RULE_V1`, an `UNKNOWN` underlying fund's exposure is **deducted** (conservatively, as if it were PARTICIPATING) and the result carries the flag `UNKNOWN_UNDERLYING_DEDUCTED`. A bid is judged against that conservative figure. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What blockchain solves / does NOT solve

Blockchain is **not implemented yet**. This section describes what it is expected to help with, and what it will not.

**Could help with**
- A tamper-evident, append-only record of participation transitions that several mutually distrusting parties can read without trusting one operator to keep history honest.
- Public commitment to rule versions and attester sets, so silent changes are visible.

**Does NOT solve**
- **Garbage in.** A ledger cannot tell whether an attester's data is true. A compromised or lying attester produces a validly formed, false attestation.
- **Privacy.** Public data is public. Anything put on-chain must be designed not to leak sensitive amounts.
- **Legal validity or regulatory acceptance** of any rule or record.
- **Off-chain enforcement.** Nothing on a ledger forces an underwriter to honor a verdict.
- **Governance.** Who may update rule versions or attester sets is still a human/institutional decision.

## Why not a central database

If every participant trusts one operator (for example a single regulator-run or exchange-run system), **a plain database is likely simpler, cheaper and better**, and this PoC does not argue otherwise. Its premise is only that, where participants do not fully trust a single operator or want independent verifiability of history and rule versions, a shared ledger with independently attested inputs is worth evaluating. The current code does not use any blockchain; the participation ledger is an in-memory class that could equally be backed by a database.

## Repository layout

```
packages/domain      Domain model, state machine, DEMO_RULE_V1, verifyBid (TypeScript, strict)
docs/ARCHITECTURE.md Short architecture notes and design decisions
docs/THREAT_MODEL.md Threat categories and what tests cover so far
.github/workflows    CI (install, lint, typecheck, test, build)
```

## Development

Requires Node 20 and pnpm 10.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT, see [LICENSE](LICENSE).
