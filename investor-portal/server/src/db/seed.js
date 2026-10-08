/**
 * Seed script.
 *   npm run seed                       -> first Super Admin (+ sample data in dev)
 *   npm run seed -- --no-sample        -> admins only
 *   npm run seed -- --reset-passwords  -> also reset the seeded admin passwords
 *
 * Idempotent: safe to run repeatedly. Passwords come from env when provided:
 *   SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD
 *   SEED_ACCOUNTANT_EMAIL  / SEED_ACCOUNTANT_PASSWORD
 *   SEED_VIEWER_EMAIL      / SEED_VIEWER_PASSWORD
 */
import { randomBytes } from 'node:crypto';
import { query, closePool } from './pool.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { assertPasswordPolicy, encryptField, hashPassword, last4, nidHash } from '../services/crypto.service.js';
import { ensureFirstSuperAdmin } from '../services/auth.service.js';
import { createInvestor } from '../services/investor.service.js';
import { createInvestment } from '../services/investment.service.js';
import { issueToken } from '../services/paylink.service.js';
import { addDays, dhakaDate } from '../utils/dates.js';
import { formatBDT } from '../utils/money.js';

const args = process.argv.slice(2);
const withSample = !args.includes('--no-sample');
const resetPasswords = args.includes('--reset-passwords');

function envPassword(name, fallback) {
  const value = process.env[name];
  if (value) return value;
  return fallback;
}

function generatePassword(name) {
  // Strong, policy-compliant, printed once for the operator.
  return `${name}-${randomBytes(9).toString('base64url')}Aa1!`;
}

async function upsertAdmin({ name, email, password, role, mustChange = true }) {
  const existing = await query('select id, role, is_active from admins where lower(email) = lower($1)', [email]);
  if (existing.rows[0]) {
    if (resetPasswords) {
      assertPasswordPolicy(password, { email, name });
      await query('update admins set password_hash = $2, must_change_password = $3, failed_login_count = 0, locked_until = null where id = $1', [
        existing.rows[0].id,
        await hashPassword(password),
        mustChange,
      ]);
      return { id: existing.rows[0].id, email, created: false, passwordReset: true };
    }
    return { id: existing.rows[0].id, email, created: false, passwordReset: false };
  }
  assertPasswordPolicy(password, { email, name });
  const res = await query(
    `insert into admins (name, email, password_hash, role, must_change_password)
     values ($1, lower($2), $3, $4, $5) returning id`,
    [name, email, await hashPassword(password), role, mustChange],
  );
  return { id: res.rows[0].id, email, created: true };
}

async function main() {
  logger.info('seeding database', { env: config.nodeEnv, withSample, resetPasswords });

  // --- admins -------------------------------------------------------------
  const superEmail = process.env.SEED_SUPER_ADMIN_EMAIL || 'superadmin@investorportal.test';
  const superPassword = envPassword('SEED_SUPER_ADMIN_PASSWORD', 'Portal#Root#2026!');

  const bootstrap = await ensureFirstSuperAdmin({
    name: process.env.SEED_SUPER_ADMIN_NAME || 'Super Admin',
    email: superEmail,
    password: superPassword,
  }).catch(async (err) => {
    if (String(err?.message ?? '').includes('at least 12')) throw err;
    throw err;
  });

  const created = [];
  if (bootstrap.created) {
    created.push({ ...bootstrap.admin, password: superPassword, role: 'SUPER_ADMIN' });
  } else {
    const result = await upsertAdmin({
      name: process.env.SEED_SUPER_ADMIN_NAME || 'Super Admin',
      email: superEmail,
      password: superPassword,
      role: 'SUPER_ADMIN',
    });
    if (result.created) created.push({ ...result, password: superPassword, role: 'SUPER_ADMIN' });
  }

  const accountantEmail = process.env.SEED_ACCOUNTANT_EMAIL || 'accountant@investorportal.test';
  const accountantPassword = envPassword('SEED_ACCOUNTANT_PASSWORD', 'Portal#Ledger#2026!');
  const accountant = await upsertAdmin({
    name: 'Accounts Officer',
    email: accountantEmail,
    password: accountantPassword,
    role: 'ACCOUNTANT',
  });
  if (accountant.created) created.push({ ...accountant, password: accountantPassword, role: 'ACCOUNTANT' });

  const viewerEmail = process.env.SEED_VIEWER_EMAIL || 'viewer@investorportal.test';
  const viewerPassword = envPassword('SEED_VIEWER_PASSWORD', 'Portal#Reports#2026!');
  const viewer = await upsertAdmin({ name: 'Report Viewer', email: viewerEmail, password: viewerPassword, role: 'VIEWER' });
  if (viewer.created) created.push({ ...viewer, password: viewerPassword, role: 'VIEWER' });

  const adminRow = await query(`select * from admins where role = 'SUPER_ADMIN' order by id asc limit 1`);
  const actor = adminRow.rows[0];

  // --- sample data --------------------------------------------------------
  let sample = null;
  if (withSample) {
    const investorCount = await query('select count(*)::int as count from investors');
    if (investorCount.rows[0].count === 0) {
      sample = await createSampleData(actor);
    } else {
      logger.info('sample data skipped (investors already exist)');
      sample = await summariseExisting();
    }
  }

  // --- report -------------------------------------------------------------
  process.stdout.write('\n================ Seed summary ================\n');
  if (created.length > 0) {
    process.stdout.write('Administrators created (change these passwords after first login):\n');
    for (const admin of created) {
      process.stdout.write(`  ${admin.role.padEnd(11)} ${admin.email}  password: ${admin.password}\n`);
    }
  } else {
    process.stdout.write('Administrators already present (use --reset-passwords to reset them).\n');
    process.stdout.write(`  ${superEmail}\n  ${accountantEmail}\n  ${viewerEmail}\n`);
  }
  if (sample) {
    process.stdout.write(`\nSample data: ${sample.investors} investor(s), ${sample.investments} investment(s), ${sample.installments} installment(s)\n`);
    process.stdout.write(`Sample investor mobile: ${sample.mobile} (no login required - payment links are sent by SMS)\n`);
    if (sample.payUrl) process.stdout.write(`Sample payment link: ${sample.payUrl}\n`);
  }
  process.stdout.write('=============================================\n\n');
  await closePool();
}

