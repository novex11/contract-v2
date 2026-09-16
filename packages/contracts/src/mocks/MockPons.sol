// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPonsV2LaunchFactory, IPonsV2BondingCurve, IPonsV2FeeEscrow} from "../pons/IPonsV2.sol";

/// @dev Mirrors PonsV2FeeEscrow: swept fees are credited per recipient and token,
///      and `claimToken` pays the caller's own balance out.
contract MockPonsFeeEscrow is IPonsV2FeeEscrow {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public balanceOfToken;

    function creditToken(address recipient, address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        balanceOfToken[recipient][token] += amount;
    }

    function claim() external {
        claim(balanceOf[msg.sender]);
    }

    function claim(uint256 amount) public {
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "MockPonsFeeEscrow: eth");
    }

    function claimToken(address token) external {
        claimToken(token, balanceOfToken[msg.sender][token]);
    }

    function claimToken(address token, uint256 amount) public {
        require(amount > 0, "MockPonsFeeEscrow: nothing to claim");
        balanceOfToken[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}

/// @dev Fixed-supply launch token, minted to the curve like PonsV2LauncherToken.
contract MockPonsToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address curve) ERC20(name_, symbol_) {
        _mint(curve, supply);
    }
}

/// @title MockPonsCurve — test double for PonsV2BondingCurve (ERC-20 quote only)
/// @notice Reproduces the verified curve's trade math: constant product over a
///         phantom quote reserve, fee + creator tax off the quote leg, a decaying
///         snipe tax for non-exempt recipients, clamped fills with refunds at the
///         sellable allocation, and reserved tokens derived from the graduation
///         threshold. Graduation just flags the curve closed.
contract MockPonsCurve is IPonsV2BondingCurve {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    address public immutable factory;
    address public token;
    address public immutable pairToken;
    uint256 public immutable phantomQuote;
    uint256 public immutable graduationThreshold;
    uint256 public immutable feeBps;
    uint256 public immutable creatorTaxBps;
    uint256 public launchSupply;
    uint256 public reservedTokens;
    uint256 public trackedQuote;
    uint256 public trackedTokens;
    uint256 public quoteFeeBalance;
    uint256 public creatorTaxBalance;
    bool public graduated;
    uint256 public launchedAt;
    uint256 public snipeTaxStartBps;
    uint256 public snipeTaxSeconds;
    mapping(address => bool) public snipeTaxExempt;
    /// @dev Fee plumbing, as on the live curve: fees wait on the curve until the
    ///      creator fee recipient sweeps them into the shared escrow.
    address public deployer;
    address public creatorFeeRecipient;
    address public feeEscrow;
    bool public buybackEnabled;
    uint256 public constant protocolFeeShareBps = 3_000;

    struct Fill {
        uint256 spent;
        uint256 fee;
        uint256 tax;
        uint256 snipe;
        uint256 tokensOut;
    }

    constructor(
        address pairToken_,
        uint256 phantomQuote_,
        uint256 graduationThreshold_,
        uint256 feeBps_,
        uint256 creatorTaxBps_,
        uint256 snipeTaxStartBps_,
        uint256 snipeTaxSeconds_
    ) {
        factory = msg.sender;
        pairToken = pairToken_;
        phantomQuote = phantomQuote_;
        graduationThreshold = graduationThreshold_;
        feeBps = feeBps_;
        creatorTaxBps = creatorTaxBps_;
        snipeTaxStartBps = snipeTaxStartBps_;
        snipeTaxSeconds = snipeTaxSeconds_;
    }

    function initialize(address token_, address deployer_, address creatorFeeRecipient_, address feeEscrow_) external {
        require(msg.sender == factory && token == address(0), "MockPonsCurve: init");
        token = token_;
        deployer = deployer_;
        creatorFeeRecipient = creatorFeeRecipient_;
        feeEscrow = feeEscrow_;
        launchSupply = IERC20(token_).balanceOf(address(this));
        trackedTokens = launchSupply;
        // Tokens left on the curve when the real quote reaches the threshold.
        reservedTokens = Math.mulDiv(launchSupply, phantomQuote, phantomQuote + graduationThreshold);
        launchedAt = block.timestamp;
    }

    function exemptFromSnipeTax(address account) external {
        require(msg.sender == factory, "MockPonsCurve: factory");
        snipeTaxExempt[account] = true;
    }

    /// @dev Only the creator fee recipient may sweep (the live curve reverts with
    ///      NotFeeSweepOperator). Pons keeps its protocol share of the curve fee; the
    ///      creator tax plus the rest of the fee is credited to the recipient in escrow.
    function sweepFees(uint256) external {
        require(msg.sender == creatorFeeRecipient, "NotFeeSweepOperator");
        uint256 fee = quoteFeeBalance;
        uint256 tax = creatorTaxBalance;
        if (fee + tax == 0) return;
        quoteFeeBalance = 0;
        creatorTaxBalance = 0;
        trackedQuote -= fee + tax;
        uint256 protocolCut = (fee * protocolFeeShareBps) / BPS;
        uint256 creatorCut = fee - protocolCut + tax;
        IERC20(pairToken).safeTransfer(factory, protocolCut);
        IERC20(pairToken).forceApprove(feeEscrow, creatorCut);
        MockPonsFeeEscrow(feeEscrow).creditToken(creatorFeeRecipient, pairToken, creatorCut);
    }

    // ─── Views ──────────────────────────────────────────────

    function getReserves() public view returns (uint256 quoteReserve, uint256 tokenReserve) {
        quoteReserve = phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance;
        tokenReserve = trackedTokens;
    }

    function realQuoteReserve() public view returns (uint256) {
        return trackedQuote - quoteFeeBalance - creatorTaxBalance;
    }

    function sellableTokens() public view returns (uint256) {
        return trackedTokens > reservedTokens ? trackedTokens - reservedTokens : 0;
    }

    function readyToGraduate() public view returns (bool) {
        if (graduated) return false;
        return sellableTokens() == 0;
    }

    function currentSnipeTaxBps(address recipient) public view returns (uint256) {
        if (snipeTaxExempt[recipient]) return 0;
        uint256 startBps = snipeTaxStartBps;
        if (startBps == 0) return 0;
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= snipeTaxSeconds) return 0;
        return startBps >> ((elapsed * 14) / snipeTaxSeconds);
    }

    // ─── Trading ────────────────────────────────────────────

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut)
    {
        require(!graduated, "MockPonsCurve: graduated");
        require(recipient != address(0), "MockPonsCurve: zero recipient");
        require(msg.value == 0, "MockPonsCurve: erc20 quote");
        require(quoteIn > 0, "MockPonsCurve: zero amount");
        uint256 before = IERC20(pairToken).balanceOf(address(this));
        IERC20(pairToken).safeTransferFrom(msg.sender, address(this), quoteIn);
        uint256 received = IERC20(pairToken).balanceOf(address(this)) - before;

        Fill memory f = _fill(received, recipient);
        require(f.spent * minTokensOut <= received * f.tokensOut, "MockPonsCurve: slippage");

        quoteFeeBalance += f.fee + f.snipe;
        creatorTaxBalance += f.tax;
        trackedQuote += f.spent;
        trackedTokens -= f.tokensOut;
        tokensOut = f.tokensOut;
        IERC20(token).safeTransfer(recipient, tokensOut);
        uint256 refund = received - f.spent;
        if (refund != 0) IERC20(pairToken).safeTransfer(msg.sender, refund);
        emit CurveBuy(msg.sender, recipient, f.spent, tokensOut, f.fee + f.snipe, f.tax);
        if (sellableTokens() == 0) graduated = true;
    }

    function _fill(uint256 received, address recipient) internal view returns (Fill memory f) {
        (uint256 qR, uint256 tR) = getReserves();
        uint256 snipeBps = currentSnipeTaxBps(recipient);
        if (snipeBps != 0) {
            uint256 maxSnipe = BPS - feeBps - creatorTaxBps - 100;
            if (snipeBps > maxSnipe) snipeBps = maxSnipe;
        }
        f.spent = received;
        f.fee = (f.spent * feeBps) / BPS;
        f.tax = (f.spent * creatorTaxBps) / BPS;
        f.snipe = (f.spent * snipeBps) / BPS;
        f.tokensOut = _out(f.spent - f.fee - f.tax - f.snipe, qR, tR);

        uint256 sellable = sellableTokens();
        require(sellable > 0, "MockPonsCurve: graduated");
        if (f.tokensOut > sellable) {
            f.tokensOut = sellable;
            uint256 net = _in(sellable, qR, tR);
            f.spent = Math.min(
                Math.mulDiv(net, BPS, BPS - feeBps - creatorTaxBps - snipeBps, Math.Rounding.Ceil), received
            );
            f.fee = (f.spent * feeBps) / BPS;
            f.tax = (f.spent * creatorTaxBps) / BPS;
            f.snipe = (f.spent * snipeBps) / BPS;
        }
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut) {
        require(!graduated && !readyToGraduate(), "MockPonsCurve: graduated");
        require(tokensIn > 0, "MockPonsCurve: zero amount");
        require(recipient != address(0), "MockPonsCurve: zero recipient");
        (uint256 qR, uint256 tR) = getReserves();
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 gross = _out(tokensIn, tR, qR);
        uint256 fee = (gross * feeBps) / BPS;
        uint256 tax = (gross * creatorTaxBps) / BPS;
        quoteOut = gross - fee - tax;
        require(quoteOut >= minQuoteOut, "MockPonsCurve: slippage");

        quoteFeeBalance += fee;
        creatorTaxBalance += tax;
        trackedQuote -= quoteOut;
        trackedTokens += tokensIn;
        IERC20(pairToken).safeTransfer(recipient, quoteOut);
        emit CurveSell(msg.sender, recipient, tokensIn, quoteOut, fee, tax);
    }

    function _out(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0, "MockPonsCurve: liquidity");
        return (amountIn * reserveOut) / (reserveIn + amountIn);
    }

    function _in(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        require(amountOut < reserveOut, "MockPonsCurve: liquidity");
        return (reserveIn * amountOut) / (reserveOut - amountOut) + 1;
    }
}

