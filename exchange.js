// ── EXCHANGE ── Export/Import for external AI sessions

import {
  $, db, addDoc, writeBatch, doc, collection, showToast, arrayRemove,
} from './core.js';

import {
  APP_PETS,
  _journalDocsCache,
  _allVisitsCache,
  _allLabsCache,
  _notesCache,
  setJournalDocsCache,
  setNotesCache,
  setChatContextDirty,
} from './state.js';

// ─────────────────────────────────────────────
// LIST NAME NORMALIZATION
// ─────────────────────────────────────────────

const _LIST_ALIASES = {
  med: 'medications', meds: 'medications', medication: 'medications', medications: 'medications',
  supp: 'supplements', supps: 'supplements', supplement: 'supplements', supplements: 'supplements',
  diet: 'diet',
  food: 'foods', foods: 'foods',
};

function _normalizeList(list) {
  return _LIST_ALIASES[(list || '').toLowerCase().trim()] || (list || '').toLowerCase().trim();
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function _jCats(e) {
  if (Array.isArray(e.cats) && e.cats.length) return e.cats;
  if (e.cat) return [e.cat];
  return [];
}

function catMatchesJournal(entry, cat) {
  if (!cat) return true;
  return _jCats(entry).includes(cat);
}

function catMatchesNote(note, cat) {
  if (!cat) return true;
  if (Array.isArray(note.cats)) return note.cats.includes(cat);
  return true;
}

// Format one journal entry as export text.
// showCat=true appends " (PetName)" or " (all cats)" to the item name.
function formatJournalLine(e, showCat = false) {
  const cats = _jCats(e);
  let name = (e.text || '').trim();
  if (showCat && cats.length > 0) {
    const label = cats.length > 1 ? 'all cats' : cats[0];
    name += ` (${label})`;
  }
  let line = `${_normalizeList(e.list || 'misc')}: ${name}`;
  if (e.dose && e.dose.trim()) line += ` | ${e.dose.trim()}`;
  if (e.startDate && e.startDate.trim()) line += ` | since ${e.startDate.trim()}`;
  return line;
}

// Key used for dedup matching: normalized list + text (lowercase) + optional cat
function _journalKey(list, text, cat) {
  let k = _normalizeList(list) + '|' + (text || '').toLowerCase().trim();
  if (cat && cat !== 'all') k += '|' + cat.toLowerCase().trim();
  else if (cat === 'all') k += '|all';
  return k;
}

// All possible keys for an original entry (one per cat, plus "all" for multi-cat)
function _origKeys(e) {
  const cats = _jCats(e);
  if (!cats.length) return [_journalKey(e.list, e.text, null)];
  const keys = cats.map(c => _journalKey(e.list, e.text, c));
  if (cats.length > 1) keys.push(_journalKey(e.list, e.text, 'all'));
  return keys;
}

function abbrevClinic(name) {
  if (!name) return '';
  return name
    .replace(/Veterinary Emergency Group/i, 'VEG')
    .replace(/Animal Medical Center/i, 'AMC')
    .replace(/BluePearl/i, 'BluePearl')
    .replace(/Banfield Pet Hospital/i, 'Banfield');
}

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

export function buildExportText(cat, fromDateStr) {
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = fromDateStr || '2000-01-01';
  const catLabel = cat || 'All pets';
  const multiCat = !cat;

  let out = `PAWS: ${catLabel} | exported ${today} | history from ${fromDate}\n\n`;

  // ── CURRENT ──
  const journal = (_journalDocsCache || []).filter(e => catMatchesJournal(e, cat));
  const byList = {};
  for (const e of journal) {
    const l = _normalizeList(e.list || 'misc');
    if (!byList[l]) byList[l] = [];
    byList[l].push(e);
  }
  if (Object.keys(byList).length) {
    out += 'CURRENT\n';
    for (const [, items] of Object.entries(byList)) {
      for (const e of items) out += formatJournalLine(e, multiCat) + '\n';
    }
    out += '\n';
  }

  // ── VISITS ──
  const visits = (_allVisitsCache || [])
    .filter(v => (!cat || v.cat === cat) && (v.date || '') >= fromDate)
    .sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);
  if (visits.length) {
    out += 'VISITS\n';
    for (const v of visits) {
      const clinic = v.clinic ? ` ${abbrevClinic(v.clinic)}:` : ':';
      const wt = v.vitals?.weight ? ` wt ${v.vitals.weight}` : '';
      const bcs = v.vitals?.BCS ? ` BCS${v.vitals.BCS}` : '';
      const synopsis = (v.synopsis || v.chiefComplaint || '').replace(/\n/g, ' ').slice(0, 200);
      out += `${v.date || '?'}${clinic}${wt}${bcs}${synopsis ? '. ' + synopsis : ''}\n`;
    }
    out += '\n';
  }

  // ── LABS ──
  const labs = (_allLabsCache || [])
    .filter(l => (!cat || l.cat === cat) && (l.resultDate || '') >= fromDate)
    .sort((a, b) => (b.resultDate || '') > (a.resultDate || '') ? 1 : -1);
  if (labs.length) {
    out += 'LABS\n';
    const byDate = {};
    for (const l of labs) {
      const d = l.resultDate || '?';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(l);
    }
    for (const [date, entries] of Object.entries(byDate).sort((a, b) => b[0] > a[0] ? 1 : -1)) {
      const parts = entries.map(l => {
        const ref = (l.refLow != null && l.refHigh != null) ? `(${l.refLow}-${l.refHigh})` : '';
        const flag = l.abnormal ? (parseFloat(l.value) > parseFloat(l.refHigh || Infinity) ? 'H' : 'L') : 'N';
        return `${l.test} ${l.value}${l.unit || ''}${ref}${flag}`;
      });
      out += `${date}: ${parts.join(' | ')}\n`;
    }
    out += '\n';
  }

  // ── WEIGHT ──
  const withWeight = (_allVisitsCache || [])
    .filter(v => (!cat || v.cat === cat) && v.vitals?.weight && (v.date || '') >= fromDate)
    .sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);
  if (withWeight.length) {
    out += 'WEIGHT\n';
    out += withWeight
      .map(v => `${v.date} ${v.vitals.weight}${v.vitals.BCS ? ' BCS' + v.vitals.BCS : ''}`)
      .join(' | ') + '\n\n';
  }

  // ── NOTES ──
  const notes = (_notesCache || [])
    .filter(n => !n.archived && catMatchesNote(n, cat) && (n.addedDate || '') >= fromDate)
    .sort((a, b) => (b.addedDate || '') > (a.addedDate || '') ? 1 : -1);
  if (notes.length) {
    out += 'NOTES\n';
    for (const n of notes) {
      out += `${n.addedDate || '?'}: ${(n.text || '').replace(/\n/g, ' ')}\n`;
    }
    out += '\n';
  }

  // ── RETURN BLOCK ──
  out += '---RETURN THIS BLOCK WHEN DONE---\n';
  out += 'JOURNAL\n';
  for (const e of journal) out += formatJournalLine(e, multiCat) + '\n';
  out += '\nSESSION NOTES\n(Add: YYYY-MM-DD: brief session summary)\n\n';

  // ── INSTRUCTIONS ──
  out += '---INSTRUCTIONS---\n';
  out += `Records for ${catLabel}. When user says done: output the RETURN block.\n`;
  out += 'JOURNAL: list every current item (omissions = discontinued). Keep the exact format:\n';
  out += multiCat
    ? '  list: item name (PetName) | dose | since YYYY-MM-DD\n'
    : '  list: item name | dose | since YYYY-MM-DD\n';
  out += '  list is one of: medications, supplements, diet, foods\n';
  if (multiCat) out += '  Use (all cats) for items shared by all pets.\n';
  out += 'SESSION NOTES: replace placeholder with: YYYY-MM-DD: brief session summary.\n';

  return out;
}

