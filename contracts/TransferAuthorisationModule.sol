// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@tokenysolutions/t-rex/contracts/compliance/modular/IModularCompliance.sol";
import "@tokenysolutions/t-rex/contracts/compliance/modular/modules/AbstractModule.sol";
import "@tokenysolutions/t-rex/contracts/token/IToken.sol";

/// @title TransferAuthorisationModule
/// @notice T-REX compliance module that only lets a holder-initiated transfer through if the backend
///         has stored a single-use, expiring authorisation for exactly (token, from, to, amount).
///
/// How it hooks into T-REX 4.1.6 (see Token.sol / ModularCompliance.sol):
///  - transfer / transferFrom call compliance.canTransfer(from, to, amount) -> moduleCheck (view),
///    then compliance.transferred(...) -> moduleTransferAction, in the same call. moduleCheck gates,
///    moduleTransferAction consumes.
///  - mint calls canTransfer(address(0), to, amount): moduleCheck lets from == 0 through.
///  - burn calls only destroyed(); forcedTransfer and recoveryAddress call only transferred(), never
///    canTransfer. So agent operations are never gated by this module.
///  - Because moduleTransferAction cannot tell a holder transfer from a forced one, it consumes a live
///    authorisation that matches exactly and is a no-op otherwise. A holder transfer always has a match
///    (moduleCheck just required it, and nothing can change state in between), so a no-op can only
///    happen on the agent path. See DESIGN.md §1 for the forced-transfer-matches-a-live-auth edge case.
contract TransferAuthorisationModule is AbstractModule, AccessControl {
    bytes32 public constant AUTHORISER_ROLE = keccak256("AUTHORISER_ROLE");

    enum Status {
        None,
        Issued,
        Used,
        Revoked
    }

    struct Authorisation {
        address token;
        uint64 expiresAt;
        Status status;
        address from;
        uint64 epoch;
        address to;
        uint256 amount;
    }

    /// authId => authorisation. An authId is never reusable, whatever happened to it.
    mapping(bytes32 => Authorisation) private _authorisations;
    /// keccak(token, from, to, amount) => authId of the most recently issued authorisation for that tuple.
    mapping(bytes32 => bytes32) private _authIdByTransfer;
    /// token => current epoch. Bumping it invalidates every authorisation issued under an older epoch.
    mapping(address => uint64) public epochOf;

    event AuthorisationIssued(
        bytes32 indexed authId,
        address indexed token,
        address indexed from,
        address to,
        uint256 amount,
        uint64 expiresAt,
        uint64 epoch
    );
    event AuthorisationConsumed(
        bytes32 indexed authId, address indexed token, address indexed from, address to, uint256 amount
    );
    event AuthorisationRevoked(bytes32 indexed authId, address indexed token);
    event AllAuthorisationsRevoked(address indexed token, uint64 newEpoch);

    error InvalidAuthorisation();
    error AuthIdAlreadyUsed(bytes32 authId);
    error TransferAlreadyAuthorised(bytes32 liveAuthId);
    error NotRevocable(bytes32 authId);
    error UnauthorisedCompliance(address caller);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- backend operations

    /// @notice Store an authorisation for one holder-initiated transfer.
    /// @dev At most one live authorisation per (token, from, to, amount) tuple, so the token's plain
    ///      transfer(to, amount) call identifies it unambiguously. A second identical transfer needs a new
    ///      authorisation after the first is used, revoked or expired.
    function issueAuthorisation(
        bytes32 authId,
        address token,
        address from,
        address to,
        uint256 amount,
        uint64 expiresAt
    ) external onlyRole(AUTHORISER_ROLE) {
        if (
            authId == bytes32(0) || token == address(0) || from == address(0) || to == address(0) || amount == 0
                || expiresAt <= block.timestamp
        ) revert InvalidAuthorisation();
        // A resubmitted issue tx must not resurrect an authorisation that was already used or revoked.
        if (_authorisations[authId].status != Status.None) revert AuthIdAlreadyUsed(authId);

        bytes32 key = transferKey(token, from, to, amount);
        bytes32 current = _authIdByTransfer[key];
        if (current != bytes32(0) && isLive(current)) revert TransferAlreadyAuthorised(current);

        uint64 epoch = epochOf[token];
        _authorisations[authId] = Authorisation({
            token: token,
            expiresAt: expiresAt,
            status: Status.Issued,
            from: from,
            epoch: epoch,
            to: to,
            amount: amount
        });
        _authIdByTransfer[key] = authId;
        emit AuthorisationIssued(authId, token, from, to, amount, expiresAt, epoch);
    }

    /// @notice Revoke one authorisation. Reverts unless it is still in the Issued state, so the backend
    ///         learns if it raced with a consumption.
    function revokeAuthorisation(bytes32 authId) external onlyRole(AUTHORISER_ROLE) {
        Authorisation storage a = _authorisations[authId];
        if (a.status != Status.Issued) revert NotRevocable(authId);
        a.status = Status.Revoked;
        bytes32 key = transferKey(a.token, a.from, a.to, a.amount);
        if (_authIdByTransfer[key] == authId) delete _authIdByTransfer[key];
        emit AuthorisationRevoked(authId, a.token);
    }

    /// @notice Revoke every outstanding authorisation for a token in O(1) by moving to a new epoch.
    function revokeAllAuthorisations(address token) external onlyRole(AUTHORISER_ROLE) {
        uint64 newEpoch = ++epochOf[token];
        emit AllAuthorisationsRevoked(token, newEpoch);
    }

    // ---------------------------------------------------------------- IModule

    function moduleCheck(address _from, address _to, uint256 _value, address _compliance)
        external
        view
        override
        returns (bool)
    {
        // Token.mint calls canTransfer(address(0), to, amount); issuance is controlled by the agent
        // role (IssuanceGateway), not by transfer authorisations.
        if (_from == address(0)) return true;
        return liveAuthorisationFor(IModularCompliance(_compliance).getTokenBound(), _from, _to, _value) != bytes32(0);
    }

    function moduleTransferAction(address _from, address _to, uint256 _value) external override onlyComplianceCall {
        address token = IModularCompliance(msg.sender).getTokenBound();
        // AbstractModule.bindCompliance is permissionless (any contract can bind itself), so a fake
        // compliance could claim any token and burn its holders' authorisations. Only the compliance the
        // token itself points at may consume.
        if (address(IToken(token).compliance()) != msg.sender) revert UnauthorisedCompliance(msg.sender);
        bytes32 authId = liveAuthorisationFor(token, _from, _to, _value);
        // No live match: an agent forcedTransfer / recoveryAddress, which T-REX never gates. Leave state alone.
        if (authId == bytes32(0)) return;
        _authorisations[authId].status = Status.Used;
        delete _authIdByTransfer[transferKey(token, _from, _to, _value)];
        emit AuthorisationConsumed(authId, token, _from, _to, _value);
    }

    // solhint-disable-next-line no-empty-blocks
    function moduleMintAction(address, uint256) external override onlyComplianceCall {}

    // solhint-disable-next-line no-empty-blocks
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    /// Plug and play: the module holds no per-holder state that would need seeding from existing balances.
    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() external pure override returns (string memory) {
        return "TransferAuthorisationModule";
    }

    // ---------------------------------------------------------------- views

    function getAuthorisation(bytes32 authId) external view returns (Authorisation memory) {
        return _authorisations[authId];
    }

    /// @notice True if the authorisation would let its transfer through right now.
    function isLive(bytes32 authId) public view returns (bool) {
        Authorisation storage a = _authorisations[authId];
        return a.status == Status.Issued && block.timestamp < a.expiresAt && a.epoch == epochOf[a.token];
    }

    /// @notice The live authorisation covering exactly this transfer, or bytes32(0).
    function liveAuthorisationFor(address token, address from, address to, uint256 amount)
        public
        view
        returns (bytes32)
    {
        bytes32 authId = _authIdByTransfer[transferKey(token, from, to, amount)];
        if (authId == bytes32(0) || !isLive(authId)) return bytes32(0);
        return authId;
    }

    function transferKey(address token, address from, address to, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(token, from, to, amount));
    }
}
