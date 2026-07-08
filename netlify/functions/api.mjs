/* Play Test — shared backend (Netlify Function + Netlify Blobs)
   One JSON blob "db" holds users/apps/matches; screenshots stored as separate blobs.
   Auth: session tokens issued at sign-in; Google accounts require a verified Google ID token. */
import { getStore } from '@netlify/blobs';

const MASTER = 'kawalko334411@gmail.com';
const GOOGLE_CLIENT_ID = '832482048394-0be28ltmam33msagi9srk0hmrs0juctq.apps.googleusercontent.com';
const FREE_LIMIT = 50;
const REQUIRED_DAYS = 14;
const ABANDON_AFTER_DAYS = 5;   // started test with no check-in for this long => abandoned
const STALE_ACCEPT_DAYS = 7;    // accepted but never started for this long => abandoned

/* strong consistency: every read sees the latest write (no stale edge cache) */
const store = () => getStore({ name: 'playtest', consistency: 'strong' });
const uid = () => Math.random().toString(36).slice(2, 10);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
const today = () => new Date().toISOString().slice(0, 10);
const daysDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/* the tester's own local date is authoritative for daily check-ins (fixes the midnight/UTC bug),
   but only if it is within 1 day of the server clock */
function effectiveDay(clientDate) {
  if (typeof clientDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientDate) && Math.abs(daysDiff(clientDate, today())) <= 1) return clientDate;
  return today();
}

/* unbroken check-in streak ending today/yesterday (how Google counts the 14 days) */
function streak(m) {
  if (!m.checkins.length) return 0;
  const dates = [...new Set(m.checkins.map(c => c.date))].sort();
  let run = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    if (daysDiff(dates[i - 1], dates[i]) === 1) run++; else break;
  }
  if (daysDiff(dates[dates.length - 1], today()) > 1) return 0;
  return run;
}

/* dead matches no longer clog the owner's dashboard and the tester count */
function sweepAbandoned(db) {
  let changed = false;
  for (const m of db.matches) {
    if (m.status !== 'active') continue;
    if (m.started) {
      const last = m.checkins.length ? [...m.checkins.map(c => c.date)].sort().pop() : m.started;
      if (daysDiff(last, today()) > ABANDON_AFTER_DAYS) { m.status = 'abandoned'; changed = true; }
    } else if (daysDiff(m.accepted, today()) > STALE_ACCEPT_DAYS) {
      m.status = 'abandoned'; changed = true;
    }
  }
  return changed;
}

async function loadDb() {
  let db = await store().get('db', { type: 'json' });
  let dirty = false;
  if (!db || !Array.isArray(db.users)) { db = { users: [], apps: [], matches: [] }; dirty = true; }
  // founder #1 — platform owner is always the first registered account
  if (!db.users.some(u => u.email === MASTER)) {
    db.users.unshift({ id: 'founder-001', nick: 'Kawalko34', email: MASTER, founder: true, createdAt: '2026-07-06', google: true, demo: false, tokens: [] });
    dirty = true;
  }
  // first game on the exchange — the owner's own app (com.arek.datenight)
  if (!db.apps.some(a => a.link.endsWith('com.arek.datenight'))) {
    db.apps.unshift({ id: 'app-001', ownerId: 'founder-001', title: 'Date Night game', desc: 'Couples party game — test the menu, card decks and daily flow. Android 12+.', link: 'https://play.google.com/apps/testing/com.arek.datenight', status: 'searching', createdAt: '2026-07-06' });
    dirty = true;
  }
  if (sweepAbandoned(db)) dirty = true;
  if (dirty) await store().setJSON('db', db);
  return db;
}
const saveDb = db => store().setJSON('db', db);

async function verifyGoogleToken(idToken, email) {
  if (!idToken) return false;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!r.ok) return false;
    const j = await r.json();
    return j.aud === GOOGLE_CLIENT_ID && String(j.email || '').toLowerCase() === email && j.email_verified === 'true';
  } catch (e) { return false; }
}

function issueToken(u) {
  const tk = token();
  u.tokens = (u.tokens || []).slice(-4);
  u.tokens.push(tk);
  return tk;
}