export async function triggerExport(cat, fromDate) {
  const text = buildExportText(cat, fromDate);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 100 * 1024) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${(bytes / 1024).toFixed(1)} KB to clipboard ✓`, 'journal');
      return;
    } catch (e) { /* fall through */ }
  }
  _downloadText(text, cat);
  showToast(`Downloaded ${(bytes / 1024).toFixed(1)} KB export`, 'journal');
}

function _downloadText(text, cat) {
  const today = new Date().toISOString().slice(0, 10);
  const name = cat ? cat.toLowerCase().replace(/\s+/g, '-') : 'all-pets';
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `paws-${name}-${today}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// IMPORT — PARSE
// ─────────────────────────────────────────────

// Extract "(CatName)" or "(all cats)" from end of text string.
// Returns { text, cat } where cat is a pet name, "all", or null.
function _extractCat(raw) {
  const m = raw.match(/\s*\(([^)]+)\)\s*$/);
  if (!m) return { text: raw.trim(), cat: null };
  const inner = m[1].trim();
  const isAll = /^all(\s+cats?)?$/i.test(inner);
  return {
    text: raw.slice(0, m.index).trim(),
    cat: isAll ? 'all' : inner,
  };
}

// Parse one journal line. Handles two formats:
//   "medications: Prednisolone (Mocha) | 2.5mg | since 2026-04-19"  (our format)
//   "list: meds | Prednisolone (Mocha) | 2.5mg | since 2026-04-19"  (Claude's variant)
function _parseJournalLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return null;
  let list = line.slice(0, colonIdx).trim().toLowerCase();
  let rest = line.slice(colonIdx + 1).trim();

  if (!list || list.startsWith('-') || list.startsWith('(') || list === 'session notes' || list === 'journal') return null;

  // Handle "list: meds | ..." variant where "list" is a literal keyword
  if (list === 'list') {
    const pipeIdx = rest.indexOf('|');
    if (pipeIdx < 0) return null;
    list = rest.slice(0, pipeIdx).trim().toLowerCase();
    rest = rest.slice(pipeIdx + 1).trim();
  }

  const parts = rest.split('|').map(p => p.trim());
  const rawText = parts[0] || '';
  if (!rawText) return null;

  const { text, cat } = _extractCat(rawText);
  if (!text) return null;

  const dose = parts[1] || '';
  let startDate = '';
  for (let i = 2; i < parts.length; i++) {
    const m = parts[i].match(/(\d{4}-\d{2}-\d{2})/);
    if (m) { startDate = m[1]; break; }
  }

  return { list, text, dose, startDate, cat };
}

