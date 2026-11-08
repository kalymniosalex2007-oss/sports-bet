import { db } from './db.js';
import { api } from './api.js';
import { evalPick } from './predict.js';
const now = () => Math.floor(Date.now() / 1000);
const cc = new Map();
export async function cornerTotal(id) {
  if (cc.has(id)) return cc.get(id);
  try {
    const vals = (await api('/fixtures/statistics', { fixture: id })).map(t => t.statistics?.find(s => s.type === 'Corner Kicks')?.value);
    if (vals.length === 2 && vals.every(v => v != null)) { const v = vals.reduce((a, b) => a + Number(b), 0); cc.set(id, v); return v; }
  } catch (e) { if (/QUOTA/.test(e.message)) throw e; }
  return null;
}
// Καταγραφή του βασικού προγνωστικού κάθε αγώνα (ένα ανά αγώνα). Δεν αλλάζει μετά το τέλος του αγώνα.
export function logPick(fid, p, source = 'auto') {
  if (!p || p.status !== 'ok') { db.prepare('DELETE FROM picks WHERE fixture_id=? AND result IS NULL').run(fid); return; }
  db.prepare(`INSERT INTO picks(fixture_id,pick_id,label,market,pct,confidence,source,created_at) VALUES(?,?,?,?,?,?,?,?)
   ON CONFLICT(fixture_id) DO UPDATE SET pick_id=excluded.pick_id,label=excluded.label,market=excluded.market,pct=excluded.pct,confidence=excluded.confidence,source=excluded.source,created_at=excluded.created_at,result=NULL,settled_at=NULL`)
    .run(fid, p.id, p.label, p.market, p.pct, p.confidence, source, now());
}
// Προγνωστικά που υπήρχαν πριν την αναβάθμιση (μόνο όσα παρήχθησαν πριν την έναρξη του αγώνα)
export function backfillPicks() {
  for (const m of db.prepare('SELECT fixture_id,prediction FROM matches WHERE prediction IS NOT NULL AND enriched_at<kickoff_ts AND fixture_id NOT IN (SELECT fixture_id FROM picks)').all()) {
    const p = JSON.parse(m.prediction); if (p.status === 'ok') logPick(m.fixture_id, p, p.source || 'auto');
  }
}
export async function settleAll(withApi) {
  const rows = db.prepare(`SELECT p.fixture_id,p.pick_id,m.status,m.goals_home,m.goals_away,m.ht_home,m.ht_away,m.ft_home,m.ft_away,m.corners FROM picks p JOIN matches m USING(fixture_id)
    WHERE p.result IS NULL AND m.status IN ('FT','AET','PEN','CANC','ABD','AWD','WO')`).all();
  const set = db.prepare('UPDATE picks SET result=?,settled_at=? WHERE fixture_id=?');
  for (const r of rows) {
    if (['CANC', 'ABD', 'AWD', 'WO'].includes(r.status)) { set.run('void', now(), r.fixture_id); continue; }
    const isC = r.pick_id.startsWith('C');
    if (isC && r.status !== 'FT') { set.run('void', now(), r.fixture_id); continue; }
    let corners = r.corners;
    if (isC && corners == null) {
      if (!withApi) continue;
      corners = await cornerTotal(r.fixture_id); if (corners == null) continue;
      db.prepare('UPDATE matches SET corners=? WHERE fixture_id=?').run(corners, r.fixture_id);
    }
    const res = evalPick({ status: 'ok', id: r.pick_id }, r.ft_home ?? r.goals_home, r.ft_away ?? r.goals_away, { hth: r.ht_home, hta: r.ht_away, corners });
    if (res !== null) set.run(res ? 'win' : 'loss', now(), r.fixture_id);
  }
}
export function stats() {
  const rows = db.prepare(`SELECT market,confidence,source,result,pct FROM picks WHERE result IN ('win','loss')`).all();
  const agg = key => { const o = {}; for (const r of rows) { const k = r[key] || '—'; (o[k] ??= { w: 0, n: 0 }); o[k].n++; if (r.result === 'win') o[k].w++; }
    return Object.entries(o).map(([k, v]) => ({ k, n: v.n, w: v.w, rate: Math.round(v.w * 100 / v.n) })).sort((a, b) => b.n - a.n); };
  const n = rows.length, w = rows.filter(r => r.result === 'win').length;
  const one = q => db.prepare(q).get().c;
  return { n, w, rate: n ? Math.round(w * 100 / n) : null, avgPct: n ? Math.round(rows.reduce((s, r) => s + (r.pct || 0), 0) / n) : null,
    pending: one("SELECT COUNT(*) c FROM picks WHERE result IS NULL"), voided: one("SELECT COUNT(*) c FROM picks WHERE result='void'"),
    byMarket: agg('market'), byConf: agg('confidence'), bySource: agg('source') };
}
