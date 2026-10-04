/**
 * Axios instance.
 *
 * - cookies carry the JWT (httpOnly) so every request uses withCredentials
 * - a single in-flight refresh happens on 401, then the original request is
 *   retried once; if the refresh fails the session is cleared and the SPA
 *   navigates to /login
 * - every other error is normalised into an ApiError with the server message
 */
import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody } from '@/lib/types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Array<{ path: string; message: string }>;

  constructor(status: number, code: string, message: string, details?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const api: AxiosInstance = axios.create({
  baseURL: `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api`,
  withCredentials: true,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

let refreshPromise: Promise<void> | null = null;
let sessionExpiredHandler: (() => void) | null = null;

/** Registered by the auth store so the interceptor can log the user out. */
export function onSessionExpired(handler: () => void): void {
  sessionExpiredHandler = handler;
}

interface RetriableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status ?? 0;
    const url = config?.url ?? '';

    const isAuthCall = url.includes('/auth/login') || url.includes('/auth/refresh') || url.includes('/auth/logout');
    if (status === 401 && config && !config._retried && !isAuthCall) {
      config._retried = true;
      try {
        refreshPromise = refreshPromise ?? api.post('/auth/refresh').then(() => undefined);
        await refreshPromise;
        refreshPromise = null;
        return api.request(config);
      } catch {
        refreshPromise = null;
        sessionExpiredHandler?.();
      }
    }

    const body = error.response?.data;
    const message =
      body?.error?.message ??
      (error.code === 'ECONNABORTED' ? 'The request timed out. Please try again.' : 'Network error. Please check your connection.');
    return Promise.reject(new ApiError(status, body?.error?.code ?? 'NETWORK_ERROR', message, body?.error?.details));
  },
);

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