export function parseImportText(raw) {
  const lines = raw.split('\n');
  const journalLines = [];
  const sessionNoteLines = [];
  let section = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'JOURNAL') { section = 'journal'; continue; }
    if (trimmed === 'SESSION NOTES') { section = 'notes'; continue; }
    if (trimmed.startsWith('---')) { section = null; continue; }
    if (!trimmed) continue;
    if (section === 'journal') journalLines.push(trimmed);
    else if (section === 'notes') sessionNoteLines.push(trimmed);
  }

  const journalItems = journalLines.map(_parseJournalLine).filter(Boolean);

  const today = new Date().toISOString().slice(0, 10);
  const sessionNotes = sessionNoteLines
    .filter(l => l && !l.startsWith('('))
    .map(l => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2}):\s*(.*)/);
      if (m) return { date: m[1], text: m[2].trim() };
      return { date: today, text: l };
    })
    .filter(n => n.text);

  return { journalItems, sessionNotes };
}

// ─────────────────────────────────────────────
// IMPORT — DIFF
// ─────────────────────────────────────────────

export function buildImportDiff(cat, parsed) {
  const { journalItems: returned, sessionNotes } = parsed;
  const originals = (_journalDocsCache || []).filter(e => catMatchesJournal(e, cat));

  // Build origMap: every possible key for each original entry
  const origMap = new Map();
  for (const e of originals) {
    for (const k of _origKeys(e)) {
      if (!origMap.has(k)) origMap.set(k, e);
    }
  }

  // Build returnMap: one key per returned item
  const returnMap = new Map();
  for (const item of returned) {
    const k = _journalKey(item.list, item.text, item.cat);
    returnMap.set(k, item);
  }

  const added = [];
  const changed = [];

  for (const [k, item] of returnMap) {
    const orig = origMap.get(k);
    if (!orig) {
      added.push(item);
    } else if (
      (item.dose || '') !== (orig.dose || '') ||
      (item.startDate || '') !== (orig.startDate || '')
    ) {
      changed.push({ orig, item });
    }
  }

  // Removed: originals where NO key appears in returnMap
  const removedIds = new Set();
  const removed = [];
  for (const e of originals) {
    if (e.id && removedIds.has(e.id)) continue;
    const anyMatch = _origKeys(e).some(k => returnMap.has(k));
    if (!anyMatch) {
      removed.push(e);
      if (e.id) removedIds.add(e.id);
    }
  }

  return { added, removed, changed, sessionNotes };
}

