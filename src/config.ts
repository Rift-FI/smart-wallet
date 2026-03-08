import { Config } from './types';

export const config: Config = {
  port: parseInt(process.env.PORT ?? '3500', 10),
  nodeEnv: (process.env.NODE_ENV as Config['nodeEnv']) ?? 'development',
  corsOrigin: process.env.CORS_ORIGIN ?? '*', // Open CORS as requested
};

export const isDevelopment = config.nodeEnv === 'development';
export const isProduction = config.nodeEnv === 'production';