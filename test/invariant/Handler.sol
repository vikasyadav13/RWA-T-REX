// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "forge-std/Test.sol";
import "@tokenysolutions/t-rex/contracts/token/Token.sol";
import "../../contracts/TransferAuthorisationModule.sol";
import "../../contracts/IssuanceGateway.sol";

/// Drives random sequences of backend, holder and agent operations, and keeps ghost accounting that the
/// invariants compare against on-chain state. Every call is wrapped in try/catch: reverts are expected
/// (expired auth, insufficient balance, duplicate issuance...) and are not failures in themselves.
contract Handler is Test {
    Token internal token;
    TransferAuthorisationModule internal authModule;
    IssuanceGateway internal gateway;
    address internal authoriser;
    address internal issuerBackend;
    address internal agent;

    address[] public actors;
    bytes32[] public authIds;
    uint256 internal authNonce;

    uint256 public ghostMinted;
    uint256 public ghostBurned;
    /// Holder transfers that succeeded + forced transfers that matched a live authorisation.
    uint256 public ghostExpectedConsumptions;
    /// A holder transfer succeeded without a live authorisation, or did not consume the one it used.
    uint256 public ghostAuthViolations;
    /// An issuance ID that already minted minted again.
    uint256 public ghostDoubleMints;
    mapping(bytes32 => bool) internal _minted;

    constructor(
        Token token_,
        TransferAuthorisationModule module_,
        IssuanceGateway gateway_,
        address authoriser_,
        address issuerBackend_,
        address agent_,
        address[] memory actors_,
        uint256 initialSupply
    ) {
        token = token_;
        authModule = module_;
        gateway = gateway_;
        authoriser = authoriser_;
        issuerBackend = issuerBackend_;
        agent = agent_;
        actors = actors_;
        ghostMinted = initialSupply;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function authCount() external view returns (uint256) {
        return authIds.length;
    }

    function _pair(uint256 f, uint256 t) internal view returns (address from, address to) {
        uint256 i = f % actors.length;
        from = actors[i];
        to = actors[(i + 1 + (t % (actors.length - 1))) % actors.length]; // always != from
    }

    // ---------------------------------------------------------------- backend

    function issueAuthorisation(uint256 f, uint256 t, uint256 amount, uint256 ttl) external {
        (address from, address to) = _pair(f, t);
        amount = bound(amount, 1, 300);
        ttl = bound(ttl, 1, 2 days);
        bytes32 id = keccak256(abi.encode("auth", authNonce++));
        vm.prank(authoriser);
        try authModule.issueAuthorisation(id, address(token), from, to, amount, uint64(block.timestamp + ttl)) {
            authIds.push(id);
        } catch {}
    }

    function revoke(uint256 idx) external {
        if (authIds.length == 0) return;
        vm.prank(authoriser);
        try authModule.revokeAuthorisation(authIds[idx % authIds.length]) {} catch {}
    }

    function revokeAll(uint256 seed) external {
        // Rare: otherwise it wipes every authorisation before the fuzzer gets to use one.
        if (seed % 8 != 0) return;
        vm.prank(authoriser);
        authModule.revokeAllAuthorisations(address(token));
    }

    function issue(uint256 idSeed, uint256 t, uint256 amount) external {
        // Small ID space so the fuzzer resubmits IDs often.
        bytes32 id = bytes32(1 + (idSeed % 12));
        address to = actors[t % actors.length];
        amount = bound(amount, 1, 1_000);
        vm.prank(issuerBackend);
        try gateway.issue(id, to, amount) {
            if (_minted[id]) ghostDoubleMints++;
            _minted[id] = true;
            ghostMinted += amount;
        } catch {}
    }

    // ---------------------------------------------------------------- holders

    /// Exactly the transfer some authorisation covers, so a good share of calls succeed.
    function transferAuthorised(uint256 idx, bool viaTransferFrom) external {
        if (authIds.length == 0) return;
        TransferAuthorisationModule.Authorisation memory a = authModule.getAuthorisation(authIds[idx % authIds.length]);
        _holderTransfer(a.from, a.to, a.amount, viaTransferFrom);
    }

    /// Arbitrary transfer, usually with no authorisation.
    function transferArbitrary(uint256 f, uint256 t, uint256 amount, bool viaTransferFrom) external {
        (address from, address to) = _pair(f, t);
        _holderTransfer(from, to, bound(amount, 1, 300), viaTransferFrom);
    }

    function _holderTransfer(address from, address to, uint256 amount, bool viaTransferFrom) internal {
        bytes32 liveBefore = authModule.liveAuthorisationFor(address(token), from, to, amount);
        bool ok;
        if (viaTransferFrom) {
            address spender = address(uint160(uint256(keccak256(abi.encode("spender", from)))));
            vm.prank(from);
            token.approve(spender, amount);
            vm.prank(spender);
            try token.transferFrom(from, to, amount) returns (bool r) {
                ok = r;
            } catch {}
        } else {
            vm.prank(from);
            try token.transfer(to, amount) returns (bool r) {
                ok = r;
            } catch {}
        }
        if (!ok) return;
        if (liveBefore == bytes32(0)) {
            ghostAuthViolations++;
        } else if (authModule.getAuthorisation(liveBefore).status != TransferAuthorisationModule.Status.Used) {
            ghostAuthViolations++;
        } else {
            ghostExpectedConsumptions++;
        }
    }

    // ---------------------------------------------------------------- agent

    function forcedTransfer(uint256 f, uint256 t, uint256 amount) external {
        (address from, address to) = _pair(f, t);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        bytes32 liveBefore = authModule.liveAuthorisationFor(address(token), from, to, amount);
        vm.prank(agent);
        token.forcedTransfer(from, to, amount); // must never revert for a verified recipient
        if (liveBefore != bytes32(0)) ghostExpectedConsumptions++;
    }

    function burn(uint256 f, uint256 amount) external {
        address from = actors[f % actors.length];
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(agent);
        token.burn(from, amount);
        ghostBurned += amount;
    }

    function freezePartial(uint256 f, uint256 amount) external {
        address who = actors[f % actors.length];
        uint256 free = token.balanceOf(who) - token.getFrozenTokens(who);
        if (free == 0) return;
        vm.prank(agent);
        token.freezePartialTokens(who, bound(amount, 1, free));
    }

    function unfreezePartial(uint256 f, uint256 amount) external {
        address who = actors[f % actors.length];
        uint256 frozen = token.getFrozenTokens(who);
        if (frozen == 0) return;
        vm.prank(agent);
        token.unfreezePartialTokens(who, bound(amount, 1, frozen));
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 6 hours));
    }
}
