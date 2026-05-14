// ── JOURNAL MODULE ──
// Journal sidebar, journal edit/delete, pending item tracking, processMessageForJournal.

import {
  APP_PETS, _petProfiles,
  pendingJournalItems, setPendingJournalItems,
  _journalDocsCache, setJournalDocsCache,
  _journalSidebarDebounce, setJournalSidebarDebounce,
  _journalActiveCat, setJournalActiveCat,
  _addPendingDebounce, setAddPendingDebounce,
  sessionActiveCat, setSessionActiveCat,
  mentionTracker, setMentionTracker,
  _journalCache, setJournalCache,
  _journalCacheTime, setJournalCacheTime,
} from './state.js';

import {
  db, doc, setDoc, deleteDoc, writeBatch, collection, getDocs, query, orderBy,
  $, showToast, showAlert, escHtml, invalidateChatContext,
} from './core.js';

// ── JOURNAL STATE HELPERS ──

// Compatibility: journal entries may have legacy `cat` string or new `cats` array
export function jCats(j) {
  if (Array.isArray(j.cats) && j.cats.length) return j.cats;
  if (j.cat) return [j.cat];
  return [];
}

export function normalizeListName(list) {
  if (!list) return 'Supplements';
  const known = ['Medications', 'Supplements', 'Diet', 'Foods'];
  if (known.includes(list)) return list;
  const lower = list.toLowerCase().trim();
  const LIST_NAME_MAP = {
    'medication': 'Medications', 'meds': 'Medications', 'med': 'Medications',
    'supplement': 'Supplements', 'supp': 'Supplements', 'supps': 'Supplements',
    'food': 'Foods', 'food items': 'Foods',
    'diet plan': 'Diet', 'nutrition': 'Diet',
    'general': 'Supplements',
  };
  return LIST_NAME_MAP[lower] || list;
}

const STANDARD_LISTS = ['Medications', 'Supplements', 'Diet', 'Foods'];

// Cat color helpers (used in journal rendering)
export function catColor(catName) {
  return _petProfiles[catName]?.color || '#e4e0d8';
}
export function catColorDark(catName) {
  const hex = catColor(catName).replace('#','');
  const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  const d = (v) => Math.max(0, Math.round(v * 0.55)).toString(16).padStart(2,'0');
  return '#' + d(r) + d(g) + d(b);
}

// ── JOURNAL SIDEBAR ──

export async function loadJournalSidebar() {
  setJournalCache(null);
  setJournalCacheTime(0);
  if (_journalSidebarDebounce) clearTimeout(_journalSidebarDebounce);
  return new Promise(resolve => {
    setJournalSidebarDebounce(setTimeout(async () => {
      setJournalSidebarDebounce(null);
      try {
        if (!_journalDocsCache) {
          const snap = await getDocs(query(collection(db, 'journal'), orderBy('addedDate', 'desc')));
          setJournalDocsCache(snap.docs.map(d => {
            const data = { id: d.id, ...d.data() };
            data.list = normalizeListName(data.list);
            return data;
          }));
        }
        renderJournalSidebar(_journalDocsCache);
      } catch (err) { console.error('Journal load error:', err); }
      resolve();
    }, 400));
  });
}

