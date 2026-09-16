// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PairFactory} from "../PairFactory.sol";
import {PairRouter} from "../PairRouter.sol";
import {PairVault} from "../PairVault.sol";
import {OracleAdapter} from "../OracleAdapter.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {PonsLauncher} from "./PonsLauncher.sol";
import {IPonsV2BondingCurve} from "./IPonsV2.sol";

/// @title PonsRouter — trade Pons-launched Compose tokens in pair shares, stocks, USDG or ETH
/// @notice Every trade lands on the token's Pons v2 bonding curve, whose quote
///         asset is one of the pair's stocks (or USDG). This router converts:
///           pair shares  → redeem both stocks → swap the other leg → quote → curve
///           USDG / ETH   → swap → quote → curve
///           quote stock  → curve directly
///         and the reverse on sells, including re-minting pair shares from the
///         quote proceeds. Swaps are floored at the oracle price minus the
///         caller's slippage, exactly like PairRouter. Holds nothing between
///         transactions. Requires PairFactory.setFeeExempt(router) so it can
///         mint pair shares for sellers.
contract PonsRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_SLIPPAGE_BPS = 300;
    uint256 internal constant BPS = 10_000;

    PonsLauncher public immutable launcher;
    PairFactory public immutable factory;
    OracleAdapter public immutable oracle;
    ISwapRouter02 public immutable swapRouter;
    address public immutable weth;
    address public immutable usdg;

    /// @param payToken  the curve's quote token (no swap), USDG or WETH (send
    ///                  `msg.value == amountIn` to pay in ETH)
    /// @param path      Uniswap v3 path payToken -> quote token (ignored when payToken is the quote)
    struct BuyParams {
        address token;
        address payToken;
        uint256 amountIn;
        bytes path;
        uint256 minTokensOut;
        uint16 maxSlippageBps;
        uint256 deadline;
    }

    /// @param receiveToken the curve's quote token, USDG or WETH
    /// @param path         Uniswap v3 path quote token -> receiveToken
    struct SellParams {
        address token;
        uint256 tokensIn;
        address receiveToken;
        bytes path;
        uint256 minAmountOut;
        uint16 maxSlippageBps;
        bool unwrapEth;
        uint256 deadline;
    }

    /// @param pathA / pathB  Uniswap v3 paths tokenA -> quote / tokenB -> quote (the quote leg's path is ignored)
    struct ShareBuyParams {
        address token;
        uint256 sharesIn;
        bytes pathA;
        bytes pathB;
        uint256 minTokensOut;
        uint16 maxSlippageBps;
        uint256 deadline;
    }

    /// @param pathA / pathB  Uniswap v3 paths quote -> tokenA / quote -> tokenB (the quote leg's path is ignored)
    struct ShareSellParams {
        address token;
        uint256 tokensIn;
        bytes pathA;
        bytes pathB;
        uint256 minShares;
        uint16 maxSlippageBps;
        uint256 deadline;
    }

    /// @dev `payToken` / `receiveToken` is address(0) for native ETH and the pair
    ///      address when the trade was settled in pair shares.
    event TokenBought(address indexed token, address indexed user, address payToken, uint256 amountIn, uint256 tokensOut);
    event TokenSold(address indexed token, address indexed user, address receiveToken, uint256 tokensIn, uint256 amountOut);

    constructor(address launcher_, address pairRouter_) {
        require(launcher_ != address(0) && pairRouter_ != address(0), "PonsRouter: zero address");
        launcher = PonsLauncher(launcher_);
        PairRouter pr = PairRouter(payable(pairRouter_));
        factory = pr.factory();
        oracle = pr.oracle();
        swapRouter = pr.swapRouter();
        weth = pr.weth();
        usdg = pr.usdg();
        require(address(factory) == address(launcher.factory()), "PonsRouter: factory mismatch");
    }

    receive() external payable {
        require(msg.sender == weth, "PonsRouter: unexpected ETH");
    }

    // ─── Buy ────────────────────────────────────────────────

    /// @notice Buy `token` with its quote stock, USDG or ETH/WETH.
    function buy(BuyParams calldata p) external payable nonReentrant returns (uint256 tokensOut) {
        (address pair, address curve, address quote) = _launch(p.token);
        _check(pair, p.maxSlippageBps, p.deadline);
        require(p.amountIn > 0, "PonsRouter: zero amount");

        if (p.payToken != quote) _checkPayToken(p.payToken);
        bool paidEth = msg.value > 0;
        if (paidEth) {
            require(p.payToken == weth && msg.value == p.amountIn, "PonsRouter: bad ETH amount");
            IWETH(weth).deposit{value: msg.value}();
        } else {
            IERC20(p.payToken).safeTransferFrom(msg.sender, address(this), p.amountIn);
        }

        uint256 quoteIn = p.amountIn;
        if (p.payToken != quote) {
            quoteIn = _convert(p.payToken, quote, p.amountIn, p.path, p.maxSlippageBps);
        }
        tokensOut = _curveBuy(curve, quote, quoteIn, p.minTokensOut);

        _refund(quote);
        if (paidEth) _refundEth();
        else _refund(p.payToken);
        emit TokenBought(p.token, msg.sender, paidEth ? address(0) : p.payToken, p.amountIn, tokensOut);
    }

    /// @notice Buy `token` with the pair's shares: redeem both stocks, swap the
    ///         non-quote leg into the quote stock, and buy on the curve.
    function buyWithShares(ShareBuyParams calldata p) external nonReentrant returns (uint256 tokensOut) {
        (address pair, address curve, address quote) = _launch(p.token);
        _check(pair, p.maxSlippageBps, p.deadline);
        require(p.sharesIn > 0, "PonsRouter: zero amount");

        uint256 quoteIn = _redeemToQuote(p, PairVault(pair), quote);
        tokensOut = _curveBuy(curve, quote, quoteIn, p.minTokensOut);
        _refund(quote);
        emit TokenBought(p.token, msg.sender, pair, p.sharesIn, tokensOut);
    }

    /// @dev Pull the caller's shares, redeem both stocks and turn them into the quote token.
    function _redeemToQuote(ShareBuyParams calldata p, PairVault vault, address quote)
        internal
        returns (uint256 quoteIn)
    {
        address tokenA = vault.tokenA();
        address tokenB = vault.tokenB();
        IERC20(address(vault.receiptToken())).safeTransferFrom(msg.sender, address(this), p.sharesIn);
        (uint256 amountA, uint256 amountB) = vault.redeem(p.sharesIn, 0, 0);
        quoteIn = _toQuote(tokenA, quote, amountA, p.pathA, p.maxSlippageBps)
            + _toQuote(tokenB, quote, amountB, p.pathB, p.maxSlippageBps);
        if (tokenA != quote) _refund(tokenA);
        if (tokenB != quote) _refund(tokenB);
    }

    // ─── Sell ───────────────────────────────────────────────

    /// @notice Sell `token` for its quote stock, USDG or WETH/ETH.
    function sell(SellParams calldata p) external nonReentrant returns (uint256 amountOut) {
        (address pair, address curve, address quote) = _launch(p.token);
        _check(pair, p.maxSlippageBps, p.deadline);
        uint256 quoteOut = _curveSell(curve, p.token, p.tokensIn);

        amountOut = quoteOut;
        if (p.receiveToken != quote) {
            _checkPayToken(p.receiveToken);
            amountOut = _convert(quote, p.receiveToken, quoteOut, p.path, p.maxSlippageBps);
        }
        require(amountOut >= p.minAmountOut, "PonsRouter: slippage");

        if (p.unwrapEth) {
            require(p.receiveToken == weth, "PonsRouter: not WETH");
            IWETH(weth).withdraw(amountOut);
            (bool ok, ) = msg.sender.call{value: amountOut}("");
            require(ok, "PonsRouter: ETH transfer failed");
        } else {
            IERC20(p.receiveToken).safeTransfer(msg.sender, amountOut);
        }
        emit TokenSold(p.token, msg.sender, p.unwrapEth ? address(0) : p.receiveToken, p.tokensIn, amountOut);
    }

    /// @notice Sell `token` and receive the pair's shares: the quote proceeds are
    ///         split at the vault's reserve ratio, swapped into both stocks and
    ///         deposited for the seller. Leftover stock dust is returned as stocks.
    function sellForShares(ShareSellParams calldata p) external nonReentrant returns (uint256 shares) {
        (address pair, address curve, address quote) = _launch(p.token);
        _check(pair, p.maxSlippageBps, p.deadline);

        uint256 quoteOut = _curveSell(curve, p.token, p.tokensIn);
        shares = _quoteToShares(p, PairVault(pair), quote, quoteOut);
        _refund(quote);
        emit TokenSold(p.token, msg.sender, pair, p.tokensIn, shares);
    }

    /// @dev Split the quote proceeds at the vault's reserve ratio, swap into both
    ///      stocks and deposit them for the caller. Stock dust goes back as stocks.
    function _quoteToShares(ShareSellParams calldata p, PairVault vault, address quote, uint256 quoteOut)
        internal
        returns (uint256 shares)
    {
        address tokenA = vault.tokenA();
        address tokenB = vault.tokenB();
        uint256 forA = _splitForA(vault, tokenA, tokenB, quoteOut);
        uint256 amountA = _fromQuote(quote, tokenA, forA, p.pathA, p.maxSlippageBps);
        uint256 amountB = _fromQuote(quote, tokenB, quoteOut - forA, p.pathB, p.maxSlippageBps);
        shares = _deposit(vault, tokenA, tokenB, amountA, amountB, p.minShares);
        if (tokenA != quote) _refund(tokenA);
        if (tokenB != quote) _refund(tokenB);
    }

    function _deposit(PairVault vault, address tokenA, address tokenB, uint256 amountA, uint256 amountB, uint256 minShares)
        internal
        returns (uint256 shares)
    {
        IERC20(tokenA).forceApprove(address(vault), amountA);
        IERC20(tokenB).forceApprove(address(vault), amountB);
        shares = vault.depositFor(address(this), amountA, amountB, minShares);
        IERC20(tokenA).forceApprove(address(vault), 0);
        IERC20(tokenB).forceApprove(address(vault), 0);
        IERC20(address(vault.receiptToken())).safeTransfer(msg.sender, shares);
    }

    // ─── Views ──────────────────────────────────────────────

    /// @notice Quote units per 1e18 tokens on the Pons curve (in the quote token's decimals).
    function priceInQuote(address token) public view returns (uint256) {
        (, address curve, ) = _launch(token);
        (uint256 q, uint256 t) = IPonsV2BondingCurve(curve).getReserves();
        if (t == 0) return 0;
        return Math.mulDiv(q, 1e18, t);
    }

    /// @notice USD (8 decimals) per 1e18 tokens at the oracle price of the quote stock.
    function priceUsd8(address token) public view returns (uint256) {
        (, , address quote) = _launch(token);
        return Math.mulDiv(priceInQuote(token), oracle.getPriceUnchecked(quote), 10 ** IERC20Metadata(quote).decimals());
    }

    /// @notice Pair shares (1e18) per 1e18 tokens: the same price re-quoted in the
    ///         two-stock share. priceInShares × sharePrice == priceUsd8.
    function priceInShares(address token) external view returns (uint256) {
        (address pair, , ) = _launch(token);
        return Math.mulDiv(priceUsd8(token), 1e18, PairVault(pair).sharePrice());
    }

    /// @notice Market cap in USD (8 decimals) over the launch supply.
    function marketCapUsd8(address token) external view returns (uint256) {
        (, address curve, ) = _launch(token);
        return Math.mulDiv(priceUsd8(token), IPonsV2BondingCurve(curve).launchSupply(), 1e18);
    }

    /// @notice Progress toward Pons graduation in basis points (capped at 10,000).
    function progressBps(address token) external view returns (uint256) {
        (, address curve, ) = _launch(token);
        IPonsV2BondingCurve c = IPonsV2BondingCurve(curve);
        if (c.graduated()) return BPS;
        uint256 threshold = c.graduationThreshold();
        if (threshold == 0) return BPS;
        uint256 real = c.realQuoteReserve();
        return real >= threshold ? BPS : (real * BPS) / threshold;
    }

    /// @notice Tokens out for `quoteIn` of the quote token, net of the curve fee and
    ///         creator tax (the launch-window snipe tax, if any, is not included).
    function quoteBuy(address token, uint256 quoteIn) external view returns (uint256 tokensOut, uint256 fee) {
        (, address curve, ) = _launch(token);
        IPonsV2BondingCurve c = IPonsV2BondingCurve(curve);
        (uint256 q, uint256 t) = c.getReserves();
        fee = (quoteIn * (c.feeBps() + c.creatorTaxBps())) / BPS;
        uint256 net = quoteIn - fee;
        if (net == 0 || q == 0 || t == 0) return (0, fee);
        tokensOut = Math.mulDiv(net, t, q + net);
        uint256 sellable = c.sellableTokens();
        if (tokensOut > sellable) tokensOut = sellable;
    }

    /// @notice Quote out for `tokensIn`, net of the curve fee and creator tax.
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 quoteOut, uint256 fee) {
        (, address curve, ) = _launch(token);
        IPonsV2BondingCurve c = IPonsV2BondingCurve(curve);
        (uint256 q, uint256 t) = c.getReserves();
        if (tokensIn == 0 || q == 0 || t == 0) return (0, 0);
        uint256 gross = Math.mulDiv(tokensIn, q, t + tokensIn);
        fee = (gross * (c.feeBps() + c.creatorTaxBps())) / BPS;
        quoteOut = gross - fee;
    }

    // ─── Internals ──────────────────────────────────────────

    function _launch(address token) internal view returns (address pair, address curve, address quote) {
        (pair, curve, quote, , ) = launcher.launches(token);
        require(curve != address(0), "PonsRouter: unknown token");
    }

    function _check(address pair, uint16 slippageBps, uint256 deadline) internal view {
        require(block.timestamp <= deadline, "PonsRouter: expired");
        require(slippageBps <= MAX_SLIPPAGE_BPS, "PonsRouter: slippage too high");
        PairVault vault = PairVault(pair);
        require(
            !oracle.isMultiplierPending(vault.tokenA()) && !oracle.isMultiplierPending(vault.tokenB()),
            "PonsRouter: corporate action pending"
        );
    }

    /// @dev After graduation Pons moves the market into its Uniswap v4 pool; the curve
    ///      rejects trades, so fail early with a message the UI can show.
    function _requireOpen(address curve) internal view {
        require(!IPonsV2BondingCurve(curve).graduated(), "PonsRouter: graduated, trade on Uniswap");
    }

    function _checkPayToken(address token) internal view {
        require(token == usdg || (token == weth && weth != address(0)), "PonsRouter: unsupported token");
    }

    function _curveBuy(address curve, address quote, uint256 quoteIn, uint256 minTokensOut)
        internal
        returns (uint256 tokensOut)
    {
        require(quoteIn > 0, "PonsRouter: zero quote");
        _requireOpen(curve);
        IERC20(quote).forceApprove(curve, quoteIn);
        tokensOut = IPonsV2BondingCurve(curve).buy(quoteIn, minTokensOut, msg.sender);
        IERC20(quote).forceApprove(curve, 0);
    }

    function _curveSell(address curve, address token, uint256 tokensIn) internal returns (uint256 quoteOut) {
        require(tokensIn > 0, "PonsRouter: zero amount");
        _requireOpen(curve);
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(token).forceApprove(curve, tokensIn);
        quoteOut = IPonsV2BondingCurve(curve).sell(tokensIn, 0, address(this));
        IERC20(token).forceApprove(curve, 0);
    }

    /// @dev Convert a stock leg into the quote token; the quote leg passes through.
    function _toQuote(address leg, address quote, uint256 amount, bytes calldata path, uint16 slippageBps)
        internal
        returns (uint256)
    {
        if (amount == 0 || leg == quote) return amount;
        return _convert(leg, quote, amount, path, slippageBps);
    }

    /// @dev Convert quote into a stock leg; the quote leg passes through.
    function _fromQuote(address quote, address leg, uint256 amount, bytes calldata path, uint16 slippageBps)
        internal
        returns (uint256)
    {
        if (amount == 0 || leg == quote) return amount;
        return _convert(quote, leg, amount, path, slippageBps);
    }

    /// @dev Share of `amountIn` that goes to tokenA, matching the vault's reserve value split.
    function _splitForA(PairVault vault, address tokenA, address tokenB, uint256 amountIn)
        internal
        view
        returns (uint256)
    {
        (uint256 balA, uint256 balB) = vault.reserves();
        require(balA > 0 && balB > 0, "PonsRouter: pair not seeded");
        uint256 valueA = _valueUsd8(tokenA, balA);
        uint256 valueB = _valueUsd8(tokenB, balB);
        return Math.mulDiv(amountIn, valueA, valueA + valueB);
    }

    /// @dev Swap `amountIn` of `tokenIn` to `tokenOut` along `path`, floored at the oracle price.
    function _convert(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata path, uint16 slippageBps)
        internal
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || tokenIn == tokenOut) return amountIn;
        _checkPath(path, tokenIn, tokenOut);

        uint256 minOut = Math.mulDiv(_fairOut(tokenIn, tokenOut, amountIn), BPS - slippageBps, BPS);
        uint256 before = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
        swapRouter.exactInput(
            ISwapRouter02.ExactInputParams({
                path: path,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut
            })
        );
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - before;
        require(amountOut >= minOut, "PonsRouter: below oracle floor");
    }

    function _checkPath(bytes calldata path, address tokenIn, address tokenOut) internal pure {
        require(path.length >= 43 && (path.length - 20) % 23 == 0, "PonsRouter: bad path");
        require(address(bytes20(path[:20])) == tokenIn, "PonsRouter: path start");
        require(address(bytes20(path[path.length - 20:])) == tokenOut, "PonsRouter: path end");
    }

    function _fairOut(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        return Math.mulDiv(
            _valueUsd8(tokenIn, amountIn),
            10 ** IERC20Metadata(tokenOut).decimals(),
            oracle.getPrice(tokenOut)
        );
    }

    function _valueUsd8(address token, uint256 amount) internal view returns (uint256) {
        return Math.mulDiv(amount, oracle.getPrice(token), 10 ** IERC20Metadata(token).decimals());
    }

    function _refund(address token) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(msg.sender, bal);
    }

    function _refundEth() internal {
        uint256 bal = IERC20(weth).balanceOf(address(this));
        if (bal > 0) IWETH(weth).withdraw(bal);
        bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = msg.sender.call{value: bal}("");
            require(ok, "PonsRouter: ETH refund failed");
        }
    }
}
