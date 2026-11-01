# Design note

## 1. Placement

**Authorisations live in a T-REX compliance module** (`TransferAuthorisationModule`), bound to the token's
`ModularCompliance`. In T-REX 4.1.6, `transfer`/`transferFrom` call `canTransfer` → `moduleCheck`, then
`transferred` → `moduleTransferAction`, in the same call. `forcedTransfer`, `recoveryAddress` and `burn` never
call `canTransfer`. So holder transfers are gated and agent operations are not (R5), without touching the
audited token implementation behind the implementation authority. `moduleCheck` gates; `moduleTransferAction`
consumes.

Rejected:
- **Forking or subclassing `Token`.** It leaves the shared implementation-authority upgrade path and the
  audit.
- **A router that holders must call.** Holders can still call the token directly, unless plain
  transfers are disabled, which again means changing the token.
- **T-REX's own `ConditionalTransferModule`.** No expiry, no IDs, and approvals can only be set via
  `ModularCompliance.callModuleFunction`. The backend hot key would have to own the compliance, which
  can add and remove modules.

Two consequences I accepted:
- **Agent path.** `moduleTransferAction` cannot tell a forced transfer from a holder one. It consumes an
  exactly matching live authorisation and is otherwise a no-op. A forced transfer that is exactly an
  authorised movement therefore spends that authorisation. I think that is right: the authorised movement
  happened, and it must not happen twice.
- **Fake compliances.** `AbstractModule.bindCompliance` is permissionless, so consumption also requires
  `token.compliance() == msg.sender`. A self-bound fake compliance cannot burn holders' authorisations.

**Issuance dedup lives on-chain in `IssuanceGateway`**, the only routine minter (a token agent). Only an
on-chain check survives a crash between broadcast and DB commit, a resubmitted tx, or two backend
replicas. Rejected: dedup only in the backend DB, and a mint hook (`moduleMintAction` never sees the
issuance ID).

**If authorisations were signed off-chain (EIP-712) and carried in the holder's tx:** ERC-20 `transfer`
has no slot for a signature, so the token (or a mandatory router) needs a `transferWithAuthorisation(...)`
and plain transfers must be disabled: a token change. In exchange:
- no backend tx per authorisation (~155k gas and a block of latency saved);
- the authorisation is not public before it is used.

Use still needs an on-chain "spent" record. Single revocation still needs an on-chain write (or short
expiries). The chain no longer lists outstanding authorisations, so reconciliation relies on the
backend's own record. A leaked signing key can mint authorisations silently offline. Today's on-chain
issuance is visible and monitorable.

## 2. Roles and keys

| Role / key | Can | Production custody | Limits: contract vs process |
|---|---|---|---|
| T-REX IA owner / factory owner | Upgrade **all** token, IR and compliance proxies | Multisig + timelock, or Tokeny's reference IA (a trust decision) | Contract: none beyond ownership. Process: change control |
| Token / IR / compliance owner | Add/remove agents and modules, swap compliance or IR | Issuer multisig (HSM signers) | Contract: owner-only. Process: everything else |
| Intervention agent (token + IR agent) | Freeze, forced transfer, recovery, burn, direct mint, pause, register identities | Multisig with 2-person rule | Contract: **no amount limits** (T-REX agents are all-powerful). Process: court order or ticket per action |
| `IssuanceGateway` (contract, token agent) | Mint, once per issuance ID | — | Contract: dedup only |
| `ISSUER_ROLE` (backend hot key) | `gateway.issue` | KMS/HSM | Contract: cannot mint directly or reuse an ID, but **no cap**. Process: maker-checker on requests |
| `AUTHORISER_ROLE` (backend hot key) | Issue and revoke authorisations | KMS/HSM | Cannot move tokens (holders still sign). Contract: exact, single-use, expiring |
| Module / gateway `DEFAULT_ADMIN` | Grant and revoke the two backend roles | Issuer multisig | Contract |
| Claim issuer signing key | KYC claims → who is verified | KYC provider HSM | Contract: claim issuer is trusted per topic |
| Holder wallets | Own transfers only | Holder | Contract: verified recipient + authorisation |

The module and gateway are **not upgradeable**; they are replaced instead.
- **Module:** the compliance owner calls `removeModule` / `addModule`. Outstanding authorisations stay in
  the old module, so the backend re-issues them.
- **Gateway:** the owner swaps the token agent. The new gateway starts with **no used issuance IDs**, so
  it must be seeded or use a new ID namespace. Otherwise R6 breaks across the swap.

## 3. Intervention

