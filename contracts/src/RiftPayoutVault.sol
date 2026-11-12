// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IAccount} from "@account-abstraction/contracts/interfaces/IAccount.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

/**
 * @title RiftPayoutVault
 * @notice Holds Rift's stablecoin liquidity on one chain and pays it out
 *         automatically: Rift-run onramp releases (GHS / TZS / MWK), refunds,
 *         LP withdrawals, float top-ups and treasury sweeps.
 *
 * Roles
 *   admin (owner, cold key)  sets limits and the delay, adds / removes
 *                            operators, unpauses, cancels queued transfers.
 *                            Rarely used. Changing the admin is two-step
 *                            with a waiting period (OZ DefaultAdminRules).
 *   operator (backend keys)  pays out within limits, queues larger transfers,
 *                            and can pause in an emergency. Many operator
 *                            keys can send in parallel (each has its own nonce),
 *                            and each call can pay a whole batch.
 *
 * Gasless (ERC-4337): the vault is its own smart account. Operator keys only
 * SIGN user operations (no ETH anywhere); a bundler submits them through the
 * EntryPoint, and gas is paid in the vault's own USDC via an ERC-20 paymaster
 * (Pimlico's). validateUserOp accepts an operation only if an operator signed
 * it AND it calls payout / queue / execute / pause / refreshGasAllowance, so a
 * user operation can never do more than an operator could directly. The
 * paymaster can pull at most `gasAllowance` (capped at MAX_GAS_ALLOWANCE).
 *
 * Deployment: one transaction per chain through the standard CREATE2 factory,
 * with identical constructor arguments everywhere, so the vault has the same
 * address on every chain and needs no follow-up setup. The token list holds
 * USDC + USDT for every supported chain; on a given chain the other chains'
 * addresses are inert (the vault never holds them, so nothing can be paid).
 *
 * Safety
 *   - Only allow-listed tokens (perDay > 0) can be paid out.
 *   - Per-payout cap and a per-UTC-day cap per token for instant payouts.
 *   - Anything above the per-payout cap goes through queue(): it can only be
 *     executed after `delay` (>= MIN_DELAY), only by Rift (operators / admin),
 *     and the admin can cancel it. Queued amounts have their own per-UTC-day
 *     cap per token (queuePerDay), so one stolen operator key can queue at
 *     most that much per day, and every queued transfer can be cancelled.
 *   - Gas: the paymaster's standing allowance is topped up at most `gasPerDay`
 *     per UTC day in total (<= MAX_GAS_PER_DAY), so gas spend is bounded per
 *     day, not just per top-up.
 *   - Every payout carries a `ref` (the order id). A ref is paid at most once:
 *     a batch skips refs already used (emits Skipped) instead of paying twice,
 *     so a retried batch after an unclear result can never double pay.
 */
