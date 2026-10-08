/** Thin, typed-by-shape wrappers around the REST API (fetch only). */
import { api } from './api.js';

export const investorsApi = {
  list: (params) => api.get('/investors', params),
  get: (id) => api.get(`/investors/${id}`),
  create: (payload) => api.post('/investors', payload),
  update: (id, payload) => api.patch(`/investors/${id}`, payload),
  setStatus: (id, payload) => api.post(`/investors/${id}/status`, payload),
  remove: (id, payload) => api.del(`/investors/${id}`, payload),
  restore: (id) => api.post(`/investors/${id}/restore`),
  replaceNominees: (id, nominees) => api.post(`/investors/${id}/nominees`, { nominees }),
  revealNid: (id) => api.get(`/investors/${id}/nid`),
  revealNomineeNid: (id, nomineeId) => api.get(`/investors/${id}/nominees/${nomineeId}/nid`),
  uploadPhoto: (id, file) => api.upload(`/investors/${id}/photo`, file, file.type),
  uploadNidScan: (id, file) => api.upload(`/investors/${id}/nid-scan`, file, file.type),
  photoUrl: (id) => `/api/investors/${id}/photo`,
  nidScanUrl: (id) => `/api/investors/${id}/nid-scan`,
  exportCsv: (params) => api.download('/reports/investors.csv', params),
};

export const investmentsApi = {
  list: (params) => api.get('/investments', params),
  get: (id) => api.get(`/investments/${id}`),
  create: (payload) => api.post('/investments', payload),
  updateTotal: (id, payload) => api.patch(`/investments/${id}/total`, payload),
  setStatus: (id, payload) => api.post(`/investments/${id}/status`, payload),
  schedulePreview: (params) => api.get('/investments/schedule-preview', params),
  resync: (id) => api.post(`/investments/${id}/resync`),
};

export const installmentsApi = {
  list: (params) => api.get('/installments', params),
  get: (id) => api.get(`/installments/${id}`),
  update: (id, payload) => api.patch(`/installments/${id}`, payload),
  setState: (id, payload) => api.post(`/installments/${id}/state`, payload),
  issueLink: (id, payload) => api.post(`/installments/${id}/pay-link`, payload),
  sendLink: (id) => api.post(`/installments/${id}/send-link`),
  bulkSendLinks: (ids) => api.post('/installments/bulk/send-links', { ids }),
};

export const paymentsApi = {
  list: (params) => api.get('/payments', params),
  get: (id) => api.get(`/payments/${id}`),
  recordManual: (payload) => api.post('/payments/manual', payload),
  refresh: (id) => api.post(`/payments/${id}/refresh`),
  cancel: (id, payload) => api.post(`/payments/${id}/cancel`, payload),
  provider: () => api.get('/payments/provider'),
  exportCsv: (params) => api.download('/payments/export', params),
  openReceipt: (id) => api.openHtml(`/payments/${id}/receipt`, { print: 'true' }),
  receiptJson: (id) => api.get(`/payments/${id}/receipt.json`),
};

export const dashboardApi = {
  summary: () => api.get('/dashboard'),
};

export const reportsApi = {
  collections: (params) => api.get('/reports/collections', params),
  due: (params) => api.get('/reports/due', params),
  overdue: (params) => api.get('/reports/overdue', params),
  statement: (investorId, params) => api.get(`/reports/investors/${investorId}/statement`, params),
  dueCsv: (params) => api.download('/reports/due.csv', params),
  overdueCsv: (params) => api.download('/reports/overdue.csv', params),
  collectionsCsv: (params) => api.download('/reports/collections.csv', params),
  statementCsv: (investorId, params) => api.download(`/reports/investors/${investorId}/statement.csv`, params),
  duePrint: (params) => api.openHtml('/reports/due.html', params),
  overduePrint: (params) => api.openHtml('/reports/overdue.html', params),
  statementPrint: (investorId, params) => api.openHtml(`/reports/investors/${investorId}/statement.html`, params),
  paymentsPrint: (params) => api.openHtml('/reports/payments.html', params),
};

export const auditApi = {
  list: (params) => api.get('/audit', params),
  filters: () => api.get('/audit/filters'),
};

export const smsApi = {
  list: (params) => api.get('/sms', params),
  provider: () => api.get('/sms/provider'),
  test: (payload) => api.post('/sms/test', payload),
};

export const adminsApi = {
  list: (params) => api.get('/admins', params),
  get: (id) => api.get(`/admins/${id}`),
  create: (payload) => api.post('/admins', payload),
  update: (id, payload) => api.patch(`/admins/${id}`, payload),
  resetPassword: (id, payload) => api.post(`/admins/${id}/reset-password`, payload),
  resetTotp: (id) => api.post(`/admins/${id}/reset-totp`),
  revokeSessions: (id) => api.post(`/admins/${id}/revoke-sessions`),
};

export const jobsApi = {
  status: () => api.get('/jobs'),
  run: (name) => api.post(`/jobs/${name}/run`),
};

export const publicApi = {
  viewLink: (token) => api.get(`/public/pay/${encodeURIComponent(token)}`),
  start: (token) => api.post(`/public/pay/${encodeURIComponent(token)}/start`, {}),
  verify: (token, paymentId) => api.post(`/public/pay/${encodeURIComponent(token)}/verify`, { paymentId }),
};
