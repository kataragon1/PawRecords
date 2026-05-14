// ── NOTES MODULE ──
// Persistent context scratchpad: load, render, add, edit, pin, delete notes.
// Notes appear in chat context on every message.

import {
  APP_PETS,
  _notesCache, setNotesCache,
  _notesPinState, setNotesPinState,
  _notesCatSelection,
} from './state.js';

import {
  db, doc, setDoc, deleteDoc, writeBatch, collection, getDocs, query, orderBy,
  $, showToast, showAlert, escHtml,
} from './core.js';

// ── LOAD & RENDER ──

export async function loadNotes() {
  try {
    const snap = await getDocs(query(collection(db, 'context_notes'), orderBy('addedDate', 'desc')));
    setNotesCache(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderNotes();
  } catch(e) { console.warn('Notes load failed:', e.message); }
}

export function renderNotes() {
  const list = $('notes-list');
  if (!list) return;
  list.innerHTML = '';

  const pinned = _notesCache.filter(n => n.pinned).sort((a,b) => a.addedDate > b.addedDate ? -1 : 1);
  const active = _notesCache.filter(n => !n.pinned).sort((a,b) => a.addedDate > b.addedDate ? -1 : 1);

  if (!pinned.length && !active.length) {
    list.innerHTML = '<div style="padding:1.5rem 1rem;font-family:\'JetBrains Mono\',monospace;font-size:0.65rem;color:var(--ink-muted);text-align:center;line-height:1.8;">No notes yet.<br>Add context Claude should<br>always know about.</div>';
    return;
  }

  if (pinned.length) {
    const lbl = document.createElement('div');
    lbl.className = 'notes-section-label';
    lbl.textContent = '📌 Pinned';
    list.appendChild(lbl);
    pinned.forEach(n => list.appendChild(makeNoteEl(n)));
  }

  if (active.length) {
    const lbl = document.createElement('div');
    lbl.className = 'notes-section-label';
    lbl.style.marginTop = pinned.length ? '0.4rem' : '0';
    lbl.textContent = 'Active';
    list.appendChild(lbl);

    if (active.length >= 12) {
      const warn = document.createElement('div');
      warn.className = 'note-count-warning';
      warn.title = 'All notes are sent to Claude on every message. Many notes = higher cost. Pin important ones, archive old ones.';
      warn.textContent = `${active.length} active notes — consider archiving old ones to reduce context size`;
      warn.style.cursor = 'help';
      list.appendChild(warn);
    }

    active.forEach(n => list.appendChild(makeNoteEl(n)));
  }
}

export function makeNoteEl(note) {
  const el = document.createElement('div');
  el.className = 'note-item' + (note.pinned ? ' pinned' : '');
  el.dataset.id = note.id;

  const pinBtn = document.createElement('button');
  pinBtn.className = 'note-pin-btn';
  pinBtn.textContent = '📌';
  pinBtn.title = note.pinned ? 'Unpin' : 'Pin';
  pinBtn.onclick = (e) => { e.stopPropagation(); toggleNotePin(note); };

  const textWrap = document.createElement('div');
  textWrap.style.cssText = 'flex:1;min-width:0;';

  const textEl = document.createElement('div');
  textEl.className = 'note-text';
  textEl.style.whiteSpace = 'pre-wrap';
  textEl.textContent = note.text;
  textEl.contentEditable = 'true';
  textEl.spellcheck = false;
  textEl.style.outline = 'none';
  textEl.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  textEl.addEventListener('blur', () => saveNoteText(note, textEl.innerText.trim()));
  textEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textEl.blur(); }
    if (e.key === 'Escape') { textEl.textContent = note.text; textEl.blur(); }
  });
  textWrap.appendChild(textEl);

  const catsRow = document.createElement('div');
  catsRow.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;margin-top:0.15rem;align-items:center;';

  const renderCatChips = () => {
    catsRow.innerHTML = '';
    const currentCats = note.cats || [];
    APP_PETS.forEach(cat => {
      const active = currentCats.includes(cat);
      const chip = document.createElement('span');
      chip.textContent = cat;
      chip.style.cssText = `font-family:"JetBrains Mono",monospace;font-size:0.52rem;padding:0 4px;border-radius:3px;cursor:pointer;transition:all 0.12s;line-height:1.6;${active ? 'background:var(--accent);color:white;' : 'background:var(--surface2);color:var(--ink-muted);'}`;
      chip.addEventListener('click', async e => {
        e.stopPropagation();
        const newCats = active ? currentCats.filter(c => c !== cat) : [...currentCats, cat];
        note.cats = newCats;
        try {
          await setDoc(doc(db, 'context_notes', note.id), { cats: newCats }, { merge: true });
        } catch(err) { showAlert('Save failed: ' + err.message, 'warning'); }
        renderCatChips();
      });
      catsRow.appendChild(chip);
    });
  };
  renderCatChips();
  textWrap.appendChild(catsRow);

  const ts = note.addedAt || note.addedDate;
  const tsEl = document.createElement('div');
  tsEl.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.53rem;color:var(--ink-muted);margin-top:0.15rem;opacity:0.7;cursor:pointer;display:inline-block;';
  const formatTs = (val) => {
    if (!val) return '';
    try {
      const d = new Date(val);
      if (isNaN(d)) return val;
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch(e) { return val; }
  };
  tsEl.textContent = formatTs(ts);
  tsEl.title = 'Click to edit date';
  tsEl.addEventListener('click', e => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'date';
    input.value = (note.addedDate || note.addedAt || '').slice(0, 10);
    input.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.53rem;border:1px solid var(--accent);border-radius:3px;padding:1px 4px;color:var(--ink);background:var(--bg);outline:none;';
    tsEl.replaceWith(input);
    input.focus();
    const save = async () => {
      const newDate = input.value;
      if (newDate && newDate !== note.addedDate) {
        note.addedDate = newDate;
        note.addedAt = newDate;
        try {
          await setDoc(doc(db, 'context_notes', note.id), { addedDate: newDate, addedAt: newDate }, { merge: true });
        } catch(err) { showAlert('Save failed: ' + err.message, 'warning'); }
      }
      tsEl.textContent = formatTs(note.addedAt || note.addedDate);
      input.replaceWith(tsEl);
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = (note.addedDate || '').slice(0,10); input.blur(); }
    });
  });
  textWrap.appendChild(tsEl);

  const delBtn = document.createElement('button');
  delBtn.className = 'note-delete-btn';
  delBtn.textContent = '✕';
  delBtn.title = note.pinned ? 'Unpin first to delete' : 'Delete';
  delBtn.onclick = (e) => { e.stopPropagation(); deleteNote(note); };

  el.appendChild(pinBtn);
  el.appendChild(textWrap);
  el.appendChild(delBtn);
  return el;
}

