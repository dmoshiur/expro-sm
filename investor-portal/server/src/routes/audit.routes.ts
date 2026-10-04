import { Router } from 'express';
import { listAuditActions, listAuditLogs } from '../controllers/audit.controller';
import { requireAuth, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { z } from 'zod';

export const auditRouter = Router();

const listQuerySchema = z.object({
  adminId: z.string().uuid().optional(),
  action: z.string().trim().max(80).optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Read-only by design: the audit trail cannot be modified through the API. */
auditRouter.use(requireAuth, requirePermission('audit:read'));

auditRouter.get('/', validate({ query: listQuerySchema }), listAuditLogs);
auditRouter.get('/actions', listAuditActions);

const methodNotAllowed: import('express').RequestHandler = (req, res) => {
  res.status(405).json({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'The audit log is append-only: entries can be read but never modified',
      requestId: req.id ?? 'unknown',
    },
  });
};
auditRouter.post('*', methodNotAllowed);
auditRouter.put('*', methodNotAllowed);
auditRouter.patch('*', methodNotAllowed);
auditRouter.delete('*', methodNotAllowed);

export default auditRouter;