// ─────────────────────────────────────────────
// IMPORT — PREVIEW HTML
// ─────────────────────────────────────────────

function _esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _fmtItem(item) {
  // For preview, show "list: text (cat) | dose | since date"
  let s = `${_normalizeList(item.list)}: ${_esc(item.text)}`;
  if (item.cat && item.cat !== 'all') s += ` <em>(${_esc(item.cat)})</em>`;
  else if (item.cat === 'all') s += ` <em>(all cats)</em>`;
  if (item.dose) s += ` | ${_esc(item.dose)}`;
  if (item.startDate) s += ` | since ${item.startDate}`;
  return s;
}

function _fmtOrig(e) {
  const cats = _jCats(e);
  let s = `${_normalizeList(e.list)}: ${_esc(e.text)}`;
  if (cats.length) s += ` <em>(${cats.join('/')})</em>`;
  if (e.dose) s += ` | ${_esc(e.dose)}`;
  if (e.startDate) s += ` | since ${e.startDate}`;
  return s;
}

function _buildPreviewHTML(diff) {
  const { added, removed, changed, sessionNotes } = diff;
  const total = added.length + removed.length + changed.length + sessionNotes.length;

  if (total === 0) {
    return '<p class="exchange-preview-empty">No changes detected — journal matches current records.</p>';
  }

  let html = '';
  if (added.length) {
    html += `<div class="exchange-preview-section">`;
    html += `<div class="exchange-preview-label add">+ Add (${added.length})</div>`;
    for (const item of added) html += `<div class="exchange-preview-row add">${_fmtItem(item)}</div>`;
    html += '</div>';
  }
  if (removed.length) {
    html += `<div class="exchange-preview-section">`;
    html += `<div class="exchange-preview-label remove">− Remove (${removed.length})</div>`;
    for (const orig of removed) html += `<div class="exchange-preview-row remove">${_fmtOrig(orig)}</div>`;
    html += '</div>';
  }
  if (changed.length) {
    html += `<div class="exchange-preview-section">`;
    html += `<div class="exchange-preview-label change">~ Update (${changed.length})</div>`;
    for (const { orig, item } of changed) {
      html += `<div class="exchange-preview-row change">${_fmtItem(item)}<br><span class="exchange-preview-was">was: ${_fmtOrig(orig)}</span></div>`;
    }
    html += '</div>';
  }
  if (sessionNotes.length) {
    html += `<div class="exchange-preview-section">`;
    html += `<div class="exchange-preview-label note">📝 Session Notes (${sessionNotes.length})</div>`;
    for (const n of sessionNotes) html += `<div class="exchange-preview-row note">${_esc(n.date)}: ${_esc(n.text)}</div>`;
    html += '</div>';
  }
  return html;
}

// ─────────────────────────────────────────────
// IMPORT — APPLY
// ─────────────────────────────────────────────

export async function applyImport(diff, cat) {
  const { added, removed, changed, sessionNotes } = diff;
  const today = new Date().toISOString().slice(0, 10);
  const defaultCatArr = cat ? [cat] : APP_PETS.slice();

  const batch = writeBatch(db);

  // Add new journal items
  for (const item of added) {
    let itemCats;
    if (item.cat === 'all') itemCats = APP_PETS.slice();
    else if (item.cat) itemCats = [item.cat];
    else itemCats = defaultCatArr;

    const ref = doc(collection(db, 'journal'));
    batch.set(ref, {
      list: item.list,
      text: item.text,
      dose: item.dose || '',
      startDate: item.startDate || '',
      cats: itemCats,
      addedDate: today,
      status: 'active',
    });
  }

  // Remove journal items
  for (const orig of removed) {
    if (!orig.id) continue;
    const origCats = _jCats(orig);
    const ref = doc(db, 'journal', orig.id);
    if (cat && origCats.length > 1) {
      batch.update(ref, { cats: origCats.filter(c => c !== cat) });
    } else {
      batch.delete(ref);
    }
  }

  // Update changed items
  for (const { orig, item } of changed) {
    if (!orig.id) continue;
    batch.update(doc(db, 'journal', orig.id), {
      dose: item.dose || '',
      startDate: item.startDate || '',
    });
  }

  await batch.commit();

  // Add session notes
  for (const n of sessionNotes) {
    await addDoc(collection(db, 'context_notes'), {
      text: n.text,
      cats: defaultCatArr,
      addedDate: n.date,
      pinned: false,
      archived: false,
    });
  }

  setJournalDocsCache(null);
  setNotesCache([]);
  setChatContextDirty(true);

  try {
    const { loadJournalSidebar } = await import('./journal.js');
    const { loadNotes } = await import('./notes.js');
    await Promise.all([loadJournalSidebar(), loadNotes()]);
  } catch (e) { /* non-critical */ }
}

