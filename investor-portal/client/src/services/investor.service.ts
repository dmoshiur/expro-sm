import { api } from './api';
import type { Investor, Nominee, Paginated } from '@/lib/types';

export interface InvestorInput {
  name: string;
  mobile: string;
  address?: string | null;
  nid?: string | null;
  notes?: string | null;
}

export interface NomineeInput {
  name: string;
  relation: string;
  mobile: string;
  nid?: string | null;
  sharePercent: number;
}

export const investorService = {
  async list(params: Record<string, string | number | undefined>): Promise<Paginated<Investor>> {
    const { data } = await api.get('/investors', { params });
    return data;
  },
  async get(id: string): Promise<{ investor: Investor }> {
    const { data } = await api.get(`/investors/${id}`);
    return data;
  },
  async create(input: InvestorInput): Promise<Investor> {
    const { data } = await api.post('/investors', input);
    return data.investor;
  },
  async update(id: string, input: Partial<InvestorInput>): Promise<Investor> {
    const { data } = await api.patch(`/investors/${id}`, input);
    return data.investor;
  },
  async setNominees(id: string, nominees: NomineeInput[]): Promise<{ investor: Investor }> {
    const { data } = await api.put(`/investors/${id}/nominees`, { nominees });
    return data;
  },
  async deactivate(id: string): Promise<Investor> {
    const { data } = await api.post(`/investors/${id}/deactivate`);
    return data.investor;
  },
  async reactivate(id: string): Promise<Investor> {
    const { data } = await api.post(`/investors/${id}/reactivate`);
    return data.investor;
  },
  async uploadPhoto(id: string, file: File): Promise<Investor> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/investors/${id}/photo`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    return data.investor;
  },
  async uploadNidScan(id: string, file: File): Promise<Investor> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/investors/${id}/nid-scan`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    return data.investor;
  },
  async nidScanUrl(id: string): Promise<{ url: string; expiresIn: number }> {
    const { data } = await api.get(`/investors/${id}/nid-scan-url`);
    return data;
  },
};

export const nomineeShareTotal = (nominees: Nominee[]): number =>
  nominees.reduce((sum, nominee) => sum + Number(nominee.sharePercent || 0), 0);