/* e-mails: visible to their owner, to the master admin, and to developers whose app
   the user tests (Google Play closed testing requires adding the tester's e-mail to the list) */
function publicView(db, email, authed) {
  const master = authed && email === MASTER;
  const viewer = authed ? db.users.find(u => u.email === email) : null;
  const myAppIds = viewer ? db.apps.filter(a => a.ownerId === viewer.id).map(a => a.id) : [];
  const myTesterIds = new Set(db.matches.filter(m => myAppIds.includes(m.appId)).map(m => m.testerId));
  return {
    users: db.users.map(u => ({
      id: u.id, nick: u.nick, founder: u.founder, createdAt: u.createdAt,
      google: !!u.google, demo: !!u.demo, phone: u.phone || '',
      email: (master || (authed && u.email === email) || myTesterIds.has(u.id)) ? u.email : undefined
    })),
    apps: db.apps,
    matches: db.matches.map(m => ({ ...m })) // tokens never live on matches; users mapped above
  };
}

export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch (e) {} }
  const url = new URL(req.url);
  const op = body.op || url.searchParams.get('op') || 'state';
  const email = String(body.email || url.searchParams.get('email') || '').toLowerCase().trim();

  try {
    const db = await loadDb();
    const me = db.users.find(u => u.email === email);
    const authed = !!(me && body.token && Array.isArray(me.tokens) && me.tokens.includes(body.token));

    if (op === 'state') return json({ ok: true, meId: authed ? me.id : null, db: publicView(db, email, authed) });

    if (op === 'register') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, err: 'email' });
      let u = db.users.find(x => x.email === email);
      if (u) {
        // sign-in to an existing account: Google-linked accounts require a verified Google token
        if (u.google && !(await verifyGoogleToken(body.idToken, email))) return json({ ok: false, err: 'needGoogle' });
        if (body.google && body.idToken && await verifyGoogleToken(body.idToken, email)) { u.google = true; if (body.picture) u.picture = body.picture; }
        const tk = issueToken(u);
        await saveDb(db);
        return json({ ok: true, meId: u.id, token: tk, db: publicView(db, email, true) });
      }
      const nick = String(body.nick || '').trim().slice(0, 24);
      if (nick.length < 3) return json({ ok: false, err: 'nick' });
      if (db.users.some(x => x.nick.toLowerCase() === nick.toLowerCase())) return json({ ok: false, err: 'nickTaken' });
      const phone = String(body.phone || '').trim().slice(0, 40);
      if (phone.length < 2) return json({ ok: false, err: 'phone' }); // Android phone model is mandatory
      const isGoogle = !!(body.google && await verifyGoogleToken(body.idToken, email));
      u = { id: uid(), nick, email, phone, founder: db.users.length < FREE_LIMIT, createdAt: today(), google: isGoogle, picture: body.picture || null, demo: false, tokens: [] };
      const tk = issueToken(u);
      db.users.push(u);
      await saveDb(db);
      return json({ ok: true, meId: u.id, token: tk, db: publicView(db, email, true) });
    }

    if (op === 'adminWipe') { // master only, guarded by ADMIN_KEY env var (key IS the credential)
      if (email !== MASTER || !process.env.ADMIN_KEY || body.key !== process.env.ADMIN_KEY) return json({ ok: false, err: 'auth' }, 403);
      await store().setJSON('db', { users: [], apps: [], matches: [] });
      const fresh = await loadDb();
      return json({ ok: true, db: publicView(fresh, email, false) });
    }

    if (!authed) return json({ ok: false, err: 'auth' }, 401);

    if (op === 'addApp') {
      // one-for-one rule: you must actively test someone's game before listing your own (owner exempt)
      if (me.email !== MASTER && !db.matches.some(m => m.testerId === me.id && m.started)) return json({ ok: false, err: 'mustTest' });
      const title = String(body.title || '').trim();
      const link = String(body.link || '').trim();
      if (title.length < 2) return json({ ok: false, err: 'title' });
      if (!/^https:\/\/play\.google\.com\/apps\/testing\/[\w.]+/.test(link)) return json({ ok: false, err: 'link' });
      db.apps.push({ id: uid(), ownerId: me.id, title: title.slice(0, 60), desc: String(body.desc || '').slice(0, 300), link, status: 'draft', createdAt: today() });
    }
    else if (op === 'publishApp') {
      const a = db.apps.find(a => a.id === body.appId && a.ownerId === me.id);
      if (!a) return json({ ok: false, err: 'app' });
      a.status = 'searching';
    }
    else if (op === 'deleteApp') {
      const a = db.apps.find(a => a.id === body.appId && a.ownerId === me.id);
      if (!a) return json({ ok: false, err: 'app' });
      if (db.matches.some(m => m.appId === a.id && m.status === 'active')) return json({ ok: false, err: 'hasTesters' });
      db.apps = db.apps.filter(x => x.id !== a.id);
      db.matches = db.matches.filter(m => m.appId !== a.id);
    }
    else if (op === 'accept') {
      const a = db.apps.find(a => a.id === body.appId);
      if (!a || a.ownerId === me.id) return json({ ok: false, err: 'app' });
      if (db.matches.some(m => m.appId === a.id && m.testerId === me.id)) return json({ ok: false, err: 'dup' });
      db.matches.push({ id: uid(), appId: a.id, testerId: me.id, accepted: today(), started: null, checkins: [], surveys: { d7: null, d14: null }, device: body.device || null, hasShot: false, status: 'active' });
      if (a.status === 'searching') a.status = 'testing';
    }
    else if (op === 'start') {
      const m = db.matches.find(m => m.id === body.matchId && m.testerId === me.id);
      if (!m) return json({ ok: false, err: 'match' });
      const note = String(body.note || '').trim();
      if (note.length < 10) return json({ ok: false, err: 'note' });
      if (!body.screenshot) return json({ ok: false, err: 'shot' });
      const day = effectiveDay(body.localDate);
      await store().set('shot-' + m.id, String(body.screenshot).slice(0, 400000));
      m.hasShot = true;
      m.started = day;
      m.status = 'active';
      if (body.device) m.device = body.device;
      if (!m.checkins.some(c => c.date === day)) m.checkins.push({ date: day, note: note.slice(0, 500) });
    }
    else if (op === 'checkin') {
      const m = db.matches.find(m => m.id === body.matchId && m.testerId === me.id);
      if (!m) return json({ ok: false, err: 'match' });
      const day = effectiveDay(body.localDate);
      if (m.checkins.some(c => c.date === day)) return json({ ok: false, err: 'dup' });
      const note = String(body.note || '').trim();
      if (note.length < 10) return json({ ok: false, err: 'note' });
      m.checkins.push({ date: day, note: note.slice(0, 500) });
      m.status = 'active'; // a returning tester revives an abandoned match
    }
    else if (op === 'survey') {
      const m = db.matches.find(m => m.id === body.matchId && m.testerId === me.id);
      if (!m) return json({ ok: false, err: 'match' });
      const { which } = body;
      if (which !== 'd7' && which !== 'd14') return json({ ok: false, err: 'which' });
      const q1 = String(body.q1 || ''), q2 = String(body.q2 || ''), q3 = String(body.q3 || '');
      if ((q1 + q2 + q3).length < 30) return json({ ok: false, err: 'short' });
      m.surveys[which] = { q1: q1.slice(0, 600), q2: q2.slice(0, 600), q3: q3.slice(0, 600), date: today() };
      if (which === 'd14' && streak(m) >= REQUIRED_DAYS) m.status = 'done';
    }
    else if (op === 'screenshot') { // owner or master can view a tester's day-1 screenshot
      const m = db.matches.find(m => m.id === body.matchId);
      if (!m) return json({ ok: false, err: 'match' });
      const a = db.apps.find(a => a.id === m.appId);
      if (email !== MASTER && (!a || a.ownerId !== me.id)) return json({ ok: false, err: 'auth' }, 403);
      const data = await store().get('shot-' + m.id);
      return json({ ok: true, screenshot: data || null });
    }
    else return json({ ok: false, err: 'op' }, 400);

    await saveDb(db);
    return json({ ok: true, meId: me.id, db: publicView(db, email, true) });
  } catch (e) {
    return json({ ok: false, err: 'server: ' + String(e && e.message || e) }, 500);
  }
};

export const config = { path: '/api' };
