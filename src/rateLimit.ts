import { CircuitBreaker, RateLimiter } from './utils';

// Shared rate limiter and circuit breakers for all routers.
// Every caller is the Rift backend (requireInternalToken), so all users share
// one IP here. 1000/min per IP throttled every user at once (WalletConnect
// pair/sessions and fee estimates 429ed). This is only a runaway guard.
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 20000;
const rateLimiter = new RateLimiter(RATE_LIMIT_PER_MIN, 60000);
export const paymasterCircuitBreaker = new CircuitBreaker(5, 30000); // 5 failures, 30s timeout
export const rpcCircuitBreaker = new CircuitBreaker(3, 60000); // 3 failures, 60s timeout

// Loosely typed on purpose: route handlers keep their inferred return types.
export const checkRateLimit = (req: any, res: any, next: any) => {
  const clientIP = req.ip || req.socket.remoteAddress || 'unknown';

  if (!rateLimiter.isAllowed(clientIP)) {
    return res.status(429).json({
      success: false,
      error: 'Rate Limit Exceeded',
      message: 'Too many requests. Please try again later.',
      timestamp: new Date().toISOString(),
    });
  }

  return next();
};
