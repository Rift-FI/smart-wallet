// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Adversarial review tests (operator-key-compromise and edge cases).
// Each test PASSES when the described weakness is present, so a failing test
// here after a fix means the fix worked (flip the assertion then).

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RiftPayoutVault} from "../src/RiftPayoutVault.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract ReviewUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract RiftPayoutVaultReviewTest is Test {
    RiftPayoutVault vault;
    EntryPoint ep;
    ReviewUSDC usdc;

    address admin = makeAddr("admin");
    uint256 opKey = 0xA11CE;
    address op = vm.addr(opKey);
    address paymaster = makeAddr("paymaster");
    address attacker = makeAddr("attacker");
    address stranger = makeAddr("stranger");

    uint128 constant ONE = 1e6;
    uint128 constant PER_PAYOUT = 5_000 * ONE;
    uint128 constant PER_DAY = 100_000 * ONE;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new ReviewUSDC();
        address[] memory ops = new address[](1);
        ops[0] = op;
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        ep = new EntryPoint();
        // Same parameters as the Base deployment script defaults (24 h delay, 5k / 100k, 50 USDC gas allowance).
        vault = new RiftPayoutVault(admin, ops, 24 hours, toks, PER_PAYOUT, PER_DAY, 50_000 * ONE, address(ep), paymaster, 50 * ONE, 200 * ONE);
        usdc.mint(address(vault), 2_000_000 * ONE);
    }

    function _userOp(bytes memory callData, uint256 signerKey) internal view returns (PackedUserOperation memory o) {
        o = PackedUserOperation({
            sender: address(vault),
            nonce: ep.getNonce(address(vault), 0),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(300_000) << 128) | uint256(500_000)),
            preVerificationGas: 60_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 h = ep.getUserOpHash(o);
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(signerKey, MessageHashUtils.toEthSignedMessageHash(h));
        o.signature = abi.encodePacked(r, s_, v);
    }

    /// FIXED (v3): one operator key can no longer queue the whole vault: queued amounts have a daily cap,
    /// and only Rift can execute. A stolen key gets at most 50,000/day queued, all cancellable for 24 h.
    function test_review_operatorCannotQueueWholeVault() public {
        uint128 all = uint128(usdc.balanceOf(address(vault)));
        vm.prank(op);
        vm.expectRevert();
        vault.queue(address(usdc), attacker, all, keccak256("rift:onramp_order:some-real-order-id"));
        vm.prank(op);
        vault.queue(address(usdc), attacker, 50_000 * ONE, bytes32("max"));
        vm.prank(op);
        vm.expectRevert();
        vault.queue(address(usdc), attacker, ONE, bytes32("one-more"));
        vm.warp(block.timestamp + 24 hours);
        vm.prank(stranger);
        vm.expectRevert(RiftPayoutVault.NotOperator.selector);
        vault.execute(bytes32("max"));
        assertEq(usdc.balanceOf(attacker), 0);
    }

    /// FIXED (v3): the gasless path hits the same queue cap (the inner call reverts, nothing is queued).
    function test_review_queueViaEntryPointIsCapped() public {
        vm.deal(address(this), 1 ether);
        ep.depositTo{value: 1 ether}(address(vault));
        bytes memory c = abi.encodeCall(RiftPayoutVault.queue, (address(usdc), attacker, 1_500_000 * ONE, bytes32("q")));
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _userOp(c, opKey);
        ep.handleOps(ops, payable(makeAddr("bundler")));
        (, , uint128 amount,,,) = vault.queued(bytes32("q"));
        assertEq(amount, 0);
        assertFalse(vault.refUsed(bytes32("q")));
    }

    /// FIXED (v3): a recipient can no longer execute their own queued transfer (e.g. a rejected LP withdrawal).
    function test_review_recipientCannotSelfExecuteQueuedTransfer() public {
        vm.prank(op);
        vault.queue(address(usdc), stranger, 6_000 * ONE, bytes32("lp-w1"));
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(stranger);
        vm.expectRevert(RiftPayoutVault.NotOperator.selector);
        vault.execute(bytes32("lp-w1"));
        assertEq(usdc.balanceOf(stranger), 0);
    }

    /// FIXED (v3): gas allowance top-ups are bounded per day (200 here), not just per top-up.
    function test_review_gasAllowanceRefreshIsBoundedPerDay() public {
        uint256 pulled;
        for (uint256 i; i < 40; ++i) {
            vm.prank(paymaster);
            try usdc.transferFrom(address(vault), paymaster, 50 * ONE) { pulled += 50 * ONE; } catch { break; }
            vm.prank(op);
            try vault.refreshGasAllowance(address(usdc)) {} catch { break; }
        }
        // initial 50 + at most 200 of top-ups
        assertLe(pulled, 250 * ONE);
    }

    /// Short / malformed callData is rejected at validation (no gas spent): selector parsing is safe.
    function test_review_shortCallDataFailsValidation() public {
        PackedUserOperation memory o = _userOp(hex"8456cb", opKey); // 3 bytes
        bytes32 h = ep.getUserOpHash(o);
        vm.prank(address(ep));
        assertEq(vault.validateUserOp(o, h, 0), 1);
    }

    /// An operator-signed op whose inner call reverts is still valid at validation, so gas is charged
    /// (paid in USDC via the paymaster in production). Repeated reverting ops = gas drain.
    function test_review_revertingOpStillConsumesPrefund() public {
        vm.deal(address(this), 1 ether);
        ep.depositTo{value: 1 ether}(address(vault));
        uint256 before = ep.balanceOf(address(vault));
        bytes memory c = abi.encodeCall(RiftPayoutVault.execute, (bytes32("nothing-queued")));
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _userOp(c, opKey);
        ep.handleOps(ops, payable(makeAddr("bundler")));
        assertLt(ep.balanceOf(address(vault)), before);
    }
}
