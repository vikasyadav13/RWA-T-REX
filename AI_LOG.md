# AI and sources log

## Tools

- **Claude Code (Claude Opus 5.5) in VS Code**: read the T-REX and OnchainID sources, drafted the contracts,
  Foundry tests, TypeScript modules, tests and these documents. It also ran `forge` / `vitest`, which is how
  most of the mistakes below were caught.
- **Foundry 1.8.5** (`forge test`, invariant metrics), **vitest 5 + fast-check 4** for property tests.
- How I verified AI output, in general:
  - every requirement has a failing-case test;
  - the invariants and the B1/B2 tests were **mutation-tested**: I broke the code on purpose (skip the
    `Used` write, make `moduleCheck` always true, remove the gateway's duplicate check, ignore the
    confirmation depth, never rebroadcast, skip the "already applied" check, ignore canonical hashes)
    and confirmed the tests fail;
  - T-REX behaviour was checked against the source, not memory.

## Where the AI output was wrong or incomplete

1. **Security bug in the first module draft.** `moduleTransferAction` derived the token from
   `IModularCompliance(msg.sender).getTokenBound()` and trusted it because of `onlyComplianceCall`. Writing
   the "only bound compliance can call" test, I re-read `AbstractModule.bindCompliance`: it is
   permissionless (`msg.sender == _compliance`), so any contract can bind itself, claim to be our token's
   compliance, and burn holders' live authorisations. Fix: require `token.compliance() == msg.sender`.
   Regression test: `test_fakeComplianceCannotConsumeAuthorisation`. (T-REX's own
   `ConditionalTransferModule` is safe only because it keys state by compliance address, not by token.)

2. **Liveness bug in the issuance submitter, found by a property test, not by review.** The chaos property
   (random drops, reorgs, foreign txs, timeouts, crashes) failed intermittently with "not final yet".
   Shrunk counterexample: `[foreignTx, none, reorg2Evict, foreignTx, none, reorg2Evict]`. Tracing it:
   - after losing its nonce, the submitter re-nonced from the *head* nonce count, which included a
     non-final foreign tx;
   - a reorg evicted that tx and left a nonce gap *below* ours;
   - the AI-written state machine only handled "nonce taken" and "pending", so it fee-bumped forever.

   Fix: if the chain's next nonce is below ours, re-sign at that nonce; the gateway's dedup keeps it safe.
   The first regression test the AI wrote **did not reproduce the bug**: it injected the foreign tx before
   mining, the property injects it after. I caught that because the test failed with the fix in place.
   Replaced with the verbatim counterexample, and checked it fails without the fix and passes with it.
   Then ran 8 seeds × 4,000 runs.

3. **Wrong compiler version for a syntax feature.** The tests used `emit TransferAuthorisationModule.AuthorisationConsumed(...)`.
   Qualified event emission needs solc ≥ 0.8.21, and this repo is pinned to 0.8.17 by T-REX. The
   compiler rejected it; the event is redeclared in the test.

4. **Foundry `vm.prank` consumed by a getter.** The fixture did `vm.prank(owner); module.grantRole(module.AUTHORISER_ROLE(), x)`.
   The prank applies to the first external call, which is the `AUTHORISER_ROLE()` getter, so `grantRole`
   ran as the test contract and `setUp` reverted. Fixed by reading the role constant before pranking.

5. **Vacuous or broken invariant handler.** The first handler computed `actors[(f + 1 + …) % n]`, which
   overflows for large fuzz inputs. With `fail_on_revert = false` this silently turned into skipped calls.
   I re-ran with `FOUNDRY_INVARIANT_FAIL_ON_REVERT=true` to surface it. A passing campaign also showed
   0 consumptions in the last run, so I made `revokeAll` and time jumps rarer and used mutation testing to
   prove the invariants catch real bugs.

Also version-related, smaller:
- the AI first tried tag `v2.1.0` for OnchainID (the tag is `2.1.0`);
- `ERC-3643/ERC-3643` has no 4.1.6 tag (only `4.1.3`, `4.2.0-beta1`), so I listed tags on both repos;
- dependency versions came from T-REX 4.1.6's `package-lock.json`, not its `^` ranges;
- vitest 3 had open advisories (`npm audit`); I moved to vitest 5, which needed `vite` as an explicit peer.

## Primary sources actually read

T-REX 4.1.6 (`lib/T-REX`):
- `contracts/token/Token.sol`: the whole contract. Confirmed which paths call `canTransfer` vs only
  `transferred`, `forcedTransfer`'s auto-unfreeze, and that `forcedTransfer` ignores address freezes.
  Also `recoveryAddress`'s key-purpose-1 requirement, IR registration and identity deletion.
- `contracts/compliance/modular/ModularCompliance.sol`, `modules/IModule.sol`, `modules/AbstractModule.sol`
  (the permissionless bind → finding 1), and `modules/ConditionalTransferModule.sol` (rejected
  alternative, DESIGN §1).
- `contracts/registry/implementation/IdentityRegistry.sol` (`isVerified`).
- `contracts/factory/TREXFactory.sol`, `ITREXFactory.sol`, and
  `proxy/authority/ITREXImplementationAuthority.sol`. The factory adds the token as an IR agent, which
  `recoveryAddress` needs.
- `test/fixtures/deploy-full-suite.fixture.ts` (the deployment the Foundry fixture mirrors),
  `hardhat.config.ts` (solc / optimizer settings), `package-lock.json` (dependency versions).

OnchainID 2.1.0 (`lib/solidity`):
- `Identity.sol`: `keyHasPurpose` (purpose 1 implies all), the `onlyManager` / `onlyClaimKey`
  modifiers, and `delegatedOnly`, which is why identities are deployed behind `IdentityProxy`.
- `ClaimIssuer.isClaimValid`: the signature is over the prefixed `keccak(abi.encode(identity, topic, data))`.
- `IdFactory`, `IdentityProxy` and `ImplementationAuthority` constructors.

Not read in this session: the EIP-3643 specification text itself. Everything above was checked against
the reference implementation.
