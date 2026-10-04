import { api } from './api';
import type { Investment, Paginated } from '@/lib/types';

export interface CreateInvestmentInput {
  investorId: string;
  totalAmount: string;
  installmentCount: number;
  firstDueDate: string;
  interval: { unit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'; value: number };
  notes?: string;
}

export const investmentService = {
  async list(params: Record<string, string | number | undefined>): Promise<Paginated<Investment>> {
    const { data } = await api.get('/investments', { params });
    return data;
  },
  async get(id: string): Promise<Investment> {
    const { data } = await api.get(`/investments/${id}`);
    return data.investment;
  },
  async create(input: CreateInvestmentInput): Promise<Investment> {
    const { data } = await api.post('/investments', input);
    return data.investment;
  },
  async update(id: string, input: { notes?: string | null; status?: string }): Promise<Investment> {
    const { data } = await api.patch(`/investments/${id}`, input);
    return data.investment;
  },
  async cancel(id: string, reason: string): Promise<Investment> {
    const { data } = await api.post(`/investments/${id}/cancel`, { reason });
    return data.investment;
  },
  async updateInstallments(
    id: string,
    input: { totalAmount?: string; firstDueDate?: string; interval?: { unit: string; value: number }; installments?: Array<{ id: string; amount?: string; dueDate?: string }> },
  ): Promise<Investment> {
    const { data } = await api.put(`/investments/${id}/installments`, input);
    return data.investment;
  },
  async waive(installmentId: string, reason: string) {
    const { data } = await api.post(`/installments/${installmentId}/waive`, { reason });
    return data.investment as Investment;
  },
  async cancelInstallment(installmentId: string, reason: string) {
    const { data } = await api.post(`/installments/${installmentId}/cancel`, { reason });
    return data.investment as Investment;
  },
  async reopen(installmentId: string, reason: string) {
    const { data } = await api.post(`/installments/${installmentId}/reopen`, { reason });
    return data.investment as Investment;
  },
};

export const installmentService = {
  async list(params: Record<string, string | number | undefined>) {
    const { data } = await api.get('/installments', { params });
    return data as Paginated<import('@/lib/types').Installment> & { totals?: { contracted: string; paid: string; outstanding: string } };
  },
};