export function renderJournalSidebar(docs) {
  const container = $('journal-tree');
  const empty = $('journal-empty');
  const tabBar = $('journal-cat-tabs');

  const existingPending = container.querySelector('.journal-pending-section');
  if (existingPending) existingPending.remove();

  if (pendingJournalItems.length) {
    empty.style.display = 'none';
    const pending = document.createElement('div');
    pending.className = 'journal-pending-section';
    pending.innerHTML = `<div class="journal-pending-header"><span>~ Tracking (${pendingJournalItems.length})</span><span style="font-size:0.58rem;color:var(--ink-muted);">rough hints · Save Session to confirm</span></div>`;
    const filtered = [];
    for (const item of [...pendingJournalItems]) {
      const t = item.text?.trim() || '';
      if (t.length < 3 || /^(another|something|item|entry|medication|supplement|this|that|the|a|an)$/i.test(t)) {
        continue;
      }
      filtered.push(item);
      const el = document.createElement('div');
      el.className = 'journal-pending-item';
      const textEl = document.createElement('div');
      textEl.style.cssText = 'flex:1;min-width:0;';
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;align-items:center;gap:0.3rem;margin-bottom:0.1rem;';
      const listSpan = document.createElement('span');
      listSpan.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.52rem;color:var(--accent);text-transform:uppercase;letter-spacing:0.06em;';
      listSpan.textContent = item.list || '?';
      topRow.appendChild(listSpan);
      const statusSel = document.createElement('select');
      statusSel.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.5rem;border:1px solid var(--border);border-radius:3px;padding:0 3px;background:var(--surface);color:var(--ink);outline:none;cursor:pointer;';
      [['current','current'],['past','past'],['plan','planned'],['maybe','potential'],['rejected','rejected']].forEach(([val, lbl]) => {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = lbl;
        if ((item.status || 'current') === val) opt.selected = true;
        statusSel.appendChild(opt);
      });
      statusSel.addEventListener('change', () => { item.status = statusSel.value; });
      topRow.appendChild(statusSel);
      textEl.appendChild(topRow);
      const textLine = document.createElement('div');
      textLine.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.68rem;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      const cats = jCats(item);
      const catPrefix = cats.length ? cats.join(', ') + ': ' : '';
      textLine.textContent = `${catPrefix}${t.slice(0, 32)}${t.length > 32 ? '…' : ''}`;
      textLine.title = item.text;
      textEl.appendChild(textLine);
      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'journal-pending-dismiss';
      dismissBtn.title = 'Dismiss';
      dismissBtn.textContent = '✕';
      dismissBtn.addEventListener('click', () => {
        setPendingJournalItems(pendingJournalItems.filter(i => i !== item));
        updateJournalBadge();
        loadJournalSidebar();
      });
      el.appendChild(textEl);
      el.appendChild(dismissBtn);
      pending.appendChild(el);
    }
    // Sync filter back (removes invalid items)
    if (filtered.length !== pendingJournalItems.length) {
      setPendingJournalItems(filtered);
    }
    container.prepend(pending);
  }

  if (!docs.length && !pendingJournalItems.length) {
    empty.style.display = 'flex';
    tabBar.style.display = 'none';
    container.querySelectorAll('.journal-cat-section').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';

  const allCatsInJournal = [...new Set(docs.flatMap(j => jCats(j)))].sort();
  if (_journalActiveCat !== 'all' && !allCatsInJournal.includes(_journalActiveCat)) {
    setJournalActiveCat('all');
  }

  tabBar.innerHTML = '';
  tabBar.style.display = 'block';
  const tabStyle = (active) =>
    `display:inline-block;padding:0.4rem 0.65rem;font-family:'JetBrains Mono',monospace;font-size:0.6rem;cursor:pointer;border-bottom:2px solid ${active ? 'var(--accent)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--ink-muted)'};background:${active ? 'var(--surface)' : 'transparent'};font-weight:${active ? '600' : '400'};user-select:none;transition:all 0.15s;white-space:nowrap;border-radius:${active ? '4px 4px 0 0' : '0'};`;

  const makeTab = (label, key) => {
    const t = document.createElement('span');
    t.textContent = label;
    t.style.cssText = tabStyle(key === _journalActiveCat);
    t.addEventListener('click', () => {
      setJournalActiveCat(key);
      renderJournalSidebar(_journalDocsCache || docs);
    });
    return t;
  };

  tabBar.appendChild(makeTab('All', 'all'));
  for (const cat of allCatsInJournal) tabBar.appendChild(makeTab(cat, cat));

  const infoBtn = document.createElement('span');
  infoBtn.textContent = 'ⓘ';
  infoBtn.title = 'Status legend';
  infoBtn.style.cssText = 'margin-left:auto;padding:0.4rem 0.5rem;font-size:0.65rem;color:var(--ink-muted);cursor:pointer;flex-shrink:0;';
  infoBtn.addEventListener('click', e => {
    e.stopPropagation();
    const existing = document.getElementById('journal-legend-popup');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div');
    pop.id = 'journal-legend-popup';
    const rect = infoBtn.getBoundingClientRect();
    pop.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;z-index:1000;background:white;border:1px solid var(--border);border-radius:8px;padding:0.6rem 0.75rem;box-shadow:0 4px 16px rgba(0,0,0,0.15);font-family:JetBrains Mono,monospace;font-size:0.62rem;display:flex;flex-direction:column;gap:0.35rem;min-width:170px;`;
    pop.innerHTML = [
      '<div style="font-weight:700;color:var(--ink);margin-bottom:0.1rem;letter-spacing:0.04em;">STATUS LEGEND</div>',
      '<div style="color:var(--ink);padding:1px 0;">● current — active now</div>',
      '<div style="background:var(--blue-bg);color:var(--blue);border-radius:3px;padding:1px 5px;">● plan — considering / upcoming</div>',
      '<div style="background:var(--amber-bg);color:var(--amber);border-radius:3px;padding:1px 5px;">● maybe — uncertain / potential</div>',
      '<div style="background:var(--surface2);color:var(--ink-muted);border-radius:3px;padding:1px 5px;text-decoration:line-through;opacity:0.8;">● past — discontinued / resolved</div>',
      '<div style="background:var(--surface2);color:var(--ink-muted);border-radius:3px;padding:1px 5px;text-decoration:line-through;opacity:0.5;">● rejected — considered &amp; decided against</div>',
    ].join('');
    const closeOnOutside = (ev) => { if (!pop.contains(ev.target) && ev.target !== infoBtn) { pop.remove(); document.removeEventListener('click', closeOnOutside); } };
    setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
    document.body.appendChild(pop);
  });
  tabBar.appendChild(infoBtn);

  const visibleDocs = _journalActiveCat === 'all'
    ? docs
    : docs.filter(j => jCats(j).includes(_journalActiveCat));

  container.querySelectorAll('.journal-cat-section, .journal-list-section').forEach(el => el.remove());
  if (!visibleDocs.length) return;

  const LIST_ORDER = ['Medications', 'Supplements', 'Diet', 'Foods'];

  if (_journalActiveCat === 'all') {
    renderJournalSection(container, visibleDocs, LIST_ORDER, true);
  } else {
    const sec = document.createElement('div');
    sec.className = 'journal-cat-section';
    const addBtn = document.createElement('button');
    addBtn.style.cssText = 'width:100%;background:none;border:none;border-bottom:1px solid var(--surface2);padding:0.3rem 0.75rem;font-family:JetBrains Mono,monospace;font-size:0.6rem;color:var(--ink-muted);cursor:pointer;text-align:left;letter-spacing:0.04em;transition:color 0.12s;';
    addBtn.textContent = '+ Add entry';
    addBtn.addEventListener('mouseenter', () => addBtn.style.color = 'var(--accent)');
    addBtn.addEventListener('mouseleave', () => addBtn.style.color = 'var(--ink-muted)');
    addBtn.addEventListener('click', () => openJournalAddItem([_journalActiveCat], null));
    sec.appendChild(addBtn);
    renderJournalSection(sec, visibleDocs, LIST_ORDER, false);
    container.appendChild(sec);
  }
}

export function renderJournalSection(container, docs, listOrder, showCatChips) {
  const byList = {};
  for (const j of docs) {
    const listKey = normalizeListName(j.list);
    if (!byList[listKey]) byList[listKey] = [];
    byList[listKey].push({...j, list: listKey});
  }

  const allListNames = Object.keys(byList);
  const orderedLists = [
    ...listOrder.filter(l => allListNames.includes(l)),
    ...allListNames.filter(l => !listOrder.includes(l)).sort()
  ];

  const STATUS_ORDER = ['current', 'plan', 'maybe', 'past', 'rejected'];
  const STATUS_STYLE = {
    current:  { bg: '',                    color: '',                   extra: '' },
    plan:     { bg: 'var(--blue-bg)',       color: 'var(--blue)',        extra: '' },
    maybe:    { bg: 'var(--amber-bg)',      color: 'var(--amber)',       extra: '' },
    past:     { bg: 'var(--surface2)',      color: 'var(--ink-muted)',   extra: 'text-decoration:line-through;opacity:0.75;' },
    rejected: { bg: 'var(--surface2)',      color: 'var(--ink-muted)',   extra: 'text-decoration:line-through;opacity:0.5;' },
  };

  for (const listName of orderedLists) {
    const items = byList[listName];
    if (!items?.length) continue;

    const ls = document.createElement('div');
    ls.className = 'journal-list-section';

    const lh = document.createElement('div');
    lh.className = 'journal-list-heading';
    const listArrow = document.createElement('span');
    listArrow.textContent = '▶';
    listArrow.style.cssText = 'font-size:0.45rem;color:var(--ink-muted);transition:transform 0.15s;';
    const countBadge = document.createElement('span');
    countBadge.className = 'journal-list-count';
    countBadge.textContent = items.length;
    const addEntryBtn = document.createElement('button');
    addEntryBtn.title = `Add to ${listName}`;
    addEntryBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--ink-muted);font-size:0.7rem;padding:0 0.2rem;margin-left:0.2rem;line-height:1;border-radius:3px;transition:color 0.12s;';
    addEntryBtn.textContent = '+';
    addEntryBtn.addEventListener('mouseenter', () => addEntryBtn.style.color = 'var(--accent)');
    addEntryBtn.addEventListener('mouseleave', () => addEntryBtn.style.color = 'var(--ink-muted)');
    addEntryBtn.addEventListener('click', e => {
      e.stopPropagation();
      const cats = _journalActiveCat === 'all' ? [] : [_journalActiveCat];
      openJournalAddItem(cats, listName);
    });
    lh.appendChild(listArrow);
    lh.appendChild(document.createTextNode(' ' + listName));
    lh.appendChild(countBadge);
    lh.appendChild(addEntryBtn);

    const lb = document.createElement('div');
    lb.className = 'journal-list-body open';
    listArrow.style.transform = 'rotate(90deg)';
    lh.addEventListener('click', () => {
      const open = lb.classList.toggle('open');
      listArrow.style.transform = open ? 'rotate(90deg)' : '';
    });

    const groups = { current:[], plan:[], maybe:[], past:[], rejected:[] };
    for (const item of items) (groups[item.status] || groups.current).push(item);

    const allCatNames = [...new Set(items.flatMap(i => jCats(i)))].sort();
    const catSortKey = (item) => {
      const cats = jCats(item).sort();
      if (cats.length === allCatNames.length && cats.every((c,i) => c === allCatNames[i])) return '0_all';
      return '1_' + cats.join(',');
    };

    for (const grp of STATUS_ORDER) {
      const grpItems = groups[grp].slice().sort((a, b) => catSortKey(a).localeCompare(catSortKey(b)));
      if (!grpItems.length) continue;

      for (const item of grpItems) {
        const ss = STATUS_STYLE[grp] || STATUS_STYLE.current;
        const ee = document.createElement('div');
        ee.className = 'journal-entry-full';
        const bgStyle = ss.bg ? `background:${ss.bg};border-radius:5px;margin:1px 0.4rem;padding:0.15rem 0.4rem 0.15rem 0.75rem;` : '';
        ee.style.cssText = `position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:0.3rem;${bgStyle}`;
        ee.title = 'Double-click to edit';

        const textWrap = document.createElement('div');
        textWrap.style.cssText = 'flex:1;min-width:0;';
        const fullText = item.text || '';
        const displayText = fullText.length > 60 ? fullText.slice(0, 59) + '…' : fullText;
        const textColorStyle = ss.color ? `color:${ss.color};` : '';
        let inner = `<div class="journal-entry-text-full" title="${escHtml(fullText)}" style="${textColorStyle}${ss.extra}">${escHtml(displayText)}</div>`;
        if (item.dose) inner += `<div class="journal-entry-dose" style="${textColorStyle}opacity:0.85;">${escHtml(item.dose)}</div>`;

        if (showCatChips) {
          const cats = jCats(item);
          if (cats.length) {
            const chipHtml = cats.map(c => {
              const bg = grp === 'past' ? 'white' : catColor(c);
              const color = catColorDark(c);
              return `<span style="font-family:'JetBrains Mono',monospace;font-size:0.5rem;background:${bg};color:${color};border-radius:3px;padding:0 3px;margin-right:2px;font-weight:600;">${escHtml(c)}</span>`;
            }).join('');
            inner += `<div style="margin-top:0.15rem;">${chipHtml}</div>`;
          }
        }
        if (item.startDate) inner += `<div class="journal-entry-date-full" style="${textColorStyle}opacity:0.8;">${escHtml(item.startDate)}${item.endDate?' → '+escHtml(item.endDate):''}</div>`;
        textWrap.innerHTML = inner;

        const actions = document.createElement('span');
        actions.style.cssText = 'display:none;gap:0.15rem;flex-shrink:0;margin-top:0.1rem;';
        actions.innerHTML = `<button title="Edit" style="background:none;border:none;cursor:pointer;font-size:0.6rem;color:var(--ink-muted);padding:0.1rem;border-radius:3px;line-height:1;">✏</button><button title="Delete" style="background:none;border:none;cursor:pointer;font-size:0.6rem;color:var(--red);padding:0.1rem;border-radius:3px;line-height:1;">🗑</button>`;
        ee.addEventListener('mouseenter', () => { actions.style.display = 'flex'; });
        ee.addEventListener('mouseleave', () => { actions.style.display = 'none'; });
        ee.addEventListener('dblclick', e => { e.stopPropagation(); openJournalEdit(item); });
        actions.querySelector('[title="Edit"]').addEventListener('click', e => { e.stopPropagation(); openJournalEdit(item); });
        actions.querySelector('[title="Delete"]').addEventListener('click', e => { e.stopPropagation(); confirmDeleteJournalEntry(item); });
        ee.appendChild(textWrap);
        ee.appendChild(actions);
        attachJournalCtxMenu(ee, item, jCats(item)[0] || '', listName);
        lb.appendChild(ee);
      }
    }

    ls.appendChild(lh);
    ls.appendChild(lb);
    container.appendChild(ls);
  }

  if (!showCatChips && _journalActiveCat !== 'all') {
    const addListBtn = document.createElement('button');
    addListBtn.style.cssText = 'width:100%;background:none;border:none;border-top:1px solid var(--surface2);padding:0.35rem 1.25rem;font-family:JetBrains Mono,monospace;font-size:0.6rem;color:var(--ink-muted);cursor:pointer;text-align:left;letter-spacing:0.04em;transition:color 0.12s;';
    addListBtn.textContent = '+ New list';
    addListBtn.addEventListener('mouseenter', () => addListBtn.style.color = 'var(--accent)');
    addListBtn.addEventListener('mouseleave', () => addListBtn.style.color = 'var(--ink-muted)');
    addListBtn.addEventListener('click', () => openJournalAddList(_journalActiveCat));
    container.appendChild(addListBtn);
  }
}

// ── JOURNAL EDIT / DELETE ──

export function openJournalAddList(cat) {
  const name = prompt(`New list name${cat ? ' for ' + cat : ''}:`);
  if (!name?.trim()) return;
  openJournalAddItem(cat ? [cat] : [], name.trim());
}

export function openJournalAddItem(cats, listName) {
  const today = new Date().toISOString().split('T')[0];
  openJournalEdit({
    cats: cats || [], list: listName, text: '', dose: '', status: 'current',
    startDate: today, endDate: null, _isNew: true
  });
}

export function openJournalEdit(item) {
  const { setupClassicPopup } = window._recordsModule || {};
  if (setupClassicPopup) {
    setupClassicPopup();
  } else {
    // Fallback: call via dynamic import
    import('./records.js').then(m => m.setupClassicPopup());
  }

  const itemCats = jCats(item);
  const isNew = !!item._isNew;
  $('popup-title').textContent = isNew ? 'Add Journal Entry' : `Edit Journal — ${itemCats.join(', ')} · ${item.list}`;
  const body = $('popup-body');
  body.innerHTML = '';

  const form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-direction:column;gap:0.75rem;';

  const mkLabel = (text) => {
    const l = document.createElement('label');
    l.textContent = text;
    l.style.cssText = 'display:block;font-family:JetBrains Mono,monospace;font-size:0.62rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:0.25rem;';
    return l;
  };
  const mkInput = (type, value, placeholder) => {
    const el = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (type === 'textarea') { el.rows = 3; }
    else { el.type = type || 'text'; }
    el.value = value || '';
    if (placeholder) el.placeholder = placeholder;
    el.style.cssText = `width:100%;font-family:JetBrains Mono,monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:${type==='textarea'?'0.5rem':'0.4rem 0.6rem'};${type==='textarea'?'resize:vertical;':''}outline:none;color:var(--ink);line-height:1.5;background:var(--bg);`;
    return el;
  };

  const catsWrap = document.createElement('div');
  catsWrap.appendChild(mkLabel('Cats'));
  const catsRow = document.createElement('div');
  catsRow.style.cssText = 'display:flex;gap:0.5rem;flex-wrap:wrap;';
  const catChecks = {};
  const displayCats = APP_PETS.length ? APP_PETS : itemCats;
  for (const cat of displayCats) {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:0.3rem;font-family:JetBrains Mono,monospace;font-size:0.68rem;color:var(--ink-dim);cursor:pointer;padding:0.25rem 0.5rem;border:1px solid var(--border);border-radius:6px;transition:all 0.15s;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = cat;
    cb.checked = itemCats.includes(cat);
    cb.style.accentColor = 'var(--accent)';
    cb.addEventListener('change', () => {
      lbl.style.borderColor = cb.checked ? 'var(--accent)' : 'var(--border)';
      lbl.style.background = cb.checked ? 'var(--surface)' : '';
    });
    if (cb.checked) { lbl.style.borderColor = 'var(--accent)'; lbl.style.background = 'var(--surface)'; }
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(cat));
    catChecks[cat] = cb;
    catsRow.appendChild(lbl);
  }
  catsWrap.appendChild(catsRow);
  form.appendChild(catsWrap);

  const listWrap = document.createElement('div');
  listWrap.appendChild(mkLabel('List'));
  const listSel = document.createElement('select');
  listSel.style.cssText = 'width:100%;font-family:JetBrains Mono,monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:0.4rem;outline:none;color:var(--ink);background:var(--bg);';
  const listOptions = [...STANDARD_LISTS];
  if (item.list && !listOptions.includes(item.list)) listOptions.push(item.list);
  listOptions.push('+ New list…');
  for (const opt of listOptions) {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt;
    if (opt === item.list) o.selected = true;
    listSel.appendChild(o);
  }
  const customListInput = mkInput('text', '', 'New list name…');
  customListInput.style.display = 'none';
  listSel.addEventListener('change', () => {
    if (listSel.value === '+ New list…') {
      customListInput.style.display = 'block';
      customListInput.focus();
    } else {
      customListInput.style.display = 'none';
    }
  });
  listWrap.appendChild(listSel);
  listWrap.appendChild(customListInput);
  form.appendChild(listWrap);

  const textWrap2 = document.createElement('div');
  textWrap2.appendChild(mkLabel('Entry'));
  const textEl = mkInput('textarea', item.text || '');
  textWrap2.appendChild(textEl);
  form.appendChild(textWrap2);

  const statusWrap = document.createElement('div');
  statusWrap.appendChild(mkLabel('Status'));
  const statusSel = document.createElement('select');
  statusSel.style.cssText = listSel.style.cssText;
  [['current','Current'],['past','Past'],['plan','Planned'],['maybe','Potential']].forEach(([val, lbl]) => {
    const o = document.createElement('option');
    o.value = val; o.textContent = lbl;
    if ((item.status || 'current') === val) o.selected = true;
    statusSel.appendChild(o);
  });
  statusWrap.appendChild(statusSel);
  form.appendChild(statusWrap);

  const doseWrap = document.createElement('div');
  doseWrap.appendChild(mkLabel('Dose / Detail'));
  const doseEl = mkInput('text', item.dose || '', 'e.g. 2.5g, 5mg SID');
  doseWrap.appendChild(doseEl);
  form.appendChild(doseWrap);

  const datesRow = document.createElement('div');
  datesRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;';
  const startWrap = document.createElement('div');
  startWrap.appendChild(mkLabel('Start Date'));
  const startEl = mkInput('date', item.startDate || '', '');
  startWrap.appendChild(startEl);
  const endWrap = document.createElement('div');
  endWrap.appendChild(mkLabel('End Date'));
  const endEl = mkInput('date', item.endDate || '', '');
  endEl.addEventListener('change', () => {
    if (endEl.value && statusSel.value === 'current') statusSel.value = 'past';
    if (!endEl.value && statusSel.value === 'past') statusSel.value = 'current';
  });
  endWrap.appendChild(endEl);
  datesRow.appendChild(startWrap);
  datesRow.appendChild(endWrap);
  form.appendChild(datesRow);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-icon free-icon';
  saveBtn.style.marginTop = '0.5rem';
  saveBtn.innerHTML = `<span class="free-dot"></span> ${isNew ? 'Add Entry' : 'Save Changes'}`;
  saveBtn.onclick = async () => {
    const today = new Date().toISOString().split('T')[0];
    const selectedCats = Object.entries(catChecks).filter(([,cb])=>cb.checked).map(([cat])=>cat);
    if (!selectedCats.length) { showToast('Select at least one cat', 'warning'); return; }
    const text = textEl.value.trim();
    if (!text) { showToast('Entry text is required', 'warning'); return; }
    const listVal = listSel.value === '+ New list…'
      ? (customListInput.value.trim() || null)
      : listSel.value;
    if (!listVal) { showToast('List name is required', 'warning'); return; }

    if (!isNew && !item.id) {
      showAlert('Cannot save — this entry is missing its Firestore ID. Try reloading the journal.', 'warning');
      return;
    }

    const endDateVal = endEl.value.trim() || null;
    let resolvedStatus = statusSel.value || 'current';
    if (endDateVal && endDateVal <= today && resolvedStatus === 'current') resolvedStatus = 'past';
    const data = {
      cats: selectedCats,
      list: listVal,
      text,
      dose: doseEl.value.trim() || null,
      status: resolvedStatus,
      startDate: startEl.value.trim() || today,
      endDate: endDateVal,
    };

    try {
      invalidateChatContext();
      if (isNew) {
        setJournalDocsCache(null);
        await setDoc(doc(collection(db, 'journal')), {
          ...data, addedDate: today, updatedDate: today, updates: []
        });
        showToast('Journal entry added', 'journal');
      } else {
        if (!item.id) { showAlert('Cannot edit — no Firestore ID', 'warning'); return; }

        const previousCats = jCats(item);
        const removedCats = previousCats.filter(c => !selectedCats.includes(c));
        if (removedCats.length && data.status !== 'past') {
          const fsBatch = writeBatch(db);
          for (const removedCat of removedCats) {
            fsBatch.set(doc(collection(db, 'journal')), {
              cats: [removedCat],
              list: listVal,
              text,
              dose: doseEl.value.trim() || null,
              status: 'past',
              startDate: item.startDate || today,
              endDate: today,
              addedDate: today, updatedDate: today, updates: []
            });
          }
          await fsBatch.commit();
          setJournalDocsCache(null);
          showToast(`History preserved for ${removedCats.join(', ')} ✓`, 'journal');
        }

        await setDoc(doc(db, 'journal', item.id), { ...data, updatedDate: today }, { merge: true });
        if (_journalDocsCache) {
          const idx = _journalDocsCache.findIndex(j => j.id === item.id);
          if (idx >= 0) _journalDocsCache[idx] = { ..._journalDocsCache[idx], ...data, updatedDate: today };
        }
        showToast('Journal entry updated', 'journal');
      }
      $('record-popup').classList.remove('open');
      loadJournalSidebar();
    } catch(err) { showAlert('Save failed: ' + err.message, 'warning'); }
  };
  form.appendChild(saveBtn);
  body.appendChild(form);
  $('popup-search-input').value = '';
  $('popup-search-count').textContent = '';
  $('record-popup').classList.add('open');
}

// ── JOURNAL CONTEXT MENU ──

export function attachJournalCtxMenu(el, item, cat, listName) {
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    import('./ui.js').then(m => m.showCtxMenu(e, `${jCats(item).join('/')} · ${listName}`, [
      { label: '✏ Edit', action: () => openJournalEdit(item) },
      { label: '🗑 Delete', danger: true, action: () => confirmDeleteJournalEntry(item) }
    ]));
  });
}

export async function confirmDeleteJournalEntry(item) {
  if (!confirm(`Delete this journal entry?\n${jCats(item).join(', ')} · ${item.list}: ${item.text}\n\nThis cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, 'journal', item.id));
    if (_journalDocsCache) {
      setJournalDocsCache(_journalDocsCache.filter(j => j.id !== item.id));
    }
    invalidateChatContext();
    renderJournalSidebar(_journalDocsCache || []);
    showToast('Entry deleted ✓', 'journal');
  } catch(err) { showAlert('Delete failed: ' + err.message, 'warning'); }
}

