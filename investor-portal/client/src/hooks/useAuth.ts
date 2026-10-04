import { useAuthStore } from '@/store/auth';
import type { AdminRole } from '@/lib/types';

const RANK: Record<AdminRole, number> = { VIEWER: 1, ACCOUNTANT: 2, SUPER_ADMIN: 3 };

export function useAuth() {
  const admin = useAuthStore((state) => state.admin);
  const status = useAuthStore((state) => state.status);
  const mustEnable2FA = useAuthStore((state) => state.mustEnable2FA);

  const hasRole = (...roles: AdminRole[]): boolean => (admin ? roles.includes(admin.role) : false);
  const atLeast = (role: AdminRole): boolean => (admin ? RANK[admin.role] >= RANK[role] : false);

  return {
    admin,
    status,
    mustEnable2FA,
    isAuthenticated: status === 'authenticated' && Boolean(admin),
    isSuperAdmin: admin?.role === 'SUPER_ADMIN',
    isAccountant: admin?.role === 'ACCOUNTANT',
    canWrite: admin?.role === 'SUPER_ADMIN' || admin?.role === 'ACCOUNTANT',
    canExport: admin?.role === 'SUPER_ADMIN' || admin?.role === 'ACCOUNTANT',
    hasRole,
    atLeast,
  };
}
