import { ok } from '../utils/http.js';
import { dashboard } from '../services/report.service.js';

export async function summary(req, res) {
  const data = await dashboard({ range: req.query.range });
  return ok(res, data);
}
