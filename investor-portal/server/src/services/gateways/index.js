/**
 * Payment gateway registry.
 *
 * Adapter interface (implement these to add Nagad / card / Rocket later):
 *   name
 *   createPayment({ amountPoisha, invoiceNumber, callbackUrl, payerReference })
 *        -> { paymentId, redirectUrl, status, raw }
 *   executePayment({ paymentId }) -> { normalized, trxId, amount, invoiceNumber, rawStatus, raw }
 *   queryPayment({ paymentId })   -> same shape as executePayment
 *
 * `normalized` is one of SUCCESS | FAILED | CANCELLED | PENDING | UNKNOWN.
 */
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { createBkashGateway } from './bkash.gateway.js';
import { createMockGateway } from './mock.gateway.js';

let instance = null;

export function getGateway() {
  if (!instance) instance = createGateway(config.payments.provider);
  return instance;
}

/** Adapter injection for tests (or for switching gateways at runtime). */
export function setGateway(gateway) {
  instance = gateway;
  logger.info('payment gateway set', { gateway: gateway?.name });
}

export function createGateway(provider = config.payments.provider, options = {}) {
  switch (String(provider).toLowerCase()) {
    case 'bkash':
      return createBkashGateway(options);
    case 'mock':
      return createMockGateway(options);
    default:
      throw new Error(`Unknown payment provider: ${provider}`);
  }
}

export { createBkashGateway, createMockGateway };
