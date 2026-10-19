/**
 * Investor portal auth context - the mirror of AuthContext for investors.
 * Completely independent: its own session cookie and /api/portal endpoints,
 * so being signed in here says nothing about the admin session (and the
 * admin 401 handler ignores portal paths, and vice versa).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { onUnauthorized } from '../services/api.js';
import { portalApi } from '../services/endpoints.js';

const InvestorAuthContext = createContext(null);

export function InvestorAuthProvider({ children }) {
  const [investor, setInvestor] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await portalApi.me();
      setInvestor(data.investor);
      return data.investor;
    } catch {
      setInvestor(null);
      return null;
    }
  }, []);

  useEffect(() => {
    return onUnauthorized((_error, path) => {
      if (String(path).startsWith('/portal') && !String(path).includes('/auth/login')) setInvestor(null);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await portalApi.me();
        if (!cancelled) setInvestor(data.investor);
      } catch {
        if (!cancelled) setInvestor(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async ({ loginId, password }) => {
    const data = await portalApi.login({ loginId, password });
    setInvestor(data.investor);
    return data.investor;
  }, []);

  const logout = useCallback(async () => {
    try {
      await portalApi.logout();
    } finally {
      setInvestor(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      investor,
      loading,
      login,
      logout,
      refresh,
      setInvestor,
      mustChangePassword: Boolean(investor?.must_change_password),
    }),
    [investor, loading, login, logout, refresh],
  );

  return <InvestorAuthContext.Provider value={value}>{children}</InvestorAuthContext.Provider>;
}

export function useInvestorAuth() {
  const context = useContext(InvestorAuthContext);
  if (!context) throw new Error('useInvestorAuth must be used inside <InvestorAuthProvider>');
  return context;
}
