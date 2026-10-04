import { api } from './api';

export interface SettingItem {
  key: string;
  label: string;
  description: string;
  type: 'number' | 'string';
  min?: number;
  max?: number;
  defaultValue: string;
  value: string;
  isOverridden: boolean;
}

export const settingsService = {
  async list(): Promise<SettingItem[]> {
    const { data } = await api.get('/settings');
    return data.settings;
  },
  async update(values: Record<string, string | number>): Promise<SettingItem[]> {
    const { data } = await api.put('/settings', values);
    return data.settings;
  },
};
