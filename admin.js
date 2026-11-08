import express from 'express'; import crypto from 'node:crypto';
import { db } from './db.js';
import { runJob, JOBS, regenAI } from './sync.js';
import { stats, logPick } from './tracking.js';
import { PICK_IDS, labelOf, marketOf } from './predict.js';
import { athensDate, addDays } from './util.js';

const r = express.Router(); r.use(express.urlencoded({ extended: false }));
const now = () => Math.floor(Date.now() / 1000);
const h = s => crypto.createHash('sha256').update(String(s)).digest();
const tok = () => crypto.createHmac('sha256', h('gp:' + process.env.ADMIN_PASSWORD)).update('admin-session').digest('hex');
const secure = (process.env.SITE_URL || '').startsWith('https') ? '; Secure' : '';
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]));
const hyd = m => ({ ...m, prediction: m.prediction ? JSON.parse(m.prediction) : null, analysis: m.analysis ? JSON.parse(m.analysis) : null });
const tries = new Map();

r.use((req, res, next) => { res.set('Cache-Control', 'no-store');
  if (!process.env.ADMIN_PASSWORD) return res.status(503).send('Ορίστε ADMIN_PASSWORD στο .env για να ενεργοποιηθεί το admin panel.'); next(); });
r.get('/login', (q, res) => res.render('admin/login', { err: null }));
r.post('/login', (req, res) => {
  const ip = req.ip, t = tries.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 9e5) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 5) return res.status(429).render('admin/login', { err: 'Πολλές προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά.' });
  if (crypto.timingSafeEqual(h(req.body.password || ''), h(process.env.ADMIN_PASSWORD))) {
    tries.delete(ip); res.set('Set-Cookie', `gp_admin=${tok()}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=604800${secure}`); return res.redirect('/admin');
  }
  t.n++; tries.set(ip, t); res.status(401).render('admin/login', { err: 'Λάθος κωδικός.' });
});
r.use((req, res, next) => { const c = cookie(req).gp_admin;
  if (c && /^[0-9a-f]{64}$/.test(c) && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(tok()))) return next(); res.redirect('/admin/login'); });
r.post('/logout', (q, res) => { res.set('Set-Cookie', 'gp_admin=; Path=/admin; Max-Age=0'); res.redirect('/admin/login'); });

r.get('/', (req, res) => res.render('admin/dash', { st: stats(), msg: req.query.msg || '', log: db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 15').all(),
  cfg: { api: !!process.env.API_FOOTBALL_KEY, ai: !!process.env.ANTHROPIC_API_KEY, corners: process.env.ENABLE_CORNERS === 'true', model: process.env.AI_MODEL || 'claude-haiku-5-5' } }));
r.post('/run/:job', (req, res) => { const j = req.params.job; if (JOBS[j]) runJob(j, JOBS[j]);
  res.redirect('/admin?msg=' + encodeURIComponent(JOBS[j] ? `Ξεκίνησε η εργασία «${j}» στο παρασκήνιο. Δες το ιστορικό σε λίγο.` : 'Άγνωστη εργασία')); });

r.get('/matches', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : athensDate();
  const rows = db.prepare('SELECT m.*,p.label pick_label,p.pct pick_pct,p.result,p.source FROM matches m LEFT JOIN picks p USING(fixture_id) WHERE match_date=? ORDER BY kickoff_ts').all(date);
  res.render('admin/matches', { rows, date, prev: addDays(date, -1), next: addDays(date, 1) });
});
r.get('/match/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE fixture_id=?').get(req.params.id); if (!m) return res.sendStatus(404);
  res.render('admin/match', { m: hyd(m), opts: PICK_IDS.map(id => ({ id, label: labelOf(id, m) })), locked: m.kickoff_ts <= now(), msg: req.query.msg || '' });
});
r.post('/match/:id', (req, res) => {
  const id = Number(req.params.id), row = db.prepare('SELECT * FROM matches WHERE fixture_id=?').get(id); if (!row) return res.sendStatus(404);
  const m = hyd(row), b = req.body, a = m.analysis; let p = m.prediction;
  const back = msg => res.redirect(`/admin/match/${id}?msg=${encodeURIComponent(msg)}`);
  const lines = (b.reasons || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (a) { const t = (b.ai_text || '').trim(); if (t !== (a.ai?.text || '')) { if (t) a.ai = { ...(a.ai || {}), text: t, edited: true, at: now() }; else delete a.ai; } }
  if (row.kickoff_ts > now()) { // το προγνωστικό αλλάζει ΜΟΝΟ πριν την έναρξη, ώστε να μη νοθεύεται το ιστορικό επιτυχίας
    if (b.pick_id === '') { p = { status: 'no_pick', note: 'Δεν προτείνεται επιλογή για αυτόν τον αγώνα.', alts: p?.alts || [], reasons: lines }; logPick(id, p); }
    else if (PICK_IDS.includes(b.pick_id)) {
      const pct = parseInt(b.pct, 10); if (!(pct >= 1 && pct <= 95)) return back('Η πιθανότητα πρέπει να είναι 1-95.');
      p = { status: 'ok', id: b.pick_id, label: labelOf(b.pick_id, m), market: marketOf(b.pick_id), pct, confidence: ['Χαμηλό', 'Μέτριο', 'Υψηλό'].includes(b.confidence) ? b.confidence : 'Μέτριο', alts: p?.alts || [], reasons: lines, source: 'manual' };
      logPick(id, p, 'manual');
    }
  } else if (p?.status === 'ok') p.reasons = lines;
  db.prepare('UPDATE matches SET analysis=?,prediction=?,hidden=? WHERE fixture_id=?').run(a ? JSON.stringify(a) : null, p ? JSON.stringify(p) : null, b.hidden ? 1 : 0, id);
  back('Αποθηκεύτηκε.');
});
r.post('/match/:id/ai', async (req, res) => {
  let msg; try { msg = (await regenAI(Number(req.params.id), true)) ? 'Η ανάλυση AI δημιουργήθηκε ξανά.' : 'Δεν δημιουργήθηκε (δεν υπάρχει ANTHROPIC_API_KEY ή ανάλυση δεδομένων).'; } catch (e) { msg = e.message; }
  res.redirect(`/admin/match/${req.params.id}?msg=${encodeURIComponent(msg)}`);
});
r.get('/results', (req, res) => res.render('admin/results', { st: stats(), rows: db.prepare(`SELECT p.*,m.slug,m.home_name,m.away_name,m.match_date,m.status,m.goals_home,m.goals_away FROM picks p JOIN matches m USING(fixture_id) ORDER BY m.kickoff_ts DESC LIMIT 100`).all() }));
r.post('/pick/:id/result', (req, res) => { const v = req.body.result;
  if (['win', 'loss', 'void', 'pending'].includes(v)) db.prepare('UPDATE picks SET result=?,settled_at=? WHERE fixture_id=?').run(v === 'pending' ? null : v, v === 'pending' ? null : now(), req.params.id);
  res.redirect('/admin/results'); });
export default r;
