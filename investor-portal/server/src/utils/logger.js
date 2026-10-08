/**
 * Structured JSON logger (stdout) with sensitive-field masking, request ids and
 * child bindings. Zero dependencies: plain node:util formatting.
 */
import { inspect } from 'node:util';
import { config } from '../config/index.js';
import { maskValue, scrubText } from './mask.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

export function setLogLevel(level) {
  currentLevel = LEVELS[String(level).toLowerCase()] ?? currentLevel;
}

function serializeError(err) {
  if (!err) return undefined;
  return {
    name: err.name,
    message: scrubText(String(err.message ?? '')),
    code: err.code,
    status: err.status,
    stack: config.isProd ? undefined : String(err.stack ?? '').split('\n').slice(0, 12).join('\n'),
  };
}

function emit(level, message, meta) {
  if (LEVELS[level] < currentLevel) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: scrubText(String(message)),
    ...(meta && typeof meta === 'object' ? maskValue(meta) : {}),
  };
  const line = `${JSON.stringify(payload)}\n`;
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

function buildLogger(bindings = {}) {
  const logger = {
    bindings,
    child(extra) {
      return buildLogger({ ...bindings, ...extra });
    },
    debug: (msg, meta) => emit('debug', msg, { ...bindings, ...(meta ?? {}) }),
    info: (msg, meta) => emit('info', msg, { ...bindings, ...(meta ?? {}) }),
    warn: (msg, meta) => emit('warn', msg, { ...bindings, ...(meta ?? {}) }),
    error: (msg, meta) => {
      const m = meta && typeof meta === 'object' ? { ...meta } : meta ? { meta } : {};
      if (m.err instanceof Error) {
        m.err = serializeError(m.err);
      }
      emit('error', msg, { ...bindings, ...m });
    },
    /** Compact non-JSON dump, useful while developing. */
    pretty: (label, value) => {
      if (config.isProd) return;
      process.stdout.write(`${label}: ${inspect(maskValue(value), { depth: 5, colors: false })}\n`);
    },
    level: () => Object.keys(LEVELS).find((k) => LEVELS[k] === currentLevel) ?? 'info',
  };
  return logger;
}

export const logger = buildLogger();

/** Wraps an async job/operation: logs duration + outcome, never throws. */
export async function withLogging(name, fn, log = logger) {
  const started = Date.now();
  try {
    const result = await fn();
    log.info(`${name} finished`, { durationMs: Date.now() - started, result: summarize(result) });
    return { ok: true, result };
  } catch (err) {
    log.error(`${name} failed`, { err, durationMs: Date.now() - started });
    return { ok: false, error: err };
  }
}

function summarize(result) {
  if (result === undefined || result === null) return result;
  if (typeof result !== 'object') return result;
  if (Array.isArray(result)) return { count: result.length };
  return maskValue(result);
}
