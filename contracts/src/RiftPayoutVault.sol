// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
 *     executed after `delay` (>= MIN_DELAY), and the admin can cancel it.
 *   - Every payout carries a `ref` (the order id). A ref is paid at most once:
 *     a batch skips refs already used (emits Skipped) instead of paying twice,
 *     so a retried batch after an unclear result can never double pay.
 */
contract RiftPayoutVault is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// Queued transfers wait at least this long, whatever the admin sets.
    uint64 public constant MIN_DELAY = 1 hours;
    /// Admin changes wait this long before the new admin can take over.
    uint48 public constant ADMIN_TRANSFER_DELAY = 2 days;

    struct Limits {
        uint128 perPayout; // largest single instant payout (token units)
        uint128 perDay; // total instant payouts per UTC day; 0 = token not allowed
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

    event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount, address operator);
    event Skipped(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event TransferQueued(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount, uint64 readyAt, address operator);
    event QueuedExecuted(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event QueuedCancelled(bytes32 indexed ref);
    event LimitsSet(address indexed token, uint128 perPayout, uint128 perDay);
    event DelaySet(uint64 delay);

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

    constructor(
        address admin,
        address[] memory operators,
        uint64 initialDelay,
        address[] memory tokens,
        uint128 perPayout,
        uint128 perDay
    ) AccessControlDefaultAdminRules(ADMIN_TRANSFER_DELAY, admin) {
        if (admin == address(0)) revert ZeroAddress();
        if (initialDelay < MIN_DELAY) revert DelayTooShort(initialDelay);
        delay = initialDelay;
        emit DelaySet(initialDelay);
        for (uint256 i; i < operators.length; ++i) {
            if (operators[i] == address(0)) revert ZeroAddress();
            _grantRole(OPERATOR_ROLE, operators[i]);
        }
        for (uint256 i; i < tokens.length; ++i) _setLimits(tokens[i], perPayout, perDay);
    }

    // ─── Payouts ─────────────────────────────────────────────────────────

    /**
     * Pay a batch instantly. Refs already used are skipped (Skipped event),
     * never paid twice. Reverts the whole batch on any other problem
     * (cap exceeded, bad address, not enough balance), so nothing half-pays.
     */
    function payout(address token, Payment[] calldata payments)
        external
        onlyRole(OPERATOR_ROLE)
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
    }

    /// Queue a transfer of any size; it can be executed after `delay` unless the admin cancels it.
    function queue(address token, address to, uint128 amount, bytes32 ref) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        if (limits[token].perDay == 0) revert TokenNotAllowed(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ref == bytes32(0)) revert ZeroRef();
        if (refUsed[ref]) revert RefAlreadyUsed(ref);
        refUsed[ref] = true;
        uint64 readyAt = uint64(block.timestamp) + delay;
        queued[ref] = Queued({token: token, to: to, amount: amount, readyAt: readyAt, executed: false, cancelled: false});
        emit TransferQueued(ref, token, to, amount, readyAt, msg.sender);
    }

    /// Anyone may execute a queued transfer once it is ready (the backend does it automatically).
    function execute(bytes32 ref) external whenNotPaused nonReentrant {
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
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, OPERATOR_ROLE);
        }
        _pause();
    }

    /// Only the admin can resume.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ─── Configuration ───────────────────────────────────────────────────

    /// Admin lists / re-limits a token (perDay = 0 delists it).
    function setLimits(address token, uint128 perPayout, uint128 perDay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setLimits(token, perPayout, perDay);
    }

    function _setLimits(address token, uint128 perPayout, uint128 perDay) internal {
        if (token == address(0)) revert ZeroAddress();
        if (perPayout > perDay) revert BadLimits();
        limits[token] = Limits({perPayout: perPayout, perDay: perDay});
        emit LimitsSet(token, perPayout, perDay);
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
