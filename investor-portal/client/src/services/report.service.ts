import { api } from './api';
import type { AuditEntry, DashboardSummary, Payment } from '@/lib/types';

export const dashboardService = {
  async summary(months = 12): Promise<DashboardSummary> {
    const { data } = await api.get('/dashboard', { params: { months } });
    return data;
  },
};

export const reportService = {
  async due(params: Record<string, string | number | undefined>) {
    const { data } = await api.get('/reports/due', { params });
    return data;
  },
  async collections(params: Record<string, string | number | undefined>) {
    const { data } = await api.get('/reports/collections', { params });
    return data as { items: Payment[]; page: number; total: number; totalPages: number; totals: { amount: string; count: number; byMethod: Array<{ method: string; amount: string; count: number }> } };
  },
  async statement(investorId: string) {
    const { data } = await api.get(`/reports/investors/${investorId}/statement`);
    return data;
  },
  async download(url: string, fileName: string) {
    const response = await api.get(url, { responseType: 'blob' });
    const blobUrl = URL.createObjectURL(response.data as Blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(blobUrl);
  },
};

export const auditService = {
  async list(params: Record<string, string | number | undefined>) {
    const { data } = await api.get('/audit-logs', { params });
    return data as { items: AuditEntry[]; page: number; pageSize: number; total: number; totalPages: number };
  },
  async actions(): Promise<string[]> {
    const { data } = await api.get('/audit-logs/actions');
    return data.actions;
  },
};
