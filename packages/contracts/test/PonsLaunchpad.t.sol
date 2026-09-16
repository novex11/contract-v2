// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PairFactory} from "../src/PairFactory.sol";
import {PairDeployer} from "../src/PairDeployer.sol";
import {PairVault} from "../src/PairVault.sol";
import {PairRouter} from "../src/PairRouter.sol";
import {OracleAdapter} from "../src/OracleAdapter.sol";
import {EmergencyRegistry} from "../src/EmergencyRegistry.sol";
import {PushPriceFeed} from "../src/PushPriceFeed.sol";
import {PriceFeedUpdater} from "../src/PriceFeedUpdater.sol";
import {OracleSwapRouter} from "../src/testnet/OracleSwapRouter.sol";
import {TestUSDG} from "../src/testnet/TestUSDG.sol";
import {FixedPriceFeed} from "../src/testnet/FixedPriceFeed.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockWRHT} from "../src/mocks/MockWRHT.sol";
import {MockPonsFactory, MockPonsCurve} from "../src/mocks/MockPons.sol";
import {PonsLauncher} from "../src/pons/PonsLauncher.sol";
import {PonsRouter} from "../src/pons/PonsRouter.sol";
import {IPonsV2LaunchFactory, IPonsV2BondingCurve, IPonsV2FeeEscrow} from "../src/pons/IPonsV2.sol";

