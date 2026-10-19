/**
 * Seed script.
 *   npm run seed                       -> first Super Admin (+ sample data in dev)
 *   npm run seed -- --no-sample        -> admins only
 *   npm run seed -- --reset-passwords  -> force-reset the seeded admin passwords
 *   npm run seed -- --sample           -> sample data (required in production; dev default)
 * In production SEED_SUPER_ADMIN_PASSWORD (and the other SEED_*_PASSWORD values) are required.
 *
 * Idempotent: safe to run repeatedly. Passwords come from env when provided:
 *   SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD
 *   SEED_ACCOUNTANT_EMAIL  / SEED_ACCOUNTANT_PASSWORD
 *   SEED_VIEWER_EMAIL      / SEED_VIEWER_PASSWORD
 *
 * Existing seeded admins are SYNCED, not skipped: when the stored hash does
 * not verify against the env password it is re-hashed and updated (lockout
 * cleared, sessions revoked) - the same sync the server runs at startup while
 * SEED_SUPER_ADMIN_* is set. `--reset-passwords` forces a re-hash even when
 * the password already matches. For a targeted one-account reset without
 * touching sample data, prefer `npm run reset-admin` (db/reset-admin.js).
 */
import { randomBytes } from 'node:crypto';
import { query, closeDatabase } from './client.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { syncSeedAdmin, syncSeedSuperAdmin } from '../services/auth.service.js';
import { createInvestor } from '../services/investor.service.js';
import { createInvestment } from '../services/investment.service.js';
import { issueToken } from '../services/paylink.service.js';
import { addDays, dhakaDate } from '../utils/dates.js';
import { formatBDT } from '../utils/money.js';
import { normalizeEmail, normalizePasswordInput } from '../utils/validate.js';
import { AppError } from '../utils/errors.js';

const args = process.argv.slice(2);
// Sample data is for development only. Production seeding needs an explicit --sample.
const withSample = config.isProd ? args.includes('--sample') : !args.includes('--no-sample');
const resetPasswords = args.includes('--reset-passwords');

function envPassword(name, fallback) {
  // Trimmed: passwords are trimmed at login, so an env value pasted with a
  // trailing space/newline must hash to the same password the admin types.
  const value = normalizePasswordInput(process.env[name]);
  if (value) return value;
  if (config.isProd) {
    // Never create production admins with the well-known development fallbacks.
    throw new Error(`${name} is required when NODE_ENV=production (no default passwords in production)`);
  }
  return fallback;
}

function generatePassword(name) {
  // Strong, policy-compliant, printed once for the operator.
  return `${name}-${randomBytes(9).toString('base64url')}Aa1!`;
}

/** Re-throws WEAK_PASSWORD naming the SEED_* variable so operators know which one to fix. */
function withPasswordEnvContext(envName, promise) {
  return promise.catch((err) => {
    if (err && err.code === 'WEAK_PASSWORD') {
      throw new AppError(err.status, 'WEAK_PASSWORD', `${envName}: ${err.message}`, err.details);
    }
    throw err;
  });
}

/**
 * Create-or-sync one seeded admin via auth.service (shared with the startup
 * env sync): an existing account whose hash no longer verifies against the
 * env password gets its password re-hashed instead of being skipped.
 */
async function upsertAdmin({ name, email, password, role, mustChange = true }) {
  const result = await syncSeedAdmin(
    { name, email: normalizeEmail(email), password, role },
    { mustChangePassword: mustChange, forcePassword: resetPasswords, source: 'seed' },
  );
  return {
    id: result.admin.id,
    email: result.admin.email,
    created: result.created,
    updated: result.updated,
    passwordReset: result.passwordReset,
  };
}