async function createSampleData(actor) {
  const today = dhakaDate();
  const investors = [
    {
      name: 'Rahim Uddin',
      mobile: '01711000111',
      nid: '1990123456789',
      address: 'House 12, Road 4, Dhanmondi, Dhaka',
      nominees: [
        { name: 'Rahima Begum', relation: 'Spouse', mobile: '01711000112', share_percent: 60, nid: '1990123456790' },
        { name: 'Tanvir Uddin', relation: 'Son', mobile: '01711000113', share_percent: 40 },
      ],
    },
    {
      name: 'Karim Sheikh',
      mobile: '01711000222',
      nid: '1985123456789',
      address: 'Plot 7, Uttara Sector 10, Dhaka',
      nominees: [{ name: 'Salma Sheikh', relation: 'Spouse', mobile: '01711000223', share_percent: 100 }],
    },
    {
      name: 'Nusrat Jahan',
      mobile: '01711000333',
      address: 'Chattogram, Agrabad',
      nominees: [],
    },
  ];

  const createdInvestors = [];
  for (const investor of investors) {
    const row = await createInvestor(
      {
        name: investor.name,
        mobile: investor.mobile,
        nid: investor.nid,
        address: investor.address,
        status: 'ACTIVE',
        notes: 'Created by seed script',
        nominees: investor.nominees,
      },
      actor,
      null,
    );
    createdInvestors.push(row);
  }

  const investments = [];
  const plans = [
    { investorIndex: 0, totalAmount: 1_200_000_00, installmentCount: 12, firstDueDate: addDays(today, 7), interval: 'MONTHLY', title: 'Business expansion capital' },
    { investorIndex: 1, totalAmount: 500_000_00, installmentCount: 10, firstDueDate: addDays(today, 3), interval: 'MONTHLY', title: 'Working capital' },
    { investorIndex: 2, totalAmount: 250_000_00, installmentCount: 5, firstDueDate: addDays(today, -10), interval: 'MONTHLY', title: 'Short term placement' },
  ];
  for (const plan of plans) {
    const result = await createInvestment(
      {
        investorId: createdInvestors[plan.investorIndex].id,
        totalAmount: plan.totalAmount,
        installmentCount: plan.installmentCount,
        firstDueDate: plan.firstDueDate,
        interval: plan.interval,
        title: plan.title,
        notes: 'Seed data',
      },
      actor,
      null,
    );
    investments.push(result);
  }

  // One paid installment (manual cash payment) so the dashboard has history.
  const firstPaymentInstallment = investments[1].installments[0];
  const { recordManualPayment } = await import('../services/payment.service.js');
  await recordManualPayment(
    {
      installmentId: firstPaymentInstallment.id,
      amount: firstPaymentInstallment.amount,
      method: 'CASH',
      reference: `SEED-CASH-${Date.now()}`,
      note: 'Seed sample payment',
      notify: false,
    },
    actor,
    null,
  );

  const linkInstallment = investments[0].installments[0];
  const link = await issueToken(linkInstallment.id, { actor, req: null });

  const totalInstallments = plans.reduce((sum, p) => sum + p.installmentCount, 0);
  process.stdout.write(
    `Seeded ${createdInvestors.length} investors, ${investments.length} investments (${formatBDT(plans[0].totalAmount)} sample amounts), ` +
      `${totalInstallments} installments.\n`,
  );

  return {
    investors: createdInvestors.length,
    investments: investments.length,
    installments: totalInstallments,
    mobile: investors[0].mobile,
    payUrl: link.url,
  };
}

async function summariseExisting() {
  const counts = await query(
    `select (select count(*)::int from investors) as investors,
            (select count(*)::int from investments) as investments,
            (select count(*)::int from installments) as installments`,
  );
  const row = counts.rows[0];
  const investor = await query('select mobile from investors order by id asc limit 1');
  return {
    investors: row.investors,
    investments: row.investments,
    installments: row.installments,
    mobile: investor.rows[0]?.mobile ?? '-',
    payUrl: null,
  };
}

main().catch(async (err) => {
  logger.error('seed failed', { err });
  await closePool().catch(() => {});
  process.exit(1);
});
