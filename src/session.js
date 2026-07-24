import crypto from 'node:crypto';

export function constantTimeEqual(first, second) {
  const a = Buffer.from(String(first ?? ''));
  const b = Buffer.from(String(second ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken({ secret, ttlMs, now = Date.now() }) {
  const session = {
    exp: now + ttlMs,
    csrf: crypto.randomBytes(24).toString('base64url'),
    nonce: crypto.randomBytes(16).toString('base64url')
  };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return {
    token: `${payload}.${signature(payload, secret)}`,
    session
  };
}

export function verifySessionToken(token, { secret, now = Date.now() }) {
  const [payload, suppliedSignature, extra] = String(token || '').split('.');
  if (!payload || !suppliedSignature || extra) return null;
  const expectedSignature = signature(payload, secret);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session || typeof session !== 'object') return null;
    if (!Number.isFinite(Number(session.exp)) || Number(session.exp) <= now) return null;
    if (typeof session.csrf !== 'string' || session.csrf.length < 20) return null;
    if (typeof session.nonce !== 'string' || session.nonce.length < 10) return null;
    return session;
  } catch {
    return null;
  }
}
