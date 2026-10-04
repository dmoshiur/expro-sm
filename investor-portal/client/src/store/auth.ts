/**
 * Auth store (zustand).
 *
 * The session itself lives in httpOnly cookies, so the store only mirrors the
 * admin profile. `bootstrap()` calls /auth/me once on app start; the axios
 * interceptor calls `clear()` when a refresh fails.
 */
import { create } from 'zustand';
import { onSessionExpired } from '@/services/api';
import { authService } from '@/services/auth.service';
import type { Admin } from '@/lib/types';

interface AuthState {
  admin: Admin | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  mustEnable2FA: boolean;
  bootstrap: () => Promise<void>;
  login: (admin: Admin, mustEnable2FA?: boolean) => void;
  clear: () => void;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  admin: null,
  status: 'loading',
  mustEnable2FA: false,

  async bootstrap() {
    try {
      const { admin, mustEnable2FA } = await authService.me();
      set({ admin, mustEnable2FA, status: 'authenticated' });
    } catch {
      set({ admin: null, status: 'anonymous' });
    }
  },

  login(admin, mustEnable2FA = false) {
    set({ admin, mustEnable2FA, status: 'authenticated' });
  },

  clear() {
    set({ admin: null, status: 'anonymous' });
  },

  async logout() {
    try {
      await authService.logout();
    } finally {
      set({ admin: null, status: 'anonymous' });
    }
  },

  async refreshProfile() {
    try {
      const { admin, mustEnable2FA } = await authService.me();
      set({ admin, mustEnable2FA, status: 'authenticated' });
    } catch {
      set({ admin: null, status: 'anonymous' });
    }
  },
}));

// A failed token refresh anywhere in the app logs the user out.
onSessionExpired(() => {
  useAuthStore.getState().clear();
});
