import { ethers } from "ethers";

/**
 * Check ERC20 token balance for an address
 */
export async function checkTokenBalance(
  tokenAddress: string,
  walletAddress: string,
  provider: ethers.providers.Provider
): Promise<ethers.BigNumber> {
  try {
    const tokenContract = new ethers.Contract(
      tokenAddress,
      [
        "function balanceOf(address owner) view returns (uint256)",
        "function decimals() view returns (uint8)"
      ],
      provider
    );
    
    const balance = await tokenContract.balanceOf(walletAddress);
    return balance;
  } catch (error: any) {
    console.error(`Failed to check token balance:`, error);
    throw new Error(`Failed to check balance: ${error?.message || error}`);
  }
}

/**
 * Get token decimals
 */
export async function getTokenDecimals(
  tokenAddress: string,
  provider: ethers.providers.Provider
): Promise<number> {
  try {
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ["function decimals() view returns (uint8)"],
      provider
    );
    
    const decimals = await tokenContract.decimals();
    return decimals;
  } catch (error: any) {
    console.error(`Failed to get token decimals:`, error);
    // Default to 6 decimals for most stablecoins
    return 6;
  }
}

/**
 * Estimate gas cost in tokens for a transaction (deprecated - using direct transfers now)
 */
export async function estimateGasCostInToken(
  _tokenAddress: string,
  _paymasterRPC: string,
  _mockUserOperation: any
): Promise<{
  gasCostInToken: ethers.BigNumber;
  gasCostInETH: ethers.BigNumber;
  exchangeRate: string;
}> {
  console.log("⚠️ estimateGasCostInToken is deprecated - using direct transfers");
  
  // Return placeholder values
  return {
    gasCostInToken: ethers.BigNumber.from("0"),
    gasCostInETH: ethers.BigNumber.from("0"),
    exchangeRate: "0"
  };
}

/**
 * Format token amount for display
 */
export function formatTokenAmount(
  amount: ethers.BigNumber,
  decimals: number,
  symbol: string = ""
): string {
  const formatted = ethers.utils.formatUnits(amount, decimals);
  return `${parseFloat(formatted).toFixed(6)} ${symbol}`.trim();
}

/**
 * Validate transaction parameters
 */
export function validateTransactionParams(params: {
  chainId?: number;
  tokenAddress?: string;
  amount?: number;
  recipient?: string;
  ownerPrivateKey?: string;
}): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!params.chainId || params.chainId <= 0) {
    errors.push("Invalid chainId");
  }

  if (!params.tokenAddress || !ethers.utils.isAddress(params.tokenAddress)) {
    errors.push("Invalid token address");
  }

  if (!params.amount || params.amount <= 0 || isNaN(params.amount)) {
    errors.push("Invalid amount - must be positive number");
  }

  if (!params.recipient || !ethers.utils.isAddress(params.recipient)) {
    errors.push("Invalid recipient address");
  }

  if (!params.ownerPrivateKey) {
    errors.push("Private key required");
  } else {
    try {
      new ethers.Wallet(params.ownerPrivateKey);
    } catch {
      errors.push("Invalid private key format");
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Rate limiting helper
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 100, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  isAllowed(identifier: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(identifier) || [];
    
    // Remove old requests outside the window
    const validRequests = requests.filter(time => now - time < this.windowMs);
    
    if (validRequests.length >= this.maxRequests) {
      return false;
    }

    // Add current request
    validRequests.push(now);
    this.requests.set(identifier, validRequests);
    
    return true;
  }

  getRemainingRequests(identifier: string): number {
    const now = Date.now();
    const requests = this.requests.get(identifier) || [];
    const validRequests = requests.filter(time => now - time < this.windowMs);
    return Math.max(0, this.maxRequests - validRequests.length);
  }
}

/**
 * Circuit breaker for external service calls
 */
export class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  
  constructor(
    private maxFailures: number = 5,
    private resetTimeoutMs: number = 60000
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN - service unavailable');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.maxFailures) {
      this.state = 'OPEN';
    }
  }

  getState(): string {
    return this.state;
  }
}