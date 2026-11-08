import { db } from './db.js';
import { api } from './api.js';
import { athensDate, addDays, slugify, FINISHED } from './util.js';
import { buildAnalysis, parseRecent } from './analysis.js';
import { aiAnalysis } from './ai.js';
import { logPick, settleAll, cornerTotal } from './tracking.js';

const LEAGUES = (process.env.LEAGUE_IDS || '2,3,848,39,140,135,78,61,197,88,94,203,40').split(',').map(Number).filter(Boolean);
const prio = id => { const i = LEAGUES.indexOf(id); return i < 0 ? 999 : i; };
const now = () => Math.floor(Date.now() / 1000);
const log = (job, ok, msg) => db.prepare('INSERT INTO sync_log(at,job,ok,msg) VALUES(?,?,?,?)').run(now(), job, ok ? 1 : 0, String(msg).slice(0, 500));

const slugTaken = db.prepare('SELECT 1 FROM matches WHERE slug=? AND fixture_id<>?');
const upsert = db.prepare(`INSERT INTO matches(fixture_id,slug,match_date,kickoff_ts,league_id,league_name,league_country,league_logo,season,round,home_id,home_name,home_logo,away_id,away_name,away_logo,venue,status,goals_home,goals_away,ht_home,ht_away,ft_home,ft_away,updated_at)
VALUES(@fixture_id,@slug,@match_date,@kickoff_ts,@league_id,@league_name,@league_country,@league_logo,@season,@round,@home_id,@home_name,@home_logo,@away_id,@away_name,@away_logo,@venue,@status,@goals_home,@goals_away,@ht_home,@ht_away,@ft_home,@ft_away,@updated_at)
ON CONFLICT(fixture_id) DO UPDATE SET match_date=excluded.match_date,kickoff_ts=excluded.kickoff_ts,round=excluded.round,venue=excluded.venue,status=excluded.status,goals_home=excluded.goals_home,goals_away=excluded.goals_away,ht_home=excluded.ht_home,ht_away=excluded.ht_away,ft_home=excluded.ft_home,ft_away=excluded.ft_away,updated_at=excluded.updated_at`);

// 1) Πρόγραμμα αγώνων μιας ημέρας (fixture_id = primary key => ποτέ διπλοί αγώνες)
export async function syncFixtures(date) {
  const rows = (await api('/fixtures', { date, timezone: 'Europe/Athens' })).filter(f => LEAGUES.includes(f.league.id));
  db.transaction(list => {
    for (const f of list) {
      const id = f.fixture.id, ts = f.fixture.timestamp;
      const old = db.prepare('SELECT slug FROM matches WHERE fixture_id=?').get(id);
      let slug = old?.slug;
      if (!slug) {
        const base = slugify(`${f.teams.home.name}-vs-${f.teams.away.name}`) || `match-${id}`;
        slug = base;
        if (slugTaken.get(slug, id)) slug = `${base}-${athensDate(new Date(ts * 1000))}`;
        if (slugTaken.get(slug, id)) slug = `${base}-${id}`;
      }
      upsert.run({ fixture_id: id, slug, match_date: athensDate(new Date(ts * 1000)), kickoff_ts: ts, league_id: f.league.id, league_name: f.league.name,
        league_country: f.league.country, league_logo: f.league.logo, season: f.league.season, round: f.league.round,
        home_id: f.teams.home.id, home_name: f.teams.home.name, home_logo: f.teams.home.logo, away_id: f.teams.away.id, away_name: f.teams.away.name, away_logo: f.teams.away.logo,
        venue: f.fixture.venue?.name || null, status: f.fixture.status.short, goals_home: f.goals.home, goals_away: f.goals.away, ht_home: f.score?.halftime?.home ?? null, ht_away: f.score?.halftime?.away ?? null, ft_home: f.score?.fulltime?.home ?? null, ft_away: f.score?.fulltime?.away ?? null, updated_at: now() });
    }
  })(rows);
  return rows.length;
}

async function injuriesFor(date) {
  try {
    const map = {};
    for (const i of await api('/injuries', { date })) {
      (map[i.fixture.id] ||= []).push({ team_id: i.team.id, name: i.player.name, type: i.player.type, reason: i.player.reason });
    }
    return map;
  } catch (e) { log('injuries', false, e.message); return null; }
}
const splitInj = (m, list) => list == null ? null : {
  home: list.filter(i => i.team_id === m.home_id).map(fmtInj), away: list.filter(i => i.team_id === m.away_id).map(fmtInj) };
const fmtInj = i => ({ name: i.name, kind: /suspen/i.test(i.reason || '') ? 'Τιμωρία' : 'Τραυματισμός/απουσία', status: i.type === 'Questionable' ? 'Αμφίβολος' : 'Θα απουσιάσει', reason: i.reason });

