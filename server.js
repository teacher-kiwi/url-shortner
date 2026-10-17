'use strict';
// 단축 주소 서버.
// 관리자(한 명)만 링크를 만들고, 다른 사람들은 <BASE_URL>/<단어> 로 접속한다.
// 사이트마다 다른 값은 모두 환경 변수로 받는다(.env.example 참고).

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const HOST = BASE_URL.replace(/^https?:\/\//, '');           // 화면에 보이는 주소 (예: s.example.com)
const SITE_NAME = process.env.SITE_NAME || '단축 주소';
const TIME_ZONE = process.env.TIME_ZONE || 'Asia/Seoul';      // 일별 접속 수를 나누는 기준
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD 환경 변수가 필요합니다 (.env.example 참고).');
  process.exit(1);
}
// 공개 저장소의 예시 비밀번호를 그대로 쓰거나 너무 짧으면 시작하지 않는다.
if (ADMIN_PASSWORD === 'change-me' || ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD 를 예시값이 아닌 8자 이상으로 바꿔주세요.');
  process.exit(1);
}
if (!/^https?:\/\/[^/]+$/.test(BASE_URL)) {
  console.error(`BASE_URL 은 https://s.example.com 처럼 경로 없는 주소여야 합니다: ${BASE_URL}`);
  process.exit(1);
}

let dayFormat;
try {
  dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
} catch {
  console.error(`TIME_ZONE 이 올바르지 않습니다: ${TIME_ZONE} (예: Asia/Seoul)`);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// 세션 서명 키. 처음 실행할 때 만들어 data 폴더에 둔다.
// 비밀번호도 서명 키에 섞으므로, 비밀번호를 바꾸면 기존 로그인은 모두 풀린다.
const secretFile = path.join(DATA_DIR, 'session.secret');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
const SIGN_KEY = fs.readFileSync(secretFile, 'utf8').trim() + ':' + ADMIN_PASSWORD;

// ---------------------------------------------------------------- DB

const db = new DatabaseSync(path.join(DATA_DIR, 'links.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT NOT NULL UNIQUE,
    url             TEXT NOT NULL,
    memo            TEXT NOT NULL DEFAULT '',
    expires_at      TEXT,              -- 'YYYY-MM-DD', 그날(TIME_ZONE 기준)까지 유효
    clicks          INTEGER NOT NULL DEFAULT 0,
    last_clicked_at TEXT,              -- ISO 8601 (UTC)
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_clicks (
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,             -- 'YYYY-MM-DD' (TIME_ZONE 기준)
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, day)
  );
`);

const q = {
  bySlug: db.prepare('SELECT * FROM links WHERE slug = ?'),
  byId: db.prepare('SELECT * FROM links WHERE id = ?'),
  list: db.prepare('SELECT * FROM links ORDER BY created_at DESC, id DESC'),
  insert: db.prepare(`INSERT INTO links (slug, url, memo, expires_at, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?)`),
  update: db.prepare(`UPDATE links SET slug = ?, url = ?, memo = ?, expires_at = ?, updated_at = ?
                      WHERE id = ?`),
  remove: db.prepare('DELETE FROM links WHERE id = ?'),
  hit: db.prepare('UPDATE links SET clicks = clicks + 1, last_clicked_at = ? WHERE id = ?'),
  hitDay: db.prepare(`INSERT INTO daily_clicks (link_id, day, count) VALUES (?, ?, 1)
                      ON CONFLICT (link_id, day) DO UPDATE SET count = count + 1`),
  daily: db.prepare('SELECT day, count FROM daily_clicks WHERE link_id = ? AND day >= ?'),
  todayAll: db.prepare('SELECT link_id, count FROM daily_clicks WHERE day = ?'),
};

// ---------------------------------------------------------------- 도우미

// TIME_ZONE 기준 날짜 'YYYY-MM-DD'. offsetDays 만큼 앞/뒤로.
// 오늘 날짜를 구한 뒤 달력 위에서 더하므로 서머타임이 있는 시간대에서도 하루씩 정확히 움직인다.
function localDay(offsetDays = 0) {
  const today = dayFormat.format(new Date());
  if (!offsetDays) return today;
  return new Date(Date.parse(today + 'T00:00:00Z') + offsetDays * 864e5).toISOString().slice(0, 10);
}

function isExpired(link) {
  return Boolean(link.expires_at) && localDay() > link.expires_at;
}

// 한글·영문·숫자·-·_ 만. 영문은 소문자로 맞춰서 대소문자를 구분하지 않는다.
const SLUG_RE = /^[\p{L}\p{N}_-]{1,50}$/u;
const RESERVED = new Set(['admin', 'api', 'static', 'healthz', 'login', 'logout']);

function normalizeSlug(s) {
  return String(s ?? '').normalize('NFC').trim().toLowerCase();
}

// 헷갈리는 글자(0/o, 1/l/i)는 뺐다.
function randomSlug() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    let s = '';
    for (const b of crypto.randomBytes(4)) s += chars[b % chars.length];
    if (!q.bySlug.get(s)) return s;
  }
}

function normalizeUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.href;
  } catch {
    return null;
  }
}

function shortUrl(slug) {
  return `${BASE_URL}/${encodeURIComponent(slug)}`;
}

function toJson(link, todayCounts) {
  return {
    ...link,
    short_url: shortUrl(link.slug),
    expired: isExpired(link),
    today: todayCounts?.get(link.id) ?? 0,
  };
}

// 링크 미리보기 봇(카톡·디스코드 등)과 브라우저 미리 불러오기는 접속 수에 넣지 않는다.
// 카톡 인앱 브라우저는 UA 에 KAKAOTALK 만 있고 scrap 은 없어서 정상 집계된다.
const BOT_RE = /bot\b|bot\/|crawl|spider|scrap|preview|facebookexternalhit|slack|discord|telegram|whatsapp|yeti|daumoa|curl|wget|python-|go-http|headless/i;

function isCountable(req) {
  if (req.method !== 'GET') return false;
  if (BOT_RE.test(req.get('user-agent') || '')) return false;
  const purpose = (req.get('sec-purpose') || req.get('purpose') || '').toLowerCase();
  return !purpose.includes('prefetch');
}

// ---------------------------------------------------------------- 로그인

function sign(value) {
  return crypto.createHmac('sha256', SIGN_KEY).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const SESSION_DAYS = 30;

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function isAuthed(req) {
  const sid = readCookie(req, 'sid');
  if (!sid) return false;
  const [exp, sig] = sid.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

function setSession(req, res) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  res.cookie('sid', `${exp}.${sign(exp)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: SESSION_DAYS * 864e5,
  });
}

