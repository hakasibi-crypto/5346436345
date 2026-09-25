// Dynamic Flow 웹서버 (1단계: 위치 정보 수신까지)
// 외부 패키지 없이 Node.js 18+ 만으로 동작합니다.
//
// 흐름
//  1) 게임 서버 -> POST /api/link/start        : 1회용 코드 발급 (API 키 필요)
//  2) 유저 폰   -> GET  /?code=XXXXXX          : 위치 허용 페이지
//  3) 유저 폰   -> POST /api/link/location     : 위치 전달 (서버는 검증만 하고 좌표를 저장하지 않음)
//  4) 게임 서버 -> GET  /api/link/status       : 3초마다 결과 확인 (API 키 필요)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GAME_SERVER_API_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외

if (API_KEY.length < 20) {
  console.error('GAME_SERVER_API_KEY 환경변수(20자 이상)를 설정하세요. Lua의 DYNAMIC_FLOW_API_KEY와 같은 값이어야 합니다.');
  process.exit(1);
}

// ---------- 저장소 (메모리) ----------
// 좌표는 저장하지 않습니다. "위치를 받았다"는 사실과 시각만 보관합니다.
const sessions = new Map(); // code -> { uid, username, status, errorReason, expiresAt, receivedAt }

function newCode() {
  let c;
  do {
    c = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (sessions.has(c));
  return c;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) if (s.expiresAt + 60_000 < now) sessions.delete(code);
}, 60_000).unref();

// ---------- 속도 제한 ----------
const hits = new Map(); // key -> [timestamps]
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 30 * 60_000).unref();

// ---------- 유틸 ----------
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function apiKeyOk(req) {
  return crypto.timingSafeEqual(sha(req.headers['x-game-api-key'] || ''), sha(API_KEY));
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}
function normCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
function getActive(code) {
  const s = sessions.get(code);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(code); return null; }
  return s;
}

// ---------- 정적 파일 (허용 목록 방식: 경로 조작 불가) ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
function serveStatic(res, key) {
  const [file, type] = STATIC[key];
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(self)',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(data);
  });
}

// ---------- 라우터 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = clientIp(req);

  try {
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && STATIC[p]) return serveStatic(res, p);

    // ----- 게임 서버 전용 -----
    if (p === '/api/link/start' && req.method === 'POST') {
      if (!apiKeyOk(req)) return send(res, 401, { error: 'unauthorized' });
      const b = await readJson(req);
      const uid = String(b.robloxUserId || '');
      if (!/^\d{1,20}$/.test(uid)) return send(res, 400, { error: 'bad_user' });

      for (const [c, s] of sessions) if (s.uid === uid) sessions.delete(c); // 유저당 코드 1개
      const code = newCode();
      const expiresAt = Date.now() + CODE_TTL_MS;
      sessions.set(code, {
        uid, username: String(b.robloxUsername || '').slice(0, 40),
        status: 'pending_web', errorReason: null, expiresAt, receivedAt: null,
      });
      return send(res, 200, { code, linkUrl: baseUrl(req), expiresAt });
    }

    if (p === '/api/link/status' && req.method === 'GET') {
      if (!apiKeyOk(req)) return send(res, 401, { error: 'unauthorized' });
      const code = normCode(url.searchParams.get('code'));
      const uid = String(url.searchParams.get('robloxUserId') || '');
      const s = getActive(code);
      if (!s || s.uid !== uid) return send(res, 200, { status: 'expired_or_not_found' });
      if (s.status === 'error') return send(res, 200, { status: 'error', errorReason: s.errorReason });
      return send(res, 200, { status: s.status }); // pending_web | location_received
    }

    // ----- 유저 폰(웹페이지) 전용 -----
    if ((p === '/api/link/location' || p === '/api/link/error') && req.method === 'POST') {
      if (limited('req:' + ip, 30, 60_000)) return send(res, 429, { error: 'too_many_requests' });
      const b = await readJson(req);
      const code = normCode(b.code);
      const s = getActive(code);
      if (!s) {
        if (limited('bad:' + ip, 8, 10 * 60_000)) return send(res, 429, { error: 'too_many_requests' });
        return send(res, 404, { error: 'invalid_code' });
      }

      if (p === '/api/link/error') {
        const reason = b.reason === 'location_denied' ? 'location_denied' : 'location_unavailable';
        if (s.status === 'pending_web') { s.status = 'error'; s.errorReason = reason; }
        return send(res, 200, { ok: true });
      }

      const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.accuracy);
      const valid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        && Number.isFinite(acc) && acc >= 0;
      if (!valid) return send(res, 400, { error: 'bad_location' });

      // 좌표는 여기서 버리고 "받았다"는 사실만 기록
      if (s.status === 'pending_web') { s.status = 'location_received'; s.receivedAt = Date.now(); }
      return send(res, 200, { ok: true });
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (e.message === 'bad_json' || e.message === 'too_large') return send(res, 400, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => console.log(`Dynamic Flow web server on :${PORT}`));
