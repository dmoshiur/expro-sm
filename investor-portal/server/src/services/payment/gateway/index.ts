/**
 * Gateway selection.
 *
 * - BKASH with credentials configured -> real Tokenized Checkout adapter
 *   (sandbox or live depending on BKASH_MODE)
 * - otherwise -> deterministic mock adapter so development, CI and the test
 *   suite exercise exactly the same code paths without a gateway account.
 */
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { serviceUnavailable } from '../../../utils/errors';
import type { GatewayAdapter } from './types';
import { createBkashGateway } from './bkash.gateway';
import { createMockGateway } from './mock.gateway';

let override: GatewayAdapter | null = null;

export function getGateway(): GatewayAdapter {
  if (override) return override;
  if (config.bkash.configured) {
    return createBkashGateway({
      appKey: config.bkash.appKey,
      appSecret: config.bkash.appSecret,
      username: config.bkash.username,
      password: config.bkash.password,
      baseUrl: config.bkash.baseUrl,
    });
  }
  if (config.isProd) {
    throw serviceUnavailable('Online payments are not configured. Please contact support.');
  }

  logger.warn('bKash credentials are not configured - using the mock gateway');
  return createMockGateway();
}

export function isGatewayLive(): boolean {
  return config.bkash.configured && config.bkash.mode === 'live';
}

/** Test helper. */
export function setGateway(adapter: GatewayAdapter | null): void {
  override = adapter;
}

export { createMockGateway, createBkashGateway };
export type { GatewayAdapter };
export * from './types';