// 비밀번호 무작위 대입 막기: IP 당 15분에 10번까지 틀릴 수 있다.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (f && f.reset < Date.now()) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip) ?? { count: 0, reset: Date.now() + 15 * 60e3 };
  f.count += 1;
  failures.set(ip, f);
}
// 다시 오지 않는 IP 의 기록이 쌓이지 않도록 주기적으로 비운다.
setInterval(() => {
  for (const [ip, f] of failures) if (f.reset < Date.now()) failures.delete(ip);
}, 15 * 60e3).unref();

// ---------------------------------------------------------------- 페이지

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 웹 폰트. integrity 로 CDN 의 파일이 바뀌면 불러오지 않는다.
const FONT_CSS = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css';
const FONT_CSS_SRI = 'sha384-ei/b2Mz3F5J8nqTvpKS89CkzDCuD7Cc+/F+OsaPUKItzHgLNKnGq3rjtYq/B7RnO';

function page(title, body, { bodyClass = '' } = {}) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${FONT_CSS}" integrity="${FONT_CSS_SRI}" crossorigin="anonymous">
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

function messagePage(res, status, { badge, title, text, color }) {
  res.status(status).type('html').send(page(title, `
<main class="center">
  <div class="card message ${color}">
    <span class="badge">${esc(badge)}</span>
    <h1>${esc(title)}</h1>
    <p>${text}</p>
  </div>
</main>`));
}

