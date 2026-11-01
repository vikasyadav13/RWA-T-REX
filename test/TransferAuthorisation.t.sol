// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./utils/TREXFixture.sol";

/// A contract that binds itself to the module (bindCompliance is permissionless) and claims to be the
/// compliance of a token it has nothing to do with.
contract FakeCompliance {
    address public getTokenBound;

    constructor(address token_) {
        getTokenBound = token_;
    }

    function bind(IModule m) external {
        m.bindCompliance(address(this));
    }

    function consume(IModule m, address from, address to, uint256 amount) external {
        m.moduleTransferAction(from, to, amount);
    }
}

/// R1–R4: holder-initiated transfers need a live, exact, single-use, expiring, revocable authorisation.
contract TransferAuthorisationTest is TREXFixture {
    bytes32 constant AUTH = bytes32("auth-1");

    // Redeclared: `emit Contract.Event` needs solc >= 0.8.21 and this repo is pinned to 0.8.17.
    event AuthorisationConsumed(
        bytes32 indexed authId, address indexed token, address indexed from, address to, uint256 amount
    );

    function setUp() public override {
        super.setUp();
        _issue(bytes32("iss-alice"), alice, 1_000);
        _issue(bytes32("iss-bob"), bob, 1_000);
    }

    // ------------------------------------------------------------------ R1: binding

    function test_R1_transferWithoutAuthorisationReverts() public {
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 100);
    }

    function test_R1_transferWithAuthorisationSucceedsAndEmitsConsumed() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);

        vm.expectEmit(true, true, true, true, address(authModule));
        emit AuthorisationConsumed(AUTH, address(token), alice, bob, 100);
        vm.prank(alice);
        token.transfer(bob, 100);

        assertEq(token.balanceOf(alice), 900);
        assertEq(token.balanceOf(bob), 1_100);
    }

    function test_R1_bindsAmountExactly() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.startPrank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 99);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 101);
        vm.stopPrank();
        assertTrue(authModule.isLive(AUTH), "failed attempts must not consume");
    }

    function test_R1_bindsRecipient() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(charlie, 100);
    }

    function test_R1_bindsSender() public {
        _authorise(AUTH, alice, charlie, 100, 1 hours);
        vm.prank(bob);
        vm.expectRevert("Transfer not possible");
        token.transfer(charlie, 100);
    }

    function test_R1_bindsToken() public {
        address otherToken = makeAddr("otherToken");
        vm.prank(authoriser);
        authModule.issueAuthorisation(AUTH, otherToken, alice, bob, 100, uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 100);
    }

    /// transferFrom: the authorisation binds the holder (`from`), not the spender. An ERC-20 allowance on
    /// its own is not enough, and the authorisation does not replace the allowance.
    function test_R1_transferFromNeedsBothAllowanceAndAuthorisation() public {
        address spender = makeAddr("spender");
        vm.prank(alice);
        token.approve(spender, 100);

        vm.prank(spender);
        vm.expectRevert("Transfer not possible");
        token.transferFrom(alice, bob, 100);

        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.prank(spender);
        token.transferFrom(alice, bob, 100);
        assertEq(token.balanceOf(bob), 1_100);
        assertEq(token.allowance(alice, spender), 0);
    }

    function test_R1_authorisationWithoutAllowanceDoesNotLetSpenderMove() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.prank(makeAddr("spender"));
        vm.expectRevert(); // allowance underflow
        token.transferFrom(alice, bob, 100);
        assertTrue(authModule.isLive(AUTH));
    }

    function test_R1_failedTransferDoesNotConsume() public {
        // Recipient is not verified: Token reverts before compliance.transferred runs.
        vm.prank(authoriser);
        authModule.issueAuthorisation(AUTH, address(token), alice, unverified, 100, uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(unverified, 100);
        assertTrue(authModule.isLive(AUTH));
    }

    function test_R1_onlyAuthoriserCanIssue() public {
        vm.prank(alice);
        vm.expectRevert();
        authModule.issueAuthorisation(AUTH, address(token), alice, bob, 100, uint64(block.timestamp + 1 hours));
    }

    function test_R1_rejectsMalformedAuthorisation() public {
        vm.startPrank(authoriser);
        uint64 exp = uint64(block.timestamp + 1 hours);
        vm.expectRevert(TransferAuthorisationModule.InvalidAuthorisation.selector);
        authModule.issueAuthorisation(bytes32(0), address(token), alice, bob, 100, exp);
        vm.expectRevert(TransferAuthorisationModule.InvalidAuthorisation.selector);
        authModule.issueAuthorisation(AUTH, address(token), alice, bob, 0, exp);
        vm.expectRevert(TransferAuthorisationModule.InvalidAuthorisation.selector);
        authModule.issueAuthorisation(AUTH, address(0), alice, bob, 100, exp);
        vm.stopPrank();
    }

    function test_R1_onlyOneLiveAuthorisationPerTransferTuple() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.prank(authoriser);
        vm.expectRevert(abi.encodeWithSelector(TransferAuthorisationModule.TransferAlreadyAuthorised.selector, AUTH));
        authModule.issueAuthorisation(bytes32("auth-2"), address(token), alice, bob, 100, uint64(block.timestamp + 1 hours));
    }

    // ------------------------------------------------------------------ R2: single use

    function test_R2_authorisationCannotBeReused() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.startPrank(alice);
        token.transfer(bob, 100);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 100);
        vm.stopPrank();
        assertEq(uint8(authModule.getAuthorisation(AUTH).status), uint8(TransferAuthorisationModule.Status.Used));
    }

    function test_R2_usedAuthIdCannotBeReissued() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.prank(alice);
        token.transfer(bob, 100);

        // e.g. the backend resubmits its original issue transaction
        vm.prank(authoriser);
        vm.expectRevert(abi.encodeWithSelector(TransferAuthorisationModule.AuthIdAlreadyUsed.selector, AUTH));
        authModule.issueAuthorisation(AUTH, address(token), alice, bob, 100, uint64(block.timestamp + 1 hours));
    }

    function test_R2_sameTupleNeedsAFreshAuthorisation() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.prank(alice);
        token.transfer(bob, 100);

        _authorise(bytes32("auth-2"), alice, bob, 100, 1 hours);
        vm.prank(alice);
        token.transfer(bob, 100);
        assertEq(token.balanceOf(bob), 1_200);
    }

    // ------------------------------------------------------------------ R3: expiry

    function test_R3_usableUntilJustBeforeExpiry() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.warp(block.timestamp + 1 hours - 1);
        vm.prank(alice);
        token.transfer(bob, 100);
    }

    function test_R3_expiredAuthorisationReverts() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.warp(block.timestamp + 1 hours); // expiresAt is exclusive
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 100);
        assertFalse(authModule.isLive(AUTH));
    }

    function test_R3_cannotIssueAlreadyExpired() public {
        vm.prank(authoriser);
        vm.expectRevert(TransferAuthorisationModule.InvalidAuthorisation.selector);
        authModule.issueAuthorisation(AUTH, address(token), alice, bob, 100, uint64(block.timestamp));
    }

    function test_R3_expiredTupleCanBeReauthorised() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.warp(block.timestamp + 2 hours);
        _authorise(bytes32("auth-2"), alice, bob, 100, 1 hours);
        vm.prank(alice);
        token.transfer(bob, 100);
        assertEq(uint8(authModule.getAuthorisation(AUTH).status), uint8(TransferAuthorisationModule.Status.Issued));
        assertEq(uint8(authModule.getAuthorisation(bytes32("auth-2")).status), uint8(TransferAuthorisationModule.Status.Used));
    }

    // ------------------------------------------------------------------ R4: revocation

    function test_R4_revokeSingle() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        _authorise(bytes32("auth-2"), alice, charlie, 50, 1 hours);

        vm.prank(authoriser);
        authModule.revokeAuthorisation(AUTH);

        vm.startPrank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 100);
        token.transfer(charlie, 50); // the other one is untouched
        vm.stopPrank();
    }

    function test_R4_revokeUsedOrUnknownReverts() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.prank(alice);
        token.transfer(bob, 100);

        vm.startPrank(authoriser);
        vm.expectRevert(abi.encodeWithSelector(TransferAuthorisationModule.NotRevocable.selector, AUTH));
        authModule.revokeAuthorisation(AUTH);
        vm.expectRevert(abi.encodeWithSelector(TransferAuthorisationModule.NotRevocable.selector, bytes32("nope")));
        authModule.revokeAuthorisation(bytes32("nope"));
        vm.stopPrank();
    }

    function test_R4_revokedAuthIdCannotBeReissued() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.startPrank(authoriser);
        authModule.revokeAuthorisation(AUTH);
        vm.expectRevert(abi.encodeWithSelector(TransferAuthorisationModule.AuthIdAlreadyUsed.selector, AUTH));
        authModule.issueAuthorisation(AUTH, address(token), alice, bob, 100, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
    }

    function test_R4_revokeAllForToken() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        _authorise(bytes32("auth-2"), bob, charlie, 10, 1 hours);
        address otherToken = makeAddr("otherToken");
        vm.prank(authoriser);
        authModule.issueAuthorisation(bytes32("other"), otherToken, alice, bob, 1, uint64(block.timestamp + 1 hours));

        vm.prank(authoriser);
        authModule.revokeAllAuthorisations(address(token));

        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(bob, 100);
        vm.prank(bob);
        vm.expectRevert("Transfer not possible");
        token.transfer(charlie, 10);
        assertTrue(authModule.isLive(bytes32("other")), "other tokens are unaffected");

        // New authorisations after the bulk revoke work, including for a previously authorised tuple.
        _authorise(bytes32("auth-3"), alice, bob, 100, 1 hours);
        vm.prank(alice);
        token.transfer(bob, 100);
    }

    function test_R4_onlyAuthoriserCanRevoke() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        vm.startPrank(alice);
        vm.expectRevert();
        authModule.revokeAuthorisation(AUTH);
        vm.expectRevert();
        authModule.revokeAllAuthorisations(address(token));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ module plumbing

    function test_moduleHooksOnlyCallableByBoundCompliance() public {
        vm.expectRevert("only bound compliance can call");
        authModule.moduleTransferAction(alice, bob, 100);
    }

    /// Regression: a self-bound fake compliance must not be able to burn a real holder's authorisation.
    function test_fakeComplianceCannotConsumeAuthorisation() public {
        _authorise(AUTH, alice, bob, 100, 1 hours);
        FakeCompliance fake = new FakeCompliance(address(token));
        fake.bind(authModule);
        assertTrue(authModule.isComplianceBound(address(fake)));

        vm.expectRevert(abi.encodeWithSelector(TransferAuthorisationModule.UnauthorisedCompliance.selector, address(fake)));
        fake.consume(authModule, alice, bob, 100);
        assertTrue(authModule.isLive(AUTH));
    }
}
