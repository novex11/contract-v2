// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PonsLauncher} from "../src/pons/PonsLauncher.sol";
import {PonsRouter} from "../src/pons/PonsRouter.sol";
import {PairFactory} from "../src/PairFactory.sol";
import {PairRouter} from "../src/PairRouter.sol";
import {IPonsV2LaunchFactory} from "../src/pons/IPonsV2.sol";

/// @title DeployPons — deploy PonsLauncher + PonsRouter against the live launchpad and Pons v2
///
///   PONS_FACTORY            Pons v2 launch factory (mainnet: 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e)
///   PONS_PAIR_FACTORY       live PairFactory
///   PONS_PAIR_ROUTER        live PairRouter bound to that factory (supplies oracle, swap router, WETH, USDG)
contract DeployPons is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address pons = vm.envAddress("PONS_FACTORY");
        address factory = vm.envAddress("PONS_PAIR_FACTORY");
        address pairRouter = vm.envAddress("PONS_PAIR_ROUTER");
        address usdg = PairRouter(payable(pairRouter)).usdg();

        require(pons.code.length > 0, "PONS_FACTORY has no code");
        console2.log("Pons launchEnabled:", IPonsV2LaunchFactory(pons).launchEnabled());
        console2.log("Pons launchFee (wei):", IPonsV2LaunchFactory(pons).launchFee());

        vm.startBroadcast(pk);
        PonsLauncher launcher = new PonsLauncher(factory, pons, usdg);
        PonsRouter router = new PonsRouter(address(launcher), pairRouter);
        // Sellers who take pair shares get them minted through the router; waive the pair creator fee.
        if (PairFactory(factory).owner() == deployer) {
            PairFactory(factory).setFeeExempt(address(router), true);
            console2.log("Fee exemption set on PairFactory for PonsRouter");
        } else {
            console2.log("SKIPPED setFeeExempt: deployer does not own the PairFactory; run it from the owner");
        }
        vm.stopBroadcast();

        console2.log("Pons canLaunch(launcher):", IPonsV2LaunchFactory(pons).canLaunch(address(launcher)));

        vm.serializeUint("pons", "chainId", block.chainid);
        vm.serializeAddress("pons", "ponsFactory", pons);
        vm.serializeAddress("pons", "ponsLauncher", address(launcher));
        string memory out = vm.serializeAddress("pons", "ponsRouter", address(router));
        vm.writeJson(out, string.concat("./deployments-pons-", vm.toString(block.chainid), ".json"));

        console2.log("PonsLauncher:", address(launcher));
        console2.log("PonsRouter:  ", address(router));
    }
}
