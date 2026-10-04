/**
 * Zod request validation for body / query / params.
 *
 * Controllers read the *parsed* (coerced, typed) values from req.body,
 * req.query and req.params. Validation failure => 400 VALIDATION_ERROR with
 * field-level details and no internal information.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { validationError } from '../utils/errors';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function assign(req: Request, key: 'query' | 'params', value: unknown): void {
  // Express defines req.query as a prototype getter in some versions and makes
  // it read-only in Express 5; defineProperty works in every case.
  try {
    Object.defineProperty(req, key, { value, writable: true, configurable: true, enumerable: true });
  } catch {
    (req as unknown as Record<string, unknown>)[key] = value;
  }
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      if (schemas.query) assign(req, 'query', schemas.query.parse(req.query ?? {}));
      if (schemas.params) assign(req, 'params', schemas.params.parse(req.params ?? {}));
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          validationError(
            'Validation failed',
            err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
        return;
      }
      next(err);
    }
  };
}

/** Typed accessor helpers so controllers stay readable. */
export const typedBody = <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> => req.body as z.infer<T>;
export const typedQuery = <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
  req.query as unknown as z.infer<T>;
export const typedParams = <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
  req.params as unknown as z.infer<T>;

export default validate;
