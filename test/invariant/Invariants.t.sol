// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../utils/TREXFixture.sol";
import "./Handler.sol";

/// Stateful fuzzing of the whole system: random interleavings of authorisation issue/revoke/revoke-all,
/// holder transfers (transfer and transferFrom), duplicate-prone issuance, forced transfers, burns,
/// partial freezes and time jumps.
contract InvariantsTest is TREXFixture {
    Handler internal handler;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        _issue(bytes32("seed-alice"), alice, 1_000);
        _issue(bytes32("seed-bob"), bob, 1_000);
        actors.push(alice);
        actors.push(bob);
        actors.push(charlie);
        handler = new Handler(token, authModule, gateway, authoriser, issuerBackend, interventionAgent, actors, 2_000);
        targetContract(address(handler));
    }

    /// Why: the platform's core promise. If any holder-signed transfer gets through without a live
    /// authorisation, or gets through without spending it, the backend no longer decides which
    /// transfers happen (context fact 3).
    function invariant_noHolderTransferWithoutConsumingAnAuthorisation() public {
        assertEq(handler.ghostAuthViolations(), 0);
    }

    /// Why: single use (R2) stated globally. Every authorisation in the Used state must correspond to
    /// exactly one movement of tokens: no consumption without a transfer, no transfer consuming two.
    function invariant_usedAuthorisationsMatchMovements() public {
        uint256 used;
        uint256 n = handler.authCount();
        for (uint256 i = 0; i < n; i++) {
            if (authModule.getAuthorisation(handler.authIds(i)).status == TransferAuthorisationModule.Status.Used) {
                used++;
            }
        }
        assertEq(used, handler.ghostExpectedConsumptions());
    }

    /// Why: a holder transfer is identified only by (token, from, to, amount). Two live authorisations
    /// for one tuple would make "which one did this transfer use?" ambiguous for the backend.
    function invariant_atMostOneLiveAuthorisationPerTransfer() public {
        uint256 n = handler.authCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.authIds(i);
            if (!authModule.isLive(id)) continue;
            TransferAuthorisationModule.Authorisation memory a = authModule.getAuthorisation(id);
            assertEq(authModule.liveAuthorisationFor(a.token, a.from, a.to, a.amount), id);
        }
    }

    /// Why: R6. Supply must equal what was issued under distinct issuance IDs minus burns. A double mint
    /// is exactly the drift between chain and backend record we most need to rule out.
    function invariant_supplyMatchesUniqueIssuancesMinusBurns() public {
        assertEq(handler.ghostDoubleMints(), 0);
        assertEq(token.totalSupply(), handler.ghostMinted() - handler.ghostBurned());
    }

    /// Why: tokens only ever sit with known, verified holders. If balances summed to less than supply,
    /// tokens would exist somewhere the backend's register does not list.
    function invariant_balancesSumToSupply() public {
        uint256 sum;
        for (uint256 i = 0; i < actors.length; i++) {
            sum += token.balanceOf(actors[i]);
        }
        assertEq(sum, token.totalSupply());
    }

    /// Why: forced transfers and burns unfreeze as needed (T-REX), and none of our hooks may break that.
    /// Frozen above balance would leave a holder unable to move anything and corrupt the frozen record.
    function invariant_frozenNeverExceedsBalance() public {
        for (uint256 i = 0; i < actors.length; i++) {
            assertLe(token.getFrozenTokens(actors[i]), token.balanceOf(actors[i]));
        }
    }
}
