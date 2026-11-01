// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "forge-std/Test.sol";

import "@tokenysolutions/t-rex/contracts/token/Token.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/ClaimTopicsRegistry.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistry.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistryStorage.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/TrustedIssuersRegistry.sol";
import "@tokenysolutions/t-rex/contracts/compliance/modular/ModularCompliance.sol";
import "@tokenysolutions/t-rex/contracts/proxy/authority/TREXImplementationAuthority.sol";
import "@tokenysolutions/t-rex/contracts/factory/TREXFactory.sol";

import "@onchain-id/solidity/contracts/Identity.sol";
import "@onchain-id/solidity/contracts/ClaimIssuer.sol";
import "@onchain-id/solidity/contracts/proxy/ImplementationAuthority.sol";
import "@onchain-id/solidity/contracts/proxy/IdentityProxy.sol";
import "@onchain-id/solidity/contracts/factory/IdFactory.sol";

import "../../contracts/TransferAuthorisationModule.sol";
import "../../contracts/IssuanceGateway.sol";

/// @notice Deploys a full T-REX 4.1.6 suite through TREXFactory (proxies, implementation authority,
///         OnchainID identities, one KYC claim topic with a trusted claim issuer) with the
///         TransferAuthorisationModule bound at deployment and an IssuanceGateway registered as agent.
///         Mirrors lib/T-REX/test/fixtures/deploy-full-suite.fixture.ts.
abstract contract TREXFixture is Test {
    uint256 internal constant KYC_TOPIC = uint256(keccak256("KYC"));

    // Roles (see DESIGN.md §2)
    address internal deployer = makeAddr("deployer"); // owns factory + implementation authorities
    address internal issuerOwner = makeAddr("issuerOwner"); // owner of token / IR / compliance (multisig in prod)
    address internal interventionAgent = makeAddr("interventionAgent"); // token + IR agent: freeze, force, recover
    address internal authoriser = makeAddr("authoriser"); // backend key: transfer authorisations
    address internal issuerBackend = makeAddr("issuerBackend"); // backend key: IssuanceGateway.issue
    address internal claimIssuerManager = makeAddr("claimIssuerManager");
    uint256 internal claimSignerPk = 0xC1A1;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");
    address internal unverified = makeAddr("unverified");

    Token internal token;
    IdentityRegistry internal ir;
    ModularCompliance internal compliance;
    TransferAuthorisationModule internal authModule;
    IssuanceGateway internal gateway;

    ImplementationAuthority internal identityIA;
    ClaimIssuer internal claimIssuer;
    mapping(address => Identity) internal identityOf;

    function setUp() public virtual {
        vm.startPrank(deployer);

        TREXImplementationAuthority trexIA = new TREXImplementationAuthority(true, address(0), address(0));
        trexIA.addAndUseTREXVersion(
            ITREXImplementationAuthority.Version({major: 4, minor: 1, patch: 6}),
            ITREXImplementationAuthority.TREXContracts({
                tokenImplementation: address(new Token()),
                ctrImplementation: address(new ClaimTopicsRegistry()),
                irImplementation: address(new IdentityRegistry()),
                irsImplementation: address(new IdentityRegistryStorage()),
                tirImplementation: address(new TrustedIssuersRegistry()),
                mcImplementation: address(new ModularCompliance())
            })
        );

        identityIA = new ImplementationAuthority(address(new Identity(deployer, true)));
        IdFactory idFactory = new IdFactory(address(identityIA));
        TREXFactory factory = new TREXFactory(address(trexIA), address(idFactory));
        idFactory.addTokenFactory(address(factory));
        vm.stopPrank();

        authModule = new TransferAuthorisationModule(issuerOwner);
        bytes32 authoriserRole = authModule.AUTHORISER_ROLE(); // read before prank: a getter call would consume it
        vm.prank(issuerOwner);
        authModule.grantRole(authoriserRole, authoriser);

        claimIssuer = new ClaimIssuer(claimIssuerManager);
        vm.prank(claimIssuerManager);
        claimIssuer.addKey(keccak256(abi.encode(vm.addr(claimSignerPk))), 3, 1);

        address[] memory agents = new address[](1);
        agents[0] = interventionAgent;
        address[] memory modules = new address[](1);
        modules[0] = address(authModule);
        uint256[] memory topics = new uint256[](1);
        topics[0] = KYC_TOPIC;
        address[] memory issuers = new address[](1);
        issuers[0] = address(claimIssuer);
        uint256[][] memory issuerClaims = new uint256[][](1);
        issuerClaims[0] = topics;

        vm.prank(deployer);
        factory.deployTREXSuite(
            "SHARE-1",
            ITREXFactory.TokenDetails({
                owner: issuerOwner,
                name: "Acme Ltd Ordinary Shares",
                symbol: "ACME",
                decimals: 0,
                irs: address(0),
                ONCHAINID: address(0),
                irAgents: agents,
                tokenAgents: agents,
                complianceModules: modules,
                complianceSettings: new bytes[](0)
            }),
            ITREXFactory.ClaimDetails({claimTopics: topics, issuers: issuers, issuerClaims: issuerClaims})
        );

        token = Token(factory.getToken("SHARE-1"));
        ir = IdentityRegistry(address(token.identityRegistry()));
        compliance = ModularCompliance(address(token.compliance()));

        gateway = new IssuanceGateway(IToken(address(token)), issuerOwner);
        bytes32 issuerRole = gateway.ISSUER_ROLE();
        vm.startPrank(issuerOwner);
        gateway.grantRole(issuerRole, issuerBackend);
        token.addAgent(address(gateway));
        vm.stopPrank();

        _onboard(alice, 42);
        _onboard(bob, 42);
        _onboard(charlie, 250);

        vm.prank(interventionAgent);
        token.unpause();
    }

    // ---------------------------------------------------------------- helpers

    function _newIdentity(address wallet) internal returns (Identity id) {
        id = Identity(address(new IdentityProxy(address(identityIA), wallet)));
        bytes memory data = "KYC passed";
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(address(id), KYC_TOPIC, data)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(claimSignerPk, digest);
        vm.prank(wallet);
        id.addClaim(KYC_TOPIC, 1, address(claimIssuer), abi.encodePacked(r, s, v), data, "");
    }

    function _onboard(address wallet, uint16 country) internal {
        Identity id = _newIdentity(wallet);
        identityOf[wallet] = id;
        vm.prank(interventionAgent);
        ir.registerIdentity(wallet, IIdentity(address(id)), country);
    }

    function _issue(bytes32 issuanceId, address to, uint256 amount) internal {
        vm.prank(issuerBackend);
        gateway.issue(issuanceId, to, amount);
    }

    function _authorise(bytes32 authId, address from, address to, uint256 amount, uint64 ttl) internal {
        vm.prank(authoriser);
        authModule.issueAuthorisation(authId, address(token), from, to, amount, uint64(block.timestamp) + ttl);
    }
}
