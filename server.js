import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constantTimeEqual, createSessionToken, verifySessionToken } from './src/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const APP_VERSION = '1.0.0';
const COOKIE_NAME = 'dota_guess_admin_session';

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeMainSiteUrl(rawValue) {
  const raw = String(rawValue || 'https://dotaguess.onrender.com').trim().replace(/\/+$/, '');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('MAIN_SITE_URL должен начинаться с http:// или https://.');
  }
  return parsed.toString().replace(/\/$/, '');
}

const config = Object.freeze({
  port: parsePositiveInt(process.env.PORT, 3000),
  mainSiteUrl: normalizeMainSiteUrl(process.env.MAIN_SITE_URL),
  mainSiteAdminSecret: String(process.env.MAIN_SITE_ADMIN_SECRET || '').trim(),
  adminPanelPassword: String(process.env.ADMIN_PANEL_PASSWORD || '').trim(),
  sessionSecret: String(process.env.SESSION_SECRET || '').trim(),
  sessionTtlMs: parsePositiveInt(process.env.SESSION_TTL_HOURS, 12) * 60 * 60 * 1000,
  trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  nodeEnv: process.env.NODE_ENV || 'development'
});

function validateConfiguration() {
  const missing = [];
  if (!config.mainSiteAdminSecret) missing.push('MAIN_SITE_ADMIN_SECRET');
  if (!config.adminPanelPassword) missing.push('ADMIN_PANEL_PASSWORD');
  if (config.sessionSecret.length < 32) missing.push('SESSION_SECRET (не менее 32 символов)');
  if (missing.length) {
    throw new Error(`Не заданы обязательные переменные: ${missing.join(', ')}`);
  }
}
validateConfiguration();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const rateBuckets = new Map();
const loginBuckets = new Map();

function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function consumeRateLimit(map, key, limit, windowMs) {
  const now = Date.now();
  const bucket = map.get(key);
  if (!bucket || now >= bucket.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com data:; connect-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
    ...extraHeaders
  });
  res.end(data);
}

async function readJsonBody(req, maxBytes = 32_768) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Слишком большой запрос.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Некорректный JSON.');
    error.status = 400;
    throw error;
  }
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionFromRequest(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return verifySessionToken(token, { secret: config.sessionSecret });
}

function sessionCookie(token, maxAgeSeconds) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie() {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function requireSession(req, res, { csrf = false } = {}) {
  const session = sessionFromRequest(req);
  if (!session) {
    sendJson(res, 401, { error: 'Сессия истекла. Войдите снова.' });
    return null;
  }
  if (csrf && !constantTimeEqual(req.headers['x-csrf-token'], session.csrf)) {
    sendJson(res, 403, { error: 'Проверка безопасности запроса не пройдена.' });
    return null;
  }
  return session;
}

async function upstreamRequest(pathname, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 70_000);
  timeout.unref?.();
  try {
    const response = await fetch(`${config.mainSiteUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.mainSiteAdminSecret}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = response.status === 403
        ? 'Основной сайт отклонил MAIN_SITE_ADMIN_SECRET. Проверьте, что он совпадает с ADMIN_API_SECRET.'
        : (data.error || `Основной сайт вернул HTTP ${response.status}.`);
      const error = new Error(message);
      error.status = response.status === 403 ? 502 : response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Основной сайт слишком долго не отвечает.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (Number(error?.status)) throw error;
    const connectionError = new Error('Не удалось подключиться к основному сайту.');
    connectionError.status = 502;
    throw connectionError;
  } finally {
    clearTimeout(timeout);
  }
}

async function serveStatic(req, res, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  if (requested.endsWith('/')) requested += 'index.html';
  const decoded = decodeURIComponent(requested);
  const relative = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.resolve(publicDir, `.${relative}`);
  if (!filePath.startsWith(publicDir + path.sep)) return false;

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ['.html', '.css', '.js'].includes(ext) ? 'no-store, max-age=0' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const ip = clientIp(req);
  if (!consumeRateLimit(rateBuckets, ip, 300, 60_000)) {
    sendJson(res, 429, { error: 'Слишком много запросов. Попробуйте через минуту.' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version: APP_VERSION, mainSiteUrl: config.mainSiteUrl });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      const session = sessionFromRequest(req);
      sendJson(res, 200, session
        ? { authenticated: true, csrfToken: session.csrf, mainSiteUrl: config.mainSiteUrl }
        : { authenticated: false, mainSiteUrl: config.mainSiteUrl });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!consumeRateLimit(loginBuckets, ip, 8, 15 * 60_000)) {
        sendJson(res, 429, { error: 'Слишком много попыток входа. Попробуйте позже.' });
        return;
      }
      const body = await readJsonBody(req, 8_192);
      if (!constantTimeEqual(body.password, config.adminPanelPassword)) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        sendJson(res, 401, { error: 'Неверный пароль администратора.' });
        return;
      }
      loginBuckets.delete(ip);
      const created = createSessionToken({ secret: config.sessionSecret, ttlMs: config.sessionTtlMs });
      sendJson(res, 200, {
        authenticated: true,
        csrfToken: created.session.csrf,
        mainSiteUrl: config.mainSiteUrl
      }, {
        'Set-Cookie': sessionCookie(created.token, Math.floor(config.sessionTtlMs / 1000))
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (!requireSession(req, res)) return;
      sendJson(res, 200, await upstreamRequest('/api/admin/state'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/day/reset') {
      if (!requireSession(req, res, { csrf: true })) return;
      const body = await readJsonBody(req);
      sendJson(res, 200, await upstreamRequest('/api/admin/day/reset', { method: 'POST', body }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/leaderboard/entry') {
      if (!requireSession(req, res, { csrf: true })) return;
      const body = await readJsonBody(req);
      sendJson(res, 200, await upstreamRequest('/api/admin/leaderboard/entry', { method: 'POST', body }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/leaderboard/entry/delete') {
      if (!requireSession(req, res, { csrf: true })) return;
      const body = await readJsonBody(req);
      sendJson(res, 200, await upstreamRequest('/api/admin/leaderboard/entry/delete', { method: 'POST', body }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/leaderboard/clear') {
      if (!requireSession(req, res, { csrf: true })) return;
      sendJson(res, 200, await upstreamRequest('/api/admin/leaderboard/clear', { method: 'POST', body: {} }));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = await serveStatic(req, res, url.pathname);
      if (served) return;
    }

    sendJson(res, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    const status = Number(error?.status) || 500;
    console.error(`[${new Date().toISOString()}]`, error);
    if (!res.headersSent) {
      sendJson(res, status, {
        error: status >= 500 ? (error.message || 'Не удалось выполнить запрос.') : error.message
      });
    } else {
      res.end();
    }
  }
});

server.listen(config.port, () => {
  console.log(`Dota Guess Admin ${APP_VERSION}: http://localhost:${config.port}`);
  console.log(`Main site: ${config.mainSiteUrl}`);
});
