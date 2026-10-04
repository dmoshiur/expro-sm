/** Canonical audit action names. Keep in sync with docs/permissions.md. */

export const AuditAction = {
  // auth
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_LOCKED: 'auth.login.locked',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESH: 'auth.token.refresh',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  PASSWORD_CHANGED: 'auth.password.changed',
  TWO_FA_SETUP_STARTED: 'auth.2fa.setup_started',
  TWO_FA_ENABLED: 'auth.2fa.enabled',
  TWO_FA_DISABLED: 'auth.2fa.disabled',
  TWO_FA_RESET: 'auth.2fa.reset',
  TWO_FA_FAILED: 'auth.2fa.failed',

  // admins
  ADMIN_CREATED: 'admin.created',
  ADMIN_UPDATED: 'admin.updated',
  ADMIN_DISABLED: 'admin.disabled',
  ADMIN_ENABLED: 'admin.enabled',
  ADMIN_ROLE_CHANGED: 'admin.role_changed',
  ADMIN_PASSWORD_RESET: 'admin.password_reset',

  // investors
  INVESTOR_CREATED: 'investor.created',
  INVESTOR_UPDATED: 'investor.updated',
  INVESTOR_DEACTIVATED: 'investor.deactivated',
  INVESTOR_REACTIVATED: 'investor.reactivated',
  INVESTOR_PHOTO_UPDATED: 'investor.photo_updated',
  INVESTOR_NID_UPDATED: 'investor.nid_updated',
  INVESTOR_NID_VIEWED: 'investor.nid_viewed',

  // nominees
  NOMINEE_CREATED: 'nominee.created',
  NOMINEE_UPDATED: 'nominee.updated',
  NOMINEE_DELETED: 'nominee.deleted',

  // investments / installments
  INVESTMENT_CREATED: 'investment.created',
  INVESTMENT_UPDATED: 'investment.updated',
  INVESTMENT_CANCELLED: 'investment.cancelled',
  INSTALLMENT_UPDATED: 'installment.updated',
  INSTALLMENT_WAIVED: 'installment.waived',
  INSTALLMENT_CANCELLED: 'installment.cancelled',
  INSTALLMENT_UNWAIVED: 'installment.unwaived',
  INSTALLMENT_STATUS_CHANGED: 'installment.status_changed',

  // payment links
  PAYMENT_LINK_REGENERATED: 'payment_link.regenerated',
  PAYMENT_LINK_SENT: 'payment_link.sent',
  PAYMENT_LINK_BULK_SENT: 'payment_link.bulk_sent',

  // payments
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CANCELLED: 'payment.cancelled',
  PAYMENT_MANUAL_RECORDED: 'payment.manual_recorded',
  PAYMENT_RECONCILED: 'payment.reconciled',
  RECEIPT_DOWNLOADED: 'receipt.downloaded',

  // system
  JOB_RUN: 'system.job_run',
  SETTING_UPDATED: 'system.setting_updated',
  DATA_EXPORTED: 'system.data_exported',
} as const;

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditEntity = {
  ADMIN: 'Admin',
  INVESTOR: 'Investor',
  NOMINEE: 'Nominee',
  INVESTMENT: 'Investment',
  INSTALLMENT: 'Installment',
  PAYMENT: 'Payment',
  SETTING: 'Setting',
  SMS: 'SmsLog',
} as const;

export type AuditEntityType = (typeof AuditEntity)[keyof typeof AuditEntity];