contract PonsLaunchpadTest is Test {
    uint24 constant POOL_FEE = 3000;
    uint256 constant LAUNCH_FEE = 0.0005 ether;
    // Live Pons economics for a Robinhood stock quote (NVDA): 16.64 / 41.6, 18 decimals.
    uint256 constant PHANTOM_TSLA = 16.64 ether;
    uint256 constant THRESHOLD_TSLA = 41.6 ether;
    uint256 constant SUPPLY = 1_000_000_000e18;

    PairFactory factory;
    OracleAdapter oracle;
    EmergencyRegistry emergency;
    PriceFeedUpdater updater;
    OracleSwapRouter swapRouter;
    PairRouter pairRouter;
    MockPonsFactory pons;
    PonsLauncher launcher;
    PonsRouter router;

    MockERC20 tsla; // $250
    MockERC20 amd; // $100
    MockWRHT weth; // $2,500
    TestUSDG usdg;

    PairVault pair;
    IERC20 share;

    address alice = address(0xA11CE); // pair creator
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    function setUp() public {
        vm.warp(1_000);
        tsla = new MockERC20("Tesla", "TSLA");
        amd = new MockERC20("AMD", "AMD");
        weth = new MockWRHT();
        usdg = new TestUSDG(address(this));

        oracle = new OracleAdapter(address(this));
        emergency = new EmergencyRegistry(address(this));
        updater = new PriceFeedUpdater(address(this));
        oracle.setPriceFeed(address(tsla), address(new PushPriceFeed(address(this), address(updater), "TSLA / USD", 250e8)));
        oracle.setPriceFeed(address(amd), address(new PushPriceFeed(address(this), address(updater), "AMD / USD", 100e8)));
        oracle.setPriceFeed(address(weth), address(new PushPriceFeed(address(this), address(updater), "ETH / USD", 2_500e8)));
        oracle.setPriceFeed(address(usdg), address(new FixedPriceFeed("USDG / USD", 1e8)));

        factory = new PairFactory(address(this), address(oracle), address(emergency), address(weth), address(new PairDeployer()));
        factory.setTokenListed(address(tsla), true);
        factory.setTokenListed(address(amd), true);
        factory.setTokenListed(address(weth), true);

        swapRouter = new OracleSwapRouter(address(this), address(oracle));
        pairRouter = new PairRouter(address(factory), address(swapRouter), address(usdg));

        pons = new MockPonsFactory(LAUNCH_FEE);
        pons.approvePairToken(address(tsla), PHANTOM_TSLA, THRESHOLD_TSLA, 18);
        pons.approvePairToken(address(usdg), 3_236e6, 8_090e6, 6);

        launcher = new PonsLauncher(address(factory), address(pons), address(usdg));
        router = new PonsRouter(address(launcher), address(pairRouter));
        factory.setFeeExempt(address(router), true);

        tsla.mint(address(swapRouter), 10_000 ether);
        amd.mint(address(swapRouter), 10_000 ether);
        usdg.mint(address(swapRouter), 10_000_000e6);
        weth.mint(address(swapRouter), 1_000 ether);
        vm.deal(address(weth), 1_000 ether);

        tsla.mint(alice, 1_000 ether);
        amd.mint(alice, 1_000 ether);
        vm.deal(alice, 1 ether);
        tsla.mint(bob, 1_000 ether);
        usdg.mint(bob, 100_000e6);
        vm.deal(bob, 100 ether);
        tsla.mint(carol, 100 ether);

        // Alice launches TSLA/AMD 60/40 with $1,000 -> 1,000 shares at $1.00
        vm.startPrank(alice);
        tsla.approve(address(factory), type(uint256).max);
        amd.approve(address(factory), type(uint256).max);
        (address p, , ) = factory.launchPair(
            PairFactory.LaunchParams({
                tokenA: address(tsla),
                tokenB: address(amd),
                weightABps: 6000,
                creatorFeeBps: 200,
                receiptName: "Tesla x AMD",
                receiptSymbol: "TSAMD",
                amountA: 2.4 ether,
                amountB: 4 ether,
                minShares: 0
            })
        );
        share = IERC20(address(PairVault(p).receiptToken()));
        share.transfer(bob, 300e18);
        vm.stopPrank();
        pair = PairVault(p);
    }

    // ─── Helpers ────────────────────────────────────────────

    function _params(address quote, uint256 devBuy) internal view returns (PonsLauncher.LaunchParams memory) {
        return PonsLauncher.LaunchParams({
            pair: address(pair),
            quoteToken: quote,
            launchConfigId: 0,
            logo: "ipfs://logo",
            description: "Tesla x AMD on Compose",
            socials: IPonsV2LaunchFactory.Socials("", "", "", "https://compose.xyz", ""),
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics: bytes32(0),
            salt: bytes32(0),
            exemptions: new address[](0),
            devBuyQuote: devBuy,
            minDevTokens: 0
        });
    }

    function _launch(uint256 devBuy) internal returns (address token, MockPonsCurve curve) {
        vm.startPrank(alice);
        tsla.approve(address(launcher), type(uint256).max);
        (address t, address c, ) = launcher.launch{value: LAUNCH_FEE}(_params(address(tsla), devBuy));
        vm.stopPrank();
        return (t, MockPonsCurve(c));
    }

    function _path(address from, address to) internal pure returns (bytes memory) {
        return abi.encodePacked(from, POOL_FEE, to);
    }

    function _buyParams(address token, address payToken, uint256 amountIn, bytes memory path)
        internal
        view
        returns (PonsRouter.BuyParams memory)
    {
        return PonsRouter.BuyParams({
            token: token,
            payToken: payToken,
            amountIn: amountIn,
            path: path,
            minTokensOut: 0,
            maxSlippageBps: 100,
            deadline: block.timestamp + 1
        });
    }

    function _sellParams(address token, uint256 tokensIn, address receiveToken, bytes memory path, bool unwrap)
        internal
        view
        returns (PonsRouter.SellParams memory)
    {
        return PonsRouter.SellParams({
            token: token,
            tokensIn: tokensIn,
            receiveToken: receiveToken,
            path: path,
            minAmountOut: 0,
            maxSlippageBps: 100,
            unwrapEth: unwrap,
            deadline: block.timestamp + 1
        });
    }


    /// @dev Paths from each vault leg into TSLA (the quote); the TSLA leg needs none.
    function _pathsToQuote() internal view returns (bytes memory pathA, bytes memory pathB) {
        address a = pair.tokenA();
        address b = pair.tokenB();
        pathA = a == address(tsla) ? bytes("") : _path(a, address(tsla));
        pathB = b == address(tsla) ? bytes("") : _path(b, address(tsla));
    }

    /// @dev Paths from TSLA (the quote) into each vault leg; the TSLA leg needs none.
    function _pathsFromQuote() internal view returns (bytes memory pathA, bytes memory pathB) {
        address a = pair.tokenA();
        address b = pair.tokenB();
        pathA = a == address(tsla) ? bytes("") : _path(address(tsla), a);
        pathB = b == address(tsla) ? bytes("") : _path(address(tsla), b);
    }

    function _shareBuy(address token, uint256 sharesIn) internal view returns (PonsRouter.ShareBuyParams memory) {
        (bytes memory pathA, bytes memory pathB) = _pathsToQuote();
        return PonsRouter.ShareBuyParams({
            token: token,
            sharesIn: sharesIn,
            pathA: pathA,
            pathB: pathB,
            minTokensOut: 0,
            maxSlippageBps: 100,
            deadline: block.timestamp + 1
        });
    }

    function _shareSell(address token, uint256 tokensIn) internal view returns (PonsRouter.ShareSellParams memory) {
        (bytes memory pathA, bytes memory pathB) = _pathsFromQuote();
        return PonsRouter.ShareSellParams({
            token: token,
            tokensIn: tokensIn,
            pathA: pathA,
            pathB: pathB,
            minShares: 0,
            maxSlippageBps: 100,
            deadline: block.timestamp + 1
        });
    }

    function _bobBuysWithTsla(address token, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(bob);
        tsla.approve(address(router), amount);
        out = router.buy(_buyParams(token, address(tsla), amount, ""));
        vm.stopPrank();
    }

    function _assertRouterEmpty(address token) internal view {
        assertEq(IERC20(token).balanceOf(address(router)), 0, "router holds tokens");
        assertEq(tsla.balanceOf(address(router)), 0, "router holds tsla");
        assertEq(amd.balanceOf(address(router)), 0, "router holds amd");
        assertEq(usdg.balanceOf(address(router)), 0, "router holds usdg");
        assertEq(weth.balanceOf(address(router)), 0, "router holds weth");
        assertEq(share.balanceOf(address(router)), 0, "router holds shares");
        assertEq(address(router).balance, 0, "router holds eth");
    }

    // ─── Launch ─────────────────────────────────────────────

    function test_launch_recordsTokenOnBothSides() public {
        (address token, MockPonsCurve curve) = _launch(0);

        // The token carries the pair's identity, like ComposeCurve.createToken.
        assertEq(IERC20Metadata(token).name(), "Tesla x AMD");
        assertEq(IERC20Metadata(token).symbol(), "TSAMD");
        assertEq(IERC20(token).totalSupply(), SUPPLY);
        assertEq(IERC20(token).balanceOf(address(curve)), SUPPLY, "whole supply on the Pons curve");

        // Pons side: one-stock curve, creator paid directly.
        assertEq(curve.pairToken(), address(tsla));
        assertEq(curve.token(), token);
        assertEq(pons.feesCollected(), LAUNCH_FEE, "launch fee forwarded");
        assertEq(pons.launched(0), token);
        assertTrue(curve.snipeTaxExempt(alice), "creator exempt from snipe tax");

        // Compose side: pair <-> token <-> curve.
        assertEq(launcher.tokenOfPair(address(pair)), token);
        assertEq(launcher.curveOf(token), address(curve));
        assertEq(launcher.pairOf(token), address(pair));
        assertEq(launcher.quoteOf(token), address(tsla));
        assertEq(launcher.tokenCount(), 1);
        assertTrue(launcher.isLaunched(token));
        assertEq(address(launcher).balance, 0);
        assertEq(tsla.balanceOf(address(launcher)), 0);
    }

    function test_launch_onlyPairCreator() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert("PonsLauncher: only pair creator");
        launcher.launch{value: LAUNCH_FEE}(_params(address(tsla), 0));
    }

    function test_launch_oncePerPair() public {
        _launch(0);
        vm.prank(alice);
        vm.expectRevert("PonsLauncher: pair already has a token");
        launcher.launch{value: LAUNCH_FEE}(_params(address(tsla), 0));
    }

    function test_launch_quoteMustBePairLegOrUsdg() public {
        vm.prank(alice);
        vm.expectRevert("PonsLauncher: quote must be a pair leg or USDG");
        launcher.launch{value: LAUNCH_FEE}(_params(address(weth), 0));
    }

    function test_launch_quoteMustBeApprovedByPons() public {
        // AMD is a pair leg but Pons has not approved it as a quote asset.
        vm.prank(alice);
        vm.expectRevert("PonsLauncher: quote not approved by Pons");
        launcher.launch{value: LAUNCH_FEE}(_params(address(amd), 0));
    }

    function test_launch_usdgQuoteAllowed() public {
        vm.prank(alice);
        (address token, address curve, ) = launcher.launch{value: LAUNCH_FEE}(_params(address(usdg), 0));
        assertEq(MockPonsCurve(curve).pairToken(), address(usdg));
        assertEq(launcher.quoteOf(token), address(usdg));
    }

    function test_launch_requiresExactPonsFee() public {
        vm.prank(alice);
        vm.expectRevert("PonsLauncher: launch fee");
        launcher.launch{value: LAUNCH_FEE - 1}(_params(address(tsla), 0));
    }

    function test_launch_pinnedEconomics() public {
        PonsLauncher.LaunchParams memory p = _params(address(tsla), 0);
        p.expectedEconomics = launcher.previewEconomics(0, address(tsla));
        vm.prank(alice);
        launcher.launch{value: LAUNCH_FEE}(p);

        // A stale pin is rejected by Pons.
        PonsLauncher.LaunchParams memory q = _params(address(usdg), 0);
        q.expectedEconomics = keccak256("stale");
        vm.prank(alice);
        vm.expectRevert("PonsLauncher: pair already has a token");
        launcher.launch{value: LAUNCH_FEE}(q);
    }

    function test_launch_followsPonsGate() public {
        // Open gate (the live state): any address launches.
        assertTrue(pons.canLaunch(address(launcher)));
        // Closed gate: only whitelisted launchers.
        pons.setLaunchEnabled(false);
        vm.prank(alice);
        vm.expectRevert("PonsLauncher: Pons launches closed");
        launcher.launch{value: LAUNCH_FEE}(_params(address(tsla), 0));

        pons.setWhitelisted(address(launcher), true);
        _launch(0);
        assertEq(launcher.tokenCount(), 1);
    }

    function test_launch_exemptionsForwarded() public {
        PonsLauncher.LaunchParams memory p = _params(address(tsla), 0);
        address[] memory ex = new address[](2);
        ex[0] = bob;
        ex[1] = carol;
        p.exemptions = ex;
        vm.prank(alice);
        (, address curve, ) = launcher.launch{value: LAUNCH_FEE}(p);
        assertTrue(MockPonsCurve(curve).snipeTaxExempt(bob));
        assertTrue(MockPonsCurve(curve).snipeTaxExempt(carol));
        assertFalse(MockPonsCurve(curve).snipeTaxExempt(address(0xDEAD)));
    }

    function test_devBuy_fillsUntaxedInLaunchTx() public {
        uint256 devBuy = 1 ether; // 1 TSLA
        uint256 before = tsla.balanceOf(alice);
        (address token, MockPonsCurve curve) = _launch(devBuy);

        // Untaxed constant-product fill: net = 0.99 TSLA against 16.64 phantom.
        uint256 net = devBuy - (devBuy * curve.feeBps()) / 10_000;
        uint256 expected = (net * SUPPLY) / (PHANTOM_TSLA + net);
        assertEq(IERC20(token).balanceOf(alice), expected);
        assertEq(before - tsla.balanceOf(alice), devBuy);
        assertEq(curve.realQuoteReserve(), net);
        assertEq(tsla.balanceOf(address(launcher)), 0);
    }

    function test_devBuy_slippageGuard() public {
        PonsLauncher.LaunchParams memory p = _params(address(tsla), 1 ether);
        p.minDevTokens = SUPPLY; // impossible
        vm.startPrank(alice);
        tsla.approve(address(launcher), type(uint256).max);
        vm.expectRevert("MockPonsCurve: slippage");
        launcher.launch{value: LAUNCH_FEE}(p);
        vm.stopPrank();
    }

    // ─── Price views: one market, two lenses ────────────────

    function test_prices_matchAcrossQuoteUsdAndShares() public {
        (address token, ) = _launch(0);

        // Opening price: 16.64 TSLA / 1B tokens = 1.664e10 TSLA-wei per token.
        uint256 pq = router.priceInQuote(token);
        assertEq(pq, Math.mulDiv(PHANTOM_TSLA, 1e18, SUPPLY));
        // In USD: × $250 = 416 USD8 per 1e18 tokens -> $4,160 market cap.
        uint256 pu = router.priceUsd8(token);
        assertEq(pu, Math.mulDiv(pq, 250e8, 1e18));
        assertEq(router.marketCapUsd8(token), Math.mulDiv(pu, SUPPLY, 1e18));
        assertEq(router.marketCapUsd8(token), 4_160e8);
        // In pair shares: share price is $1.00, so 416 USD8 = 4.16e12 shares.
        uint256 ps = router.priceInShares(token);
        assertEq(Math.mulDiv(ps, pair.sharePrice(), 1e18), pu);

        // A trade on Pons directly (carol uses the Pons UI) moves every Compose lens.
        vm.warp(block.timestamp + 10);
        vm.startPrank(carol);
        tsla.approve(launcher.curveOf(token), 5 ether);
        IPonsV2BondingCurve(launcher.curveOf(token)).buy(5 ether, 0, carol);
        vm.stopPrank();
        assertGt(router.priceInQuote(token), pq);
        assertGt(router.priceUsd8(token), pu);
        assertGt(router.priceInShares(token), ps);
        assertEq(Math.mulDiv(router.priceInShares(token), pair.sharePrice(), 1e18), router.priceUsd8(token));
        assertEq(router.progressBps(token), (IPonsV2BondingCurve(launcher.curveOf(token)).realQuoteReserve() * 10_000) / THRESHOLD_TSLA);
    }

    function test_prices_reQuoteWhenStockMoves() public {
        (address token, ) = _launch(0);
        uint256 pq = router.priceInQuote(token);
        uint256 pu = router.priceUsd8(token);
        // TSLA doubles: the quote price is unchanged, USD and share prices follow the stock.
        PushPriceFeed(oracle.priceFeeds(address(tsla))).updateAnswer(500e8);
        assertEq(router.priceInQuote(token), pq);
        assertEq(router.priceUsd8(token), pu * 2);
        assertEq(Math.mulDiv(router.priceInShares(token), pair.sharePrice(), 1e18), pu * 2);
    }

    // ─── Buy ────────────────────────────────────────────────

    function test_buy_withQuoteStock() public {
        (address token, MockPonsCurve curve) = _launch(0);
        vm.warp(block.timestamp + 10); // past the snipe window
        (uint256 expected, ) = router.quoteBuy(token, 2 ether);
        uint256 out = _bobBuysWithTsla(token, 2 ether);
        assertEq(out, expected);
        assertEq(IERC20(token).balanceOf(bob), out);
        assertEq(curve.realQuoteReserve(), 2 ether - (2 ether * curve.feeBps()) / 10_000);
        _assertRouterEmpty(token);
    }

    function test_buy_withUsdg() public {
        (address token, ) = _launch(0);
        vm.warp(block.timestamp + 10);
        // $500 -> ~2 TSLA minus the 0.3% pool fee.
        uint256 amountIn = 500e6;
        (uint256 expectedFair, ) = router.quoteBuy(token, 2 ether);
        vm.startPrank(bob);
        usdg.approve(address(router), amountIn);
        uint256 out = router.buy(_buyParams(token, address(usdg), amountIn, _path(address(usdg), address(tsla))));
        vm.stopPrank();
        assertGt(out, 0);
        assertLt(out, expectedFair);
        assertGt(out, (expectedFair * 99) / 100);
        assertEq(usdg.balanceOf(bob), 100_000e6 - amountIn);
        _assertRouterEmpty(token);
    }

    function test_buy_withEth() public {
        (address token, ) = _launch(0);
        vm.warp(block.timestamp + 10);
        uint256 ethBefore = bob.balance;
        // 0.2 ETH = $500 -> ~2 TSLA
        vm.prank(bob);
        uint256 out = router.buy{value: 0.2 ether}(
            _buyParams(token, address(weth), 0.2 ether, _path(address(weth), address(tsla)))
        );
        assertGt(out, 0);
        assertEq(ethBefore - bob.balance, 0.2 ether);
        assertEq(IERC20(token).balanceOf(bob), out);
        _assertRouterEmpty(token);
    }

    function test_buy_withPairShares() public {
        (address token, MockPonsCurve curve) = _launch(0);
        vm.warp(block.timestamp + 10);
        // 100 shares = $100 = 0.24 TSLA + 0.4 AMD; AMD leg swaps to ~0.1595 TSLA.
        uint256 sharesIn = 100e18;
        vm.startPrank(bob);
        share.approve(address(router), sharesIn);
        uint256 out = router.buyWithShares(_shareBuy(token, sharesIn));
        vm.stopPrank();

        assertGt(out, 0);
        assertEq(share.balanceOf(bob), 200e18);
        assertEq(IERC20(token).balanceOf(bob), out);
        // ~0.3995 TSLA reached the curve (0.24 + 0.4 × 100/250 × 0.997), less the 1% curve fee.
        uint256 quoteIn = 0.24 ether + (0.4 ether * 100 * 997) / (250 * 1000);
        assertApproxEqRel(curve.realQuoteReserve(), quoteIn - quoteIn / 100, 1e15);
        // The vault shrank by exactly the redeemed slice.
        assertEq(pair.totalShares(), 900e18);
        _assertRouterEmpty(token);
    }

    function test_buy_rejectsUnsupportedPayToken() public {
        (address token, ) = _launch(0);
        vm.warp(block.timestamp + 10);
        vm.startPrank(bob);
        amd.approve(address(router), 1 ether);
        vm.expectRevert("PonsRouter: unsupported token");
        router.buy(_buyParams(token, address(amd), 1 ether, _path(address(amd), address(tsla))));
        vm.stopPrank();
    }

    function test_buy_slippageAndDeadline() public {
        (address token, ) = _launch(0);
        vm.warp(block.timestamp + 10);
        PonsRouter.BuyParams memory p = _buyParams(token, address(tsla), 1 ether, "");
        p.minTokensOut = SUPPLY;
        vm.startPrank(bob);
        tsla.approve(address(router), 1 ether);
        vm.expectRevert("MockPonsCurve: slippage");
        router.buy(p);

        p.minTokensOut = 0;
        p.deadline = block.timestamp - 1;
        vm.expectRevert("PonsRouter: expired");
        router.buy(p);

        p.deadline = block.timestamp + 1;
        p.maxSlippageBps = 301;
        vm.expectRevert("PonsRouter: slippage too high");
        router.buy(p);
        vm.stopPrank();
    }

    function test_buy_unknownToken() public {
        vm.expectRevert("PonsRouter: unknown token");
        router.buy(_buyParams(address(0xBEEF), address(tsla), 1 ether, ""));
    }

    function test_buy_snipeTaxAppliesToNonExemptInLaunchWindow() public {
        (address token, ) = _launch(0);
        (uint256 untaxed, ) = router.quoteBuy(token, 1 ether);
        // Same second as the launch: 99% tax for a stranger.
        uint256 taxed = _bobBuysWithTsla(token, 1 ether);
        assertLt(taxed, untaxed / 50);
        // After the 3s window the tax is gone.
        vm.warp(block.timestamp + 3);
        (uint256 later, ) = router.quoteBuy(token, 1 ether);
        assertEq(_bobBuysWithTsla(token, 1 ether), later);
    }

    // ─── Sell ───────────────────────────────────────────────

    function test_sell_forQuoteStock() public {
        (address token, MockPonsCurve curve) = _launch(0);
        vm.warp(block.timestamp + 10);
        uint256 bought = _bobBuysWithTsla(token, 2 ether);
        uint256 half = bought / 2;
        (uint256 expected, ) = router.quoteSell(token, half);

        uint256 before = tsla.balanceOf(bob);
        vm.startPrank(bob);
        IERC20(token).approve(address(router), half);
        uint256 out = router.sell(_sellParams(token, half, address(tsla), "", false));
        vm.stopPrank();

        assertEq(out, expected);
        assertEq(tsla.balanceOf(bob) - before, out);
        assertEq(IERC20(token).balanceOf(bob), bought - half);
        assertEq(IERC20(token).balanceOf(address(curve)), SUPPLY - bought + half);
        _assertRouterEmpty(token);
    }

    function test_sell_forUsdgAndEth() public {
        (address token, ) = _launch(0);
        vm.warp(block.timestamp + 10);
        uint256 bought = _bobBuysWithTsla(token, 2 ether);
        uint256 quarter = bought / 4;
        (uint256 quoteOut, ) = router.quoteSell(token, quarter);

        vm.startPrank(bob);
        IERC20(token).approve(address(router), bought);
        uint256 usdgBefore = usdg.balanceOf(bob);
        uint256 outUsdg = router.sell(_sellParams(token, quarter, address(usdg), _path(address(tsla), address(usdg)), false));
        assertEq(usdg.balanceOf(bob) - usdgBefore, outUsdg);
        // ~$250 per TSLA minus the 0.3% pool fee.
        assertApproxEqRel(outUsdg, (quoteOut * 250 * 997) / (1e12 * 1000), 1e15);

        uint256 ethBefore = bob.balance;
        uint256 outEth = router.sell(_sellParams(token, quarter, address(weth), _path(address(tsla), address(weth)), true));
        assertEq(bob.balance - ethBefore, outEth);
        assertGt(outEth, 0);
        vm.stopPrank();
        _assertRouterEmpty(token);
    }

    function test_sell_forPairShares() public {
        (address token, ) = _launch(0);
        vm.warp(block.timestamp + 10);
        uint256 bought = _bobBuysWithTsla(token, 2 ether);
        uint256 half = bought / 2;
        (uint256 quoteOut, ) = router.quoteSell(token, half);

        uint256 sharesBefore = share.balanceOf(bob);
        uint256 tsBefore = pair.totalShares();
        vm.startPrank(bob);
        IERC20(token).approve(address(router), half);
        uint256 shares = router.sellForShares(_shareSell(token, half));
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(share.balanceOf(bob) - sharesBefore, shares);
        assertEq(pair.totalShares() - tsBefore, shares, "no creator fee on router deposits");
        // ~quoteOut × $250 of value became shares at $1.00, minus the 0.3% swap on the AMD leg (40%).
        uint256 valueUsd18 = quoteOut * 250;
        assertApproxEqRel(shares, valueUsd18 - (valueUsd18 * 40 * 3) / (100 * 1000), 5e15);
        _assertRouterEmpty(token);
    }

    function test_sell_slippage() public {
        (address token, ) = _launch(0);
        vm.warp(block.timestamp + 10);
        uint256 bought = _bobBuysWithTsla(token, 1 ether);
        PonsRouter.SellParams memory p = _sellParams(token, bought, address(tsla), "", false);
        p.minAmountOut = 10 ether;
        vm.startPrank(bob);
        IERC20(token).approve(address(router), bought);
        vm.expectRevert("PonsRouter: slippage");
        router.sell(p);
        vm.stopPrank();
    }

    // ─── Graduation ─────────────────────────────────────────

    function test_graduation_clampsRefundsAndCloses() public {
        (address token, MockPonsCurve curve) = _launch(0);
        vm.warp(block.timestamp + 10);
        uint256 sellable = curve.sellableTokens();
        uint256 before = tsla.balanceOf(bob);

        // 100 TSLA is far more than the 41.6 threshold: fill is clamped, the rest refunded.
        uint256 out = _bobBuysWithTsla(token, 100 ether);
        assertEq(out, sellable);
        uint256 spent = before - tsla.balanceOf(bob);
        assertLt(spent, 100 ether);
        // Real quote net of the 1% fee lands on the threshold.
        assertApproxEqRel(curve.realQuoteReserve(), THRESHOLD_TSLA, 1e14);
        assertTrue(curve.graduated());
        assertEq(router.progressBps(token), 10_000);
        _assertRouterEmpty(token);

        // Curve trading is closed on both venues; the V4 pool takes over on Pons.
        vm.startPrank(bob);
        tsla.approve(address(router), 1 ether);
        vm.expectRevert("PonsRouter: graduated, trade on Uniswap");
        router.buy(_buyParams(token, address(tsla), 1 ether, ""));
        IERC20(token).approve(address(router), 1e18);
        vm.expectRevert("PonsRouter: graduated, trade on Uniswap");
        router.sell(_sellParams(token, 1e18, address(tsla), "", false));
        vm.stopPrank();
    }

    // ─── Creator fees: sweep on the curve, claim from the escrow ──────────

    function test_creatorFees_sweepThenClaim() public {
        (address token, MockPonsCurve curve) = _launch(0);
        vm.warp(block.timestamp + 10);
        _bobBuysWithTsla(token, 5 ether);

        // Fees wait on the curve; nothing reaches the creator by itself.
        uint256 fee = curve.quoteFeeBalance();
        uint256 tax = curve.creatorTaxBalance();
        assertGt(fee, 0);
        assertEq(tax, 0, "no creator tax configured");
        IPonsV2FeeEscrow escrow = IPonsV2FeeEscrow(pons.feeEscrow());
        assertEq(escrow.balanceOfToken(alice, address(tsla)), 0);

        // Only the creator fee recipient (the pair creator) may sweep; the launcher
        // contract is Pons's deployer of record but has no fee rights.
        vm.prank(bob);
        vm.expectRevert("NotFeeSweepOperator");
        curve.sweepFees(0);
        vm.prank(address(launcher));
        vm.expectRevert("NotFeeSweepOperator");
        curve.sweepFees(0);

        (uint256 quoteBefore, uint256 tokenBefore) = curve.getReserves();
        vm.prank(alice);
        curve.sweepFees(0);
        (uint256 quoteAfter, uint256 tokenAfter) = curve.getReserves();
        assertEq(quoteAfter, quoteBefore, "sweep must not move the price");
        assertEq(tokenAfter, tokenBefore);
        assertEq(curve.quoteFeeBalance(), 0);

        uint256 creatorCut = fee - (fee * curve.protocolFeeShareBps()) / 10_000 + tax;
        assertEq(escrow.balanceOfToken(alice, address(tsla)), creatorCut);

        uint256 before = tsla.balanceOf(alice);
        vm.prank(alice);
        escrow.claimToken(address(tsla));
        assertEq(tsla.balanceOf(alice) - before, creatorCut);
        assertEq(escrow.balanceOfToken(alice, address(tsla)), 0);
    }

    function test_creatorFees_taxAccruesToCreator() public {
        vm.startPrank(alice);
        tsla.approve(address(launcher), type(uint256).max);
        PonsLauncher.LaunchParams memory p = _params(address(tsla), 0);
        p.creatorTaxBps = 200;
        (address token, address c, ) = launcher.launch{value: LAUNCH_FEE}(p);
        vm.stopPrank();
        MockPonsCurve curve = MockPonsCurve(c);
        vm.warp(block.timestamp + 10);
        _bobBuysWithTsla(token, 5 ether);
        uint256 tax = curve.creatorTaxBalance();
        assertGt(tax, 0);
        uint256 fee = curve.quoteFeeBalance();
        vm.prank(alice);
        curve.sweepFees(0);
        IPonsV2FeeEscrow escrow = IPonsV2FeeEscrow(pons.feeEscrow());
        assertEq(escrow.balanceOfToken(alice, address(tsla)), fee - (fee * 3_000) / 10_000 + tax);
    }

    // ─── Same market from both venues ───────────────────────

    function test_volumeAndPriceAreSharedWithPons() public {
        (address token, MockPonsCurve curve) = _launch(0);
        vm.warp(block.timestamp + 10);

        // Bob buys on Compose (via shares), carol buys on Pons (directly). Same curve.
        vm.startPrank(bob);
        share.approve(address(router), 50e18);
        uint256 bobOut = router.buyWithShares(_shareBuy(token, 50e18));
        vm.stopPrank();
        vm.startPrank(carol);
        tsla.approve(address(curve), 1 ether);
        uint256 carolOut = curve.buy(1 ether, 0, carol);
        vm.stopPrank();

        (, uint256 tokenReserve) = curve.getReserves();
        assertEq(SUPPLY - tokenReserve, bobOut + carolOut, "both venues drain the one reserve");
        assertEq(IERC20(token).balanceOf(bob), bobOut);
        assertEq(IERC20(token).balanceOf(carol), carolOut);
        // Carol can sell what she bought on Pons through Compose, into pair shares.
        vm.startPrank(carol);
        IERC20(token).approve(address(router), carolOut);
        uint256 shares = router.sellForShares(_shareSell(token, carolOut));
        vm.stopPrank();
        assertGt(shares, 0);
        assertEq(share.balanceOf(carol), shares);
        _assertRouterEmpty(token);
    }
}
