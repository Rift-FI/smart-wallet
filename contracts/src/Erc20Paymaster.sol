// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/core/Helpers.sol";
import "@account-abstraction/contracts/core/UserOperationLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title Erc20Paymaster
 * @notice ERC-4337 v0.7 verifying paymaster that accepts ERC-20 tokens for gas.
 *         The token/native exchange rate is supplied by the off-chain backend
 *         in paymasterData per UserOp (signed) — no on-chain price update needed.
 *
 * paymasterData layout (after the 52-byte EntryPoint prefix):
 *   [0..20)    token address                        (20 bytes)
 *   [20..26)   validUntil  (uint48)                 (6 bytes)
 *   [26..32)   validAfter  (uint48)                 (6 bytes)
 *   [32..64)   pricePerNative (uint256)             (32 bytes)
 *   [64..129)  ECDSA signature                      (65 bytes)
 *
 *   pricePerNative = how many smallest token units equal 1 native unit (1e18 wei).
 *     e.g. CELO=$0.32, USDC 6dec → pricePerNative = 320_000.
 *
 * Flow:
 *   1. Off-chain backend fetches CELO/USD, computes pricePerNative.
 *   2. Backend signs (UserOp fields + token + validUntil + validAfter + pricePerNative).
 *   3. validatePaymasterUserOp verifies signature and stashes (sender, token, pricePerNative)
 *      in context.
 *   4. UserOp callData runs (must include `approve(paymaster, ...)` for the token).
 *   5. postOp computes actualTokenCost = actualGasCost * pricePerNative * markup
 *      and pulls it from sender via transferFrom.
 *
 * Deployment checklist:
 *   - Deploy with (entryPoint, verifyingSigner).
 *   - entryPoint.depositTo{value: X}(paymaster) — fund native deposit.
 *   - Optionally addStake.
 *   - setSupportedToken(USDC, true), setSupportedToken(USDT, true).
 */
contract Erc20Paymaster is BasePaymaster {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    using SafeERC20 for IERC20;
    using UserOperationLib for PackedUserOperation;

    // ─── Storage ────────────────────────────────────────────────────────

    /// @notice The trusted backend signer that authorizes UserOps + supplies prices.
    address public verifyingSigner;

    /// @notice Tokens accepted as gas payment.
    mapping(address => bool) public supportedTokens;

    /// @notice Price markup in basis points. 10000 = 100%, 11000 = 110%.
    uint32 public priceMarkup = 11000;

    // ─── Events ─────────────────────────────────────────────────────────

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event TokenSupportUpdated(address indexed token, bool supported);
    event PriceMarkupUpdated(uint32 oldMarkup, uint32 newMarkup);
    event TokensWithdrawn(address indexed token, address indexed to, uint256 amount);
    event GasPaid(address indexed sender, address indexed token, uint256 tokenCharged, uint256 gasCostWei, uint256 pricePerNative);

    // ─── Errors ─────────────────────────────────────────────────────────

    error TokenNotSupported(address token);
    error InvalidPaymasterDataLength(uint256 length);
    error MarkupOutOfRange(uint32 markup);

    // ─── Constructor ────────────────────────────────────────────────────

    constructor(
        IEntryPoint _entryPoint,
        address _verifyingSigner
    ) BasePaymaster(_entryPoint) {
        verifyingSigner = _verifyingSigner;
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setVerifyingSigner(address _signer) external onlyOwner {
        emit SignerUpdated(verifyingSigner, _signer);
        verifyingSigner = _signer;
    }

    function setSupportedToken(address _token, bool _supported) external onlyOwner {
        supportedTokens[_token] = _supported;
        emit TokenSupportUpdated(_token, _supported);
    }

    function setPriceMarkup(uint32 _markup) external onlyOwner {
        if (_markup < 10000 || _markup > 20000) revert MarkupOutOfRange(_markup);
        emit PriceMarkupUpdated(priceMarkup, _markup);
        priceMarkup = _markup;
    }

    function withdrawTokens(address _token, address _to, uint256 _amount) external onlyOwner {
        IERC20(_token).safeTransfer(_to, _amount);
        emit TokensWithdrawn(_token, _to, _amount);
    }

    // ─── View helpers ───────────────────────────────────────────────────

    /**
     * @notice Calculate token cost for a given native gas cost using a supplied price.
     * @param _gasCostInWei  Gas cost in native wei.
     * @param _pricePerNative Smallest token units per 1 native unit (1e18 wei).
     */
    function getTokenCostForGas(uint256 _gasCostInWei, uint256 _pricePerNative) public view returns (uint256) {
        return (_gasCostInWei * _pricePerNative * priceMarkup) / (1e18 * 10000);
    }

    /**
     * @notice Compute the hash the backend must sign.
     *         Binds signature to the UserOp fields, this paymaster, the token,
     *         the validity window, AND the price-per-native.
     */
    function getHash(
        PackedUserOperation calldata userOp,
        address token,
        uint48 validUntil,
        uint48 validAfter,
        uint256 pricePerNative
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            userOp.sender,
            userOp.nonce,
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            block.chainid,
            address(this),
            token,
            validUntil,
            validAfter,
            pricePerNative
        ));
    }

    // ─── Core paymaster logic ───────────────────────────────────────────

    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 /*maxCost*/
    ) internal view override returns (bytes memory context, uint256 validationData) {
        bytes calldata data = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        if (data.length < 129) revert InvalidPaymasterDataLength(data.length);

        address token         = address(bytes20(data[0:20]));
        uint48 validUntil     = uint48(bytes6(data[20:26]));
        uint48 validAfter     = uint48(bytes6(data[26:32]));
        uint256 pricePerNative = uint256(bytes32(data[32:64]));
        bytes calldata signature = data[64:129];

        if (!supportedTokens[token]) revert TokenNotSupported(token);

        bytes32 hash = getHash(userOp, token, validUntil, validAfter, pricePerNative);
        if (hash.toEthSignedMessageHash().recover(signature) != verifyingSigner) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        context = abi.encode(userOp.sender, token, pricePerNative);
        validationData = _packValidationData(false, validUntil, validAfter);
    }

    function _postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /*actualUserOpFeePerGas*/
    ) internal override {
        (address sender, address token, uint256 pricePerNative) = abi.decode(context, (address, address, uint256));

        uint256 actualTokenCost = getTokenCostForGas(actualGasCost, pricePerNative);

        IERC20(token).safeTransferFrom(sender, address(this), actualTokenCost);

        emit GasPaid(sender, token, actualTokenCost, actualGasCost, pricePerNative);
    }
}
