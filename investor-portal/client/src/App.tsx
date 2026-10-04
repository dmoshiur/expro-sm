import { useEffect } from 'react';
import { useAuthStore } from '@/store/auth';
import { AppRoutes } from '@/routes/AppRoutes';

/**
 * Application shell.
 *
 * `bootstrap()` asks /auth/me once (the session lives in httpOnly cookies, so
 * the browser cannot read it) and the resulting status drives the route guards.
 */
export default function App() {
  const bootstrap = useAuthStore((state) => state.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return <AppRoutes />;
}
