import { ok } from '../utils/http.js';
import * as scheduler from '../jobs/scheduler.js';

export async function status(_req, res) {
  const runs = await scheduler.recentRuns(20);
  return ok(res, { ...scheduler.jobStatus(), recentRuns: runs });
}

export async function run(req, res) {
  const result = await scheduler.runJobByName(String(req.params.name), { actor: req.admin, req });
  return ok(res, result);
}