// ── PENDING ITEMS / SESSION TRACKING ──

const MENTION_THRESHOLD = 4;

export function updateJournalBadge() {
  const count = pendingJournalItems.length;
  const tabs = document.querySelectorAll('.sidebar-tab');
  tabs.forEach(t => {
    if (t.dataset.tab === 'journal') {
      const existing = t.querySelector('.journal-badge');
      if (count > 0) {
        if (!existing) {
          const badge = document.createElement('span');
          badge.className = 'journal-badge';
          badge.style.cssText = 'display:inline-block;background:var(--amber);color:white;border-radius:8px;padding:0 4px;font-size:0.5rem;margin-left:3px;line-height:1.4;vertical-align:middle;';
          t.appendChild(badge);
        }
        t.querySelector('.journal-badge').textContent = count;
      } else if (existing) {
        existing.remove();
      }
    }
  });
}

export function addPendingItem(item) {
  if (!item.text?.trim()) return;
  const t = item.text.trim();
  if (t.length < 3) return;
  if (/^(another|something|item|entry|medication|supplement|this|that|the|a|an|and|or|to|in|of|for)$/i.test(t)) return;
  const itemCatsKey = jCats(item).sort().join(',');
  const key = `${itemCatsKey}_${t.toLowerCase()}`;
  if (pendingJournalItems.some(p => {
    const pKey = `${jCats(p).sort().join(',')}_${(p.text||'').toLowerCase().trim()}`;
    return pKey === key;
  })) return;
  if (_journalDocsCache) {
    const cats = jCats(item);
    const alreadySaved = _journalDocsCache.some(j => {
      const jc = jCats(j);
      const textMatch = (j.text||'').toLowerCase().trim() === t.toLowerCase();
      const catMatch = cats.length === 0 || cats.some(c => jc.includes(c));
      const statusMatch = (j.status || 'current') === (item.status || 'current');
      const doseMatch = (j.dose || null) === (item.dose || null);
      return textMatch && catMatch && statusMatch && doseMatch && j.status !== 'past';
    });
    if (alreadySaved) return;
  }
  item.id = Math.random().toString(36).slice(2,9);
  setPendingJournalItems([...pendingJournalItems, item]);
  if (_addPendingDebounce) clearTimeout(_addPendingDebounce);
  setAddPendingDebounce(setTimeout(() => {
    setAddPendingDebounce(null);
    if (_journalDocsCache) {
      renderJournalSidebar(_journalDocsCache);
    } else {
      loadJournalSidebar();
    }
  }, 300));
}

