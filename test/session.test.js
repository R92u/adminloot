import test from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual, createSessionToken, verifySessionToken } from '../src/session.js';

const secret = 'session-secret-with-more-than-thirty-two-characters';

test('creates and verifies a signed session', () => {
  const created = createSessionToken({ secret, ttlMs: 60_000, now: 1_000 });
  const verified = verifySessionToken(created.token, { secret, now: 2_000 });
  assert.equal(verified.csrf, created.session.csrf);
  assert.equal(verified.exp, 61_000);
});

test('rejects tampered and expired sessions', () => {
  const created = createSessionToken({ secret, ttlMs: 1_000, now: 1_000 });
  assert.equal(verifySessionToken(`${created.token}x`, { secret, now: 1_500 }), null);
  assert.equal(verifySessionToken(created.token, { secret, now: 2_001 }), null);
});

test('constant time helper compares values', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
});
