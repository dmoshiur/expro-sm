/**
 * The single source of truth for the profile tab order. Admin and investor
 * views render the SAME eight tabs so support conversations and staff actions
 * always talk about the same sections.
 */
export const PROFILE_TABS = [
  { key: 'profile', label: 'Profile', icon: '☰' },
  { key: 'enrollments', label: 'Pension Enrollments', icon: '▦' },
  { key: 'installments', label: 'Pension Installments', icon: '≡' },
  { key: 'wallet', label: 'Wallet', icon: '◈' },
  { key: 'transactions', label: 'Transactions', icon: '⇄' },
  { key: 'payments', label: 'Payments', icon: '৳' },
  { key: 'nominees', label: 'Nominees', icon: '♡' },
  { key: 'password', label: 'Change Password', icon: '⚿' },
];

export const TAB_ALIASES = {
  investments: 'enrollments',
  pension: 'enrollments',
  ledger: 'transactions',
};

export function normaliseTab(tab) {
  if (!tab) return 'profile';
  const key = TAB_ALIASES[tab] ?? tab;
  return PROFILE_TABS.some((entry) => entry.key === key) ? key : 'profile';
}
