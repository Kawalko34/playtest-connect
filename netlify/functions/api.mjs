/* Play Test — shared backend (Netlify Function + Netlify Blobs)
   One JSON blob "db" holds users/apps/matches; screenshots stored as separate blobs. */
import { getStore } from '@netlify/blobs';

const MASTER = 'kawalko334411@gmail.com';
const FREE_LIMIT = 100;
const REQUIRED_DAYS = 14;

/* strong consistency: every read sees the latest write (no stale edge cache) */
const store = () => getStore({ name: 'playtest', consistency: 'strong' });
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const daysDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

async function loadDb() {
  let db = await store().get('db', { type: 'json' });
  if (!db || !Array.isArray(db.users)) db = { users: [], apps: [], matches: [] };
  // founder #1 — platform owner is always the first registered account
  if (!db.users.some(u => u.email === MASTER)) {
    db.users.unshift({ id: 'founder-001', nick: 'Kawalko34', email: MASTER, founder: true, createdAt: '2026-07-06', google: true, demo: false });
    await store().setJSON('db', db);
  }
  return db;
}
const saveDb = db => store().setJSON('db', db);

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

/* e-mails are visible only to their owner and to the master admin */
function publicView(db, email) {
  const master = email === MASTER;
  return {
    users: db.users.map(u => ({
      id: u.id, nick: u.nick, founder: u.founder, createdAt: u.createdAt,
      google: !!u.google, demo: !!u.demo,
      email: (master || u.email === email) ? u.email : undefined
    })),
    apps: db.apps,
    matches: db.matches
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

    if (op === 'state') return json({ ok: true, meId: me ? me.id : null, db: publicView(db, email) });

    if (op === 'register') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, err: 'email' });
      let u = db.users.find(x => x.email === email);
      if (!u) {
        const nick = String(body.nick || '').trim().slice(0, 24);
        if (nick.length < 3) return json({ ok: false, err: 'nick' });
        if (db.users.some(x => x.nick.toLowerCase() === nick.toLowerCase())) return json({ ok: false, err: 'nickTaken' });
        u = { id: uid(), nick, email, founder: db.users.length < FREE_LIMIT, createdAt: today(), google: !!body.google, picture: body.picture || null, demo: false };
        db.users.push(u);
        await saveDb(db);
      } else if (body.google) {
        u.google = true; if (body.picture) u.picture = body.picture;
        await saveDb(db);
      }
      return json({ ok: true, meId: u.id, db: publicView(db, email) });
    }

    if (!me) return json({ ok: false, err: 'auth' }, 401);

    if (op === 'addApp') {
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
      await store().set('shot-' + m.id, String(body.screenshot).slice(0, 400000));
      m.hasShot = true;
      m.started = today();
      if (body.device) m.device = body.device;
      if (!m.checkins.some(c => c.date === today())) m.checkins.push({ date: today(), note: note.slice(0, 500) });
    }
    else if (op === 'checkin') {
      const m = db.matches.find(m => m.id === body.matchId && m.testerId === me.id);
      if (!m) return json({ ok: false, err: 'match' });
      if (m.checkins.some(c => c.date === today())) return json({ ok: false, err: 'dup' });
      const note = String(body.note || '').trim();
      if (note.length < 10) return json({ ok: false, err: 'note' });
      m.checkins.push({ date: today(), note: note.slice(0, 500) });
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
    else if (op === 'adminWipe') { // master only, guarded by ADMIN_KEY env var
      if (email !== MASTER || !process.env.ADMIN_KEY || body.key !== process.env.ADMIN_KEY) return json({ ok: false, err: 'auth' }, 403);
      await store().setJSON('db', { users: [], apps: [], matches: [] });
      const fresh = await loadDb();
      return json({ ok: true, db: publicView(fresh, email) });
    }
    else return json({ ok: false, err: 'op' }, 400);

    await saveDb(db);
    return json({ ok: true, meId: me.id, db: publicView(db, email) });
  } catch (e) {
    return json({ ok: false, err: 'server: ' + String(e && e.message || e) }, 500);
  }
};

export const config = { path: '/api' };
