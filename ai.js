// AI ανάλυση (Anthropic API). Το μοντέλο βλέπει ΜΟΝΟ τα δεδομένα της βάσης και δεν μπορεί να προσθέσει στοιχεία.
const SYSTEM = `Είσαι αναλυτής ποδοσφαίρου. Γράφεις στα ελληνικά, σε επαγγελματικό ύφος, για ιστοσελίδα προγνωστικών.
Χρησιμοποιείς ΜΟΝΟ τα δεδομένα JSON που σου δίνονται. Απαγορεύεται να αναφέρεις παίκτες, τραυματισμούς, τιμωρίες, προπονητές, ενδεκάδες, ειδήσεις ή αριθμούς που δεν υπάρχουν στα δεδομένα.
Αν κάτι είναι «ΜΗ ΔΙΑΘΕΣΙΜΟ» ή «ΔΕΝ ΕΧΟΥΝ ΑΝΑΚΟΙΝΩΘΕΙ», γράψε ότι δεν υπάρχουν πληροφορίες. Μην αλλάξεις το προγνωστικό ή την πιθανότητα: εξήγησέ τα. Μην υπόσχεσαι κέρδος.
Γράψε 4 σύντομες παραγράφους (φόρμα· εντός/εκτός έδρας και βαθμολογία/κίνητρο· απουσίες και ενδεκάδες· προγνωστικό και ρίσκα), 200-300 λέξεις συνολικά, χωρίς τίτλους και χωρίς markdown.`;
export async function aiAnalysis(m, a, p, lineups) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const names = { [m.home_id]: m.home_name, [m.away_id]: m.away_name };
  const facts = {
    match: { home: m.home_name, away: m.away_name, league: m.league_name, round: m.round, date: m.match_date, venue: m.venue },
    form_last5: a.form, home_away_season_stats: a.venue, table: a.table, motivation: a.motivation, head_to_head: a.h2h,
    injuries: a.injuries.has ? { home: a.injuries.home, away: a.injuries.away } : 'ΜΗ ΔΙΑΘΕΣΙΜΑ',
    lineups: lineups ? lineups.map(t => ({ team: names[t.team_id], formation: t.formation, xi: t.xi.map(x => x.name) })) : 'ΔΕΝ ΕΧΟΥΝ ΑΝΑΚΟΙΝΩΘΕΙ',
    prediction: p?.status === 'ok' ? { pick: p.label, probability_pct: p.pct, confidence: p.confidence, other_markets: p.alts, reasons: p.reasons } : 'ΚΑΝΕΝΑ'
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-haiku-5-5', max_tokens: 900, system: SYSTEM, messages: [{ role: 'user', content: 'Δεδομένα:\n' + JSON.stringify(facts) }] }) });
  if (!res.ok) throw new Error('AI ' + res.status);
  const j = await res.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  if (!text) return null;
  // Έλεγχος: κάθε λατινικό όνομα και κάθε αριθμός ≥10 πρέπει να υπάρχει στα δεδομένα, αλλιώς απορρίπτεται το κείμενο
  const src = JSON.stringify(facts).toLowerCase().replace(/\.0+\b/g, '');
  const bad = (text.match(/\b[A-Z][A-Za-z'’\-]{2,}\b/g) || []).find(w => !src.includes(w.toLowerCase()))
    || (text.match(/\b\d{2,}(?:[.,]\d+)?\b/g) || []).find(n => !src.includes(n.replace(',', '.').replace(/\.0+$/, '')));
  if (bad) throw new Error(`AI: απορρίφθηκε κείμενο (όρος που δεν υπάρχει στα δεδομένα: ${bad})`);
  return { text, model: process.env.AI_MODEL || 'claude-haiku-5-5', at: Math.floor(Date.now() / 1000), edited: false };
}
