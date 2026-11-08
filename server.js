import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import express from 'express'; import compression from 'compression'; import cron from 'node-cron';
import { db } from './db.js';
import { runJob, JOBS, enrichDay, dailyJob } from './sync.js';
import { athensDate, addDays, fmtDT, fmtTime, fmtDay, statusLabel, FINISHED } from './util.js';
import { evalPick } from './predict.js';
import admin from './admin.js';
import { stats, backfillPicks } from './tracking.js';

const app = express(), TZ = { timezone: 'Europe/Athens' };
const SITE = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''), NAME = process.env.SITE_NAME || 'GoalPredict';
app.set('view engine', 'ejs'); app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
app.use(compression()); app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: '7d' }));
app.set('trust proxy', 1);
const evalFor = (p, m) => ['FT', 'AET', 'PEN'].includes(m.status) ? evalPick(p, m.ft_home ?? m.goals_home, m.ft_away ?? m.goals_away, { hth: m.ht_home, hta: m.ht_away, corners: m.corners }) : null;
Object.assign(app.locals, { fmtDT, fmtTime, fmtDay, statusLabel, SITE, NAME, FINISHED, evalPick: evalFor });

const hydrate = r => ({ ...r, prediction: r.prediction ? JSON.parse(r.prediction) : null, analysis: r.analysis ? JSON.parse(r.analysis) : null, lineups: r.lineups ? JSON.parse(r.lineups) : null });
const LG = (process.env.LEAGUE_IDS || '2,3,848,39,140,135,78,61,197,88,94,203,40').split(',').map(Number);

app.get('/', (req, res) => {
  const today = athensDate(); // υπολογίζεται σε κάθε αίτημα => στις 00:00 Αθήνας αλλάζει αυτόματα η ημέρα
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
  const rows = db.prepare('SELECT * FROM matches WHERE match_date=? AND hidden=0 ORDER BY kickoff_ts').all(date).map(hydrate);
  const groups = [];
  for (const m of rows) { let g = groups.find(x => x.id === m.league_id); if (!g) groups.push(g = { id: m.league_id, name: m.league_name, country: m.league_country, logo: m.league_logo, items: [] }); g.items.push(m); }
  groups.sort((a, b) => (LG.indexOf(a.id) + 1 || 999) - (LG.indexOf(b.id) + 1 || 999));
  const picks = rows.filter(m => m.prediction?.status === 'ok').sort((a, b) => b.prediction.pct - a.prediction.pct).slice(0, 3);
  const days = Array.from({ length: 8 }, (_, i) => addDays(today, i - 1));
  res.set('Cache-Control', 'public, max-age=60').render('index', { date, today, groups, picks, days, total: rows.length });
});

app.get('/predictions/:slug', (req, res) => {
  const r = db.prepare('SELECT * FROM matches WHERE slug=?').get(req.params.slug);
  if (!r || r.hidden) return res.status(404).render('404');
  res.set('Cache-Control', 'public, max-age=60').render('match', { m: hydrate(r) });
});

app.get('/robots.txt', (q, res) => res.type('text').send(`User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`));
app.get('/sitemap.xml', (q, res) => {
  const rows = db.prepare('SELECT slug,match_date FROM matches WHERE hidden=0 ORDER BY match_date DESC LIMIT 5000').all();
  res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc></url>${rows.map(r => `<url><loc>${SITE}/predictions/${r.slug}</loc><lastmod>${r.match_date}</lastmod></url>`).join('')}</urlset>`);
});
app.get('/stats', (q, res) => res.set('Cache-Control', 'public, max-age=300').render('stats', { st: stats(), rows: db.prepare(`SELECT p.*,m.slug,m.home_name,m.away_name FROM picks p JOIN matches m USING(fixture_id) WHERE p.result IN ('win','loss') ORDER BY p.settled_at DESC LIMIT 30`).all() }));
app.use('/admin', admin); // ιδιωτικό panel (login με ADMIN_PASSWORD)

// Cron (ώρα Ελλάδας)
cron.schedule('5 0 * * *', () => runJob('daily', dailyJob), TZ);                       // νέα ημέρα: αγώνες + αναλύσεις
cron.schedule('0 11,16 * * *', () => runJob('injuries', JOBS.injuries), TZ);           // ανανέωση απουσιών
cron.schedule('*/15 * * * *', () => runJob('live', JOBS.live), TZ);                    // ενδεκάδες + αποτελέσματα
if (process.env.ENRICH_TOMORROW === 'true') cron.schedule('0 18 * * *', () => runJob('tomorrow', () => enrichDay(addDays(athensDate(), 1))), TZ);

backfillPicks();
app.listen(process.env.PORT || 3000, () => {
  console.log(`${NAME} στο ${SITE}`);
  if (!process.env.API_FOOTBALL_KEY) return console.warn('⚠ Βάλε API_FOOTBALL_KEY στο .env');
  const n = db.prepare('SELECT COUNT(*) c FROM matches WHERE match_date=?').get(athensDate()).c;
  runJob('startup', n ? () => enrichDay(athensDate()) : dailyJob);
});
