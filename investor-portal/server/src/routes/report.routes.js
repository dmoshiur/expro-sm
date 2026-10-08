import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth } from '../middleware/auth.js';
import * as ctrl from '../controllers/report.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/collections', asyncHandler(ctrl.collections));
router.get('/collections.csv', asyncHandler(ctrl.collectionsCsvExport));
router.get('/due', asyncHandler(ctrl.due));
router.get('/due.csv', asyncHandler(ctrl.dueCsv));
router.get('/due.html', asyncHandler(ctrl.duePrint));
router.get('/overdue', asyncHandler(ctrl.overdue));
router.get('/overdue.csv', asyncHandler(ctrl.overdueCsv));
router.get('/overdue.html', asyncHandler(ctrl.overduePrint));
router.get('/investors.csv', asyncHandler(ctrl.investorsCsvExport));
router.get('/payments.html', asyncHandler(ctrl.paymentsPrint));
router.get('/today', asyncHandler(ctrl.today));
router.get('/investors/:investorId/statement', asyncHandler(ctrl.statement));
router.get('/investors/:investorId/statement.csv', asyncHandler(ctrl.statementCsvExport));
router.get('/investors/:investorId/statement.html', asyncHandler(ctrl.statementPrint));

export default router;
