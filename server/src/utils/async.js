/** Async route wrapper: forwarded rejections reach the central error handler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Wrap every handler of a controller object. */
export function wrapAll(handlers) {
  const out = {};
  for (const [key, fn] of Object.entries(handlers)) {
    out[key] = typeof fn === 'function' ? asyncHandler(fn) : fn;
  }
  return out;
}
