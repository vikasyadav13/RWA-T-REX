// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./utils/TREXFixture.sol";

/// Gas for the main transfer path. Numbers are from gasleft() deltas around the external call, so they
/// include proxy delegatecalls, identity/claim verification and compliance, but not the 21k base cost or
/// calldata. Run with `forge test --match-contract GasTest -vv` to print them.
contract GasTest is TREXFixture {
    function setUp() public override {
        super.setUp();
        _issue(bytes32("iss-alice"), alice, 1_000);
        _issue(bytes32("iss-bob"), bob, 1_000); // bob's balance slot is warm-able / non-zero, like a real holder
    }

    function test_gas_authorisedTransfer() public {
        _authorise(bytes32("a"), alice, bob, 100, 1 hours);
        vm.prank(alice);
        uint256 g = gasleft();
        token.transfer(bob, 100);
        g -= gasleft();
        console.log("transfer with authorisation (consumes it):", g);
    }

    function test_gas_issueAuthorisation() public {
        vm.prank(authoriser);
        uint256 g = gasleft();
        authModule.issueAuthorisation(bytes32("a"), address(token), alice, bob, 100, uint64(block.timestamp + 1 hours));
        g -= gasleft();
        console.log("issueAuthorisation:", g);
    }

    function test_gas_baselineTransferWithoutModule() public {
        vm.prank(issuerOwner);
        compliance.removeModule(address(authModule));
        vm.prank(alice);
        uint256 g = gasleft();
        token.transfer(bob, 100);
        g -= gasleft();
        console.log("plain T-REX transfer, no modules:", g);
    }

    function test_gas_gatewayIssue() public {
        vm.prank(issuerBackend);
        uint256 g = gasleft();
        gateway.issue(bytes32("iss-charlie"), charlie, 100);
        g -= gasleft();
        console.log("IssuanceGateway.issue (new holder):", g);
    }
}
