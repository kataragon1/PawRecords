// ── LOOKUP ── Free, local retrieval answers for the chat.
// Detects pure-lookup questions and answers them from cached data with NO API
// call (no tokens, works even with no API key / no credits). Anything that
// needs reasoning returns null so the caller falls through to Claude.

import {
  APP_PETS,
  _allVisitsCache,
  _allLabsCache,
  _journalDocsCache,
} from './state.js';

// ─────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────

function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _jCats(e) {
  if (Array.isArray(e.cats) && e.cats.length) return e.cats;
  if (e.cat) return [e.cat];
  return [];
}

// Detect a pet named in the query (first match wins).
function detectCat(text) {
  return (APP_PETS || []).find(c => new RegExp(`\\b${_escapeRe(c)}\\b`, 'i').test(text)) || null;
}

const byDateDesc = (da, db) => (db || '') > (da || '') ? 1 : -1;

// ─────────────────────────────────────────────
// VISIT SEARCH  (used by chat context builder too)
// ─────────────────────────────────────────────

// Query/intent words that describe the *request*, not clinical content.
const _SEARCH_STOPWORDS = new Set([
  'search','find','show','list','tell','give','look','looking','mention','mentions','mentioned',
  'history','visit','visits','vet','veterinary','record','records','note','notes','appointment','appointments',
  'all','any','every','when','did','does','has','have','had','ever','was','were','with','about',
  'from','back','year','years','ago','the','and','for','what','which','she','her','him','his',
  'they','their','please','you','can','could','would','me','my','our','get','see','pull','recent',
]);

