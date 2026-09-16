// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PairFactory} from "../PairFactory.sol";
import {PairVault} from "../PairVault.sol";
import {IPonsV2LaunchFactory, IPonsV2BondingCurve} from "./IPonsV2.sol";

/// @title PonsLauncher — launch a Compose pair's token on the Pons v2 curve
/// @notice One market, two lenses. The pair creator launches the pair's token
///         through this contract, which calls the Pons v2 factory with one of the
///         pair's two stocks (or USDG) as the quote asset. The token then trades
///         on Pons quoted in that single stock, and on Compose quoted in the
///         pair's two-stock share (see PonsRouter). Both venues hit the same
///         curve, so price and volume are identical by construction.
///
///         The token carries the pair's receipt name and symbol, exactly like
///         ComposeCurve.createToken. The creator is Pons's creatorFeeRecipient,
///         so Pons's creator payout (and any creator tax) goes straight to them.
///         This contract is Pons's "deployer" of record and holds nothing
///         between transactions.
contract PonsLauncher is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Pons caps the exemption list at 32 wallets per launch.
    uint256 public constant MAX_EXEMPTIONS = 32;
    /// @dev Same limits as PairFactory, since the token inherits the pair's receipt name/symbol.
    uint256 public constant MAX_NAME_LENGTH = 64;
    uint256 public constant MAX_SYMBOL_LENGTH = 16;

    PairFactory public immutable factory;
    IPonsV2LaunchFactory public immutable pons;
    address public immutable usdg;

    struct Launch {
        address pair;
        address curve;
        address quoteToken;
        address creator;
        uint64 launchTime;
    }

    struct LaunchParams {
        address pair;
        /// One of the pair's two stocks, or USDG. Must be approved by Pons.
        address quoteToken;
        uint256 launchConfigId;
        string logo;
        string description;
        IPonsV2LaunchFactory.Socials socials;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        /// Pass Pons's previewLaunchEconomics(launchConfigId, quoteToken), or 0 to waive.
        bytes32 expectedEconomics;
        bytes32 salt;
        /// Extra wallets exempt from the snipe tax (the creator already is).
        address[] exemptions;
        /// Optional opening buy in quote units, filled before anyone else can trade.
        uint256 devBuyQuote;
        uint256 minDevTokens;
    }

    mapping(address token => Launch) public launches;
    mapping(address pair => address token) public tokenOfPair;
    address[] public allTokens;

    event TokenLaunched(
        address indexed token,
        address indexed pair,
        address indexed creator,
        address curve,
        address quoteToken,
        string name,
        string symbol,
        uint256 launchConfigId
    );
    event DevBuy(address indexed token, address indexed creator, uint256 quoteIn, uint256 tokensOut);

    constructor(address factory_, address pons_, address usdg_) {
        require(factory_ != address(0) && pons_ != address(0) && usdg_ != address(0), "PonsLauncher: zero address");
        factory = PairFactory(factory_);
        pons = IPonsV2LaunchFactory(pons_);
        usdg = usdg_;
    }

    // ─── Launch ─────────────────────────────────────────────

    /// @notice Launch the pair's token on Pons. Only the pair creator may call, once per pair.
    ///         `msg.value` must equal Pons's `launchFee()`.
    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address token, address curve, uint256 devTokens)
    {
        PairVault vault = _validate(p);
        (string memory name, string memory symbol) = _metadata(vault);
        (token, curve) = _launchOnPons(p, name, symbol);
        _record(p, token, curve, name, symbol);
        if (p.devBuyQuote > 0) {
            devTokens = _devBuy(token, curve, p.quoteToken, p.devBuyQuote, p.minDevTokens);
        }
    }

    function _validate(LaunchParams calldata p) internal view returns (PairVault vault) {
        require(factory.isPair(p.pair), "PonsLauncher: unknown pair");
        vault = PairVault(p.pair);
        require(msg.sender == vault.creator(), "PonsLauncher: only pair creator");
        require(tokenOfPair[p.pair] == address(0), "PonsLauncher: pair already has a token");
        require(vault.totalShares() > 0, "PonsLauncher: pair not seeded");
        require(
            p.quoteToken == vault.tokenA() || p.quoteToken == vault.tokenB() || p.quoteToken == usdg,
            "PonsLauncher: quote must be a pair leg or USDG"
        );
        require(pons.approvedPairTokens(p.quoteToken), "PonsLauncher: quote not approved by Pons");
        require(pons.canLaunch(address(this)), "PonsLauncher: Pons launches closed");
        require(p.exemptions.length <= MAX_EXEMPTIONS, "PonsLauncher: too many exemptions");
        require(msg.value == pons.launchFee(), "PonsLauncher: launch fee");
    }

    function _metadata(PairVault vault) internal view returns (string memory name, string memory symbol) {
        IERC20Metadata receipt = IERC20Metadata(address(vault.receiptToken()));
        name = receipt.name();
        symbol = receipt.symbol();
        uint256 nameLen = bytes(name).length;
        uint256 symbolLen = bytes(symbol).length;
        require(nameLen > 0 && nameLen <= MAX_NAME_LENGTH, "PonsLauncher: invalid name");
        require(symbolLen > 0 && symbolLen <= MAX_SYMBOL_LENGTH, "PonsLauncher: invalid symbol");
    }

    function _launchOnPons(LaunchParams calldata p, string memory name, string memory symbol)
        internal
        returns (address token, address curve)
    {
        IPonsV2LaunchFactory.TokenParams memory params = IPonsV2LaunchFactory.TokenParams({
            name: name,
            symbol: symbol,
            logo: p.logo,
            description: p.description,
            socials: p.socials,
            creatorFeeRecipient: msg.sender,
            creatorTaxBps: p.creatorTaxBps,
            buybackEnabled: p.buybackEnabled,
            expectedEconomics: p.expectedEconomics,
            // Pons namespaces salts per deployer (this contract); scope them per pair.
            salt: keccak256(abi.encode(p.pair, p.salt))
        });
        (token, curve) = pons.launchToken{value: msg.value}(params, p.launchConfigId, p.quoteToken, p.exemptions);
        require(
            IPonsV2BondingCurve(curve).token() == token && IPonsV2BondingCurve(curve).pairToken() == p.quoteToken,
            "PonsLauncher: curve mismatch"
        );
    }

    function _record(LaunchParams calldata p, address token, address curve, string memory name, string memory symbol)
        internal
    {
        launches[token] = Launch({
            pair: p.pair,
            curve: curve,
            quoteToken: p.quoteToken,
            creator: msg.sender,
            launchTime: uint64(block.timestamp)
        });
        tokenOfPair[p.pair] = token;
        allTokens.push(token);
        emit TokenLaunched(token, p.pair, msg.sender, curve, p.quoteToken, name, symbol, p.launchConfigId);
    }

    /// @dev The creator is Pons's creatorFeeRecipient and therefore snipe-tax exempt,
    ///      so the opening buy fills at the untaxed price.
    function _devBuy(address token, address curve, address quote, uint256 quoteIn, uint256 minTokens)
        internal
        returns (uint256 tokensOut)
    {
        IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteIn);
        IERC20(quote).forceApprove(curve, quoteIn);
        tokensOut = IPonsV2BondingCurve(curve).buy(quoteIn, minTokens, msg.sender);
        IERC20(quote).forceApprove(curve, 0);
        // A clamped fill refunds the unspent quote to this contract.
        uint256 left = IERC20(quote).balanceOf(address(this));
        if (left > 0) IERC20(quote).safeTransfer(msg.sender, left);
        emit DevBuy(token, msg.sender, quoteIn - left, tokensOut);
    }

    // ─── Views ──────────────────────────────────────────────

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function isLaunched(address token) public view returns (bool) {
        return launches[token].curve != address(0);
    }

    function curveOf(address token) external view returns (address) {
        return launches[token].curve;
    }

    function pairOf(address token) external view returns (address) {
        return launches[token].pair;
    }

    function quoteOf(address token) external view returns (address) {
        return launches[token].quoteToken;
    }

    /// @notice Economics digest to pin in `LaunchParams.expectedEconomics` for a quote asset.
    function previewEconomics(uint256 launchConfigId, address quoteToken) external view returns (bytes32) {
        return pons.previewLaunchEconomics(launchConfigId, quoteToken);
    }
}
