/**
 * Structured logging (pino) with aggressive redaction of anything sensitive:
 * passwords, tokens, cookies, NID values and mobile numbers never hit the
 * log files in clear text.
 */
import pino from 'pino';
import type { Logger } from 'pino';
import { config } from '../config';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'payTokenHash',
  '*.payTokenHash',
  'nid',
  '*.nid',
  'nidEncrypted',
  '*.nidEncrypted',
  'mobile',
  '*.mobile',
  'twoFASecret',
  '*.twoFASecret',
  'secret',
  '*.secret',
  'otp',
  '*.otp',
];

export const logger: Logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  base: { service: 'investor-portal-api', env: config.env },
  redact: { paths: redactPaths, censor: '[redacted]' },
  transport: config.isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Child logger used by jobs so their output is easy to grep. */
export const jobLogger = (jobName: string): Logger => logger.child({ job: jobName });
