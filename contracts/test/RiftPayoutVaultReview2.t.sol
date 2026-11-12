// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Second-round adversarial review of RiftPayoutVault v3. Tests document the
// RESIDUAL exposure and edge cases (they pass on the current code).

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RiftPayoutVault} from "../src/RiftPayoutVault.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";

contract Review2USDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract RiftPayoutVaultReview2Test is Test {
    RiftPayoutVault vault;
    EntryPoint ep;
    Review2USDC usdc;
    address admin = makeAddr("admin");
    address op = makeAddr("op");
    address paymaster = makeAddr("paymaster");
    address attacker = makeAddr("attacker");
    uint128 constant ONE = 1e6;

    function _deploy(uint128 gasAllowance, uint128 gasPerDay) internal {
        address[] memory ops = new address[](1);
        ops[0] = op;
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        vault = new RiftPayoutVault(admin, ops, 24 hours, toks, 5_000 * ONE, 100_000 * ONE, 50_000 * ONE, address(ep), paymaster, gasAllowance, gasPerDay);
        usdc.mint(address(vault), 2_000_000 * ONE);
    }

    function setUp() public {
        usdc = new Review2USDC();
        ep = new EntryPoint();
        // 1 minute before a UTC midnight
        uint256 t0 = 1_800_000_000; // integer division on a variable (literals divide as rationals)
        vm.warp((t0 / 1 days + 1) * 1 days - 60);
        _deploy(50 * ONE, 200 * ONE);
    }

    function _pay(bytes32 ref, uint128 amount) internal {
        RiftPayoutVault.Payment[] memory ps = new RiftPayoutVault.Payment[](1);
        ps[0] = RiftPayoutVault.Payment({to: attacker, amount: amount, ref: ref});
        vm.prank(op);
        vault.payout(address(usdc), ps);
    }

    /// The execute() restriction does not help against a STOLEN operator key: the thief is an operator.
    /// Residual: 50k/day queued (cancellable for 24h) — but only if the admin acts.
    function test_review2_stolenOperatorExecutesOwnQueueIfAdminSilent() public {
        vm.prank(op);
        vault.queue(address(usdc), attacker, 50_000 * ONE, "q1");
        vm.warp(block.timestamp + 24 hours);
        vm.prank(op);
        vault.execute("q1");
        assertEq(usdc.balanceOf(attacker), 50_000 * ONE);
    }

    /// Day-boundary: within ~2 minutes around UTC midnight a stolen key moves 2x perDay instantly
    /// (200k, NOT cancellable) and queues 2x queuePerDay (100k).
    function test_review2_midnightDoublesEveryDailyCap() public {
        for (uint256 i; i < 20; ++i) _pay(bytes32(i + 1), 5_000 * ONE); // 100k before midnight
        vm.prank(op);
        vault.queue(address(usdc), attacker, 50_000 * ONE, "qa");
        uint256 t0 = 1_800_000_000;
        vm.warp((t0 / 1 days + 1) * 1 days + 60); // after midnight
        for (uint256 i; i < 20; ++i) _pay(bytes32(i + 100), 5_000 * ONE); // another 100k
        vm.prank(op);
        vault.queue(address(usdc), attacker, 50_000 * ONE, "qb");
        assertEq(usdc.balanceOf(attacker), 200_000 * ONE);
        (,, uint128 a,,,) = vault.queued("qa");
        (,, uint128 b,,,) = vault.queued("qb");
        assertEq(uint256(a) + b, 100_000 * ONE);
    }

    /// Cancel does not give the queue budget back (conservative): a legitimate re-queue after an
    /// admin cancel must wait for tomorrow if the day's budget was used.
    function test_review2_cancelDoesNotRefundQueueBudget() public {
        vm.prank(op);
        vault.queue(address(usdc), attacker, 50_000 * ONE, "bad");
        vm.prank(admin);
        vault.cancel("bad");
        vm.prank(op);
        vm.expectRevert();
        vault.queue(address(usdc), makeAddr("legit"), 10_000 * ONE, "legit-new-ref");
    }

    /// Gas: total paymaster pull per day = standing allowance + gasPerDay. Holds through payout() top-ups too.
    function test_review2_gasPullBoundedThroughPayoutTopUps() public {
        uint256 pulled;
        for (uint256 i; i < 30; ++i) {
            uint256 a = usdc.allowance(address(vault), paymaster);
            if (a > 0) {
                vm.prank(paymaster);
                usdc.transferFrom(address(vault), paymaster, a);
                pulled += a;
            }
            _pay(bytes32(i + 1000), ONE); // payout() tops up non-strictly
        }
        assertLe(pulled, 250 * ONE);
        assertGe(pulled, 200 * ONE); // and the budget is actually usable
    }

    /// FIXED: a gas budget smaller than the standing allowance is refused, so top-ups can't brick silently.
    function test_review2_gasPerDayBelowAllowanceRejected() public {
        address[] memory ops = new address[](1);
        ops[0] = op;
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.BadGasConfig.selector, uint128(50 * ONE), uint128(20 * ONE)));
        new RiftPayoutVault(admin, ops, 24 hours, toks, 5_000 * ONE, 100_000 * ONE, 50_000 * ONE, address(ep), paymaster, 50 * ONE, 20 * ONE);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.BadGasConfig.selector, uint128(50 * ONE), uint128(20 * ONE)));
        vault.setGasPaymaster(paymaster, 50 * ONE, 20 * ONE);
    }

    /// FIXED: switching paymaster revokes the old one's allowance and approves the new one.
    function test_review2_oldPaymasterRevokedOnSwitch() public {
        address np = makeAddr("newPaymaster");
        vm.prank(admin);
        vault.setGasPaymaster(np, 50 * ONE, 200 * ONE);
        assertEq(usdc.allowance(address(vault), paymaster), 0);
        assertEq(usdc.allowance(address(vault), np), 50 * ONE);
    }

    /// queuePerDay = 0 disables queueing entirely; lowering it mid-day below what was used blocks further queues.
    function test_review2_queuePerDayEdges() public {
        vm.prank(op);
        vault.queue(address(usdc), attacker, 30_000 * ONE, "a");
        vm.prank(admin);
        vault.setLimits(address(usdc), 5_000 * ONE, 100_000 * ONE, 10_000 * ONE);
        vm.prank(op);
        vm.expectRevert();
        vault.queue(address(usdc), attacker, ONE, "b");
        vm.prank(admin);
        vault.setLimits(address(usdc), 5_000 * ONE, 100_000 * ONE, 0);
        vm.warp(block.timestamp + 2 days);
        vm.prank(op);
        vm.expectRevert();
        vault.queue(address(usdc), attacker, ONE, "c");
    }
}