/// @title MockPonsFactory — test double for PonsV2LaunchFactory
contract MockPonsFactory is IPonsV2LaunchFactory {
    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public constant MAX_EXEMPTIONS = 32;

    uint256 public launchFee;
    bool public launchEnabled = true;
    uint256 public maxCreatorTaxBps = 1_000;
    uint256 public snipeTaxStartBps = 9_900;
    uint256 public snipeTaxSeconds = 3;
    mapping(address => bool) public whitelistedLaunchers;
    mapping(address => bool) public approvedPairTokens;
    mapping(address => uint256) internal _phantom;
    mapping(address => uint256) internal _threshold;
    mapping(address => uint8) internal _decimals;
    mapping(address => address) public curveOf;
    address[] public launched;
    uint256 public feesCollected;
    MockPonsFeeEscrow public immutable escrow;

    constructor(uint256 launchFee_) {
        launchFee = launchFee_;
        escrow = new MockPonsFeeEscrow();
    }

    function feeEscrow() external view returns (address) {
        return address(escrow);
    }

    // ─── Admin (test helpers) ───────────────────────────────

    function setLaunchEnabled(bool enabled) external {
        launchEnabled = enabled;
    }

    function setWhitelisted(address launcher, bool enabled) external {
        whitelistedLaunchers[launcher] = enabled;
    }

    function approvePairToken(address pairToken, uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)
        external
    {
        approvedPairTokens[pairToken] = true;
        _phantom[pairToken] = phantomQuote;
        _threshold[pairToken] = graduationThreshold;
        _decimals[pairToken] = decimals;
    }

    // ─── IPonsV2LaunchFactory ───────────────────────────────

    function canLaunch(address launcher) public view returns (bool) {
        return launchEnabled || whitelistedLaunchers[launcher];
    }

    function launchConfigCount() external pure returns (uint256) {
        return 1;
    }

    function getLaunchConfig(uint256 id) external pure returns (LaunchConfig memory) {
        require(id == 0, "InvalidLaunchConfigId");
        return LaunchConfig({
            supply: SUPPLY,
            curveFeeBps: CURVE_FEE_BPS,
            phantomQuote: 1.68 ether,
            graduationThreshold: 4.2 ether,
            poolFee: 0,
            tickSpacing: 200,
            enabled: true
        });
    }

    function pairTokenEconomics(address pairToken) external view returns (uint256, uint256, uint8) {
        return (_phantom[pairToken], _threshold[pairToken], _decimals[pairToken]);
    }

    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) public view returns (bytes32) {
        return keccak256(abi.encode(launchConfigId, pairToken, _phantom[pairToken], _threshold[pairToken]));
    }

    function launchToken(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve) {
        require(canLaunch(msg.sender), "NotWhitelisted");
        require(msg.value == launchFee, "LaunchFeeNotPaid");
        require(launchConfigId == 0, "InvalidLaunchConfigId");
        require(bytes(params.name).length > 0 && bytes(params.symbol).length > 0, "InvalidTokenParams");
        require(params.creatorTaxBps <= maxCreatorTaxBps, "CreatorTaxTooHigh");
        require(pairToken != address(0), "MockPonsFactory: ERC20 quote only");
        require(approvedPairTokens[pairToken], "PairTokenNotApproved");
        require(snipeTaxExemptions.length <= MAX_EXEMPTIONS, "ExemptionListTooLong");
        if (params.expectedEconomics != bytes32(0)) {
            require(params.expectedEconomics == previewLaunchEconomics(launchConfigId, pairToken), "LaunchEconomicsMismatch");
        }
        feesCollected += msg.value;

        (token, curve) = _deploy(params, pairToken);
        _exempt(curve, params.creatorFeeRecipient, snipeTaxExemptions);
        curveOf[token] = curve;
        launched.push(token);
        emit TokenLaunched(token, curve, msg.sender, pairToken, launchConfigId, _threshold[pairToken]);
    }

    function _deploy(TokenParams calldata params, address pairToken) internal returns (address token, address curve) {
        bytes32 salt = keccak256(abi.encode(msg.sender, params.salt));
        MockPonsCurve c = new MockPonsCurve{salt: salt}(
            pairToken,
            _phantom[pairToken],
            _threshold[pairToken],
            CURVE_FEE_BPS,
            params.creatorTaxBps,
            snipeTaxStartBps,
            snipeTaxSeconds
        );
        MockPonsToken t = new MockPonsToken{salt: salt}(params.name, params.symbol, SUPPLY, address(c));
        address recipient = params.creatorFeeRecipient == address(0) ? msg.sender : params.creatorFeeRecipient;
        c.initialize(address(t), msg.sender, recipient, address(escrow));
        token = address(t);
        curve = address(c);
    }

    function _exempt(address curve, address creatorFeeRecipient, address[] calldata extra) internal {
        MockPonsCurve c = MockPonsCurve(curve);
        c.exemptFromSnipeTax(msg.sender);
        address recipient = creatorFeeRecipient == address(0) ? msg.sender : creatorFeeRecipient;
        if (recipient != msg.sender) c.exemptFromSnipeTax(recipient);
        for (uint256 i = 0; i < extra.length; ++i) {
            c.exemptFromSnipeTax(extra[i]);
        }
    }
}