// ── NOTE ARCHIVE REVIEW ──

export function showNoteArchiveReview(oldNotes) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:200;display:flex;align-items:center;justify-content:center;';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:white;border-radius:12px;padding:1.5rem;max-width:520px;width:90%;max-height:80vh;display:flex;flex-direction:column;gap:1rem;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
  modal.innerHTML = `<div style="font-family:'JetBrains Mono',monospace;font-size:0.75rem;font-weight:700;color:var(--ink);">📝 Old Notes</div>
    <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--ink-muted);line-height:1.5;">These notes haven't been updated in 60+ days. Delete the ones that are no longer relevant to reduce context size.</div>`;
  const list = document.createElement('div');
  list.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:0.4rem;';
  const checks = new Map();
  for (const note of oldNotes) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:0.6rem;padding:0.4rem 0.5rem;border:1px solid var(--border);border-radius:6px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.style.cssText = 'margin-top:2px;flex-shrink:0;cursor:pointer;';
    checks.set(note.id, cb);
    const txt = document.createElement('div');
    txt.style.cssText = 'font-family:\'JetBrains Mono\',monospace;font-size:0.62rem;color:var(--ink);line-height:1.5;';
    const cats = note.cats?.length ? `[${note.cats.join('/')}] ` : '';
    const age = Math.round((Date.now() - new Date(note.addedDate)) / 86400000);
    txt.innerHTML = `<span style="color:var(--ink-muted);font-size:0.55rem;">${cats}${age}d old</span><br>${escHtml(note.text)}`;
    row.appendChild(cb); row.appendChild(txt);
    list.appendChild(row);
  }
  modal.appendChild(list);
  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:0.5rem;justify-content:flex-end;';
  const skip = document.createElement('button');
  skip.className = 'btn-icon';
  skip.textContent = 'Keep All';
  skip.onclick = () => document.body.removeChild(overlay);
  const del = document.createElement('button');
  del.className = 'btn-icon free-icon';
  del.innerHTML = '<span class="free-dot"></span> Delete Checked';
  del.onclick = async () => {
    const toDelete = oldNotes.filter(n => checks.get(n.id)?.checked);
    if (!toDelete.length) { document.body.removeChild(overlay); return; }
    const batch = writeBatch(db);
    for (const n of toDelete) batch.delete(doc(db, 'context_notes', n.id));
    await batch.commit();
    setNotesCache(_notesCache.filter(n => !toDelete.find(d => d.id === n.id)));
    renderNotes();
    document.body.removeChild(overlay);
    showToast(`${toDelete.length} note${toDelete.length !== 1 ? 's' : ''} deleted`, 'journal');
  };
  foot.appendChild(skip); foot.appendChild(del);
  modal.appendChild(foot);
  overlay.appendChild(modal);
  overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
  document.body.appendChild(overlay);
}