async function main() {
  logger.info('seeding database', { env: config.nodeEnv, withSample, resetPasswords });

  // --- admins -------------------------------------------------------------
  // Emails/passwords are normalised (trim + lower-case / trim) so values
  // pasted into a hosting dashboard match what the login form will send.
  const created = [];
  const passwordResets = [];
  const noteResult = (result, password, role) => {
    if (result.created) created.push({ ...result, password, role });
    else if (result.passwordReset) passwordResets.push({ ...result, role });
  };

  const superEmail = normalizeEmail(process.env.SEED_SUPER_ADMIN_EMAIL) || 'superadmin@investorportal.test';
  const superPassword = envPassword('SEED_SUPER_ADMIN_PASSWORD', 'Portal#Root#2026!');
  const superAdmin = await withPasswordEnvContext(
    'SEED_SUPER_ADMIN_PASSWORD',
    syncSeedSuperAdmin(
      {
        name: String(process.env.SEED_SUPER_ADMIN_NAME ?? '').trim() || 'Super Admin',
        email: superEmail,
        password: superPassword,
      },
      { forcePassword: resetPasswords, source: 'seed' },
    ).then((result) => ({
      id: result.admin.id,
      email: result.admin.email,
      created: result.created,
      updated: result.updated,
      passwordReset: result.passwordReset,
    })),
  );
  noteResult(superAdmin, superPassword, 'SUPER_ADMIN');

  const accountantEmail = normalizeEmail(process.env.SEED_ACCOUNTANT_EMAIL) || 'accountant@investorportal.test';
  const accountantPassword = envPassword('SEED_ACCOUNTANT_PASSWORD', 'Portal#Ledger#2026!');
  const accountant = await withPasswordEnvContext(
    'SEED_ACCOUNTANT_PASSWORD',
    upsertAdmin({
      name: 'Accounts Officer',
      email: accountantEmail,
      password: accountantPassword,
      role: 'ACCOUNTANT',
    }),
  );
  noteResult(accountant, accountantPassword, 'ACCOUNTANT');

  const viewerEmail = normalizeEmail(process.env.SEED_VIEWER_EMAIL) || 'viewer@investorportal.test';
  const viewerPassword = envPassword('SEED_VIEWER_PASSWORD', 'Portal#Reports#2026!');
  const viewer = await withPasswordEnvContext(
    'SEED_VIEWER_PASSWORD',
    upsertAdmin({ name: 'Report Viewer', email: viewerEmail, password: viewerPassword, role: 'VIEWER' }),
  );
  noteResult(viewer, viewerPassword, 'VIEWER');

  const adminRow = await query(`select * from admins where role = 'SUPER_ADMIN' order by id asc limit 1`);
  const actor = adminRow.rows[0];

  // --- sample data --------------------------------------------------------
  let sample = null;
  if (withSample) {
    const investorCount = await query('select count(*) as count from investors');
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
  }
  if (passwordResets.length > 0) {
    process.stdout.write('Administrators whose password was updated to match the SEED_* env value (change it after first login):\n');
    for (const admin of passwordResets) {
      process.stdout.write(`  ${admin.role.padEnd(11)} ${admin.email}\n`);
    }
  }
  if (created.length === 0 && passwordResets.length === 0) {
    process.stdout.write('Administrators already present and already in sync with the SEED_* passwords.\n');
    process.stdout.write(`  ${superEmail}\n  ${accountantEmail}\n  ${viewerEmail}\n`);
  }
  if (sample) {
    process.stdout.write(`\nSample data: ${sample.investors} investor(s), ${sample.investments} investment(s), ${sample.installments} installment(s)\n`);
    process.stdout.write(`Sample investor mobile: ${sample.mobile}\n`);
    if (sample.portalPassword) {
      process.stdout.write(
        `Investor portal demo login (${sample.memberCode}): mobile ${sample.mobile} / password ${sample.portalPassword} at /portal/login (temporary - change on first login)\n`,
      );
    }
    if (sample.payUrl) process.stdout.write(`Sample payment link: ${sample.payUrl}\n`);
  }
  process.stdout.write('=============================================\n\n');
  closeDatabase();
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

  // The first sample investor gets portal access with a known temporary
  // password (override with SEED_INVESTOR_PASSWORD) + a mostly complete
  // profile, so the investor portal can be tried immediately after seeding.
  const portalPassword = normalizePasswordInput(process.env.SEED_INVESTOR_PASSWORD) || 'Investor#2026Portal';

  const createdInvestors = [];
  for (const [index, investor] of investors.entries()) {
    const row = await createInvestor(
      {
        name: investor.name,
        mobile: investor.mobile,
        nid: investor.nid,
        address: investor.address,
        status: 'ACTIVE',
        notes: 'Created by seed script',
        nominees: investor.nominees,
        ...(index === 0
          ? {
              email: 'demo.investor@test.local',
              date_of_birth: '1990-05-14',
              gender: 'MALE',
              father_name: 'Abdul Karim',
              mother_name: 'Fatema Begum',
              religion: 'Islam',
              present_address: investor.address,
              permanent_address: 'Village North Char, Bogura',
              portal: { enabled: true, password: portalPassword },
            }
          : {}),
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
    memberCode: createdInvestors[0].member_code,
    portalPassword: createdInvestors[0].portal?.tempPassword ?? null,
    payUrl: link.url,
  };
}

async function summariseExisting() {
  const counts = await query(
    `select (select count(*) from investors) as investors,
            (select count(*) from investments) as investments,
            (select count(*) from installments) as installments`,
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
  closeDatabase();
  process.exit(1);
});