contract RiftPayoutVault is IAccount, AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// Queued transfers wait at least this long, whatever the admin sets.
    uint64 public constant MIN_DELAY = 1 hours;
    /// Admin changes wait this long before the new admin can take over.
    uint48 public constant ADMIN_TRANSFER_DELAY = 2 days;
    /// Most the gas paymaster may ever be allowed to pull (6-decimal stablecoins: 1,000 USD).
    uint128 public constant MAX_GAS_ALLOWANCE = 1_000e6;
    /// Most the paymaster allowance may be topped up in one UTC day, in total.
    uint128 public constant MAX_GAS_PER_DAY = 1_000e6;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    /// ERC-4337 EntryPoint (v0.7) allowed to run operator-signed operations.
    address public immutable ENTRY_POINT;

    struct Limits {
        uint128 perPayout; // largest single instant payout (token units)
        uint128 perDay; // total instant payouts per UTC day; 0 = token not allowed
        uint128 queuePerDay; // total queued (delayed) transfers per UTC day; 0 = no queueing
    }

    struct Payment {
        address to;
        uint128 amount;
        bytes32 ref;
    }

    struct Queued {
        address token;
        address to;
        uint128 amount;
        uint64 readyAt;
        bool executed;
        bool cancelled;
    }

    mapping(address token => Limits) public limits;
    /// token => UTC day number => amount paid instantly that day
    mapping(address token => mapping(uint256 day => uint256)) public spentOnDay;
    /// ref => already paid or queued (never reusable, even after a cancel)
    mapping(bytes32 ref => bool) public refUsed;
    mapping(bytes32 ref => Queued) public queued;
    uint64 public delay;
    /// ERC-20 paymaster that charges this vault's stablecoin for gas.
    address public gasPaymaster;
    /// Standing allowance kept for the paymaster per token.
    uint128 public gasAllowance;
    /// Total allowance top-ups allowed per UTC day (all tokens together).
    uint128 public gasPerDay;
    /// UTC day number => allowance granted to the paymaster that day by top-ups
    mapping(uint256 day => uint256) public gasToppedUpOnDay;
    /// token => UTC day number => amount queued that day
    mapping(address token => mapping(uint256 day => uint256)) public queuedOnDay;

    event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount, address operator);
    event Skipped(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event TransferQueued(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount, uint64 readyAt, address operator);
    event QueuedExecuted(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event QueuedCancelled(bytes32 indexed ref);
    event LimitsSet(address indexed token, uint128 perPayout, uint128 perDay, uint128 queuePerDay);
    event DelaySet(uint64 delay);
    event GasPaymasterSet(address paymaster, uint128 allowance, uint128 gasPerDay);

    error EmptyBatch();
    error TokenNotAllowed(address token);
    error ZeroAddress();
    error ZeroAmount();
    error ZeroRef();
    error OverPerPayout(bytes32 ref, uint256 amount, uint256 cap);
    error OverDailyLimit(address token, uint256 wouldBe, uint256 cap);
    error RefAlreadyUsed(bytes32 ref);
    error NotQueued(bytes32 ref);
    error NotReady(bytes32 ref, uint64 readyAt);
    error AlreadyFinalised(bytes32 ref);
    error DelayTooShort(uint64 delay);
    error BadLimits();
    error NoNativeToken();
    error NotOperator();
    error NotEntryPoint();
    error AllowanceTooHigh(uint128 allowance);
    error OverQueueDailyLimit(address token, uint256 wouldBe, uint256 cap);
    error GasBudgetExhausted(uint256 wouldBe, uint256 cap);

    constructor(
        address admin,
        address[] memory operators,
        uint64 initialDelay,
        address[] memory tokens,
        uint128 perPayout,
        uint128 perDay,
        uint128 queuePerDay,
        address entryPoint,
        address paymaster,
        uint128 paymasterAllowance,
        uint128 paymasterPerDay
    ) AccessControlDefaultAdminRules(ADMIN_TRANSFER_DELAY, admin) {
        if (admin == address(0) || entryPoint == address(0)) revert ZeroAddress();
        if (paymasterAllowance > MAX_GAS_ALLOWANCE) revert AllowanceTooHigh(paymasterAllowance);
        if (paymasterPerDay > MAX_GAS_PER_DAY) revert AllowanceTooHigh(paymasterPerDay);
        ENTRY_POINT = entryPoint;
        gasPaymaster = paymaster;
        gasAllowance = paymasterAllowance;
        gasPerDay = paymasterPerDay;
        emit GasPaymasterSet(paymaster, paymasterAllowance, paymasterPerDay);
        if (initialDelay < MIN_DELAY) revert DelayTooShort(initialDelay);
        delay = initialDelay;
        emit DelaySet(initialDelay);
        for (uint256 i; i < operators.length; ++i) {
            if (operators[i] == address(0)) revert ZeroAddress();
            _grantRole(OPERATOR_ROLE, operators[i]);
        }
        for (uint256 i; i < tokens.length; ++i) {
            _setLimits(tokens[i], perPayout, perDay, queuePerDay);
            // Initial standing allowance (not counted against the daily top-up budget).
            // Tokens listed for other chains have no code here; skip them.
            if (paymaster != address(0) && tokens[i].code.length > 0) {
                IERC20(tokens[i]).forceApprove(paymaster, paymasterAllowance);
            }
        }
    }

    modifier onlyOperatorOrEntryPoint() {
        if (msg.sender != ENTRY_POINT && !hasRole(OPERATOR_ROLE, msg.sender)) revert NotOperator();
        _;
    }

    // ─── ERC-4337 ────────────────────────────────────────────────────────

    /// Accept an operation only if an operator signed it and it calls an operator function.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData)
    {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        validationData = _isOperatorCall(userOp.callData) && _signedByOperator(userOpHash, userOp.signature)
            ? 0
            : SIG_VALIDATION_FAILED;
        if (missingAccountFunds > 0) {
            // Only without a paymaster; the vault normally holds no ETH, so this just fails the op.
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
    }

    function _isOperatorCall(bytes calldata callData) internal pure returns (bool) {
        if (callData.length < 4) return false;
        bytes4 sel = bytes4(callData[:4]);
        return sel == this.payout.selector || sel == this.queue.selector || sel == this.execute.selector
            || sel == this.pause.selector || sel == this.refreshGasAllowance.selector;
    }

    function _signedByOperator(bytes32 userOpHash, bytes calldata signature) internal view returns (bool) {
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(userOpHash), signature);
        return err == ECDSA.RecoverError.NoError && hasRole(OPERATOR_ROLE, signer);
    }

    // ─── Payouts ─────────────────────────────────────────────────────────

    /**
     * Pay a batch instantly. Refs already used are skipped (Skipped event),
     * never paid twice. Reverts the whole batch on any other problem
     * (cap exceeded, bad address, not enough balance), so nothing half-pays.
     */
    function payout(address token, Payment[] calldata payments)
        external
        onlyOperatorOrEntryPoint
        whenNotPaused
        nonReentrant
        returns (uint256 paidCount, uint256 paidTotal)
    {
        if (payments.length == 0) revert EmptyBatch();
        Limits memory l = limits[token];
        if (l.perDay == 0) revert TokenNotAllowed(token);

        for (uint256 i; i < payments.length; ++i) {
            Payment calldata p = payments[i];
            if (p.ref == bytes32(0)) revert ZeroRef();
            if (p.to == address(0)) revert ZeroAddress();
            if (p.amount == 0) revert ZeroAmount();
            if (refUsed[p.ref]) {
                emit Skipped(p.ref, token, p.to, p.amount);
                continue;
            }
            if (p.amount > l.perPayout) revert OverPerPayout(p.ref, p.amount, l.perPayout);
            refUsed[p.ref] = true;
            paidTotal += p.amount;
            ++paidCount;
            IERC20(token).safeTransfer(p.to, p.amount);
            emit Paid(p.ref, token, p.to, p.amount, msg.sender);
        }

        if (paidTotal > 0) {
            uint256 day = block.timestamp / 1 days;
            uint256 wouldBe = spentOnDay[token][day] + paidTotal;
            if (wouldBe > l.perDay) revert OverDailyLimit(token, wouldBe, l.perDay);
            spentOnDay[token][day] = wouldBe;
        }
        // Keep the gas paymaster's standing allowance topped up (bounded by gasAllowance).
        if (gasPaymaster != address(0) && IERC20(token).allowance(address(this), gasPaymaster) < gasAllowance / 2) {
            _approveGas(token, false);
        }
    }

    /// Queue a transfer of any size; it can be executed after `delay` unless the admin cancels it.
    function queue(address token, address to, uint128 amount, bytes32 ref) external onlyOperatorOrEntryPoint whenNotPaused {
        if (limits[token].perDay == 0) revert TokenNotAllowed(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ref == bytes32(0)) revert ZeroRef();
        if (refUsed[ref]) revert RefAlreadyUsed(ref);
        uint256 day = block.timestamp / 1 days;
        uint256 wouldBe = queuedOnDay[token][day] + amount;
        uint256 cap = limits[token].queuePerDay;
        if (wouldBe > cap) revert OverQueueDailyLimit(token, wouldBe, cap);
        queuedOnDay[token][day] = wouldBe;
        refUsed[ref] = true;
        uint64 readyAt = uint64(block.timestamp) + delay;
        queued[ref] = Queued({token: token, to: to, amount: amount, readyAt: readyAt, executed: false, cancelled: false});
        emit TransferQueued(ref, token, to, amount, readyAt, msg.sender);
    }

    /// Rift (an operator, the EntryPoint on an operator's behalf, or the admin) executes a ready transfer.
    function execute(bytes32 ref) external whenNotPaused nonReentrant {
        if (msg.sender != ENTRY_POINT && !hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotOperator();
        }
        Queued storage q = queued[ref];
        if (q.readyAt == 0) revert NotQueued(ref);
        if (q.executed || q.cancelled) revert AlreadyFinalised(ref);
        if (block.timestamp < q.readyAt) revert NotReady(ref, q.readyAt);
        q.executed = true;
        IERC20(q.token).safeTransfer(q.to, q.amount);
        emit QueuedExecuted(ref, q.token, q.to, q.amount);
    }

    /// Admin stops a queued transfer. The ref stays used; a legitimate retry needs a new ref.
    function cancel(bytes32 ref) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Queued storage q = queued[ref];
        if (q.readyAt == 0) revert NotQueued(ref);
        if (q.executed || q.cancelled) revert AlreadyFinalised(ref);
        q.cancelled = true;
        emit QueuedCancelled(ref);
    }

    // ─── Emergency ───────────────────────────────────────────────────────

    /// Operators (e.g. a monitoring bot) or the admin can stop everything at once.
    function pause() external {
        if (msg.sender != ENTRY_POINT && !hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, OPERATOR_ROLE);
        }
        _pause();
    }

    /// Only the admin can resume.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ─── Configuration ───────────────────────────────────────────────────

    /// Admin lists / re-limits a token (perDay = 0 delists it; queuePerDay = 0 disables queueing).
    function setLimits(address token, uint128 perPayout, uint128 perDay, uint128 queuePerDay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setLimits(token, perPayout, perDay, queuePerDay);
    }

    function _setLimits(address token, uint128 perPayout, uint128 perDay, uint128 queuePerDay) internal {
        if (token == address(0)) revert ZeroAddress();
        if (perPayout > perDay) revert BadLimits();
        limits[token] = Limits({perPayout: perPayout, perDay: perDay, queuePerDay: queuePerDay});
        emit LimitsSet(token, perPayout, perDay, queuePerDay);
    }

    /// Re-approve the gas paymaster up to `gasAllowance` for a listed token.
    function refreshGasAllowance(address token) external onlyOperatorOrEntryPoint {
        if (limits[token].perDay == 0) revert TokenNotAllowed(token);
        _approveGas(token, true);
    }

    /// Admin switches the gas paymaster (zero address turns gasless off).
    function setGasPaymaster(address paymaster, uint128 allowance, uint128 perDay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (allowance > MAX_GAS_ALLOWANCE) revert AllowanceTooHigh(allowance);
        if (perDay > MAX_GAS_PER_DAY) revert AllowanceTooHigh(perDay);
        gasPaymaster = paymaster;
        gasAllowance = allowance;
        gasPerDay = perDay;
        emit GasPaymasterSet(paymaster, allowance, perDay);
    }

    /// Top the paymaster back up to `gasAllowance`, counting the top-up against today's gas budget.
    /// strict: revert when over budget; otherwise skip quietly (payouts must not fail over gas top-ups).
    function _approveGas(address token, bool strict) internal {
        if (gasPaymaster == address(0)) return;
        uint256 current = IERC20(token).allowance(address(this), gasPaymaster);
        if (current >= gasAllowance) return;
        uint256 topUp = gasAllowance - current;
        uint256 day = block.timestamp / 1 days;
        uint256 wouldBe = gasToppedUpOnDay[day] + topUp;
        if (wouldBe > gasPerDay) {
            if (strict) revert GasBudgetExhausted(wouldBe, gasPerDay);
            return;
        }
        gasToppedUpOnDay[day] = wouldBe;
        IERC20(token).forceApprove(gasPaymaster, gasAllowance);
    }

    function setDelay(uint64 newDelay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newDelay < MIN_DELAY) revert DelayTooShort(newDelay);
        delay = newDelay;
        emit DelaySet(newDelay);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// How much more can be paid instantly today for `token`.
    function remainingToday(address token) external view returns (uint256) {
        uint256 cap = limits[token].perDay;
        uint256 spent = spentOnDay[token][block.timestamp / 1 days];
        return spent >= cap ? 0 : cap - spent;
    }

    receive() external payable {
        revert NoNativeToken();
    }
}
