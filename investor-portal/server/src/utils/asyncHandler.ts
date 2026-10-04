import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so rejected promises reach the central error
 * handler instead of hanging the request (Express 4 does not do this itself).
 */
export const asyncHandler =
  <T extends RequestHandler>(fn: T): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };

export default asyncHandler;