// ─────────────────────────────────────────────
// COPY REMINDER PROMPT
// ─────────────────────────────────────────────

const REMINDER_PROMPT = `We're done for today. Please output the complete RETURN block now.

---RETURN THIS BLOCK WHEN DONE---
JOURNAL
(list every current medication, supplement, diet, and food item — one per line)
Format: list: item name (PetName) | dose | since YYYY-MM-DD
  - list is one of: medications, supplements, diet, foods
  - Use (all cats) for items shared by all pets
  - Omit anything discontinued

SESSION NOTES
YYYY-MM-DD: brief summary of what we discussed today`;

// ─────────────────────────────────────────────
// UI — INIT
// ─────────────────────────────────────────────

let _pendingDiff = null;
let _pendingCat = null;

export function initExchangeBar() {
  const sel = $('exchange-cat-select');
  if (!sel) return;

  while (sel.options.length > 1) sel.remove(1);
  for (const pet of APP_PETS) {
    const opt = document.createElement('option');
    opt.value = pet; opt.textContent = pet;
    sel.appendChild(opt);
  }

  // Export
  $('exchange-export-btn')?.addEventListener('click', async () => {
    const cat = sel.value || null;
    const fromDate = $('exchange-from-date')?.value || '';
    const btn = $('exchange-export-btn');
    btn.disabled = true; btn.textContent = 'Exporting…';
    try { await triggerExport(cat, fromDate); }
    finally { btn.disabled = false; btn.textContent = '↑ Export'; }
  });

  // Copy reminder prompt
  $('exchange-copy-prompt-btn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(REMINDER_PROMPT);
      showToast('Prompt copied — paste it to Claude ✓', 'journal');
    } catch (e) {
      showToast('Copy failed', 'warning');
    }
  });

  // Toggle import area
  $('exchange-import-btn')?.addEventListener('click', () => {
    const area = $('exchange-import-area');
    if (!area) return;
    const visible = area.style.display !== 'none';
    area.style.display = visible ? 'none' : '';
    if (!visible) setTimeout(() => $('exchange-import-input')?.focus(), 60);
  });

  // Cancel import
  $('exchange-import-cancel')?.addEventListener('click', () => {
    $('exchange-import-area').style.display = 'none';
    $('exchange-import-input').value = '';
  });

  // Preview & Apply
  $('exchange-import-preview-btn')?.addEventListener('click', () => {
    const raw = $('exchange-import-input')?.value?.trim();
    if (!raw) { showToast('Paste the AI response first', 'warning'); return; }

    const cat = sel.value || null;
    const parsed = parseImportText(raw);

    if (!parsed.journalItems.length && !parsed.sessionNotes.length) {
      showToast('No JOURNAL or SESSION NOTES block found', 'warning');
      return;
    }

    const diff = buildImportDiff(cat, parsed);
    _pendingDiff = diff;
    _pendingCat = cat;

    const body = $('import-preview-body');
    if (body) body.innerHTML = _buildPreviewHTML(diff);
    const modal = $('import-preview-modal');
    if (modal) modal.style.display = 'flex';
  });

  // Apply confirmed
  $('import-preview-apply')?.addEventListener('click', async () => {
    if (!_pendingDiff) return;
    const btn = $('import-preview-apply');
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      await applyImport(_pendingDiff, _pendingCat);
      $('import-preview-modal').style.display = 'none';
      $('exchange-import-area').style.display = 'none';
      $('exchange-import-input').value = '';
      _pendingDiff = null;
      showToast('Import applied ✓', 'journal');
    } catch (e) {
      showToast('Import failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Apply';
    }
  });

  const closePreview = () => {
    $('import-preview-modal').style.display = 'none';
    _pendingDiff = null; _pendingCat = null;
  };
  $('import-preview-close')?.addEventListener('click', closePreview);
  $('import-preview-cancel')?.addEventListener('click', closePreview);
}
