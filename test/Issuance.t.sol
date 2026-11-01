// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./utils/TREXFixture.sol";

/// R6: an issuance ID mints at most once, however many times the backend submits it.
contract IssuanceTest is TREXFixture {
    bytes32 constant ID = bytes32("issuance-1");

    event Issued(bytes32 indexed issuanceId, address indexed to, uint256 amount);

    function test_R6_issueMintsAndEmits() public {
        vm.expectEmit(true, true, false, true, address(gateway));
        emit Issued(ID, alice, 100);
        _issue(ID, alice, 100);
        assertEq(token.balanceOf(alice), 100);
        assertTrue(gateway.isIssued(ID));
    }

    function test_R6_duplicateIssuanceIdReverts() public {
        _issue(ID, alice, 100);
        vm.prank(issuerBackend);
        vm.expectRevert(abi.encodeWithSelector(IssuanceGateway.AlreadyIssued.selector, ID));
        gateway.issue(ID, alice, 100);
        assertEq(token.totalSupply(), 100);
    }

    function test_R6_duplicateIdWithDifferentParamsAlsoReverts() public {
        _issue(ID, alice, 100);
        vm.prank(issuerBackend);
        vm.expectRevert(abi.encodeWithSelector(IssuanceGateway.AlreadyIssued.selector, ID));
        gateway.issue(ID, bob, 999);
        assertEq(token.totalSupply(), 100);
    }

    function test_R6_distinctIdsMintIndependently() public {
        _issue(ID, alice, 100);
        _issue(bytes32("issuance-2"), alice, 100);
        assertEq(token.balanceOf(alice), 200);
    }

    /// A failed mint (recipient not verified) rolls back the "issued" mark, so the same ID can be
    /// submitted again once the recipient is onboarded. Nothing was minted, so this is not a double mint.
    function test_R6_failedMintDoesNotBurnTheId() public {
        vm.prank(issuerBackend);
        vm.expectRevert("Identity is not verified.");
        gateway.issue(ID, unverified, 100);
        assertFalse(gateway.isIssued(ID));

        _onboard(unverified, 42);
        _issue(ID, unverified, 100);
        assertEq(token.balanceOf(unverified), 100);
    }

    function test_R6_onlyIssuerRoleCanIssue() public {
        vm.prank(alice);
        vm.expectRevert();
        gateway.issue(ID, alice, 100);
    }

    /// Mint authority: the backend key can only mint through the gateway, never directly on the token.
    function test_R6_backendKeyIsNotATokenAgent() public {
        vm.prank(issuerBackend);
        vm.expectRevert("AgentRole: caller does not have the Agent role");
        token.mint(alice, 100);
    }

    function test_R6_rejectsZeroIdOrAmount() public {
        vm.startPrank(issuerBackend);
        vm.expectRevert(IssuanceGateway.InvalidIssuance.selector);
        gateway.issue(bytes32(0), alice, 100);
        vm.expectRevert(IssuanceGateway.InvalidIssuance.selector);
        gateway.issue(ID, alice, 0);
        vm.stopPrank();
    }

    function testFuzz_R6_resubmissionNeverMintsTwice(bytes32 id, uint96 amount, uint8 resubmits) public {
        vm.assume(id != bytes32(0) && amount > 0);
        _issue(id, alice, amount);
        for (uint256 i = 0; i < resubmits % 8; i++) {
            vm.prank(issuerBackend);
            try gateway.issue(id, alice, amount) {
                fail();
            } catch {}
        }
        assertEq(token.totalSupply(), amount);
    }
}
