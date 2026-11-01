// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./utils/TREXFixture.sol";

/// R5: issuer/agent operations work with the module attached and no authorisation, and leave the module's
/// state consistent: outstanding authorisations are neither consumed nor corrupted unless the forced
/// movement is exactly the one they authorise (see DESIGN.md §1).
contract AgentOperationsTest is TREXFixture {
    bytes32 constant OUTSTANDING = bytes32("outstanding");

    function setUp() public override {
        super.setUp();
        _issue(bytes32("iss-alice"), alice, 1_000);
        _issue(bytes32("iss-bob"), bob, 1_000);
        // An unrelated outstanding authorisation that every agent operation must leave alone.
        _authorise(OUTSTANDING, bob, charlie, 10, 1 days);
    }

    function _assertOutstandingUntouched() internal {
        assertTrue(authModule.isLive(OUTSTANDING), "unrelated authorisation must stay live");
        vm.prank(bob);
        token.transfer(charlie, 10);
        assertFalse(authModule.isLive(OUTSTANDING));
    }

    function test_R5_mintByAgentWithoutAuthorisation() public {
        vm.prank(interventionAgent);
        token.mint(charlie, 500);
        assertEq(token.balanceOf(charlie), 500);
        _assertOutstandingUntouched();
    }

    function test_R5_mintViaGatewayWithoutAuthorisation() public {
        _issue(bytes32("iss-charlie"), charlie, 500);
        assertEq(token.balanceOf(charlie), 500);
        _assertOutstandingUntouched();
    }

    function test_R5_burnWithoutAuthorisation() public {
        vm.prank(interventionAgent);
        token.burn(alice, 400);
        assertEq(token.balanceOf(alice), 600);
        assertEq(token.totalSupply(), 1_600);
        _assertOutstandingUntouched();
    }

    function test_R5_burnBelowAuthorisedAmountLeavesAuthLiveButUnusable() public {
        _authorise(bytes32("a"), alice, bob, 900, 1 days);
        vm.prank(interventionAgent);
        token.burn(alice, 200);
        // The authorisation is untouched; the token's own balance check now blocks the transfer.
        assertTrue(authModule.isLive(bytes32("a")));
        vm.prank(alice);
        vm.expectRevert("Insufficient Balance");
        token.transfer(bob, 900);
        assertTrue(authModule.isLive(bytes32("a")), "a reverted transfer consumes nothing");
    }

    function test_R5_freezeAddressBlocksAuthorisedTransferWithoutConsuming() public {
        _authorise(bytes32("a"), alice, bob, 100, 1 days);
        vm.prank(interventionAgent);
        token.setAddressFrozen(alice, true);

        vm.prank(alice);
        vm.expectRevert("wallet is frozen");
        token.transfer(bob, 100);
        assertTrue(authModule.isLive(bytes32("a")));

        vm.prank(interventionAgent);
        token.setAddressFrozen(alice, false);
        vm.prank(alice);
        token.transfer(bob, 100);
        _assertOutstandingUntouched();
    }

    function test_R5_partialFreezeWithoutAuthorisation() public {
        _authorise(bytes32("a"), alice, bob, 500, 1 days);
        vm.prank(interventionAgent);
        token.freezePartialTokens(alice, 600);
        assertEq(token.getFrozenTokens(alice), 600);

        vm.prank(alice);
        vm.expectRevert("Insufficient Balance"); // only 400 free
        token.transfer(bob, 500);
        assertTrue(authModule.isLive(bytes32("a")));

        vm.prank(interventionAgent);
        token.unfreezePartialTokens(alice, 600);
        vm.prank(alice);
        token.transfer(bob, 500);
        _assertOutstandingUntouched();
    }

    function test_R5_forcedTransferWithoutAuthorisation() public {
        vm.prank(interventionAgent);
        token.forcedTransfer(alice, charlie, 300);
        assertEq(token.balanceOf(charlie), 300);
        _assertOutstandingUntouched();
    }

    function test_R5_forcedTransferIgnoresFreezeAndUnfreezesAsNeeded() public {
        vm.startPrank(interventionAgent);
        token.freezePartialTokens(alice, 900);
        token.forcedTransfer(alice, charlie, 500); // T-REX unfreezes 400 to make room
        vm.stopPrank();
        assertEq(token.getFrozenTokens(alice), 500);
        _assertOutstandingUntouched();
    }

    /// Documented edge case: a forced transfer that is exactly the movement a live authorisation covers
    /// consumes it, so the same movement cannot then happen a second time on the holder's signature.
    function test_R5_forcedTransferMatchingLiveAuthorisationConsumesIt() public {
        _authorise(bytes32("a"), alice, bob, 100, 1 days);
        vm.prank(interventionAgent);
        token.forcedTransfer(alice, bob, 100);
        assertEq(uint8(authModule.getAuthorisation(bytes32("a")).status), uint8(TransferAuthorisationModule.Status.Used));
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 100);
        _assertOutstandingUntouched();
    }

    function test_R5_forcedTransferReversesCompletedTransfer() public {
        _authorise(bytes32("a"), alice, bob, 250, 1 days);
        vm.prank(alice);
        token.transfer(bob, 250);

        // Court order: reverse it. No authorisation needed, none issued.
        vm.prank(interventionAgent);
        token.forcedTransfer(bob, alice, 250);
        assertEq(token.balanceOf(alice), 1_000);
        assertEq(token.balanceOf(bob), 1_000);
        _assertOutstandingUntouched();
    }

    function test_R5_walletRecoveryWithoutAuthorisation() public {
        address aliceNew = makeAddr("aliceNew");
        Identity aliceId = identityOf[alice];
        _authorise(bytes32("from-lost"), alice, bob, 100, 1 days);
        _authorise(bytes32("to-lost"), bob, alice, 5, 1 days);

        vm.prank(interventionAgent);
        token.freezePartialTokens(alice, 300);

        // The holder (via another management key in production) adds the new wallet to their ONCHAINID.
        vm.prank(alice);
        aliceId.addKey(keccak256(abi.encode(aliceNew)), 1, 1);

        vm.prank(interventionAgent);
        token.recoveryAddress(alice, aliceNew, address(aliceId));

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(aliceNew), 1_000);
        assertEq(token.getFrozenTokens(aliceNew), 300, "frozen amount follows the holder");
        assertEq(token.getFrozenTokens(alice), 0);
        assertFalse(ir.contains(alice));
        assertTrue(ir.isVerified(aliceNew));

        // Authorisations naming the lost wallet are not consumed, but can no longer move anything:
        // the lost wallet is empty and no longer verified as a recipient. The backend revokes them.
        assertTrue(authModule.isLive(bytes32("from-lost")));
        vm.prank(bob);
        vm.expectRevert("Transfer not possible");
        token.transfer(alice, 5);
        vm.startPrank(authoriser);
        authModule.revokeAuthorisation(bytes32("from-lost"));
        authModule.revokeAuthorisation(bytes32("to-lost"));
        vm.stopPrank();

        // The recovered holder transacts normally with fresh authorisations for the new wallet.
        _authorise(bytes32("new"), aliceNew, bob, 100, 1 days);
        vm.prank(aliceNew);
        token.transfer(bob, 100);
        _assertOutstandingUntouched();
    }

    function test_R5_pauseBlocksHoldersNotAuthorisations() public {
        _authorise(bytes32("a"), alice, bob, 100, 1 days);
        vm.prank(interventionAgent);
        token.pause();
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        token.transfer(bob, 100);
        vm.prank(interventionAgent);
        token.unpause();
        vm.prank(alice);
        token.transfer(bob, 100);
    }
}
