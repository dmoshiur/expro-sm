import { Router } from 'express';
import * as investmentController from '../controllers/investment.controller';
import { requireAuth, requirePermission } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import {
  createInvestmentSchema,
  installmentIdParamSchema,
  installmentReasonSchema,
  investmentIdParamSchema,
  listInstallmentsQuerySchema,
  listInvestmentsQuerySchema,
  updateInstallmentsSchema,
  updateInvestmentSchema,
} from '../validators/investment.validator';
import { asyncHandler } from '../utils/asyncHandler';

export const investmentRouter = Router();
export const installmentRouter = Router();

// --------------------------- investments -----------------------------------
investmentRouter.use(requireAuth, csrfProtection);

investmentRouter.get(
  '/',
  requirePermission('investment:read'),
  validate({ query: listInvestmentsQuerySchema }),
  asyncHandler(investmentController.list),
);

investmentRouter.get(
  '/:id',
  requirePermission('investment:read'),
  validate({ params: investmentIdParamSchema }),
  asyncHandler(investmentController.detail),
);

investmentRouter.post(
  '/',
  requirePermission('investment:write'),
  validate({ body: createInvestmentSchema }),
  asyncHandler(investmentController.create),
);

investmentRouter.patch(
  '/:id',
  requirePermission('investment:write'),
  validate({ params: investmentIdParamSchema, body: updateInvestmentSchema }),
  asyncHandler(investmentController.update),
);

investmentRouter.post(
  '/:id/cancel',
  requirePermission('installment:write'),
  validate({ params: investmentIdParamSchema, body: installmentReasonSchema }),
  asyncHandler(investmentController.cancel),
);

investmentRouter.put(
  '/:id/installments',
  requirePermission('installment:write'),
  validate({ params: investmentIdParamSchema, body: updateInstallmentsSchema }),
  asyncHandler(investmentController.updateInstallments),
);

// --------------------------- installments ----------------------------------
installmentRouter.use(requireAuth, csrfProtection);

installmentRouter.get(
  '/',
  requirePermission('investment:read'),
  validate({ query: listInstallmentsQuerySchema }),
  asyncHandler(investmentController.listInstallments),
);

installmentRouter.post(
  '/:id/waive',
  requirePermission('installment:waive'),
  validate({ params: installmentIdParamSchema, body: installmentReasonSchema }),
  asyncHandler(investmentController.waive),
);

installmentRouter.post(
  '/:id/cancel',
  requirePermission('installment:waive'),
  validate({ params: installmentIdParamSchema, body: installmentReasonSchema }),
  asyncHandler(investmentController.cancelInstallment),
);

installmentRouter.post(
  '/:id/reopen',
  requirePermission('installment:waive'),
  validate({ params: installmentIdParamSchema, body: installmentReasonSchema }),
  asyncHandler(investmentController.reopen),
);

export default investmentRouter;