// ── NOTE ACTIONS ──

export async function toggleNotePin(note) {
  try {
    await setDoc(doc(db, 'context_notes', note.id), { pinned: !note.pinned }, { merge: true });
    note.pinned = !note.pinned;
    renderNotes();
  } catch(e) { showAlert('Pin failed: ' + e.message, 'warning'); }
}

export async function saveNoteText(note, newText) {
  if (!newText || newText === note.text) return;
  try {
    await setDoc(doc(db, 'context_notes', note.id), { text: newText }, { merge: true });
    note.text = newText;
  } catch(e) { showAlert('Save failed: ' + e.message, 'warning'); }
}

export async function deleteNote(note) {
  if (note.pinned) { showToast('Unpin before deleting', 'warning'); return; }
  try {
    await deleteDoc(doc(db, 'context_notes', note.id));
    setNotesCache(_notesCache.filter(n => n.id !== note.id));
    renderNotes();
  } catch(e) { showAlert('Delete failed: ' + e.message, 'warning'); }
}

export async function addNote(text, cats, pinned) {
  if (!text.trim()) return;
  const now = new Date();
  const addedDate = now.toISOString().split('T')[0];
  const addedAt = now.toISOString();
  try {
    const ref = doc(collection(db, 'context_notes'));
    const note = { id: ref.id, text: text.trim(), cats: [...cats], pinned, addedDate, addedAt };
    await setDoc(ref, note);
    setNotesCache([note, ..._notesCache]);
    renderNotes();
  } catch(e) { showAlert('Add failed: ' + e.message, 'warning'); }
}

// ── CONTEXT BUILDER ──

export function buildNotesContext() {
  if (!_notesCache.length) return '';
  const pinned = _notesCache.filter(n => n.pinned);
  const active = _notesCache.filter(n => !n.pinned);
  let ctx = '\n\n## Active Context Notes (AI-generated observations from previous sessions — not written by the owner)\n';
  for (const n of pinned) {
    const catPrefix = n.cats?.length ? `[${n.cats.join('/')}] ` : '';
    ctx += `📌 ${catPrefix}${n.text}\n`;
  }
  for (const n of active) {
    const catPrefix = n.cats?.length ? `[${n.cats.join('/')}] ` : '';
    ctx += `• ${catPrefix}${n.text}\n`;
  }
  return ctx;
}

// ── NOTES UI WIRING ──

export function initNotesUI() {
  const chipsEl = $('notes-cat-chips');
  if (chipsEl) {
    const renderChips = () => {
      chipsEl.innerHTML = '';
      APP_PETS.forEach(cat => {
        const chip = document.createElement('button');
        chip.className = 'notes-cat-chip';
        chip.textContent = cat;
        chip.onclick = () => {
          if (_notesCatSelection.has(cat)) { _notesCatSelection.delete(cat); chip.classList.remove('active'); }
          else { _notesCatSelection.add(cat); chip.classList.add('active'); }
        };
        chipsEl.appendChild(chip);
      });
    };
    renderChips();
    window._renderNoteChips = renderChips;
  }

  const pinToggle = $('notes-pin-toggle');
  if (pinToggle) {
    pinToggle.onclick = () => {
      setNotesPinState(!_notesPinState);
      pinToggle.classList.toggle('active', _notesPinState);
      pinToggle.title = _notesPinState ? 'Will be pinned' : 'Pin this note';
    };
  }

  const addBtn = $('notes-add-btn');
  const input = $('notes-input');
  if (addBtn && input) {
    const autoResize = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };
    input.addEventListener('input', autoResize);

    input.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      const start = input.selectionStart, end = input.selectionEnd;
      const val = input.value;
      input.value = val.slice(0, start) + text + val.slice(end);
      input.selectionStart = input.selectionEnd = start + text.length;
      autoResize();
    });

    const doAdd = async () => {
      const text = input.value.trim();
      if (!text) return;
      await addNote(text, _notesCatSelection, _notesPinState);
      input.value = '';
      input.style.height = 'auto';
      _notesCatSelection.clear();
      setNotesPinState(false);
      if (pinToggle) { pinToggle.classList.remove('active'); pinToggle.title = 'Pin this note'; }
      document.querySelectorAll('.notes-cat-chip').forEach(c => c.classList.remove('active'));
    };
    addBtn.onclick = doAdd;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAdd(); }
    });
  }
}
