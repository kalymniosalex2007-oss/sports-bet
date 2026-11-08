import { computePrediction } from './predict.js';
import { athensDate } from './util.js';
const pts = r => r === 'W' ? 3 : r === 'D' ? 1 : 0;
const d8 = ts => athensDate(new Date(ts * 1000));
export function parseRecent(list, teamId) {
  return list.filter(f => f.goals.home !== null).sort((a, b) => b.fixture.timestamp - a.fixture.timestamp).slice(0, 5).map(f => {
    const home = f.teams.home.id === teamId, gf = home ? f.goals.home : f.goals.away, ga = home ? f.goals.away : f.goals.home;
    return { date: d8(f.fixture.timestamp), opp: home ? f.teams.away.name : f.teams.home.name, home, gf, ga, res: gf > ga ? 'W' : gf === ga ? 'D' : 'L', comp: f.league.name, id: f.fixture.id, htg: f.score?.halftime?.home == null ? null : f.score.halftime.home + f.score.halftime.away, ct: null };
  });
}
const sum = r => r.length ? { pts: r.reduce((s, x) => s + pts(x.res), 0), gf: r.reduce((s, x) => s + x.gf, 0), ga: r.reduce((s, x) => s + x.ga, 0) } : null;
function venue(pred, side, loc) {
  const l = pred?.teams?.[side]?.league; if (!l) return null;
  return { p: l.fixtures?.played?.[loc], w: l.fixtures?.wins?.[loc], d: l.fixtures?.draws?.[loc], l: l.fixtures?.loses?.[loc], gf: l.goals?.for?.total?.[loc], ga: l.goals?.against?.total?.[loc] };
}
function motivation(name, st, total) {
  if (!st) return `${name}: δεν διατίθενται βαθμολογικά δεδομένα για αυτή τη διοργάνωση.`;
  const r = st.rank; let t = `${name}: ${r}η θέση με ${st.points} βαθμούς σε ${st.all.played} αγώνες.`;
  if (r === 1) t += ' Ηγείται και θέλει να διατηρήσει το προβάδισμα.';
  else if (r <= 4) t += ' Βρίσκεται στη μάχη για την κορυφή και τις ευρωπαϊκές θέσεις.';
  else if (total && r > total - 3) t += ' Βρίσκεται στη ζώνη ή κοντά στη ζώνη υποβιβασμού και χρειάζεται βαθμούς.';
  else t += ' Βρίσκεται στο μέσο της βαθμολογίας.';
  return t + (st.description ? ` (Κατηγορία πηγής: ${st.description})` : '');
}
export function buildAnalysis(m, { pred, recent, standings, injuries }) {
  const rh = recent.home, ra = recent.away, sh = sum(rh), sa = sum(ra);
  const all = (pred?.h2h || []).filter(f => f.goals.home !== null).sort((a, b) => b.fixture.timestamp - a.fixture.timestamp).slice(0, 8);
  const h2h = { list: all.map(f => ({ date: d8(f.fixture.timestamp), home: f.teams.home.name, away: f.teams.away.name, gh: f.goals.home, ga: f.goals.away })), hw: 0, d: 0, aw: 0, avg: null };
  for (const f of all) { const w = f.goals.home > f.goals.away ? f.teams.home.id : f.goals.home < f.goals.away ? f.teams.away.id : 0; if (!w) h2h.d++; else if (w === m.home_id) h2h.hw++; else h2h.aw++; }
  if (all.length) h2h.avg = +(all.reduce((s, f) => s + f.goals.home + f.goals.away, 0) / all.length).toFixed(2);
  const inj = side => [...new Map((injuries?.[side] || []).map(i => [i.name, i])).values()];
  const sH = standings?.home, sA = standings?.away, reasons = [];
  if (sh && sa) reasons.push(`Φόρμα τελευταίων αγώνων: ${m.home_name} ${sh.pts} βαθμοί (γκολ ${sh.gf}-${sh.ga}), ${m.away_name} ${sa.pts} βαθμοί (γκολ ${sa.gf}-${sa.ga}).`);
  if (sH && sA) reasons.push(`Βαθμολογία: ${m.home_name} ${sH.rank}η (${sH.points} β.), ${m.away_name} ${sA.rank}η (${sA.points} β.).`);
  if (h2h.list.length >= 3) reasons.push(`Στις τελευταίες ${h2h.list.length} μεταξύ τους αναμετρήσεις: ${h2h.hw} νίκες ${m.home_name}, ${h2h.d} ισοπαλίες, ${h2h.aw} νίκες ${m.away_name}, με μ.ό. ${h2h.avg} γκολ ανά αγώνα.`);
  const ih = inj('home').length, ia = inj('away').length;
  if (ih + ia) reasons.push(`Καταγεγραμμένες απουσίες/αμφίβολοι: ${m.home_name} ${ih}, ${m.away_name} ${ia} (μη επιβεβαιωμένες από τους συλλόγους).`);
  const both = [...rh, ...ra].filter(x => x.htg != null), allG = both.reduce((s, x) => s + x.gf + x.ga, 0);
  const avg = l => l.reduce((s, x) => s + x.ct, 0) / l.length, cH = rh.filter(x => x.ct != null), cA = ra.filter(x => x.ct != null);
  const ctx = { reasons, hasForm: !!(sh && sa), lowSample: (sH?.all?.played ?? 99) < 6 || (sA?.all?.played ?? 99) < 6,
    htShare: both.length >= 8 && allG >= 10 ? both.reduce((s, x) => s + x.htg, 0) / allG : null, htN: both.length,
    corners: cH.length >= 4 && cA.length >= 4 ? { lambda: (avg(cH) + avg(cA)) / 2, n: cH.length + cA.length } : null };
  const prediction = pred ? computePrediction(m, pred, ctx) : { status: 'no_data', note: 'Δεν υπάρχουν επαρκή δεδομένα για αξιόπιστο προγνωστικό.' };
  const notes = [];
  for (const [n, r] of [[m.home_name, rh], [m.away_name, ra]]) {
    if (r.length >= 4 && !r.some(x => x.res === 'L')) notes.push(`${n}: αήττητη στους τελευταίους ${r.length} αγώνες.`);
    if (r.length >= 4 && !r.some(x => x.res === 'W')) notes.push(`${n}: χωρίς νίκη στους τελευταίους ${r.length} αγώνες.`);
  }
  notes.push('Οι απουσίες προέρχονται από την πηγή δεδομένων και μπορεί να είναι ελλιπείς. Έλεγξε τις ανακοινώσεις των ομάδων πριν τον αγώνα.');
  return { prediction, analysis: {
    form: { home: rh, away: ra }, venue: { home: venue(pred, 'home', 'home'), away: venue(pred, 'away', 'away') },
    table: { home: sH ? { rank: sH.rank, pts: sH.points, p: sH.all.played } : null, away: sA ? { rank: sA.rank, pts: sA.points, p: sA.all.played } : null },
    motivation: { home: motivation(m.home_name, sH, standings?.total), away: motivation(m.away_name, sA, standings?.total) },
    h2h, injuries: { home: inj('home'), away: inj('away'), has: injuries != null }, notes } };
}