// Search visits by content terms. `catFilter` (optional) restricts to one pet.
// Best-matching first. With no real content terms ("show Evie's visits"),
// returns that pet's visits newest-first (browse mode).
export function searchVisits(query, catFilter = null) {
  if (!_allVisitsCache) return [];
  const petNames = new Set((APP_PETS || []).map(p => p.toLowerCase()));
  const terms = query.toLowerCase().split(/\W+/)
    .filter(t => t.length > 2 && !_SEARCH_STOPWORDS.has(t) && !petNames.has(t));

  let pool = _allVisitsCache;
  if (catFilter) pool = pool.filter(v => v.cat === catFilter);

  if (!terms.length) return pool.slice().sort((a, b) => byDateDesc(a.date, b.date));

  return pool
    .map(v => {
      const text = `${v.synopsis||''} ${v.narrative||''} ${v.chiefComplaint||''} ${v.clinic||''}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
      return { v, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || byDateDesc(a.v.date, b.v.date))
    .map(x => x.v);
}

// ─────────────────────────────────────────────
// INTENT CLASSIFIER
// ─────────────────────────────────────────────

// If any of these appear, the user wants reasoning — hand off to Claude.
const REASONING_RE = /\b(why|summar\w+|explain|interpret\w*|analyz\w*|assess\w*|evaluat\w*|compare|should|recommend\w*|suggest\w*|concern\w*|worr\w*|means?|meaning|normal|abnormal|healthy|unhealthy|safe|dangerous|trend\w*|diagnos\w*|opinion|advice|advis\w*|think|cause\w*|causing|relat\w*|connect\w*|correlat\w*)\b/i;

const LAB_RE = /\b(labs?|bloodwork|blood\s*work|cbc|chemistry|chem|urinalysis|ua|sdma|bun|creatinine|hematocrit|hct|wbc|rbc|platelets?|glucose|t4|thyroid|albumin|potassium|phosphorus|calcium)\b/i;
const WEIGHT_RE = /\bweights?\b/i;
const JOURNAL_RE = /\b(medications?|meds?|supplements?|supps?|diet|diets|foods?|taking|prescrib\w*|on\s+now|currently\s+on)\b/i;
const VISIT_RE = /\b(visits?|appointments?|vet|seen|went|been\s+to|records?)\b|\bwhen\s+did\b/i;

// Returns { text } for a local answer, or null to defer to Claude.
export function tryLocalAnswer(text) {
  if (!text) return null;
  if (REASONING_RE.test(text)) return null; // needs reasoning → Claude

  const cat = detectCat(text);

  if (LAB_RE.test(text))     return answerLabs(text, cat);
  if (WEIGHT_RE.test(text))  return answerWeight(cat);
  if (JOURNAL_RE.test(text)) return answerJournal(text, cat);
  if (VISIT_RE.test(text))   return answerVisits(text, cat);

  return null; // unknown shape → Claude
}

const LOCAL_TAG = '🔍 Local lookup (free, no API):\n\n';

// ─────────────────────────────────────────────
// ANSWER BUILDERS
// ─────────────────────────────────────────────

function answerVisits(text, cat) {
  const matches = searchVisits(text, cat);
  if (!matches.length) {
    return { text: LOCAL_TAG + `No vet visits found${cat ? ' for ' + cat : ''} in the records.\n(This searches visit note text only — not labs or journal.)` };
  }
  const shown = matches.slice(0, 15);
  let out = LOCAL_TAG + `${matches.length} visit${matches.length !== 1 ? 's' : ''} found${cat ? ' for ' + cat : ''}${matches.length > 15 ? ' (showing 15 most relevant)' : ''}:\n`;
  for (const v of shown) {
    out += `\n• ${v.date || '?'}${!cat ? ' · ' + (v.cat || '?') : ''}${v.clinic ? ' · ' + v.clinic : ''}`;
    const syn = (v.synopsis || v.chiefComplaint || '').replace(/\n/g, ' ').trim();
    if (syn) out += `\n  ${syn.slice(0, 200)}`;
  }
  return { text: out };
}

function answerJournal(text, cat) {
  const q = text.toLowerCase();
  let listFilter = null;
  if (/\bsupp/.test(q)) listFilter = 'Supplements';
  else if (/\bdiet/.test(q)) listFilter = 'Diet';
  else if (/\bfood/.test(q)) listFilter = 'Foods';
  else if (/\bmed/.test(q) || /prescrib/.test(q)) listFilter = 'Medications';

  const active = (_journalDocsCache || []).filter(e => {
    const s = e.status || 'current';
    if (s === 'past' || s === 'rejected') return false;
    if (cat && !_jCats(e).includes(cat)) return false;
    if (listFilter && (e.list || '') !== listFilter) return false;
    return true;
  });

  if (!active.length) {
    return { text: LOCAL_TAG + `No current ${listFilter ? listFilter.toLowerCase() : 'journal entries'}${cat ? ' for ' + cat : ''}.` };
  }

  // Group by list, then (if no cat) note which pets.
  const byList = {};
  for (const e of active) {
    const l = e.list || 'Other';
    (byList[l] = byList[l] || []).push(e);
  }

  let out = LOCAL_TAG + `Current ${listFilter ? listFilter.toLowerCase() : 'journal'}${cat ? ' for ' + cat : ' (all pets)'}:\n`;
  for (const [list, items] of Object.entries(byList)) {
    out += `\n${list}:`;
    for (const e of items) {
      const cats = _jCats(e);
      const who = !cat && cats.length ? ` [${cats.join('/')}]` : '';
      const dose = e.dose ? ` — ${e.dose}` : '';
      const since = e.startDate ? ` (since ${e.startDate})` : '';
      out += `\n  • ${e.text}${dose}${who}${since}`;
    }
  }
  return { text: out };
}

function answerLabs(text, cat) {
  if (!_allLabsCache || !_allLabsCache.length) {
    return { text: LOCAL_TAG + 'No lab results are loaded.' };
  }
  let pool = _allLabsCache;
  if (cat) pool = pool.filter(l => l.cat === cat);
  if (!pool.length) {
    return { text: LOCAL_TAG + `No lab results found${cat ? ' for ' + cat : ''}.` };
  }

  // Did they name a specific test? Match against distinct test names present.
  const q = text.toLowerCase();
  const testNames = [...new Set(pool.map(l => (l.test || '').trim()).filter(Boolean))];
  const namedTest = testNames.find(t => t && q.includes(t.toLowerCase()));

  if (namedTest) {
    const series = pool
      .filter(l => (l.test || '').trim().toLowerCase() === namedTest.toLowerCase())
      .sort((a, b) => byDateDesc(a.resultDate, b.resultDate))
      .slice(0, 12);
    let out = LOCAL_TAG + `${namedTest}${cat ? ' — ' + cat : ''} (newest first):\n`;
    for (const l of series) {
      const ref = (l.refLow != null && l.refHigh != null) ? ` (${l.refLow}-${l.refHigh})` : '';
      const flag = l.abnormal ? ' *' + l.abnormal : '';
      out += `\n• ${l.resultDate || '?'}: ${l.value}${l.unit || ''}${ref}${flag}`;
    }
    return { text: out };
  }

  // Otherwise show the most recent panel (by latest date) for the pet(s).
  const latestDate = pool.map(l => l.resultDate || '').sort().reverse()[0];
  const panel = pool.filter(l => (l.resultDate || '') === latestDate)
    .sort((a, b) => (a.labGroup || '') > (b.labGroup || '') ? 1 : -1);
  let out = LOCAL_TAG + `Most recent labs${cat ? ' for ' + cat : ''} (${latestDate || 'undated'}):\n`;
  for (const l of panel) {
    const ref = (l.refLow != null && l.refHigh != null) ? ` (${l.refLow}-${l.refHigh})` : '';
    const flag = l.abnormal ? ' *' + l.abnormal : '';
    const who = !cat ? ` [${l.cat}]` : '';
    out += `\n• ${l.test}: ${l.value}${l.unit || ''}${ref}${flag}${who}`;
  }
  out += '\n\n(Ask for a specific test by name to see its history.)';
  return { text: out };
}

function answerWeight(cat) {
  const pool = (_allVisitsCache || [])
    .filter(v => v.vitals?.weight && (!cat || v.cat === cat))
    .sort((a, b) => byDateDesc(a.date, b.date));
  if (!pool.length) {
    return { text: LOCAL_TAG + `No recorded weights found${cat ? ' for ' + cat : ''}.` };
  }
  let out = LOCAL_TAG + `Weight history${cat ? ' for ' + cat : ''} (newest first):\n`;
  for (const v of pool.slice(0, 15)) {
    const who = !cat ? ` [${v.cat}]` : '';
    const bcs = v.vitals.BCS ? ` · BCS ${v.vitals.BCS}` : '';
    out += `\n• ${v.date || '?'}: ${v.vitals.weight}${bcs}${who}`;
  }
  return { text: out };
}
