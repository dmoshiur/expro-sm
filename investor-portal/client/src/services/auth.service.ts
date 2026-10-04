import { api } from './api';
import type { Admin } from '@/lib/types';

export interface LoginInput {
  email: string;
  password: string;
  totp?: string;
}

export const authService = {
  async login(input: LoginInput): Promise<{ admin?: Admin; mustEnable2FA?: boolean; twoFactorRequired?: boolean }> {
    const { data } = await api.post('/auth/login', input);
    return data;
  },
  async me(): Promise<{ admin: Admin; mustEnable2FA: boolean }> {
    const { data } = await api.get('/auth/me');
    return data;
  },
  async logout(): Promise<void> {
    await api.post('/auth/logout');
  },
  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    await api.post('/auth/change-password', input);
  },
  async setupTwoFactor(): Promise<{ otpauthUrl: string; qrDataUrl: string }> {
    const { data } = await api.post('/auth/2fa/setup');
    return data;
  },
  async verifyTwoFactor(code: string): Promise<void> {
    await api.post('/auth/2fa/verify', { code });
  },
  async disableTwoFactor(password: string): Promise<void> {
    await api.post('/auth/2fa/disable', { password });
  },
};

export const adminService = {
  async list(params: { search?: string; role?: string; isActive?: string; page?: number; pageSize?: number } = {}) {
    const { data } = await api.get('/admins', { params });
    return data as { items: Admin[]; page: number; pageSize: number; total: number; totalPages: number };
  },
  async create(input: { name: string; email: string; password: string; role: string }) {
    const { data } = await api.post('/admins', input);
    return data.admin as Admin;
  },
  async update(id: string, input: { name?: string; role?: string; isActive?: boolean }) {
    const { data } = await api.patch(`/admins/${id}`, input);
    return data.admin as Admin;
  },
  async resetPassword(id: string, newPassword: string) {
    await api.post(`/admins/${id}/reset-password`, { newPassword });
  },
  async resetTwoFactor(id: string) {
    const { data } = await api.post(`/admins/${id}/reset-2fa`);
    return data as { ok: boolean; pendingSecret?: string };
  },
  async unlock(id: string) {
    await api.post(`/admins/${id}/unlock`);
  },
};
