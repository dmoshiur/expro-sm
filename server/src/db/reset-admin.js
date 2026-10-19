/**
 * Manual admin password reset / Super Admin recovery.
 *
 *   npm run reset-admin
 *     -> uses SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD from the
 *        environment (Render Shell: the service env vars are already there).
 *   npm run reset-admin -- --email admin@example.com --password 'New#Pass#2026!'
 *   npm run reset-admin -- --email admin@example.com        (password from env)
 *
 * What it does:
 *   - existing admin  -> force re-hash + update the password, clear any
 *                        lockout, re-activate the account, revoke all live
 *                        sessions, and (by default) force a password change
 *                        at next login. The account's role is kept.
 *   - no such admin   -> created as a SUPER_ADMIN by default (recovery path);
 *                        pass --no-create to fail instead, --role / --name to
 *                        control what gets created.
 * The email is matched case/space-insensitively and the password is trimmed,
 * exactly like the login flow. The password itself is never printed.
 *
 * Prefer passing the password through the environment: a --password argument
 * is visible in shell history and the process list.
 *
 * Exit code 0 only when the stored hash was written AND re-verified.
 */
import { closeDatabase } from './client.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { normalizeEmail, normalizePasswordInput } from '../utils/validate.js';
import { verifyPassword } from '../services/crypto.service.js';
import {
  ROLES,
  findAdminByEmail,
  forceResetAdminPasswordByEmail,
  syncSeedAdmin,
} from '../services/auth.service.js';

const USAGE = `Usage: npm run reset-admin -- [options]

Options:
  --email <email>        Admin email (default: SEED_SUPER_ADMIN_EMAIL)
  --password <password>  New password (default: SEED_SUPER_ADMIN_PASSWORD)
                         Prefer the env var: CLI args show in shell history.
  --name <name>          Display name when creating (default: "Super Admin")
  --role <role>          Role when creating: SUPER_ADMIN | ACCOUNTANT | VIEWER
                         (default: SUPER_ADMIN; existing admins keep their role)
  --no-create            Fail instead of creating when the email is unknown
  --no-must-change       Do not force a password change at next login
  --help                 Show this help

Password policy: at least 12 characters with an uppercase letter, a lowercase
letter, a digit and a symbol, and it must not contain the email name.
`;

function parseArgs(argv) {
  const out = { create: true, mustChange: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s).filter((_, idx) => idx < 2) : [arg, undefined];
    const takeValue = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    switch (flag) {
      case '--email': out.email = takeValue(); break;
      case '--password': out.password = takeValue(); break;
      case '--name': out.name = takeValue(); break;
      case '--role': out.role = takeValue(); break;
      case '--create': out.create = true; break;
      case '--no-create': out.create = false; break;
      case '--must-change': out.mustChange = true; break;
      case '--no-must-change': out.mustChange = false; break;
      case '--help':
      case '-h': out.help = true; break;
      // Only the flag name is echoed: the raw arg could carry a password value.
      default: throw new Error(`Unknown option: ${flag}\n\n${USAGE}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const email = normalizeEmail(
    args.email ?? process.env.RESET_ADMIN_EMAIL ?? config.seed.superAdminEmail,
  );
  const password = normalizePasswordInput(
    args.password ?? process.env.RESET_ADMIN_PASSWORD ?? config.seed.superAdminPassword,
  );
  const name = String(args.name ?? config.seed.superAdminName ?? 'Super Admin').trim() || 'Super Admin';
  const role = String(args.role ?? 'SUPER_ADMIN').trim().toUpperCase();

  if (!ROLES.includes(role)) {
    throw new Error(`Invalid --role "${args.role}". Expected one of: ${ROLES.join(', ')}`);
  }
  if (!email || !password) {
    process.stderr.write(
      'An email and a password are required.\n' +
        'Set SEED_SUPER_ADMIN_EMAIL + SEED_SUPER_ADMIN_PASSWORD in the environment ' +
        '(Render dashboard -> Environment), or pass --email / --password.\n\n' +
        USAGE,
    );
    process.exitCode = 1;
    return;
  }

  const passwordSource = args.password !== undefined
    ? '--password argument'
    : process.env.RESET_ADMIN_PASSWORD
      ? 'RESET_ADMIN_PASSWORD'
      : 'SEED_SUPER_ADMIN_PASSWORD';

  const existing = await findAdminByEmail(email);
  let admin;
  let action;
  if (existing) {
    admin = await forceResetAdminPasswordByEmail(email, password, {
      mustChangePassword: args.mustChange,
      source: 'reset-admin-cli',
    });
    action = 'password reset';
  } else if (args.create) {
    const result = await syncSeedAdmin(
      { name, email, password, role },
      { mustChangePassword: args.mustChange, forcePassword: true, source: 'reset-admin-cli' },
    );
    admin = result.admin;
    action = 'admin created';
  } else {
    process.stderr.write(
      `No admin found for ${email} and --no-create was given. ` +
        'Check the spelling, or re-run without --no-create to create the account.\n',
    );
    process.exitCode = 1;
    return;
  }

  // Read back and verify, so a green result really means "login will work".
  const stored = await findAdminByEmail(email);
  const verified = Boolean(stored) && (await verifyPassword(password, stored.password_hash));
  if (!verified) {
    throw new Error('Password was written but does not verify on read-back - investigate before relying on it.');
  }

  process.stdout.write(
    `\nOK: ${action} for ${admin.email} (id ${admin.id}, role ${admin.role}).\n` +
      `  password source : ${passwordSource} (verified against the stored hash)\n` +
      `  account active  : ${admin.is_active ? 'yes' : 'no'}   lockout cleared: yes   sessions revoked: yes\n` +
      `  must change pwd : ${args.mustChange ? 'yes (forced at next login)' : 'no'}\n` +
      'Log in with this email + password. If you used SEED_* variables, change the\n' +
      'password in the app and then remove SEED_SUPER_ADMIN_* from the environment\n' +
      '(or set SEED_SUPER_ADMIN_ON_START=false) so a later restart cannot reset it.\n\n',
  );
}

main()
  .catch((err) => {
    // err.message for WEAK_PASSWORD explains the policy without echoing secrets.
    logger.error('reset-admin failed', { err });
    process.stderr.write(`\nreset-admin failed: ${err?.message ?? err}\n`);
    if (err?.code === 'WEAK_PASSWORD') {
      process.stderr.write(
        'Fix the password (at least 12 characters with an uppercase letter, a lowercase letter,\n' +
          'a digit and a symbol, not containing the email name) in SEED_SUPER_ADMIN_PASSWORD / --password.\n',
      );
    }
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
