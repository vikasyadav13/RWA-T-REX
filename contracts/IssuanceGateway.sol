// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@tokenysolutions/t-rex/contracts/token/IToken.sol";

/// @title IssuanceGateway
/// @notice The backend's only path to minting. It is registered as a token agent and exposes nothing but
///         an idempotent mint keyed by issuance ID, so the backend hot key (ISSUER_ROLE) never holds the
///         token's agent role and cannot mint outside this check.
/// @dev The guarantee "one issuance ID mints at most once" lives here, on-chain, because it is the only
///      place that cannot be bypassed by a backend bug, a resubmitted tx, or two backend replicas racing.
///      The off-chain submitter (offchain/src/issuance) is responsible for "at least once".
contract IssuanceGateway is AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    IToken public immutable token;

    mapping(bytes32 => bool) private _issued;

    event Issued(bytes32 indexed issuanceId, address indexed to, uint256 amount);

    error InvalidIssuance();
    error AlreadyIssued(bytes32 issuanceId);

    constructor(IToken token_, address admin) {
        token = token_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function issue(bytes32 issuanceId, address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        if (issuanceId == bytes32(0) || amount == 0) revert InvalidIssuance();
        if (_issued[issuanceId]) revert AlreadyIssued(issuanceId);
        _issued[issuanceId] = true;
        // Token.mint reverts unless `to` is verified in the identity registry and compliance allows it.
        token.mint(to, amount);
        emit Issued(issuanceId, to, amount);
    }

    function isIssued(bytes32 issuanceId) external view returns (bool) {
        return _issued[issuanceId];
    }
}
