import { CircuitBreaker, RateLimiter } from './utils';

// Shared rate limiter and circuit breakers for all routers.
const rateLimiter = new RateLimiter(1000, 60000); // 1000 requests per minute per IP
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