function loginPage(error = '') {
  return page(`로그인 · ${SITE_NAME}`, `
<main class="center">
  <form class="card login" method="post" action="/admin/login">
    <span class="badge">ADMIN</span>
    <h1>${esc(SITE_NAME)}</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <label class="field">
      <span>비밀번호</span>
      <input type="password" name="password" autocomplete="current-password" autofocus required>
    </label>
    <button class="btn btn-primary btn-block" type="submit">들어가기 →</button>
  </form>
</main>`);
}

// 관리자 화면은 시작할 때 한 번 채워둔다.
const adminHtml = fs.readFileSync(path.join(__dirname, 'views', 'admin.html'), 'utf8')
  .replaceAll('{{SITE_NAME}}', esc(SITE_NAME))
  .replaceAll('{{HOST}}', esc(HOST))
  .replaceAll('{{TIME_ZONE}}', esc(TIME_ZONE));

// ---------------------------------------------------------------- 앱

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal'); // nginx-proxy 가 같은 도커 네트워크에 있다

// 보안 헤더. 스크립트는 우리 서버의 것만, 다른 사이트의 iframe 안에는 뜨지 않게.
// (통계 막대 높이를 style 속성으로 넣어서 style 은 inline 을 허용한다)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  'font-src https://cdn.jsdelivr.net',
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));

app.get('/', (req, res) => {
  res.type('html').send(page(SITE_NAME, `
<main class="center">
  <div class="card hero">
    <span class="badge">${esc(HOST.toUpperCase())}</span>
    <h1><mark>${esc(SITE_NAME)}</mark></h1>
    <p>받은 짧은 주소를 그대로 입력하세요.</p>
    <p class="example">${esc(HOST)}/<b>단어</b></p>
  </div>
</main>`, { bodyClass: 'home' }));
});

// --- 관리자 화면

app.get('/admin', (req, res) => {
  if (!isAuthed(req)) return res.type('html').send(loginPage());
  res.set('Cache-Control', 'no-store');
  res.type('html').send(adminHtml);
});

app.post('/admin/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  if (tooManyFailures(req.ip)) {
    return res.status(429).type('html').send(loginPage('너무 많이 틀렸어요. 15분 뒤에 다시 해주세요.'));
  }
  if (!safeEqual(req.body?.password ?? '', ADMIN_PASSWORD)) {
    recordFailure(req.ip);
    return res.status(401).type('html').send(loginPage('비밀번호가 맞지 않아요.'));
  }
  failures.delete(req.ip);
  setSession(req, res);
  res.redirect(303, '/admin');
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie('sid', { path: '/' });
  res.redirect(303, '/admin');
});

// --- 관리자 API

const api = express.Router();

