import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { SLOTS, MAX_GUESTS, SLOT_CAPACITY, BOOKING_WINDOW_DAYS, PHONE_PATTERN, TZ_OFFSET_HOURS } from './rules';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_USER: string;
  ADMIN_PASS: string;
  SESSION_SECRET: string;
  ENABLE_TEST_API?: string;
  CORS_ORIGINS?: string;
};

type ReservationInput = { name?: unknown; phone?: unknown; date?: unknown; slot?: unknown; guests?: unknown };

const app = new Hono<{ Bindings: Bindings }>();
const COOKIE = 'admin_session';

// ---------- CORS：只允許 CORS_ORIGINS 列出的前端網址（逗號分隔）跨來源呼叫 ----------
app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.CORS_ORIGINS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    return allowed.includes(origin) ? origin : null;
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'DELETE'],
  maxAge: 600,
}));

// ---------- 日期工具（以台灣時間為準） ----------
const today = () => new Date(Date.now() + TZ_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const isValidDate = (d: unknown): d is string =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const bookingRange = () => ({ min: addDays(today(), 1), max: addDays(today(), BOOKING_WINDOW_DAYS) });

// ---------- 驗證（BR-01 ~ BR-05，後端為準 BR-08） ----------
function validate(b: ReservationInput) {
  const fields: Record<string, string> = {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
  if (!name) fields.name = 'REQUIRED';
  if (!phone) fields.phone = 'REQUIRED';
  else if (!PHONE_PATTERN.test(phone)) fields.phone = 'INVALID_PHONE';
  if (b.date === undefined || b.date === '') fields.date = 'REQUIRED';
  else if (!isValidDate(b.date)) fields.date = 'INVALID_DATE';
  else {
    const { min, max } = bookingRange();
    if (b.date < min || b.date > max) fields.date = 'OUT_OF_RANGE';
  }
  if (b.slot === undefined || b.slot === '') fields.slot = 'REQUIRED';
  else if (!SLOTS.includes(b.slot as (typeof SLOTS)[number])) fields.slot = 'INVALID_SLOT';
  if (b.guests === undefined || b.guests === '') fields.guests = 'REQUIRED';
  else if (!Number.isInteger(b.guests) || (b.guests as number) < 1 || (b.guests as number) > MAX_GUESTS)
    fields.guests = 'OUT_OF_RANGE';
  return { fields, data: { name, phone, date: b.date as string, slot: b.slot as string, guests: b.guests as number } };
}

async function bookedBySlot(db: D1Database, date: string) {
  const { results } = await db
    .prepare('SELECT slot, COALESCE(SUM(guests),0) AS booked FROM reservations WHERE date = ? GROUP BY slot')
    .bind(date)
    .all<{ slot: string; booked: number }>();
  const map: Record<string, number> = {};
  for (const r of results) map[r.slot] = r.booked;
  return map;
}

// ---------- 前台 API ----------
// BR-12：各時段剩餘名額
app.get('/api/availability', async (c) => {
  const date = c.req.query('date');
  if (!isValidDate(date)) return c.json({ error: 'VALIDATION_ERROR', fields: { date: 'INVALID_DATE' } }, 400);
  const booked = await bookedBySlot(c.env.DB, date);
  return c.json({
    date,
    range: bookingRange(),
    maxGuests: MAX_GUESTS,
    slots: SLOTS.map((slot) => ({ slot, remaining: SLOT_CAPACITY - (booked[slot] ?? 0) })),
  });
});

// 建立預約：BR-01~08
app.post('/api/reservations', async (c) => {
  const body = await c.req.json<ReservationInput>().catch(() => ({}) as ReservationInput);
  const { fields, data } = validate(body);
  if (Object.keys(fields).length) return c.json({ error: 'VALIDATION_ERROR', fields }, 400);

  try {
    // 單一 SQL 同時檢查容量並寫入，避免兩人同時送出造成超賣（BR-06）
    const res = await c.env.DB.prepare(
      `INSERT INTO reservations (name, phone, date, slot, guests)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COALESCE(SUM(guests),0) FROM reservations WHERE date = ?3 AND slot = ?4) + ?5 <= ?6`
    )
      .bind(data.name, data.phone, data.date, data.slot, data.guests, SLOT_CAPACITY)
      .run();

    if (res.meta.changes === 0) {
      const booked = await bookedBySlot(c.env.DB, data.date);
      return c.json({ error: 'SLOT_FULL', remaining: SLOT_CAPACITY - (booked[data.slot] ?? 0) }, 409);
    }
    return c.json({ id: res.meta.last_row_id, ...data }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json({ error: 'DUPLICATE' }, 409); // BR-07
    throw e;
  }
});

// ---------- 後台 API（BR-09） ----------
app.post('/api/admin/login', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (username !== c.env.ADMIN_USER || password !== c.env.ADMIN_PASS) return c.json({ error: 'UNAUTHORIZED' }, 401);
  const token = await sign({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 8 * 3600 }, c.env.SESSION_SECRET);
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: 'Strict', path: '/', maxAge: 8 * 3600 });
  // 同網域頁面用 cookie；其他網站的前端改用回傳的 token（Authorization: Bearer）
  return c.json({ token, expiresIn: 8 * 3600 });
});

app.post('/api/admin/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' });
  return c.body(null, 204);
});

// 後台 API 共用：驗證登入狀態（外部前端用 Bearer token，同網域頁面用 cookie）
const requireAdmin = async (c: any, next: () => Promise<void>) => {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : getCookie(c, COOKIE);
  try {
    if (!token) throw new Error('no token');
    await verify(token, c.env.SESSION_SECRET, 'HS256');
  } catch {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }
  await next();
};

// BR-10：依日期、姓名或電話篩選，依日期、時段排序
app.get('/api/admin/reservations', requireAdmin, async (c) => {
  const date = c.req.query('date');
  const q = c.req.query('q')?.trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (date) { where.push('date = ?'); params.push(date); }
  if (q) { where.push('(name LIKE ? OR phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const sql = `SELECT * FROM reservations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date, slot, id`;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ items: results });
});

// BR-11：刪除後名額自然釋出（容量以即時加總計算）
app.delete('/api/admin/reservations/:id', requireAdmin, async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM reservations WHERE id = ?').bind(Number(c.req.param('id'))).run();
  if (res.meta.changes === 0) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.body(null, 204);
});

// ---------- 測試專用 API：只在 ENABLE_TEST_API=true 時存在 ----------
app.use('/api/test/*', async (c, next) => {
  if (c.env.ENABLE_TEST_API !== 'true') return c.json({ error: 'NOT_FOUND' }, 404);
  await next();
});
app.post('/api/test/reset', async (c) => {
  await c.env.DB.prepare('DELETE FROM reservations').run();
  return c.body(null, 204);
});
// 直接寫入前置資料（不經規則檢查），例如「D+3 12:30 已有 15 人」
app.post('/api/test/seed', async (c) => {
  const { reservations = [] } = await c.req.json<{ reservations?: Array<Record<string, unknown>> }>();
  const stmt = c.env.DB.prepare('INSERT INTO reservations (name, phone, date, slot, guests) VALUES (?, ?, ?, ?, ?)');
  if (reservations.length)
    await c.env.DB.batch(reservations.map((r) => stmt.bind(r.name, r.phone, r.date, r.slot, r.guests)));
  return c.body(null, 204);
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'NOT_FOUND' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

export default app;
