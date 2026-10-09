/** Auth context: current admin, session bootstrap, login/logout, role checks. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, setUnauthorizedHandler } from '../services/api.js';

const AuthContext = createContext(null);

export const ROLE_RANK = { VIEWER: 1, ACCOUNTANT: 2, SUPER_ADMIN: 3 };

export function AuthProvider({ children }) {
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [totpRequired, setTotpRequired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await authApi.me();
      setAdmin(data.admin);
      return data.admin;
    } catch {
      setAdmin(null);
      return null;
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAdmin(null);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authApi.me();
        if (!cancelled) setAdmin(data.admin);
      } catch {
        if (!cancelled) setAdmin(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async ({ email, password, totpCode }) => {
    const data = await authApi.login({ email, password, totpCode });
    setAdmin(data.admin);
    setTotpRequired(false);
    return data.admin;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setAdmin(null);
      setTotpRequired(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      admin,
      loading,
      totpRequired,
      setTotpRequired,
      login,
      logout,
      refresh,
      setAdmin,
      isSuperAdmin: admin?.role === 'SUPER_ADMIN',
      isAccountant: admin?.role === 'ACCOUNTANT',
      isViewer: admin?.role === 'VIEWER',
      can: (roles) => Boolean(admin && (Array.isArray(roles) ? roles : [roles]).includes(admin.role)),
      atLeast: (role) => Boolean(admin && ROLE_RANK[admin.role] >= ROLE_RANK[role]),
      /** True while the admin still uses the seeded password. */
      mustChangePassword: Boolean(admin?.must_change_password),
    }),
    [admin, loading, totpRequired, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