**(a) Court orders A→B (X) reversed.**
1. On receipt of the order, the backend records `agentOperations[freeze] = {freeze, B, X}`. The agent
   calls `token.freezePartialTokens(B, X)` so B cannot move the tokens meanwhile, and
   `module.revokeAuthorisation` for B's outstanding authorisations.
2. The backend records `{forcedTransfer, B→A, X, ref: order}`. The agent calls
   `token.forcedTransfer(B, A, X)`. This unfreezes as needed (`TokensUnfrozen`) and needs no
   authorisation.
3. The reconciler matches `Transfer(B, A, X)` (plus the unfreeze) to the pending operation. The
   register moves X back. The original authorisation stays `used`, so both legs remain as audit trail.

If B has already sold to C, reaching C needs a separate order; the register shows exactly what is left.

**(b) Lost wallet W1 → W2.**
1. Off-chain: re-KYC the holder.
2. W2 is added as a management key (purpose 1) on the holder's ONCHAINID, by another management key
   (holder or platform). `recoveryAddress` requires that.
3. The backend records `{recovery, W1, W2}`. The agent calls `token.recoveryAddress(W1, W2, identity)`.
   It registers W2 in the identity registry (same country), force-transfers the whole balance,
   re-freezes the frozen part on W2, copies the address freeze, and deletes W1's registry entry.
4. The backend revokes every authorisation naming W1. They can no longer move anything, but should not
   linger.
5. W1's key is removed from the ONCHAINID.
6. The reconciler matches `RecoverySuccess`, moves balance and frozen amount to W2, and re-keys the
   holder record.

## 4. Split timing

**What happens with this code:** the split is extra mints (one gateway issuance per holder). Two
problems:
- **Frozen amounts.** T-REX freezes an *absolute* amount, so a holder with 100 of 200 frozen ends with
  100 of 300 frozen. The restriction silently shrinks from 50% to 33%.
- **Outstanding authorisations.** They bind pre-split amounts and still pass on-chain. An authorisation
  for 100 now moves 100 post-split shares, worth 66.7 pre-split shares.

**What should happen:**
1. Pause the token.
2. `revokeAllAuthorisations(token)`.
3. Reconcile to zero discrepancies.
4. Plan from the register.
5. Pre-register the per-holder issuances, then mint them.
6. Freeze the uplift on frozen holdings: `freezePartialTokens(h, ceil(frozen·(n−d)/d))`.
7. Hold cash-in-lieu for frozen holders' fractions in escrow.
8. Reconcile, unpause, and re-issue authorisations at `amount·n/d` where integral (otherwise the trade
   is re-confirmed).

## 5. Liquidity (AMM)

**No.** Three things block it:
- The pool must be a verified identity.
- Every swap leg needs an exact pre-issued authorisation, but output amounts are set by the curve at
  execution, and the pool initiates its own outgoing transfer.
- An LP pool is an omnibus holder, so the register would no longer know who owns what.

**What would work:**
- A permissioned venue: a pool or hook that checks trader verification, with a module rule that exempts
  transfers to and from that venue from authorisation.
- The register treats the pool as an omnibus account with a sub-ledger rebuilt from pool events.

**Cost:**
- The backend loses pre-trade control: its off-chain business rules must become on-chain rules or
  post-trade checks.
- MEV and front-running.
- Likely venue licensing (MTF/ATS).

I'd recommend RFQ or order-book matching off-chain with atomic on-chain settlement instead (T-REX ships
`DVDTransferManager`). It keeps the authorisation model.

## 6. Alternatives

**ERC-1400** (partitions, controller operations, `transferWithData`). I'd choose it when:
- the asset needs partitions (share classes, locked vs unlocked tranches);
- per-transfer off-chain approvals should ride in the transfer's `data` as signed certificates, instead
  of being stored on-chain.

ERC-3643 wins when on-chain identity and claims must be reused across issuers and tokens, and when the
modular-compliance ecosystem matters. For a single issuer with simple rules, ERC-1404 is enough.

## 7. What I'd change

**Mint authority has a correctness requirement (R6, idempotency) but no security requirement.** The
`ISSUER_ROLE` hot key can mint any amount to any verified wallet, limited only by unique IDs. Minting
is the highest-impact key compromise in the system: it dilutes every holder, and the register can't
undo it without forced burns.

I'd require, on-chain:
- a per-period supply cap in the gateway;
- a second approver for issuances above a threshold (maker-checker), e.g. a request registered by one
  key and executed by another.

The same reasoning applies to the all-powerful T-REX agent: route interventions through a contract that
enforces per-action limits and two approvals.
