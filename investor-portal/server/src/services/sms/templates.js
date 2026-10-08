/** SMS copy. Never includes NID, address or any data beyond what is needed. */
import { formatBDT } from '../../utils/money.js';
import { firstNameOnly } from '../../utils/mask.js';
import { isoDateOnly } from '../../utils/dates.js';

const SIGNATURE = 'Investor Portal';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-09-28' -> '28 Sep 2026'. Tolerates Date objects and ISO timestamps. */
function shortDate(value) {
  const iso = isoDateOnly(value);
  if (!iso) return 'an earlier date';
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function paymentLinkMessage({ name, serial, amount, dueDate, url }) {
  return (
    `Dear ${firstNameOnly(name)}, your installment #${serial} of ${formatBDT(amount)} ` +
    `is due on ${shortDate(dueDate)}. Pay securely via bKash here: ${url} - ${SIGNATURE}`
  );
}

export function dueReminderMessage({ name, serial, amount, dueDate, url, daysLeft }) {
  const when = daysLeft === 0 ? 'is due today' : `is due in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${shortDate(dueDate)})`;
  return `Reminder: ${firstNameOnly(name)}, your installment #${serial} of ${formatBDT(amount)} ${when}. Pay: ${url} - ${SIGNATURE}`;
}

export function overdueReminderMessage({ name, serial, amount, dueDate, url, daysOverdue }) {
  return (
    `Overdue: ${firstNameOnly(name)}, installment #${serial} of ${formatBDT(amount)} was due on ` +
    `${shortDate(dueDate)} (${daysOverdue} day${daysOverdue === 1 ? '' : 's'} late). Pay now: ${url} - ${SIGNATURE}`
  );
}

export function paymentSuccessMessage({ name, serial, amount, trxId }) {
  return `Payment received: ${firstNameOnly(name)}, ${formatBDT(amount)} for installment #${serial}. TrxID ${trxId}. Thank you. - ${SIGNATURE}`;
}

export function manualPaymentMessage({ name, serial, amount, reference, method }) {
  return (
    `Payment recorded: ${firstNameOnly(name)}, ${formatBDT(amount)} for installment #${serial} ` +
    `via ${method} (ref ${reference}). Thank you. - ${SIGNATURE}`
  );
}

export function testMessage() {
  return `Test message from ${SIGNATURE}. SMS configuration is working.`;
}

export function renderTemplate(templateKey, data) {
  switch (templateKey) {
    case 'PAYMENT_LINK':
      return paymentLinkMessage(data);
    case 'DUE_REMINDER':
      return dueReminderMessage(data);
    case 'OVERDUE_REMINDER':
      return overdueReminderMessage(data);
    case 'PAYMENT_SUCCESS':
      return paymentSuccessMessage(data);
    case 'MANUAL':
      return manualPaymentMessage(data);
    case 'TEST':
      return testMessage();
    default:
      throw new Error(`Unknown SMS template: ${templateKey}`);
  }
}
