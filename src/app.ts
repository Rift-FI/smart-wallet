import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

import { config, isDevelopment } from './config';
import { errorHandler, notFoundHandler, requestLogger } from './middleware';
import { requireInternalToken } from './auth';
import routes from './routes';

/** Build the Express app (no listen) — server.ts listens, tests use it directly. */
export function createApp(): express.Express {
  const app = express();

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for API server
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: config.corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  }));

  app.use(compression());

  // Body parsing middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Logging middleware. Never log bodies: /api/v3/migrate carries a key.
  if (isDevelopment) {
    app.use(requestLogger);
  } else if (config.nodeEnv !== 'test') {
    app.use(morgan('combined'));
  }

  // Bearer INTERNAL_SERVICE_TOKEN on everything except /health.
  app.use(requireInternalToken);

  app.use('/', routes);

  // Error handling middleware (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
