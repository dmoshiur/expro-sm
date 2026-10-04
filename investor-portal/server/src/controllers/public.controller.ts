/**
 * Public (unauthenticated) endpoints.
 *
 * The ONLY write operation available to an investor in v1 is starting a bKash
 * payment for a valid, unexpired token. Everything else is read-only and
 * deliberately minimal: first name, installment number, amount, due date.
 *
 * Invalid, expired, already-paid or unknown tokens all produce the SAME generic
 * error, so the endpoint cannot be used to enumerate tokens.
 */
import type { Request, Response } from 'express';
import { config } from '../config';
import * as linkService from '../services/payment/link.service';
import * as paymentService from '../services/payment/payment.service';
import { notFound } from '../utils/errors';
import { getClientIp, getUserAgent } from '../utils/http';
import { logger } from '../utils/logger';

/** GET /api/public/config - what the public page needs to render (no secrets) */
export async function publicConfig(_req: Request, res: Response): Promise<void> {
  res.json({
    companyName: process.env.COMPANY_NAME ?? 'Investor Portal',
    supportMobile: process.env.SUPPORT_MOBILE ?? null,
    gateway: 'bKash',
    gatewayMode: config.bkash.mode,
  });
}

/** GET /api/public/payments/:token */
export async function paymentDetails(req: Request, res: Response): Promise<void> {
  const { token } = req.params as { token: string };
  try {
    const payload = await linkService.publicPayload(token);
    res.json(payload);
  } catch {
    // generic error - never reveal whether the token existed
    throw notFound('This payment link is invalid or has expired. Please contact the office for a new link.');
  }
}

/** POST /api/public/payments/:token/start */
export async function startPayment(req: Request, res: Response): Promise<void> {
  const { token } = req.params as { token: string };
  const result = await paymentService.startPayment(token, {
    ip: getClientIp(req),
    userAgent: getUserAgent(req),
  });
  res.json(result);
}

/**
 * GET /api/public/payments/bkash/callback
 *
 * The gateway sends the investor's browser here with ?paymentID=...&status=...
 * We confirm everything server-side and then redirect to the SPA result page.
 * A redirect is always produced, even on failure, so the investor is never left
 * staring at a JSON error from a payment provider redirect.
 */
export async function bkashCallback(req: Request, res: Response): Promise<void> {
  const query = req.query as { paymentID?: string; status?: string; trxID?: string };
  const base = config.appBaseUrl;

  try {
    const result = await paymentService.handleGatewayCallback({
      paymentID: query.paymentID,
      status: query.status,
      trxID: query.trxID,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    if (result.status === 'SUCCESS') {
      res.redirect(303, `${base}/pay/result?status=success&paymentId=${result.paymentId}`);
      return;
    }
    if (result.status === 'CANCELLED') {
      res.redirect(303, `${base}/pay/result?status=cancelled&paymentId=${result.paymentId}`);
      return;
    }
    if (result.status === 'FAILED') {
      res.redirect(303, `${base}/pay/result?status=failed&paymentId=${result.paymentId}`);
      return;
    }
    res.redirect(303, `${base}/pay/result?status=pending&paymentId=${result.paymentId}`);
  } catch (error) {
    logger.warn({ err: error, paymentID: query.paymentID }, 'bkash callback could not be processed');
    res.redirect(303, `${base}/pay/result?status=failed`);
  }
}

/** POST /api/public/payments/bkash/webhook (disabled unless configured) */
export async function bkashWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-bkash-signature'];
  const result = await paymentService.handleWebhook(req.body, typeof signature === 'string' ? signature : undefined);
  res.status(result.accepted ? 200 : 202).json(result);
}