// 2) Εμπλουτισμός: προγνωστικά, φόρμα, βαθμολογία, απουσίες (προτεραιότητα στα μεγάλα πρωταθλήματα)
export async function enrichDay(date) {
  const max = Number(process.env.MAX_ANALYSES_PER_DAY || 10);
  const top = db.prepare('SELECT * FROM matches WHERE match_date=? ORDER BY kickoff_ts').all(date)
    .sort((a, b) => prio(a.league_id) - prio(b.league_id) || a.kickoff_ts - b.kickoff_ts).slice(0, max)
    .filter(m => !m.enriched_at && !FINISHED.includes(m.status));
  if (!top.length) return 0;
  const inj = await injuriesFor(date), stand = {};
  let done = 0;
  for (const m of top) {
    try {
      const k = `${m.league_id}-${m.season}`;
      if (!(k in stand)) {
        try {
          const rows = await api('/standings', { league: m.league_id, season: m.season });
          stand[k] = (rows[0]?.league?.standings || []);
        } catch (e) { if (/QUOTA/.test(e.message)) throw e; stand[k] = []; }
      }
      const grp = stand[k].find(g => g.some(t => t.team.id === m.home_id)) || [];
      const standings = { home: grp.find(t => t.team.id === m.home_id), away: grp.find(t => t.team.id === m.away_id), total: grp.length };
      const pred = (await api('/predictions', { fixture: m.fixture_id }))[0] || null;
      const recent = { home: parseRecent(await api('/fixtures', { team: m.home_id, last: 5 }), m.home_id), away: parseRecent(await api('/fixtures', { team: m.away_id, last: 5 }), m.away_id) };
      if (process.env.ENABLE_CORNERS === 'true') for (const r of [...recent.home, ...recent.away]) r.ct = await cornerTotal(r.id);
      const { analysis, prediction } = buildAnalysis(m, { pred, recent, standings, injuries: splitInj(m, inj?.[m.fixture_id] ?? (inj ? [] : null)) });
      try { analysis.ai = await aiAnalysis(m, analysis, prediction, null) || undefined; } catch (e) { log('ai', false, `${m.slug}: ${e.message}`); }
      db.prepare('UPDATE matches SET analysis=?,prediction=?,enriched_at=? WHERE fixture_id=?').run(JSON.stringify(analysis), JSON.stringify(prediction), now(), m.fixture_id);
      logPick(m.fixture_id, prediction, 'auto');
      done++;
    } catch (e) { log('enrich', false, `${m.slug}: ${e.message}`); if (/QUOTA/.test(e.message)) break; }
  }
  return done;
}

// 3) Ενδεκάδες (μόνο επίσημες, όταν ανακοινωθούν) + ζωντανά αποτελέσματα
export async function refreshLive() {
  await settleAll(false);
  const t = now(), today = athensDate();
  const act = db.prepare(`SELECT * FROM matches WHERE match_date IN (?,?) AND status NOT IN ('FT','AET','PEN','CANC','PST','ABD','AWD','WO') AND kickoff_ts<? AND kickoff_ts>?`)
    .all(addDays(today, -1), today, t + 5400, t - 4 * 3600);
  if (!act.length) return;
  for (const m of act.filter(x => x.enriched_at && !x.lineups && x.lineups_try < 6 && x.kickoff_ts - t < 4200)) {
    db.prepare('UPDATE matches SET lineups_try=lineups_try+1 WHERE fixture_id=?').run(m.fixture_id);
    const r = await api('/fixtures/lineups', { fixture: m.fixture_id });
    if (r.length === 2) db.prepare('UPDATE matches SET lineups=? WHERE fixture_id=?').run(JSON.stringify(r.map(x => ({ team_id: x.team.id, formation: x.formation, coach: x.coach?.name, xi: x.startXI.map(p => ({ n: p.player.number, name: p.player.name, pos: p.player.pos })) }))), m.fixture_id);
    if (r.length === 2) await regenAI(m.fixture_id).catch(e => log('ai', false, e.message));
  }
  for (const d of new Set(act.filter(x => x.kickoff_ts < t).map(x => x.match_date))) await syncFixtures(d);
  await settleAll(false);
}

export async function dailyJob() {
  const today = athensDate(), n = Number(process.env.DAYS_AHEAD || 2);
  await syncFixtures(addDays(today, -1)); // τελικά αποτελέσματα χθες -> έλεγχος προγνωστικών
  await settleAll(true);
  for (let i = 0; i <= n; i++) await syncFixtures(addDays(today, i));
  await enrichDay(today);
  if (process.env.ENRICH_TOMORROW === 'true') await enrichDay(addDays(today, 1));
}
export async function refreshInjuries() {
  const today = athensDate(), inj = await injuriesFor(today);
  if (!inj) return;
  for (const m of db.prepare('SELECT * FROM matches WHERE match_date=? AND analysis IS NOT NULL AND kickoff_ts>?').all(today, now())) {
    const a = JSON.parse(m.analysis); a.injuries = { ...splitInj(m, inj[m.fixture_id] || []), has: true };
    db.prepare('UPDATE matches SET analysis=? WHERE fixture_id=?').run(JSON.stringify(a), m.fixture_id);
  }
}
let busy = false;
export async function runJob(name, fn) {
  if (busy) return false; busy = true;
  try { await fn(); log(name, true, 'ok'); } catch (e) { log(name, false, e.message); console.error(name, e.message); } finally { busy = false; }
  return true;
}
export async function regenAI(id, force = false) {
  const m = db.prepare('SELECT * FROM matches WHERE fixture_id=?').get(id); if (!m?.analysis) return false;
  const a = JSON.parse(m.analysis); if (a.ai?.edited && !force) return false;
  const ai = await aiAnalysis(m, a, m.prediction ? JSON.parse(m.prediction) : null, m.lineups ? JSON.parse(m.lineups) : null);
  if (!ai) return false; a.ai = ai;
  db.prepare('UPDATE matches SET analysis=? WHERE fixture_id=?').run(JSON.stringify(a), id); return true;
}
export const JOBS = { daily: dailyJob, live: refreshLive, injuries: refreshInjuries, settle: () => settleAll(true) };
