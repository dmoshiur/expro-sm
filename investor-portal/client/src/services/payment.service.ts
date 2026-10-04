import { api } from './api';
import type { Paginated, Payment, SmsLog } from '@/lib/types';

export const paymentService = {
  async list(params: Record<string, string | number | undefined>): Promise<Paginated<Payment>> {
    const { data } = await api.get('/payments', { params });
    return data;
  },
  async get(id: string): Promise<Payment> {
    const { data } = await api.get(`/payments/${id}`);
    return data.payment;
  },
  async recordManual(
    installmentId: string,
    input: { amount?: string; method: 'CASH' | 'BANK' | 'OTHER'; reference: string; note?: string; paidAt?: string },
  ) {
    const { data } = await api.post(`/payments/installments/${installmentId}/manual`, input);
    return data as { paymentId: string; receiptNumber: string; status: string; paidAmount: string };
  },
  async regenerateLink(installmentId: string, sendSms = false) {
    const { data } = await api.post(`/payments/installments/${installmentId}/link/regenerate`, { sendSms });
    return data as { url: string; expiresAt: string; sms?: { success: boolean; error?: string } };
  },
  async sendLink(installmentId: string) {
    const { data } = await api.post(`/payments/installments/${installmentId}/link/send`);
    // `link.url` is returned so the admin can share it manually (WhatsApp, print)
    // when SMS delivery fails - the SMS log shows the failure reason.
    return data as {
      link: { url: string; expiresAt: string };
      sms: { success: boolean; error?: string; to?: string; provider?: string };
    };
  },
  async sendLinksForInvestment(investmentId: string) {
    const { data } = await api.post(`/payments/investments/${investmentId}/links/send`);
    return data as { sent: number; failed: number; skipped: number; results: Array<{ installmentSerial: number; success: boolean }> };
  },
  async smsLogs(params: Record<string, string | number | undefined>): Promise<Paginated<SmsLog>> {
    const { data } = await api.get('/payments/sms-logs', { params });
    return data;
  },
  receiptUrl: (paymentId: string) => `/api/payments/${paymentId}/receipt.pdf`,
};

export const publicService = {
  async config() {
    const { data } = await api.get('/public/config');
    return data;
  },
  async payment(token: string) {
    const { data } = await api.get(`/public/payments/${token}`);
    return data;
  },
  async start(token: string) {
    const { data } = await api.post(`/public/payments/${token}/start`);
    return data as { paymentId: string; redirectUrl: string; gatewayPaymentId: string; amount: string; gatewayLive: boolean };
  },
};
