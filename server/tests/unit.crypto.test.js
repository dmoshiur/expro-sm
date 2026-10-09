/** Password hashing, AES-256-GCM round trip, blind index and RFC 6238 TOTP vectors. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prepareEnv } from './helpers/harness.js';

prepareEnv();

const {
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
  encryptField,
  decryptField,
  encryptBuffer,
  decryptBuffer,
  blindIndex,
  nidHash,
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  totpUri,
  base32Encode,
  base32Decode,
  groupSecret,
  hashToken,
  generateSessionToken,
} = await import('../src/services/crypto.service.js');

test('password hashing: scrypt with a random salt, verifiable, non-reversible', async () => {
  const hash = await hashPassword('Harness#Secret#2026!x');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('Harness#Secret#2026!x', hash), true);
  assert.equal(await verifyPassword('Harness#Secret#2026!y', hash), false);

  const other = await hashPassword('Harness#Secret#2026!x');
  assert.notEqual(hash, other, 'each hash must use a fresh salt');
  assert.equal(await verifyPassword('Harness#Secret#2026!x', other), true);
});

test('password hashing rejects malformed stored values without throwing', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('anything', 'scrypt$1$2$3$4'), false);
  assert.equal(await verifyPassword('', ''), false);
});

test('password policy enforces length, classes and personal references', () => {
  assert.throws(() => assertPasswordPolicy('short1!A'), /not strong enough/);
  assert.throws(() => assertPasswordPolicy('alllowercase1!'), /uppercase/);
  assert.throws(() => assertPasswordPolicy('NoDigitsHere!!'), /digit/);
  assert.throws(() => assertPasswordPolicy('N0SymbolsHere'), /symbol/);
  assert.throws(() => assertPasswordPolicy('MyNameIsX1!bcdef', { name: 'MyNameIsX' }), /your name/);
  assert.throws(() => assertPasswordPolicy('Somebody1!xyzAbc', { email: 'somebody@test.local' }), /email name/);
  assert.equal(assertPasswordPolicy('Apricot#Harbor#2026!v', { email: 'root@test.local', name: 'Test Root' }), true);
});

test('AES-256-GCM field encryption round-trips and authenticates', () => {
  const plaintext = '1990123456789';
  const cipher = encryptField(plaintext, { aad: 'investor:nid' });
  assert.match(cipher, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(cipher, plaintext);
  assert.equal(decryptField(cipher, { aad: 'investor:nid' }), plaintext);

  // Same plaintext must produce different ciphertext (random IV)
  assert.notEqual(encryptField(plaintext, { aad: 'investor:nid' }), cipher);

  // Wrong AAD / tampered ciphertext must fail, and never leak why
  assert.throws(() => decryptField(cipher, { aad: 'investor:other' }), /could not be decrypted/);
  const parts = cipher.split('.');
  parts[3] = `${parts[3].slice(0, -2)}AB`;
  assert.throws(() => decryptField(parts.join('.'), { aad: 'investor:nid' }), /could not be decrypted/);
  assert.throws(() => decryptField('garbage'), /not decryptable/);
});

test('AES-256-GCM round-trips binary buffers (NID scans)', () => {
  const buffer = randomBytes(2048);
  const cipher = encryptBuffer(buffer, { aad: 'investor:1:nid_scan' });
  const back = decryptBuffer(cipher, { aad: 'investor:1:nid_scan' });
  assert.equal(Buffer.compare(buffer, back), 0);
});

test('blind index is deterministic, keyed and normalises case', () => {
  assert.equal(nidHash('1990123456789'), nidHash('1990-1234-56789'.replace(/-/g, '')));
  assert.equal(blindIndex('abc', 'nid'), blindIndex('ABC', 'nid'));
  assert.notEqual(blindIndex('abc', 'nid'), blindIndex('abc', 'other'));
  assert.equal(nidHash(''), null);
  assert.match(nidHash('1990123456789'), /^[0-9a-f]{64}$/);
});

test('session tokens are 256-bit, URL-safe and only stored as hashes', () => {
  const token = generateSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  const hash = hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
  assert.notEqual(generateSessionToken(), token);
});

// ---------------------------------------------------------------------------
// RFC 6238 test vectors (SHA-1, 8 digits, 20-byte secret "12345678901234567890")
// ---------------------------------------------------------------------------
test('TOTP matches the RFC 6238 appendix B test vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  // Note: expected values are strings - Annex B's value for T=1111111109 has a
  // leading zero (07081804) that a numeric literal would drop.
  const vectors = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    const code = generateTotp(secret, { instantMs: seconds * 1000, digits: 8 });
    assert.equal(code, expected, `TOTP at T=${seconds}`);
  }
});

test('TOTP verify honours the drift window, rejects wrong/old codes and replay', () => {
  const secret = generateTotpSecret();
  const now = 1_800_000_000_000;
  const current = generateTotp(secret, { instantMs: now });

  assert.equal(verifyTotp(secret, current, { instantMs: now }).ok, true);
  assert.equal(verifyTotp(secret, '000000', { instantMs: now }).ok, false);
  assert.equal(verifyTotp(secret, 'abcdef', { instantMs: now }).ok, false);
  assert.equal(verifyTotp(secret, '', { instantMs: now }).ok, false);

  // Previous step is accepted inside the +/-1 window ...
  const previous = generateTotp(secret, { instantMs: now - 30_000 });
  const previousCheck = verifyTotp(secret, previous, { instantMs: now, window: 1 });
  assert.equal(previousCheck.ok, true);

  // ... but replaying an already-used step fails
  const replayed = verifyTotp(secret, previous, { instantMs: now, window: 1, lastStep: previousCheck.step });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.replayed, true);

  // Codes outside the window are rejected
  const tooOld = generateTotp(secret, { instantMs: now - 10 * 30_000 });
  assert.equal(verifyTotp(secret, tooOld, { instantMs: now, window: 1 }).ok, false);
  assert.equal(verifyTotp(secret, tooOld, { instantMs: now, window: 20 }).ok, true);
});

test('TOTP secret helpers: base32, grouping and otpauth URI', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(Buffer.compare(base32Decode(secret), base32Decode(secret)), 0);
  assert.equal(base32Decode(secret).length, 20);
  assert.equal(groupSecret('ABCDEFGH').replace(/\s/g, ''), 'ABCDEFGH');

  const uri = totpUri(secret, { account: 'admin@test.local', issuer: 'Investor Installment Portal' });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567|secret=/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
  assert.throws(() => base32Decode('!!!!'), /Invalid base32 secret/);
});
