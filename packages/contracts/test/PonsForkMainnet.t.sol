// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PairFactory} from "../src/PairFactory.sol";
import {PairVault} from "../src/PairVault.sol";
import {PairRouter} from "../src/PairRouter.sol";
import {OracleAdapter} from "../src/OracleAdapter.sol";
import {PonsLauncher} from "../src/pons/PonsLauncher.sol";
import {PonsRouter} from "../src/pons/PonsRouter.sol";
import {IPonsV2LaunchFactory, IPonsV2BondingCurve} from "../src/pons/IPonsV2.sol";

/// @title Fork test: launch a live Compose pair's token on the real Pons v2 factory
/// @notice Run against Robinhood Chain mainnet:
///   forge test --match-contract PonsForkMainnetTest --fork-url https://rpc.mainnet.chain.robinhood.com -vv
/// Skips itself on any other chain. Proves, against the verified factory: no whitelist
/// is needed for a contract launcher, our ABI encoding of launchToken is right, the
/// creator's dev buy fills untaxed, and router buys/sells settle on the Pons curve.
contract PonsForkMainnetTest is Test {
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant PAIR_FACTORY = 0x14F7fD2eeC1D716b30B161aD7072A7DcCDA2dc69;
    address constant PAIR_ROUTER = 0x67B32aFf036461e41392C2d6985a5b82965f8Eb1;

    IPonsV2LaunchFactory pons = IPonsV2LaunchFactory(PONS);
    PairFactory factory = PairFactory(PAIR_FACTORY);
    PairVault vault;
    address creator;
    address usdg;
    PonsLauncher launcher;
    PonsRouter router;

    address quote;
    uint8 dec;
    uint256 phantom;
    uint256 threshold;
    uint256 devBuy;

    address token;
    IPonsV2BondingCurve curve;
    address bob = makeAddr("bob");

    function test_fork_launchAndTradeOnRealPons() public {
        if (block.chainid != 4663) {
            emit log("skipped: run with --fork-url <robinhood mainnet rpc>");
            return;
        }
        _setupFork();
        _launch();
        _trade();
        _checkViews();
    }

    function _setupFork() internal {
        usdg = PairRouter(payable(PAIR_ROUTER)).usdg();
        if (factory.pairCount() == 0) _launchPair();
        (address pairAddr, , , , , , address creator_) = factory.pairs(0);
        vault = PairVault(pairAddr);
        creator = creator_;

        // Live gate state.
        assertTrue(pons.launchEnabled(), "Pons gate closed");
        assertTrue(pons.approvedPairTokens(usdg), "USDG not approved");

        launcher = new PonsLauncher(PAIR_FACTORY, PONS, usdg);
        router = new PonsRouter(address(launcher), PAIR_ROUTER);
        assertTrue(pons.canLaunch(address(launcher)), "contract launcher not allowed");
        vm.prank(factory.owner());
        factory.setFeeExempt(address(router), true);

        // Prefer a stock leg Pons has approved, else USDG.
        if (pons.approvedPairTokens(vault.tokenA())) quote = vault.tokenA();
        else if (pons.approvedPairTokens(vault.tokenB())) quote = vault.tokenB();
        else quote = usdg;
        dec = IERC20Metadata(quote).decimals();
        uint8 econDec;
        (phantom, threshold, econDec) = pons.pairTokenEconomics(quote);
        assertEq(econDec, dec, "Pons decimals mismatch");
        devBuy = 2 * 10 ** dec;
        emit log_named_string("pair", IERC20Metadata(address(vault.receiptToken())).symbol());
        emit log_named_string("quote", IERC20Metadata(quote).symbol());
        emit log_named_decimal_uint("phantom", phantom, dec);
        emit log_named_decimal_uint("threshold", threshold, dec);
    }


    /// @dev A freshly redeployed factory has no pairs yet: seed one 50/50 from two listed stocks.
    function _launchPair() internal {
        address[] memory listed = factory.listedTokens();
        require(listed.length >= 2, "need two listed tokens");
        address a = listed[0];
        address b = listed[1];
        OracleAdapter oracle = PairRouter(payable(PAIR_ROUTER)).oracle();
        uint256 amountA = 10 ** IERC20Metadata(a).decimals();
        uint256 amountB = Math.mulDiv(
            Math.mulDiv(amountA, oracle.getPrice(a), 10 ** IERC20Metadata(a).decimals()),
            10 ** IERC20Metadata(b).decimals(),
            oracle.getPrice(b)
        );
        address seeder = makeAddr("seeder");
        deal(a, seeder, amountA);
        deal(b, seeder, amountB);
        vm.startPrank(seeder);
        IERC20(a).approve(PAIR_FACTORY, amountA);
        IERC20(b).approve(PAIR_FACTORY, amountB);
        factory.launchPair(
            PairFactory.LaunchParams({
                tokenA: a,
                tokenB: b,
                weightABps: 5000,
                creatorFeeBps: 100,
                receiptName: "Fork Pair",
                receiptSymbol: "FORKP",
                amountA: amountA,
                amountB: amountB,
                minShares: 0
            })
        );
        vm.stopPrank();
    }

    function _launch() internal {
        uint256 fee = pons.launchFee();
        vm.deal(creator, fee + 1 ether);
        deal(quote, creator, devBuy * 10);

        PonsLauncher.LaunchParams memory p = PonsLauncher.LaunchParams({
            pair: address(vault),
            quoteToken: quote,
            launchConfigId: 0,
            logo: "",
            description: "Compose pair token (fork test)",
            socials: IPonsV2LaunchFactory.Socials("", "", "", "", ""),
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics: pons.previewLaunchEconomics(0, quote),
            salt: keccak256("compose-fork-test"),
            exemptions: new address[](0),
            devBuyQuote: devBuy,
            minDevTokens: 1
        });
        vm.startPrank(creator);
        IERC20(quote).approve(address(launcher), type(uint256).max);
        (address token_, address curve_, uint256 devTokens) = launcher.launch{value: fee}(p);
        vm.stopPrank();
        token = token_;
        curve = IPonsV2BondingCurve(curve_);

        assertEq(curve.token(), token);
        assertEq(curve.pairToken(), quote);
        assertEq(IERC20Metadata(token).name(), IERC20Metadata(address(vault.receiptToken())).name());
        assertEq(IERC20Metadata(token).symbol(), IERC20Metadata(address(vault.receiptToken())).symbol());
        assertEq(launcher.tokenOfPair(address(vault)), token);
        assertGt(devTokens, 0, "dev buy empty");
        assertEq(IERC20(token).balanceOf(creator), devTokens);
        // Untaxed fill: net of the 1% curve fee, constant product over the phantom reserve.
        uint256 net = devBuy - (devBuy * curve.feeBps()) / 10_000;
        assertEq(devTokens, (net * curve.launchSupply()) / (phantom + net), "creator paid snipe tax");
        assertEq(curve.currentSnipeTaxBps(creator), 0);
        assertGt(curve.currentSnipeTaxBps(bob), 0, "stranger should be taxed in launch second");
        assertEq(IERC20(quote).balanceOf(address(launcher)), 0);
        assertEq(address(launcher).balance, 0);
        emit log_named_address("token", token);
        emit log_named_address("curve", address(curve));
        emit log_named_decimal_uint("dev tokens", devTokens, 18);
    }

    /// @dev A stranger trades through Compose after the launch window; both venues share the curve.
    function _trade() internal {
        vm.warp(block.timestamp + 5);
        deal(quote, bob, devBuy);
        (uint256 expected, ) = router.quoteBuy(token, devBuy);
        vm.startPrank(bob);
        IERC20(quote).approve(address(router), devBuy);
        uint256 bought = router.buy(
            PonsRouter.BuyParams({
                token: token,
                payToken: quote,
                amountIn: devBuy,
                path: "",
                minTokensOut: 0,
                maxSlippageBps: 100,
                deadline: block.timestamp + 1
            })
        );
        assertEq(bought, expected, "router quote != Pons fill");
        assertEq(IERC20(token).balanceOf(bob), bought);

        (uint256 quoteOutExpected, ) = router.quoteSell(token, bought / 2);
        IERC20(token).approve(address(router), bought / 2);
        uint256 quoteOut = router.sell(
            PonsRouter.SellParams({
                token: token,
                tokensIn: bought / 2,
                receiveToken: quote,
                path: "",
                minAmountOut: 0,
                maxSlippageBps: 100,
                unwrapEth: false,
                deadline: block.timestamp + 1
            })
        );
        vm.stopPrank();
        assertEq(quoteOut, quoteOutExpected, "router sell quote != Pons payout");
        assertEq(IERC20(quote).balanceOf(bob), quoteOut);
        assertEq(IERC20(quote).balanceOf(address(router)), 0);
        assertEq(IERC20(token).balanceOf(address(router)), 0);
        emit log_named_decimal_uint("bob bought", bought, 18);
        emit log_named_decimal_uint("bob sold half for", quoteOut, dec);
    }

    /// @dev The Compose lenses read the same curve.
    function _checkViews() internal {
        (uint256 q, uint256 t) = curve.getReserves();
        assertEq(router.priceInQuote(token), Math.mulDiv(q, 1e18, t));
        assertEq(router.progressBps(token), (curve.realQuoteReserve() * 10_000) / threshold);
        emit log_named_decimal_uint("price in quote (per 1e18 tokens)", router.priceInQuote(token), dec);
        emit log_named_uint("progress bps", router.progressBps(token));
        if (router.oracle().hasFeed(quote)) {
            emit log_named_decimal_uint("price USD", router.priceUsd8(token), 8);
            emit log_named_decimal_uint("market cap USD", router.marketCapUsd8(token), 8);
            emit log_named_decimal_uint("price in pair shares", router.priceInShares(token), 18);
        }
    }
}
