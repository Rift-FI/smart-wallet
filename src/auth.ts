/**
 * Internal service auth (spec §2f): every route except the health check
 * requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`. Only Rift's
 * backend calls this service.
 *
 * Fails closed: if INTERNAL_SERVICE_TOKEN is unset, protected routes
 * return 503 instead of running unauthenticated.
 */

import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

const PUBLIC_PATHS = new Set(["/health"]);

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS" || PUBLIC_PATHS.has(req.path)) return next();

  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (!expected) {
    res.status(503).json({
      success: false,
      error: "CONFIGURATION_ERROR",
      message: "INTERNAL_SERVICE_TOKEN is not configured on the smart-wallet service",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !tokensEqual(match[1]!.trim(), expected)) {
    res.status(401).json({
      success: false,
      error: "UNAUTHORIZED",
      message: "missing or invalid internal service token",
      timestamp: new Date().toISOString(),
    });
    return;
  }
  next();
}
