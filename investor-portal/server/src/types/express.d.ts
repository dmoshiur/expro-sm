/// <reference types="express-serve-static-core" />
import type { AdminRole } from '../generated/prisma/client';

/**
 * Request-scoped types injected by middleware.
 */
declare global {
  namespace Express {
    interface AuthAdmin {
      id: string;
      name: string;
      email: string;
      role: AdminRole;
    }

    interface Request {
      /** correlation id, echoed in the X-Request-Id response header */
      id: string;
      /** set by requireAuth / optionalAuth */
      admin?: AuthAdmin;
      /** raw refresh token from the cookie (only on refresh/logout routes) */
      refreshTokenRaw?: string;
    }
  }
}

export {};
