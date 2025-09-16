import { Request, Response } from 'express';

// Enhanced Request interface with strong typing
export interface TypedRequest<T = any> extends Request {
  body: T;
}

// Standard API response structure
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  timestamp: string;
}

// Error response structure
export interface ErrorResponse {
  success: false;
  error: string;
  message: string;
  timestamp: string;
  statusCode: number;
}

// Success response structure
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
  timestamp: string;
}

// Custom response type
export type TypedResponse<T = any> = Response<ApiResponse<T>>;

// Environment configuration
export interface Config {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  corsOrigin: string | string[];
}

// Health check response
export interface HealthCheckResponse {
  status: 'healthy';
  uptime: number;
  timestamp: string;
  version: string;
}