/** Thin, typed-by-shape wrappers around the REST API (fetch only). */
import { api } from './api.js';

export const investorsApi = {
  list: (params) => api.get('/investors', params),
  get: (id) => api.get(`/investors/${id}`),
  portalAccess: (id) => api.get(`/investors/${id}/portal-access`),
  setPortalPassword: (id, payload) => api.post(`/investors/${id}/portal-access/password`, payload),
  setPortalEnabled: (id, enabled) => api.post(`/investors/${id}/portal-access/enabled`, { enabled }),
  revokePortalSessions: (id) => api.post(`/investors/${id}/portal-access/revoke-sessions`),
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
  // Document slots (photo / NID front / NID back / signature) + verification.
  documents: (id) => api.get(`/investors/${id}/documents`),
  uploadDocument: (id, kind, file) => api.upload(`/investors/${id}/documents/${kind}`, file, file.type),
  documentUrl: (id, kind, bust = '') => `/api/investors/${id}/documents/${kind}/file${bust ? `?v=${bust}` : ''}`,
  reviewDocument: (id, kind, payload) => api.post(`/investors/${id}/documents/${kind}/review`, payload),
  uploadNomineePhoto: (id, nomineeId, file) => api.upload(`/investors/${id}/nominees/${nomineeId}/photo`, file, file.type),
  nomineePhotoUrl: (id, nomineeId, bust = '') => `/api/investors/${id}/nominees/${nomineeId}/photo${bust ? `?v=${bust}` : ''}`,
  reviewNomineePhoto: (id, nomineeId, payload) => api.post(`/investors/${id}/nominees/${nomineeId}/photo/review`, payload),
  // Wallet ledger + request decisions
  wallet: (id) => api.get(`/investors/${id}/wallet`),
  recordWalletEntry: (id, payload) => api.post(`/investors/${id}/wallet/transactions`, payload),
  decideWallet: (id, txId, payload) => api.post(`/investors/${id}/wallet/transactions/${txId}/decide`, payload),
  // Membership approval / account freeze
  decideMembership: (id, payload) => api.post(`/investors/${id}/membership`, payload),
  setFrozen: (id, payload) => api.post(`/investors/${id}/freeze`, payload),
  certificatePrint: (id) => api.openHtml(`/reports/investors/${id}/certificate.html`, { print: 'true' }),
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

/** Staff view of donations (read-only). */
export const donationsApi = {
  list: (params) => api.get('/donations', params),
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

export const supportApi = {
  summary: () => api.get('/support/summary'),
  list: (params) => api.get('/support/tickets', params),
  get: (id) => api.get(`/support/tickets/${id}`),
  reply: (id, payload) => api.post(`/support/tickets/${id}/messages`, payload),
  setStatus: (id, payload) => api.post(`/support/tickets/${id}/status`, payload),
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

/** Investor self-service portal (own session cookie, own data only). */
export const portalApi = {
  login: (payload) => api.post('/portal/auth/login', payload),
  logout: () => api.post('/portal/auth/logout'),
  me: () => api.get('/portal/auth/me'),
  changePassword: (payload) => api.post('/portal/auth/change-password', payload),
  revokeOtherSessions: () => api.post('/portal/auth/sessions/revoke-others'),
  dashboard: () => api.get('/portal/dashboard'),
  profile: () => api.get('/portal/profile'),
  updateProfile: (payload) => api.patch('/portal/profile', payload),
  investments: () => api.get('/portal/investments'),
  installments: (params) => api.get('/portal/installments', params),
  payments: () => api.get('/portal/payments'),
  payLink: (installmentId) => api.post(`/portal/installments/${installmentId}/pay-link`),
  photoUrl: '/api/portal/photo',
  openReceipt: (paymentId) => api.openHtml(`/portal/payments/${paymentId}/receipt`, { print: 'true' }),
  statementCsv: () => api.download('/portal/statement.csv'),
  // Wallet: live balance, ledger and self-service requests.
  wallet: () => api.get('/portal/wallet'),
  requestWallet: (payload) => api.post('/portal/wallet/requests', payload),
  // Document slots + nominee photos (view only: uploads are staff-only).
  documents: () => api.get('/portal/documents'),
  documentUrl: (kind, bust = '') => `/api/portal/documents/${kind}/file${bust ? `?v=${bust}` : ''}`,
  nomineePhotoUrl: (nomineeId, bust = '') => `/api/portal/nominees/${nomineeId}/photo${bust ? `?v=${bust}` : ''}`,
  // Support / inquiries.
  tickets: () => api.get('/portal/support/tickets'),
  createTicket: (payload) => api.post('/portal/support/tickets', payload),
  ticket: (id) => api.get(`/portal/support/tickets/${id}`),
  replyTicket: (id, payload) => api.post(`/portal/support/tickets/${id}/messages`, payload),
  closeTicket: (id) => api.post(`/portal/support/tickets/${id}/close`),
  // Donates: real donations through the payment gateway, with stored receipts.
  donations: () => api.get('/portal/donations'),
  createDonation: (payload) => api.post('/portal/donations', payload),
  donation: (id) => api.get(`/portal/donations/${id}`),
  verifyDonation: (id) => api.post(`/portal/donations/${id}/verify`),
  openDonationReceipt: (id) => api.openHtml(`/portal/donations/${id}/receipt`, { print: 'true' }),
  // Printable documents (print / save as PDF in the browser).
  certificate: () => api.openHtml('/portal/certificate', { print: 'true' }),
  statementPrint: () => api.openHtml('/portal/statement.html', { print: 'true' }),
};
