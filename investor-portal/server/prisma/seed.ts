/**
 * Seed script.
 *
 *   npm run seed              -> first super admin + default settings
 *   SEED_DEMO=1 npm run seed  -> ... plus sample investors / investments / payments
 *
 * Idempotent: running it twice changes nothing (upserts on unique keys).
 *
 * The first super admin is read from:
 *   SEED_SUPER_ADMIN_EMAIL     (default admin@investorportal.local)
 *   SEED_SUPER_ADMIN_PASSWORD  (default: a randomly generated strong password that
 *                               is printed once - never hardcode a password in prod)
 *   SEED_SUPER_ADMIN_NAME      (default "Super Admin")
 */
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { prisma, disconnectPrisma } from '../src/config/prisma';
import { splitIntoInstallments, formatBdt } from '../src/utils/money';
import { addDhakaDays, startOfDhakaDay } from '../src/utils/dates';
import { encrypt, hmac, randomToken, sha256 } from '../src/utils/encryption';
import { emailSchema, passwordSchema } from '../src/validators/auth.validator';
import { logger } from '../src/utils/logger';

const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

function generatePassword(): string {
  // 24 chars, guaranteed to satisfy the password policy
  return `Ip${crypto.randomBytes(9).toString('base64url')}${crypto.randomInt(10, 99)}!`;
}

async function seedSuperAdmin(): Promise<void> {
  const requestedEmail = process.env.SEED_SUPER_ADMIN_EMAIL?.trim() || 'admin@investorportal.local';
  const emailResult = emailSchema.safeParse(requestedEmail);
  if (!emailResult.success) throw new Error('[seed] SEED_SUPER_ADMIN_EMAIL must be a valid email address');
  const email = emailResult.data;
  const name = process.env.SEED_SUPER_ADMIN_NAME?.trim() || 'Super Admin';

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== 'SUPER_ADMIN') {
      throw new Error('[seed] SEED_SUPER_ADMIN_EMAIL belongs to a non-super-admin account; choose another email');
    }
    logger.info({ email }, 'super admin already exists - password left unchanged');
    return;
  }

  // Bootstrap only an empty admin table. A changed SEED_SUPER_ADMIN_EMAIL must
  // never silently create an extra privileged account on a later deployment.
  const existingSuperAdmin = await prisma.admin.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { id: true },
  });
  if (existingSuperAdmin) {
    logger.info({ adminId: existingSuperAdmin.id }, 'a super admin already exists - bootstrap account left unchanged');
    return;
  }

  const configuredPassword = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const generated = !configuredPassword?.trim();
  const password = generated ? generatePassword() : configuredPassword!;
  if (!passwordSchema.safeParse(password).success) {
    throw new Error(
      '[seed] SEED_SUPER_ADMIN_PASSWORD must be 10-200 characters, include a letter and number, and have no outer spaces',
    );
  }

  await prisma.admin.create({
    data: {
      name,
      email,
      role: 'SUPER_ADMIN',
      passwordHash: await argon2.hash(password, ARGON_OPTIONS),
    },
  });

  logger.info({ email, role: 'SUPER_ADMIN' }, 'super admin created');
  if (generated) {
    // eslint-disable-next-line no-console
    console.log(
      `\n  ┌──────────────────────────────────────────────────────────────┐\n` +
        `  │ FIRST SUPER ADMIN CREDENTIALS (shown once - save them now)   │\n` +
        `  ├──────────────────────────────────────────────────────────────┤\n` +
        `  │ email:    ${email.padEnd(51)}│\n` +
        `  │ password: ${password.padEnd(51)}│\n` +
        `  └──────────────────────────────────────────────────────────────┘\n`,
    );
  }
}

async function seedSettings(): Promise<void> {
  const defaults: Array<[string, string]> = [
    ['payment_link_ttl_days', '7'],
    ['reminder_days_before', '3'],
    ['company_name', 'Investor Installment Portal'],
    ['receipt_prefix', 'RC'],
  ];
  for (const [key, value] of defaults) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }
  logger.info('default settings ensured');
}

async function seedDemoData(): Promise<void> {
  const investors = [
    { name: 'Md. Rahim Uddin', mobile: '01711000001', nid: '1990123456789', address: 'Mirpur, Dhaka' },
    { name: 'Fatema Begum', mobile: '01711000002', nid: '1985987654321', address: 'Uttara, Dhaka' },
    { name: 'Karim Traders (Prop. Karim)', mobile: '01711000003', nid: '1980555666777', address: 'Chattogram' },
  ];

  for (const [index, record] of investors.entries()) {
    const investor = await prisma.investor.upsert({
      where: { mobile: record.mobile },
      update: {},
      create: {
        name: record.name,
        mobile: record.mobile,
        nidEncrypted: encrypt(record.nid),
        nidHash: hmac(record.nid),
        address: record.address,
        status: 'ACTIVE',
      },
    });

    const existingInvestment = await prisma.investment.findFirst({ where: { investorId: investor.id } });
    if (existingInvestment) continue;

    const total = BigInt((index + 1) * 500_000) * 100n; // 5,00,000 BDT * (index+1) in poisha
    const count = 4;
    const firstDue = addDhakaDays(startOfDhakaDay(), index === 2 ? -45 : 5);

    await prisma.$transaction(async (tx) => {
      const investment = await tx.investment.create({
        data: {
          investorId: investor.id,
          totalAmount: total,
          installmentCount: count,
          status: 'ACTIVE',
          notes: 'Seed data',
        },
      });

      const amounts = splitIntoInstallments(total, count);
      for (let i = 0; i < count; i += 1) {
        const dueDate = addDhakaDays(firstDue, i * 30);
        const token = randomToken(32);
        await tx.installment.create({
          data: {
            investmentId: investment.id,
            serial: i + 1,
            amount: amounts[i]!,
            dueDate,
            status: 'PENDING',
            payTokenHash: sha256(token),
            tokenExpiresAt: addDhakaDays(dueDate, 7),
          },
        });
      }

      await tx.nominee.create({
        data: {
          investorId: investor.id,
          name: `${record.name.split(' ')[0]}'s spouse`,
          relation: 'Spouse',
          mobile: '01719990001',
          nidEncrypted: encrypt('1991111222333'),
          sharePercent: 100,
        },
      });
    });

    logger.info({ investor: investor.name, total: formatBdt(total) }, 'demo investment created');
  }
}

async function main(): Promise<void> {
  const seedDemo = process.env.SEED_DEMO === '1' || process.argv.includes('--demo');
  if (seedDemo && process.env.VERCEL_ENV === 'production') {
    throw new Error('[seed] demo records are disabled on Vercel production');
  }

  await seedSuperAdmin();
  await seedSettings();
  if (seedDemo) {
    await seedDemoData();
  }
  logger.info('seed complete');
  await disconnectPrisma();
}

main().catch(async (error) => {
  logger.error({ err: error }, 'seed failed');
  await disconnectPrisma();
  process.exit(1);
});
