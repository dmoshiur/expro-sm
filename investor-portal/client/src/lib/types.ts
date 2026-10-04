/** Shared API types (mirrors the server serialisers - money fields are poisha strings). */
export type AdminRole = 'SUPER_ADMIN' | 'ACCOUNTANT' | 'VIEWER';

export interface Admin {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  twoFAEnabled: boolean;
  isActive: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type InvestorStatus = 'ACTIVE' | 'INACTIVE';
export type InvestmentStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type InstallmentStatus = 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'WAIVED' | 'CANCELLED';
export type PaymentStatus = 'INITIATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
export type PaymentMethod = 'BKASH' | 'CASH' | 'BANK' | 'OTHER';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Nominee {
  id: string;
  name: string;
  relation: string;
  mobile: string;
  nid?: string | null;
  sharePercent: number;
}

export interface Investor {
  id: string;
  name: string;
  mobile: string;
  mobileMasked: string;
  address: string | null;
  status: InvestorStatus;
  photoUrl: string | null;
  nid: string | null;
  hasNid: boolean;
  hasNidScan: boolean;
  investmentCount: number;
  nomineeCount: number;
  notes?: string | null;
  nominees?: Nominee[];
  investments?: Investment[];
  smsLogs?: SmsLog[];
  totals?: { contracted: string; collected: string; outstanding: string; waived: string };
  createdAt: string;
  updatedAt: string;
}

export interface Installment {
  id: string;
  investmentId: string;
  serial: number;
  amount: string;
  paidAmount: string;
  outstanding: string;
  dueDate: string;
  dueDateLabel: string;
  status: InstallmentStatus;
  paidAt: string | null;
  lastRemindedAt: string | null;
  linkExpiresAt: string | null;
  hasActiveLink: boolean;
  isOverdue: boolean;
  waivedReason: string | null;
  cancelledReason: string | null;
  daysOverdue?: number;
  dueInDays?: number;
}

export interface Investment {
  id: string;
  investorId: string;
  investor?: { id: string; name: string; mobile: string };
  totalAmount: string;
  installmentCount: number;
  status: InvestmentStatus;
  notes: string | null;
  scheduledTotal: string;
  payableTotal: string;
  collected: string;
  outstanding: string;
  progress: number;
  paidCount: number;
  installments: Installment[];
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  installmentId: string;
  amount: string;
  method: PaymentMethod;
  gateway: string;
  status: PaymentStatus;
  trxId: string | null;
  gatewayPaymentId: string | null;
  manualReference: string | null;
  note?: string | null;
  receiptNumber: string | null;
  failureReason: string | null;
  completedAt: string | null;
  createdAt: string;
  installment?: {
    id: string;
    serial: number;
    status: InstallmentStatus;
    investment?: { id: string; investor: { id: string; name: string; mobile: string } };
  };
  recordedByAdmin?: { id: string; name: string } | null;
}

export interface SmsLog {
  id: string;
  toMobile: string;
  body: string;
  provider: string;
  status: 'QUEUED' | 'SENT' | 'FAILED';
  purpose: 'PAYMENT_LINK' | 'REMINDER_DUE' | 'REMINDER_OVERDUE' | 'MANUAL' | 'BULK';
  error: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  adminId: string | null;
  admin?: { id: string; name: string; email: string } | null;
  action: string;
  entity: string;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface DashboardSummary {
  totals: { invested: string; collected: string; outstanding: string; overdue: string; waived: string };
  counts: {
    investors: number;
    activeInvestors: number;
    investments: number;
    activeInvestments: number;
    installments: number;
    paidInstallments: number;
    overdueInstallments: number;
  };
  collection: {
    today: string;
    todayCount: number;
    yesterday: string;
    thisMonth: string;
    thisMonthCount: number;
    last30Days: string;
  };
  due: { next7Days: string; next7DaysCount: number; overdueAmount: string; overdueCount: number };
  collectionByMonth: Array<{ month: string; total: string; count: number }>;
  upcomingInstallments: Array<{
    id: string;
    serial: number;
    installmentCount: number;
    amount: string;
    outstanding: string;
    dueDate: string;
    status: InstallmentStatus;
    investor: { id: string; name: string };
  }>;
  recentPayments: Array<{
    id: string;
    amount: string;
    method: PaymentMethod;
    status: PaymentStatus;
    completedAt: string | null;
    createdAt: string;
    receiptNumber: string | null;
    investorName: string;
  }>;
}

export interface PublicPayment {
  firstName: string;
  installmentSerial: number;
  installmentCount: number;
  amount: string;
  amountLabel: string;
  dueDate: string;
  status: InstallmentStatus;
  isOverdue: boolean;
  alreadyPaid: boolean;
}

export interface PublicConfig {
  companyName: string;
  supportMobile: string | null;
  gateway: string;
  gatewayMode: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Array<{ path: string; message: string }>; requestId?: string };
}