export function processMessageForJournal(userMsg, assistantMsg) {
  if (userMsg.length > 1500) return;

  const today = new Date().toISOString().split('T')[0];
  const cat = extractCatFromText(userMsg + ' ' + assistantMsg);
  const fullText = userMsg + ' ' + assistantMsg;

  const JOURNAL_COMMAND_PATTERNS = [
    { re: /\b(?:add|adding|started?|she(?:'s| is) (?:on|taking|getting)|(?:giving|put) (?:her|him) (?:on)?|prescribed?)\s+([a-zA-Z0-9 \-]+?)(?:\s+to\s+(?:her|his)\s+(\w+))?(?:\s|$|,|\.)/i, action: 'add' },
    { re: /\b(?:stopped?|stopping|discontinued?|discontinuing|no longer (?:giving|taking|on)|removed?|taking (?:her|him) off)\s+(?:the\s+)?([a-zA-Z0-9 \-]+?)(?:\s|$|,|\.)/i, action: 'remove' },
    { re: /\b(?:going to (?:try|start|add)|(?:want|plan(?:ning)?|thinking about|considering|might try) (?:to )?(?:start|add|try|use|give her|give him)?)\s+([a-zA-Z0-9 \-]+?)(?:\s|$|,|\.)/i, action: 'plan' },
    { re: /\b(?:maybe|might|should we try|wondering (?:about|if)|(?:that )?sounds? good|let(?:'s| us) (?:do|try) that)\b/i, action: 'maybe_confirm' },
  ];

  for (const pattern of JOURNAL_COMMAND_PATTERNS) {
    if (pattern.action === 'maybe_confirm') {
      if (pattern.re.test(userMsg) && sessionActiveCat) {
        addPendingItem({
          cats: [sessionActiveCat],
          list: 'General',
          text: `[Confirm at save] User indicated interest: "${userMsg.slice(0,60)}"`,
          status: 'maybe',
          startDate: today,
          _needsResolution: true
        });
      }
      continue;
    }

    const match = fullText.match(pattern.re);
    if (match && match[1] && cat) {
      const term = match[1].trim().toLowerCase();
      if (term.length < 4 || term.length > 40) continue;
      const STOPWORDS = new Set(['the','and','that','this','with','from','have','been','they','will','what','when','which','your','some','also','just','into','then','than','more','very','over','such','each','about','after','these','those','where','there','their','other','would','could','should','might','still','well','like','here','only','both','back','even','how','her','him','its','she','was','were','are','had','has','not','but','for','can','may','all','any','few','new','old','now','his','out','use','our','you','who','get']);
      if (STOPWORDS.has(term.split(' ')[0])) continue;
      if (!/[a-z]{4}/.test(term)) continue;

      const list = guessListForTerm(term);
      const status = pattern.action === 'add' ? 'current'
        : pattern.action === 'remove' ? 'past'
        : 'plan';

      addPendingItem({
        cats: cat ? [cat] : [],
        list,
        text: capitalizeFirst(match[1].trim()),
        status,
        startDate: today,
        endDate: status === 'past' ? today : null,
        _source: 'explicit'
      });
    }
  }

  const medTerms = extractMedicalTerms(fullText);
  const tracker = { ...mentionTracker };
  for (const term of medTerms) {
    if (!cat) continue;
    const key = `${cat}_${term.toLowerCase()}`;
    if (!tracker[key]) tracker[key] = { count: 0 };
    tracker[key].count++;

    if (tracker[key].count === MENTION_THRESHOLD) {
      const alreadyPending = pendingJournalItems.some(p =>
        jCats(p).includes(cat) && p.text.toLowerCase().includes(term.toLowerCase())
      );
      if (!alreadyPending) {
        addPendingItem({
          cats: [cat],
          list: guessListForTerm(term),
          text: capitalizeFirst(term),
          status: 'maybe',
          startDate: today,
          _source: 'auto',
          _autoNote: `Mentioned ${MENTION_THRESHOLD}× in this session — review before saving`
        });
      }
    }
  }
  setMentionTracker(tracker);
  updateJournalBadge();
}

function extractCatFromText(text) {
  const lower = text.toLowerCase();
  for (const cat of APP_PETS) {
    if (lower.includes(cat.toLowerCase())) {
      setSessionActiveCat(cat);
      return cat;
    }
  }
  return sessionActiveCat;
}

function extractMedicalTerms(text) {
  const terms = [];
  const lower = text.toLowerCase();
  const MULTI_WORD = ['fish oil','b12','cobalamin','fortiflora','denamarin','royal canin',
    'psyllium husk','probiotics','omega 3','vitamin d','prednisolone','gabapentin',
    'omeprazole','metronidazole','cerenia','convenia','mirtazapine','famotidine','sucralfate',
    'azodyl','epakitin','miralax','adequan','dasuquin','solensia','cytopoint','apoquel'];
  for (const term of MULTI_WORD) {
    if (lower.includes(term)) terms.push(term);
  }
  return [...new Set(terms)];
}

function guessListForTerm(term) {
  const t = term.toLowerCase();
  if (/\b(mg|mcg|ml|tablet|capsule|injection|drops?|cream|ointment|spray)\b/.test(t)) return 'Medications';
  if (/\b(supplement|vitamin|probiotic|omega|cobalamin|b12|fish oil|lysine|pumpkin|fiber|fortiflora|azodyl|epakitin|denamarin|tumil)\b/.test(t)) return 'Supplements';
  if (/\b(food|kibble|canned|dry|wet|purina|hills|royal canin|ultamino|hydrolyzed|instinct|blue buffalo|wellness)\b/.test(t)) return 'Foods';
  if (/\b(diet|feeding|meal plan|kcal|calor|portion)\b/.test(t)) return 'Diet';
  if (/\b(prednisolone|gabapentin|omeprazole|cerenia|convenia|metronidazole|mirtazapine|famotidine|sucralfate|atenolol|amlodipine|methimazole|cyclosporine|solensia|buprenorphine|tramadol|meloxicam|adequan)\b/.test(t)) return 'Medications';
  return 'Supplements';
}

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
