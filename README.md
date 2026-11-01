# Permissioned share token on ERC-3643 (T-REX v4)

Take-home exercise: transfer authorisations and idempotent issuance on a T-REX token (Part A), plus the
off-chain issuance submitter, reconciliation and stock-split planner (Part B).
Design answers are in [DESIGN.md](DESIGN.md), the AI/sources log in [AI_LOG.md](AI_LOG.md).

## Pinned versions

| Dependency | Version | Commit |
|---|---|---|
| T-REX (`TokenySolutions/T-REX`) | **4.1.6** | `a09cfd38aa257d56db7ff9c90f30e65f125a141b` |
| OnchainID (`onchain-id/solidity`) | 2.1.0 (resolved by T-REX 4.1.6's `package-lock.json`) | `3f3b07ab9ddc0266e9d726c4a70605902fc86d48` |
| OpenZeppelin contracts / contracts-upgradeable | 4.9.3 (same lockfile) | `fd81a96f` / `3d4c0d57` |
| forge-std | 1.9.7 | `77041d2c` |
| solc | 0.8.17 (T-REX and OnchainID pin it), optimizer 200 runs as in T-REX's hardhat config |

4.1.6 is the latest stable v4 tag. `ERC-3643/ERC-3643` only has `4.1.3` and `4.2.0-beta1`, so the
`TokenySolutions/T-REX` tags were used. All dependencies are git submodules under `lib/`.

## Run it

```bash
git clone --recurse-submodules <repo> && cd <repo>
forge test                      # Part A: 52 tests incl. invariant campaign (~2 s)
forge test --match-contract GasTest -vv   # prints the gas numbers below

cd offchain && npm ci && npm test   # Part B: 50 tests (vitest + fast-check, ethers v6)
npm run typecheck
```

If you cloned without `--recurse-submodules`, run `git submodule update --init --recursive` first.
Tested with Foundry 1.8.6 and Node 24.

## Layout

```
contracts/TransferAuthorisationModule.sol   T-REX compliance module: R1–R5
contracts/IssuanceGateway.sol               token agent with idempotent issue(issuanceId, to, amount): R6
test/utils/TREXFixture.sol                  full suite via TREXFactory (proxies, IA, OnchainID, KYC claims)
test/TransferAuthorisation.t.sol            R1–R4, incl. fake-compliance regression
test/AgentOperations.t.sol                  R5: mint, burn, freeze, forced transfer, recovery, pause
test/Issuance.t.sol                         R6 + fuzz
test/invariant/                             stateful invariants (reasons in comments)
test/Gas.t.sol                              gas of the main paths
offchain/src/issuance/                      B1 submitter, chain/store interfaces, ethers v6 adapter
offchain/src/reconcile/reconcile.ts         B2
offchain/src/split/planSplit.ts             B3
offchain/test/fakeChain.ts                  deterministic chain + mempool used to test B1
```

## Gas (main transfer path)

Execution gas from `gasleft()` deltas in `test/Gas.t.sol`. It includes proxy delegatecalls, identity and
claim verification and compliance. It excludes the 21k intrinsic cost and calldata.

| Path | Gas |
|---|---|
| `transfer` with authorisation (check + consume) | **250,639** |
| same token, module removed (plain T-REX transfer) | 217,037 |
| overhead of the authorisation module | **+33,602 (+15%)** |
| `issueAuthorisation` (backend) | 154,897 |
| `IssuanceGateway.issue` (new holder) | 268,679 |

The module's overhead is cold reads of the tuple index, the authorisation and the epoch, the status
write, and one `token.compliance()` call. Most of the transfer's cost is T-REX's own `isVerified` claim
check. The SSTORE refund from deleting the tuple index is not reflected in `gasleft()` deltas.

## Assumptions

Each of these is a decision I made instead of asking. Each one is a good question for the interviewer.

**Contracts**
1. An authorisation binds the *holder whose balance moves* (`from`). For `transferFrom` the spender
   also needs a normal ERC-20 allowance. The authorisation does not replace it.
2. At most one live authorisation per `(token, from, to, amount)`. A plain `transfer(to, amount)` carries no
   ID, so the tuple must identify the authorisation unambiguously. A second identical transfer needs a new
   authorisation once the first is used, revoked or expired.
3. `expiresAt` is exclusive: usable while `block.timestamp < expiresAt`.
4. Authorisation IDs and issuance IDs can never be reused, even after revocation or expiry. A resubmitted
   backend tx cannot resurrect a spent authorisation.
5. "Revoke all for a token" bumps an epoch (O(1)). Old authorisations keep status `Issued` in storage;
   `isLive()` is the source of truth.
6. Mint is not gated by authorisations. Control is the agent role, held only by `IssuanceGateway` for
   routine issuance.
7. A forced transfer that exactly matches a live authorisation consumes it. The module cannot tell
   forced from holder transfers in `moduleTransferAction`. See DESIGN.md §1.
8. A duplicate issuance ID reverts (`AlreadyIssued`) rather than silently succeeding. The submitter does
   not rely on the revert: it reads `isIssued` at a final block.

**Off-chain**
9. B1 is tested against a mocked chain interface (`offchain/test/fakeChain.ts`), not Anvil. One submitter
   process per signer key (leader election is out of scope). `IssuanceStore.put` is durable when it
   resolves. Only an in-memory store is provided.
10. Confirmation depth defaults to 64 blocks (Ethereum: ~2 epochs, i.e. finalized). The tests use 3.
11. B2 handles one token per state. A batch contains every log for each block it covers, so a tx's logs
    are never split. State keys are lower-case hex.
12. B2's backend state includes `agentOperations` (interventions the backend initiated), so forced
    transfers, burns, freezes and recoveries the backend ordered can be told apart from unauthorised ones.
13. B3: "minted tokens plus fractional entitlements equal exactly the old supply × 3/2" is read as *new
    holdings* (old + minted) + fractions = old × 3/2. The tests also assert the equivalent statement
    for the increase alone (minted + fractions = old × 1/2). Reverse splits are rejected.
14. B1: a final revert (e.g. recipient not yet verified) is `failed` and is never retried automatically.
    `retryFailedIssuance(request)` retries it once a human has fixed the cause. The contract allows this
    (a reverted mint does not burn the ID), and the old attempts are kept in `failedAttempts`.
15. B2 reports two things. `discrepancies` holds new findings from this batch only, so a replay adds
    nothing. `standingMismatches` is a full register-vs-chain snapshot over every known address, so drift
    on a holder with no events in the batch is still caught. That snapshot repeats until fixed.

## Unfinished / known gaps

- In `offchain/src/issuance/ethersAdapter.ts`, `EthersTxSigner` is unit-tested (local signing, no node
  needed), but `EthersChainClient` is only type-checked. There is no Anvil end-to-end test and no
  deploy script.
- `IssuanceGateway` has no supply or rate cap. This is the change I'd make first (DESIGN.md §7).
- B2 does not reconcile `AuthorisationIssued/Revoked`, `AddressFrozen` or `Paused` events, and does not
  auto-unwind a reorg deeper than the confirmation depth. It raises `DEEP_REORG` for a human.
- The split is planned (B3) but not executed. The pause → revoke-all → mint → re-freeze → unpause
  orchestration in DESIGN.md §4 is not implemented.
- Replacing `IssuanceGateway` loses its set of used issuance IDs (see DESIGN.md §2).
