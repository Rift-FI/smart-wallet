// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RiftPayoutVault} from "../src/RiftPayoutVault.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract RiftPayoutVaultTest is Test {
    RiftPayoutVault vault;
    MockUSDC usdc;
    MockUSDC other;

    address admin = makeAddr("admin");
    address op1 = makeAddr("op1");
    address op2 = makeAddr("op2");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    uint128 constant ONE = 1e6; // 1 USDC
    uint128 constant PER_PAYOUT = 5_000 * ONE;
    uint128 constant PER_DAY = 50_000 * ONE;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        other = new MockUSDC();
        address[] memory ops = new address[](2);
        ops[0] = op1;
        ops[1] = op2;
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        vault = new RiftPayoutVault(admin, ops, 24 hours, toks, PER_PAYOUT, PER_DAY);
        usdc.mint(address(vault), 1_000_000 * ONE);
    }

    function _one(address to, uint128 amount, bytes32 ref) internal pure returns (RiftPayoutVault.Payment[] memory ps) {
        ps = new RiftPayoutVault.Payment[](1);
        ps[0] = RiftPayoutVault.Payment({to: to, amount: amount, ref: ref});
    }

    // ── payouts ──────────────────────────────────────────────────────

    function test_batchPaysEveryone() public {
        RiftPayoutVault.Payment[] memory ps = new RiftPayoutVault.Payment[](2);
        ps[0] = RiftPayoutVault.Payment({to: alice, amount: 100 * ONE, ref: "order-1"});
        ps[1] = RiftPayoutVault.Payment({to: bob, amount: 250 * ONE, ref: "order-2"});
        vm.prank(op1);
        (uint256 n, uint256 total) = vault.payout(address(usdc), ps);
        assertEq(n, 2);
        assertEq(total, 350 * ONE);
        assertEq(usdc.balanceOf(alice), 100 * ONE);
        assertEq(usdc.balanceOf(bob), 250 * ONE);
        assertTrue(vault.refUsed("order-1"));
        assertEq(vault.remainingToday(address(usdc)), PER_DAY - 350 * ONE);
    }

    function test_sameRefNeverPaysTwice_retryIsSkipped() public {
        vm.prank(op1);
        vault.payout(address(usdc), _one(alice, 100 * ONE, "order-1"));
        // Retry of the same order (e.g. after an unclear result) from another operator.
        vm.expectEmit(true, true, true, true);
        emit RiftPayoutVault.Skipped("order-1", address(usdc), alice, 100 * ONE);
        vm.prank(op2);
        (uint256 n,) = vault.payout(address(usdc), _one(alice, 100 * ONE, "order-1"));
        assertEq(n, 0);
        assertEq(usdc.balanceOf(alice), 100 * ONE);
    }

    function test_duplicateRefInsideOneBatchPaysOnce() public {
        RiftPayoutVault.Payment[] memory ps = new RiftPayoutVault.Payment[](2);
        ps[0] = RiftPayoutVault.Payment({to: alice, amount: 100 * ONE, ref: "dup"});
        ps[1] = RiftPayoutVault.Payment({to: alice, amount: 100 * ONE, ref: "dup"});
        vm.prank(op1);
        vault.payout(address(usdc), ps);
        assertEq(usdc.balanceOf(alice), 100 * ONE);
    }

    function test_overPerPayoutRevertsWholeBatch() public {
        RiftPayoutVault.Payment[] memory ps = new RiftPayoutVault.Payment[](2);
        ps[0] = RiftPayoutVault.Payment({to: alice, amount: 100 * ONE, ref: "a"});
        ps[1] = RiftPayoutVault.Payment({to: bob, amount: PER_PAYOUT + 1, ref: "b"});
        vm.prank(op1);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.OverPerPayout.selector, bytes32("b"), uint256(PER_PAYOUT + 1), uint256(PER_PAYOUT)));
        vault.payout(address(usdc), ps);
        assertEq(usdc.balanceOf(alice), 0);
        assertFalse(vault.refUsed("a"));
    }

    function test_dailyCapEnforced_andResetsNextDay() public {
        RiftPayoutVault.Payment[] memory ps = new RiftPayoutVault.Payment[](10);
        for (uint256 i; i < 10; ++i) ps[i] = RiftPayoutVault.Payment({to: alice, amount: PER_PAYOUT, ref: bytes32(i + 1)});
        vm.prank(op1);
        vault.payout(address(usdc), ps); // exactly 50k
        assertEq(vault.remainingToday(address(usdc)), 0);
        vm.prank(op1);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.OverDailyLimit.selector, address(usdc), uint256(PER_DAY + ONE), uint256(PER_DAY)));
        vault.payout(address(usdc), _one(bob, ONE, "next"));
        vm.warp(block.timestamp + 1 days);
        vm.prank(op1);
        vault.payout(address(usdc), _one(bob, ONE, "next"));
        assertEq(usdc.balanceOf(bob), ONE);
    }

    function test_onlyOperatorsPay() public {
        bytes32 role = vault.OPERATOR_ROLE();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role));
        vault.payout(address(usdc), _one(stranger, ONE, "x"));
    }

    function test_unlistedTokenRejected() public {
        other.mint(address(vault), 1000 * ONE);
        vm.prank(op1);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.TokenNotAllowed.selector, address(other)));
        vault.payout(address(other), _one(alice, ONE, "x"));
    }

    function test_badInputsRejected() public {
        vm.startPrank(op1);
        vm.expectRevert(RiftPayoutVault.EmptyBatch.selector);
        vault.payout(address(usdc), new RiftPayoutVault.Payment[](0));
        vm.expectRevert(RiftPayoutVault.ZeroRef.selector);
        vault.payout(address(usdc), _one(alice, ONE, bytes32(0)));
        vm.expectRevert(RiftPayoutVault.ZeroAddress.selector);
        vault.payout(address(usdc), _one(address(0), ONE, "x"));
        vm.expectRevert(RiftPayoutVault.ZeroAmount.selector);
        vault.payout(address(usdc), _one(alice, 0, "x"));
        vm.stopPrank();
    }

    function test_insufficientBalanceRevertsNothingPaid() public {
        MockUSDC poor = new MockUSDC();
        vm.prank(admin);
        vault.setLimits(address(poor), PER_PAYOUT, PER_DAY);
        poor.mint(address(vault), 50 * ONE);
        RiftPayoutVault.Payment[] memory ps = new RiftPayoutVault.Payment[](2);
        ps[0] = RiftPayoutVault.Payment({to: alice, amount: 40 * ONE, ref: "a"});
        ps[1] = RiftPayoutVault.Payment({to: bob, amount: 40 * ONE, ref: "b"});
        vm.prank(op1);
        vm.expectRevert();
        vault.payout(address(poor), ps);
        assertEq(poor.balanceOf(alice), 0);
        assertFalse(vault.refUsed("a"));
    }

    // ── queue (big transfers) ────────────────────────────────────────

    function test_bigTransferQueuesThenExecutesAfterDelay() public {
        uint128 big = 200_000 * ONE;
        vm.prank(op1);
        vault.queue(address(usdc), bob, big, "lp-withdraw-1");
        vm.expectRevert();
        vault.execute("lp-withdraw-1");
        vm.warp(block.timestamp + 24 hours);
        vm.prank(stranger); // anyone can execute once ready
        vault.execute("lp-withdraw-1");
        assertEq(usdc.balanceOf(bob), big);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.AlreadyFinalised.selector, bytes32("lp-withdraw-1")));
        vault.execute("lp-withdraw-1");
    }

    function test_adminCancelsQueued_refStaysUsed() public {
        vm.prank(op1);
        vault.queue(address(usdc), stranger, 900_000 * ONE, "suspicious");
        vm.prank(admin);
        vault.cancel("suspicious");
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.AlreadyFinalised.selector, bytes32("suspicious")));
        vault.execute("suspicious");
        assertEq(usdc.balanceOf(stranger), 0);
        vm.prank(op1);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.RefAlreadyUsed.selector, bytes32("suspicious")));
        vault.queue(address(usdc), stranger, ONE, "suspicious");
    }

    function test_operatorCannotCancel() public {
        vm.prank(op1);
        vault.queue(address(usdc), bob, 10 * ONE, "q");
        vm.prank(op1);
        vm.expectRevert();
        vault.cancel("q");
    }

    function test_queuedRefCannotAlsoBePaidInstantly() public {
        vm.prank(op1);
        vault.queue(address(usdc), bob, 10 * ONE, "q");
        vm.prank(op2);
        (uint256 n,) = vault.payout(address(usdc), _one(bob, 10 * ONE, "q"));
        assertEq(n, 0);
    }

    // ── pause ────────────────────────────────────────────────────────

    function test_operatorPauses_onlyAdminUnpauses() public {
        vm.prank(op2);
        vault.pause();
        vm.prank(op1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payout(address(usdc), _one(alice, ONE, "x"));
        vm.prank(op1);
        vm.expectRevert();
        vault.unpause();
        vm.prank(admin);
        vault.unpause();
        vm.prank(op1);
        vault.payout(address(usdc), _one(alice, ONE, "x"));
    }

    function test_pauseBlocksQueuedExecution() public {
        vm.prank(op1);
        vault.queue(address(usdc), bob, 10 * ONE, "q");
        vm.warp(block.timestamp + 24 hours);
        vm.prank(admin);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.execute("q");
    }

    function test_strangerCannotPause() public {
        vm.prank(stranger);
        vm.expectRevert();
        vault.pause();
    }

    // ── configuration ────────────────────────────────────────────────

    function test_constructorListsTokens_onlyAdminChangesLimits() public {
        (uint128 pp, uint128 pd) = vault.limits(address(usdc));
        assertEq(pp, PER_PAYOUT);
        assertEq(pd, PER_DAY);
        vm.prank(op1);
        vm.expectRevert();
        vault.setLimits(address(usdc), 1, 1);
        vm.prank(admin);
        vault.setLimits(address(usdc), 1, 2);
        (pp, pd) = vault.limits(address(usdc));
        assertEq(pp, 1);
        assertEq(pd, 2);
    }

    function test_tokenListedForAnotherChainIsInert() public {
        // An address listed for another chain has no code here: nothing can be paid.
        address foreign = address(0xBEEF);
        vm.prank(admin);
        vault.setLimits(foreign, PER_PAYOUT, PER_DAY);
        vm.prank(op1);
        vm.expectRevert();
        vault.payout(foreign, _one(alice, ONE, "x"));
    }

    function test_limitsMustBeSane() public {
        vm.prank(admin);
        vm.expectRevert(RiftPayoutVault.BadLimits.selector);
        vault.setLimits(address(usdc), 10, 5);
    }

    function test_delayFloor() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.DelayTooShort.selector, uint64(10 minutes)));
        vault.setDelay(10 minutes);
        address[] memory ops = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(RiftPayoutVault.DelayTooShort.selector, uint64(0)));
        new RiftPayoutVault(admin, ops, 0, new address[](0), 1, 1);
    }

    function test_adminManagesOperators() public {
        bytes32 role = vault.OPERATOR_ROLE();
        vm.startPrank(admin);
        vault.revokeRole(role, op1);
        vault.grantRole(role, alice);
        vm.stopPrank();
        vm.prank(op1);
        vm.expectRevert();
        vault.payout(address(usdc), _one(bob, ONE, "x"));
        vm.prank(alice);
        vault.payout(address(usdc), _one(bob, ONE, "x"));
    }

    function test_adminHandoverIsTwoStepWithWait() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        vault.beginDefaultAdminTransfer(newAdmin);
        vm.prank(newAdmin);
        vm.expectRevert();
        vault.acceptDefaultAdminTransfer();
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(newAdmin);
        vault.acceptDefaultAdminTransfer();
        assertEq(vault.defaultAdmin(), newAdmin);
    }

    function test_rejectsNativeToken() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ── scale ────────────────────────────────────────────────────────

    function test_gas_batchOf200() public {
        vm.prank(admin);
        vault.setLimits(address(usdc), PER_PAYOUT, 1_000_000 * ONE);
        RiftPayoutVault.Payment[] memory ps = new RiftPayoutVault.Payment[](200);
        for (uint256 i; i < 200; ++i) {
            ps[i] = RiftPayoutVault.Payment({to: address(uint160(0x1000 + i)), amount: 10 * ONE, ref: bytes32(i + 1000)});
        }
        vm.prank(op1);
        uint256 g = gasleft();
        vault.payout(address(usdc), ps);
        uint256 used = g - gasleft();
        emit log_named_uint("gas for 200 payouts", used);
        emit log_named_uint("gas per payout", used / 200);
        assertLt(used, 15_000_000);
    }

    function testFuzz_neverPaysMoreThanDailyCap(uint128[8] memory amounts) public {
        uint256 total;
        for (uint256 i; i < 8; ++i) {
            uint128 a = uint128(bound(amounts[i], 1, PER_PAYOUT));
            if (total + a > PER_DAY) {
                vm.prank(op1);
                vm.expectRevert();
                vault.payout(address(usdc), _one(alice, a, bytes32(i + 1)));
            } else {
                vm.prank(op1);
                vault.payout(address(usdc), _one(alice, a, bytes32(i + 1)));
                total += a;
            }
        }
        assertEq(usdc.balanceOf(alice), total);
        assertLe(total, PER_DAY);
    }
}