// 로그인 확인 + CSRF 방어(다른 사이트의 폼은 이 헤더를 붙일 수 없다).
api.use((req, res, next) => {
  if (!isAuthed(req)) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch') {
    return res.status(403).json({ error: '잘못된 요청이에요.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});
api.use(express.json({ limit: '16kb' }));

// 만들기/수정 입력을 검사하고 정리한다. 문제가 있으면 { error } 를 돌려준다.
function validate(body, currentId = null) {
  const url = normalizeUrl(body.url);
  if (!url) return { error: '목적지 주소가 올바르지 않아요. (http:// 또는 https:// 주소)' };
  if (url.startsWith(BASE_URL + '/')) return { error: '단축 주소를 다시 단축할 수는 없어요.' };

  let slug = normalizeSlug(body.slug);
  if (!slug) {
    if (currentId) return { error: '단어를 입력해주세요.' };
    slug = randomSlug();
  }
  if (!SLUG_RE.test(slug)) return { error: '단어는 한글·영문·숫자·-·_ 만, 50자까지 쓸 수 있어요.' };
  if (RESERVED.has(slug)) return { error: `'${slug}' 는 예약된 단어라 쓸 수 없어요.` };
  const taken = q.bySlug.get(slug);
  if (taken && taken.id !== currentId) return { error: `'${slug}' 는 이미 쓰고 있어요.` };

  const memo = String(body.memo ?? '').trim().slice(0, 200);

  let expires = String(body.expires_at ?? '').trim() || null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return { error: '만료일 형식이 올바르지 않아요.' };

  return { slug, url, memo, expires };
}

function linkOr404(req, res) {
  const link = q.byId.get(Number(req.params.id));
  if (!link) res.status(404).json({ error: '없는 링크예요.' });
  return link;
}

api.get('/links', (req, res) => {
  const today = new Map(q.todayAll.all(localDay()).map((r) => [r.link_id, r.count]));
  res.json({ base_url: BASE_URL, links: q.list.all().map((l) => toJson(l, today)) });
});

api.post('/links', (req, res) => {
  const v = validate(req.body ?? {});
  if (v.error) return res.status(400).json(v);
  const now = new Date().toISOString();
  const { lastInsertRowid } = q.insert.run(v.slug, v.url, v.memo, v.expires, now, now);
  res.status(201).json(toJson(q.byId.get(lastInsertRowid)));
});

api.patch('/links/:id', (req, res) => {
  const link = linkOr404(req, res);
  if (!link) return;
  const v = validate({ ...link, ...req.body }, link.id);
  if (v.error) return res.status(400).json(v);
  q.update.run(v.slug, v.url, v.memo, v.expires, new Date().toISOString(), link.id);
  res.json(toJson(q.byId.get(link.id)));
});

api.delete('/links/:id', (req, res) => {
  const link = linkOr404(req, res);
  if (!link) return;
  q.remove.run(link.id);
  res.status(204).end();
});

// 일별 접속 수. 접속이 없던 날은 0 으로 채운다.
api.get('/links/:id/stats', (req, res) => {
  const link = linkOr404(req, res);
  if (!link) return;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const from = localDay(-(days - 1));
  const counts = new Map(q.daily.all(link.id, from).map((r) => [r.day, r.count]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = localDay(-i);
    series.push({ day, count: counts.get(day) ?? 0 });
  }
  res.json({ link: toJson(link), series });
});

const QR_OPTS = { margin: 2, errorCorrectionLevel: 'M', width: 1024 };

api.get('/links/:id/qr.svg', async (req, res) => {
  const link = linkOr404(req, res);
  if (!link) return;
  res.type('svg').send(await QRCode.toString(shortUrl(link.slug), { ...QR_OPTS, type: 'svg' }));
});

api.get('/links/:id/qr.png', async (req, res) => {
  const link = linkOr404(req, res);
  if (!link) return;
  if (req.query.download) res.attachment(`qr-${link.slug}.png`);
  res.type('png').send(await QRCode.toBuffer(shortUrl(link.slug), QR_OPTS));
});

app.use('/api', api);

// --- 단축 주소로 이동

app.get('/:slug', (req, res) => {
  const link = q.bySlug.get(normalizeSlug(req.params.slug));
  if (!link) {
    return messagePage(res, 404, {
      badge: '404', color: 'pink', title: '없는 주소예요',
      text: '주소를 다시 한 번 확인해주세요.<br>대문자·소문자는 상관없어요.',
    });
  }
  if (isExpired(link)) {
    return messagePage(res, 410, {
      badge: '만료', color: 'yellow', title: '기간이 끝난 링크예요',
      text: '링크를 알려준 사람에게 새 주소를 받아주세요.',
    });
  }
  if (isCountable(req)) {
    q.hit.run(new Date().toISOString(), link.id);
    q.hitDay.run(link.id, localDay());
  }
  // 302: 목적지를 나중에 바꿀 수 있고, 브라우저가 기억해서 접속 수가 빠지는 일도 없다.
  res.set('Cache-Control', 'private, no-store');
  res.redirect(302, link.url);
});

app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: '서버 오류가 났어요.' });
  messagePage(res, 500, { badge: '500', color: 'pink', title: '서버 오류', text: '잠시 뒤에 다시 시도해주세요.' });
});

app.listen(PORT, () => console.log(`url-shortner listening on :${PORT} (${BASE_URL}, ${TIME_ZONE})`));
