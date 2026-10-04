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
import { notFound } from '../utils/errors';

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
