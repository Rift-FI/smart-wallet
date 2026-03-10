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
 * @title LiskPaymaster
 * @notice ERC-4337 v0.7 Verifying Paymaster that accepts ERC-20 tokens (USDC/USDT) for gas on Lisk.
 *
 * Flow:
 *   1. Backend signs a paymaster authorization for the UserOp (off-chain).
 *   2. validatePaymasterUserOp verifies the signature and records token + sender in context.
 *   3. The UserOp's callData executes (which must include `approve(paymaster, ...)` for the token).
 *   4. postOp pulls the actual gas cost in tokens from the sender.
 *
 * Deployment checklist:
 *   - Deploy this contract on Lisk (chainId 1135).
 *   - Call entryPoint.depositTo{value: X}(address(this)) to fund the paymaster's ETH deposit.
 *   - Call addStake{value: Y}(unstakeDelaySec) to stake with the EntryPoint.
 *   - Call configureToken() for each supported token (USDC, USDT).
 *   - Set the verifying signer via setVerifyingSigner().
 *
 * Dependencies:
 *   account-abstraction v0.7 (eth-infinitism)
 *   openzeppelin-contracts v5.x
 */
contract LiskPaymaster is BasePaymaster {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    using SafeERC20 for IERC20;
    using UserOperationLib for PackedUserOperation;

    // ─── Storage ────────────────────────────────────────────────────────

    /// @notice The trusted backend signer that authorizes UserOps.
    address public verifyingSigner;

    struct TokenConfig {
        bool supported;
        uint8 decimals;         // token decimals (6 for USDC/USDT)
        uint256 pricePerEth;    // how many token-units equal 1 ETH (1e18 wei)
                                // e.g. ETH=$2500, USDC 6 dec → pricePerEth = 2500 * 1e6 = 2_500_000_000
    }

    /// @notice Per-token configuration.
    mapping(address => TokenConfig) public tokenConfigs;

    /// @notice Price markup in basis points. 10000 = 100%, 11000 = 110%.
    uint32 public priceMarkup = 11000; // 10% safety margin

    // ─── Events ─────────────────────────────────────────────────────────

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event TokenConfigured(address indexed token, uint8 decimals, uint256 pricePerEth);
    event TokenRemoved(address indexed token);
    event PriceMarkupUpdated(uint32 oldMarkup, uint32 newMarkup);
    event TokensWithdrawn(address indexed token, address indexed to, uint256 amount);
    event GasPaid(address indexed sender, address indexed token, uint256 tokenCharged, uint256 gasCostWei);

    // ─── Errors ─────────────────────────────────────────────────────────

    error TokenNotSupported(address token);
    error InvalidPaymasterDataLength(uint256 length);
    error InvalidSignature();
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

    /**
     * @notice Configure a token for gas payment.
     * @param _token       Token contract address.
     * @param _decimals    Token decimals (6 for USDC/USDT).
     * @param _pricePerEth How many smallest-token-units equal 1 ETH.
     *                     Example: ETH = $2 500, USDC (6 dec) → 2500 * 1e6 = 2_500_000_000
     */
    function configureToken(address _token, uint8 _decimals, uint256 _pricePerEth) external onlyOwner {
        tokenConfigs[_token] = TokenConfig({
            supported: true,
            decimals: _decimals,
            pricePerEth: _pricePerEth
        });
        emit TokenConfigured(_token, _decimals, _pricePerEth);
    }

    function removeToken(address _token) external onlyOwner {
        delete tokenConfigs[_token];
        emit TokenRemoved(_token);
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
     * @notice Calculate token cost for a given native gas cost.
     * @param _token          Token address.
     * @param _gasCostInWei   Gas cost in native wei.
     * @return tokenAmount    Amount of token to charge.
     */
    function getTokenCostForGas(address _token, uint256 _gasCostInWei) public view returns (uint256) {
        TokenConfig memory cfg = tokenConfigs[_token];
        if (!cfg.supported) revert TokenNotSupported(_token);

        // tokenAmount = gasCostInWei * pricePerEth / 1e18
        // Then apply markup: * priceMarkup / 10000
        uint256 cost = (_gasCostInWei * cfg.pricePerEth * priceMarkup) / (1e18 * 10000);
        return cost;
    }

    // ─── Core paymaster logic ───────────────────────────────────────────

    /**
     * @dev Compute the hash the backend must sign.
     *      Binds signature to: the exact UserOp fields, this paymaster, the token, and validity window.
     */
    function getHash(
        PackedUserOperation calldata userOp,
        address token,
        uint48 validUntil,
        uint48 validAfter
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
            validAfter
        ));
    }

    /**
     * @dev Validate the paymaster signature and return context for postOp.
     *
     * paymasterData layout (after the 52-byte prefix parsed by EntryPoint):
     *   [0..20)   token address
     *   [20..26)  validUntil  (uint48)
     *   [26..32)  validAfter  (uint48)
     *   [32..97)  ECDSA signature (65 bytes)
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 maxCost
    ) internal view override returns (bytes memory context, uint256 validationData) {
        bytes calldata data = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        if (data.length < 97) revert InvalidPaymasterDataLength(data.length);

        address token  = address(bytes20(data[0:20]));
        uint48 validUntil = uint48(bytes6(data[20:26]));
        uint48 validAfter = uint48(bytes6(data[26:32]));
        bytes calldata signature = data[32:97];

        if (!tokenConfigs[token].supported) revert TokenNotSupported(token);

        // Verify backend signature
        bytes32 hash = getHash(userOp, token, validUntil, validAfter);
        if (hash.toEthSignedMessageHash().recover(signature) != verifyingSigner) {
            // Return SIG_VALIDATION_FAILED (1) — EntryPoint will reject
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        // Pre-compute max token charge (used in postOp for refund calc)
        uint256 maxTokenCost = getTokenCostForGas(token, maxCost);

        // Return context for postOp — we DON'T pull tokens here.
        // Tokens are pulled in postOp AFTER the callData executes (which includes the approve).
        context = abi.encode(userOp.sender, token, maxTokenCost);
        validationData = _packValidationData(false, validUntil, validAfter);
    }

    /**
     * @dev Pull actual token cost from sender. Runs after callData (approve) has executed.
     */
    function _postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /*actualUserOpFeePerGas*/
    ) internal override {
        (address sender, address token, ) = abi.decode(context, (address, address, uint256));

        uint256 actualTokenCost = getTokenCostForGas(token, actualGasCost);

        // Pull tokens from the smart wallet (approval was set in callData)
        IERC20(token).safeTransferFrom(sender, address(this), actualTokenCost);

        emit GasPaid(sender, token, actualTokenCost, actualGasCost);
    }
}
