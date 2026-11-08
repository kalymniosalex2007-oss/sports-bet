import { num } from './util.js';
const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
const cdf = (l, k) => { let s = 0; for (let i = 0; i <= k; i++) s += pois(l, i); return s; };
export function expectedGoals(pred) {
  const t = pred?.teams; if (!t) return null;
  const g = (s, k, loc) => num(t[s]?.league?.goals?.[k]?.average?.[loc]);
  const v = (s, k, loc) => g(s, k, loc) ?? g(s, k, 'total');
  const ha = v('home', 'for', 'home'), hd = v('home', 'against', 'home'), aa = v('away', 'for', 'away'), ad = v('away', 'against', 'away');
  if ([ha, hd, aa, ad].some(x => x === null)) return null;
  const c = x => Math.min(4, Math.max(0.2, x));
  return { lh: c((ha + ad) / 2), la: c((aa + hd) / 2) };
}
function grid(lh, la) {
  const r = { h: 0, d: 0, a: 0, o15: 0, o25: 0, o35: 0, gg: 0, t: 0 };
  for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) {
    const p = pois(lh, i) * pois(la, j); r.t += p;
    if (i > j) r.h += p; else if (i === j) r.d += p; else r.a += p;
    if (i + j > 1) r.o15 += p; if (i + j > 2) r.o25 += p; if (i + j > 3) r.o35 += p;
    if (i && j) r.gg += p;
  }
  for (const k of Object.keys(r)) if (k !== 't') r[k] /= r.t;
  return r;
}
// Ημίχρονο/Τελικό: δύο ανεξάρτητα ημίχρονα Poisson, με s = ποσοστό γκολ στο 1ο ημίχρονο
function htft(lh, la, s) {
  const a1 = lh * s, b1 = la * s, a2 = lh * (1 - s), b2 = la * (1 - s); let h = 0, a = 0, t = 0;
  for (let i1 = 0; i1 < 6; i1++) for (let j1 = 0; j1 < 6; j1++) { const p1 = pois(a1, i1) * pois(b1, j1);
    for (let i2 = 0; i2 < 6; i2++) for (let j2 = 0; j2 < 6; j2++) { const p = p1 * pois(a2, i2) * pois(b2, j2); t += p;
      const ht = i1 - j1, ft = i1 + i2 - j1 - j2; if (ht > 0 && ft > 0) h += p; if (ht < 0 && ft < 0) a += p; } }
  return { h11: h / t, a22: a / t };
}
const STATIC = { '1': '1Χ2', '2': '1Χ2', '1X': 'Διπλή Ευκαιρία', 'X2': 'Διπλή Ευκαιρία', 'O2.5': 'Over/Under', 'U2.5': 'Over/Under', 'O1.5': 'Over/Under', 'U3.5': 'Over/Under', 'GG': 'Goal/No Goal', 'NG': 'Goal/No Goal', 'HT0.5': 'Ημίχρονο', 'HF11': 'Ημίχρονο/Τελικό', 'HF22': 'Ημίχρονο/Τελικό' };
export const PICK_IDS = [...Object.keys(STATIC), 'CO9.5', 'CU9.5', 'CO10.5', 'CU10.5'];
export const marketOf = id => STATIC[id] || (/^C[OU]/.test(id) ? 'Κόρνερ' : 'Άλλο');
export function labelOf(id, m) {
  const c = /^C([OU])(\d+\.5)$/.exec(id); if (c) return `${c[1] === 'O' ? 'Over' : 'Under'} ${c[2]} κόρνερ`;
  return { '1': `Νίκη ${m.home_name} (1)`, '2': `Νίκη ${m.away_name} (2)`, '1X': 'Διπλή Ευκαιρία 1Χ', 'X2': 'Διπλή Ευκαιρία Χ2', 'O2.5': 'Over 2.5 γκολ', 'U2.5': 'Under 2.5 γκολ', 'O1.5': 'Over 1.5 γκολ', 'U3.5': 'Under 3.5 γκολ', 'GG': 'Goal/Goal (GG)', 'NG': 'No Goal (NG)', 'HT0.5': 'Over 0.5 γκολ στο 1ο ημίχρονο', 'HF11': 'Ημίχρονο/Τελικό 1/1', 'HF22': 'Ημίχρονο/Τελικό 2/2' }[id] || id;
}
export function computePrediction(m, pred, ctx) {
  const xg = expectedGoals(pred);
  if (!xg) return { status: 'no_data', note: 'Δεν υπάρχουν επαρκή στατιστικά δεδομένα για αξιόπιστο προγνωστικό.' };
  const g = grid(xg.lh, xg.la);
  let { h, d, a } = g;
  const pc = pred?.predictions?.percent;
  if (pc && num(pc.home) !== null) { h = (h + num(pc.home) / 100) / 2; d = (d + num(pc.draw) / 100) / 2; a = (a + num(pc.away) / 100) / 2; const s = h + d + a; h /= s; d /= s; a /= s; }
  const mk = (id, p, w) => ({ id, label: labelOf(id, m), market: marketOf(id), p, score: p * w });
  const all = [mk('1', h, 1.08), mk('2', a, 1.08), mk('1X', h + d, .88), mk('X2', a + d, .88), mk('O2.5', g.o25, 1), mk('U2.5', 1 - g.o25, 1),
    mk('O1.5', g.o15, .86), mk('U3.5', 1 - g.o35, .84), mk('GG', g.gg, 1), mk('NG', 1 - g.gg, .98)];
  if (ctx.htShare) {
    const s = Math.min(.6, Math.max(.3, ctx.htShare)), hf = htft(xg.lh, xg.la, s);
    all.push(mk('HT0.5', 1 - Math.exp(-(xg.lh + xg.la) * s), .8), mk('HF11', hf.h11, .8), mk('HF22', hf.a22, .8));
  }
  if (ctx.corners) {
    const l = ctx.corners.lambda, adj = p => .5 + (p - .5) * .7; // μείωση βεβαιότητας: τα κόρνερ έχουν μεγάλη διακύμανση
    for (const L of [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]) if (Math.abs(L - l) <= 1.5) { const po = 1 - cdf(l, Math.floor(L)); all.push(mk(`CO${L}`, adj(po), .85), mk(`CU${L}`, adj(1 - po), .85)); }
  }
  all.sort((x, y) => y.score - x.score);
  const alts = all.slice(0, 5).map(x => ({ label: x.label, pct: Math.round(Math.min(.85, x.p) * 100) }));
  const best = all[0];
  const xgTxt = `Το μοντέλο (Poisson, με βάση τους μέσους όρους γκολ εντός/εκτός έδρας) εκτιμά αναμενόμενα γκολ ${xg.lh.toFixed(2)} για ${m.home_name} και ${xg.la.toFixed(2)} για ${m.away_name}.`;
  if (best.p < .56) return { status: 'no_pick', alts, note: 'Καμία αγορά δεν ξεπερνά το όριο 56%. Δεν προτείνουμε επιλογή για αυτόν τον αγώνα.', reasons: [xgTxt] };
  let conf = best.p >= .70 ? 2 : best.p >= .62 ? 1 : 0;
  if (!ctx.hasForm || ctx.lowSample) conf = Math.max(0, conf - 1);
  const reasons = [xgTxt, ...ctx.reasons];
  if (/^(HT|HF)/.test(best.id)) reasons.push(`Στους τελευταίους ${ctx.htN} αγώνες των δύο ομάδων το ${Math.round(ctx.htShare * 100)}% των γκολ μπήκε στο 1ο ημίχρονο (μικρό δείγμα, η εκτίμηση είναι πιο αβέβαιη).`);
  if (best.id.startsWith('C')) reasons.push(`Μ.ό. κόρνερ ανά αγώνα στους τελευταίους ${ctx.corners.n} αγώνες των δύο ομάδων (υπέρ και κατά): ${ctx.corners.lambda.toFixed(1)}. Η πιθανότητα έχει περιοριστεί λόγω της υψηλής διακύμανσης των κόρνερ.`);
  const adv = pred?.predictions?.advice; if (adv) reasons.push(`Η πηγή δεδομένων (API-Football) προτείνει: «${adv}».`);
  return { status: 'ok', id: best.id, label: best.label, market: best.market, pct: Math.round(Math.min(.85, best.p) * 100),
    confidence: ['Χαμηλό', 'Μέτριο', 'Υψηλό'][conf], alts, reasons, source: 'auto' };
}
// Έλεγχος επαλήθευσης. Επιστρέφει true/false ή null αν λείπουν δεδομένα. gh/ga = σκορ 90'
export function evalPick(p, gh, ga, x = {}) {
  if (!p || p.status !== 'ok' || gh == null || ga == null) return null;
  const { hth, hta, corners } = x, t = gh + ga, id = p.id;
  if (id === 'HT0.5') return hth == null ? null : hth + hta > 0;
  if (id === 'HF11') return hth == null ? null : hth > hta && gh > ga;
  if (id === 'HF22') return hth == null ? null : hth < hta && ga > gh;
  const c = /^C([OU])(\d+\.5)$/.exec(id);
  if (c) return corners == null ? null : c[1] === 'O' ? corners > +c[2] : corners < +c[2];
  return ({ '1': gh > ga, '2': ga > gh, '1X': gh >= ga, 'X2': ga >= gh, 'O2.5': t > 2, 'U2.5': t < 3, 'O1.5': t > 1, 'U3.5': t < 4, 'GG': gh > 0 && ga > 0, 'NG': !(gh > 0 && ga > 0) })[id] ?? null;
}
