// ── RECORDS MODULE ──
// Records sidebar, visit detail popup, visit edit, merge modal, visit search, home issue modal.
// Imports from state.js and core.js; exports functions used by chat.js, ui.js, and main.js.

import {
  APP_PETS, _petProfiles,
  _allVisitsCache, setAllVisitsCache,
  _allLabsCache,
  _recordsSidebarDirty, setRecordsSidebarDirty,
  _recordsSidebarDebounce, setRecordsSidebarDebounce,
  _recordsSidebarLoading, setRecordsSidebarLoading,
  popupRawText, setPopupRawText,
  popupMatches, setPopupMatches,
  popupMatchIdx, setPopupMatchIdx,
} from './state.js';

import {
  db, doc, getDoc, setDoc, addDoc, deleteDoc, updateDoc, deleteField,
  writeBatch, collection, getDocs, query, where, orderBy,
  $, showToast, showAlert, escHtml, formatDate, formatDateShort,
  catEmoji, abbreviateClinic, invalidateChatContext,
  isCatKitten, renderPetAges,
} from './core.js';

// ── RECORDS SIDEBAR ──

export function dirtyRecordsSidebar() { setRecordsSidebarDirty(true); }

export async function loadRecordsSidebar() {
  if (_recordsSidebarDebounce) clearTimeout(_recordsSidebarDebounce);
  return new Promise(resolve => {
    setRecordsSidebarDebounce(setTimeout(async () => {
      setRecordsSidebarDebounce(null);
      if (_recordsSidebarLoading) { resolve(); return; }
      setRecordsSidebarLoading(true);
      try {
        await _loadRecordsSidebarImpl();
      } finally {
        setRecordsSidebarLoading(false);
        resolve();
      }
    }, 400));
  });
}

async function _loadRecordsSidebarImpl() {
  try {
    const cacheWasNull = !_allVisitsCache;
    if (!_allVisitsCache) {
      const q = query(collection(db, 'visits'), orderBy('date', 'desc'));
      const snap = await getDocs(q);
      setAllVisitsCache(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }
    if (!_recordsSidebarDirty && !cacheWasNull) return;
    const tree = {};
    _allVisitsCache.forEach(v => {
      if (!tree[v.cat]) tree[v.cat] = {};
      if (!tree[v.cat][v.date]) tree[v.cat][v.date] = [];
      if (!tree[v.cat][v.date].find(x => x.id === v.id)) tree[v.cat][v.date].push(v);
    });
    renderRecordsTree(tree);
    setRecordsSidebarDirty(false);
  } catch (err) {
    console.error('Records load error:', err);
  }
}

function briefComplaint(v) {
  if (v.docType === 'Invoice') return '';
  if (v.source === 'home') {
    const raw = (v.chiefComplaint || v.issueType || '').trim();
    if (!raw) return '';
    return raw.length <= 36 ? raw : raw.slice(0, 34) + '…';
  }
  let raw = (v.chiefComplaint || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^(recheck|re-check|follow[\s\-]?up|f\/u|followup)[\s\-:,–—]+/i, '').trim();
  raw = raw.replace(/[\s\-,–—]+(recheck|re-check|follow[\s\-]?up|f\/u|followup)$/i, '').trim();
  if (raw.length <= 36) return raw;
  const cut = raw.slice(0, 35);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 15 ? cut.slice(0, lastSpace) : cut) + '…';
}

function briefInvoice(v) {
  if (!v) return '';
  if (v.invoiceSummary) {
    const isFoodDiagnosis = /gi upset|gastrointestinal|digestive|stomach|intestinal|bowel/i.test(v.invoiceSummary) &&
      (v.medications||[]).concat(v.procedures||[]).every(x =>
        /food|diet|hills|royal canin|purina|instinct|hydrolyzed|ultamino|z\/d|i\/d|gastrointestinal/i.test(x.name||'')
      );
    if (!isFoodDiagnosis) return v.invoiceSummary;
    setDoc(doc(db, 'visits', v.id), { invoiceSummary: null }, { merge: true });
    v.invoiceSummary = null;
  }
  if (v.chiefComplaint) return v.chiefComplaint;
  const meds = (v.medications || []).map(m => m.name).filter(Boolean)
    .filter(n => !/syringe|disposal|fee|tax|bandage|glove/i.test(n));
  const procs = (v.procedures || []).map(p => p.name).filter(Boolean)
    .filter(p => !/exam|visit|consult|blood draw/i.test(p));
  const items = [...meds, ...procs];
  if (!items.length) return '';
  const joined = items.join(', ');
  return joined.length > 40 ? joined.slice(0, 38) + '…' : joined;
}

function queueInvoiceSummary() {}
async function processInvoiceSummaryQueue() {}

function visitTypeStyle(v) {
  if (v.source === 'home') return null;
  if (v.docType === 'Invoice') return null;
  if (v.visitClass === 'well') return { type: 'well', color: '#5a6e8c' };
  if (v.visitClass === 'problem') return null;
  const raw = v.chiefComplaint || (v.synopsis || '').split(/[.!?]/)[0];
  const cc = raw.toLowerCase();
  const isSpecialty = /\b(derm|dermatol|cardio|oncol|neuro|ophth|ortho|renal|ckd|ibd|giardia|recheck|follow.?up|thyroid|diabetes|hypertens|hyperth|cancer|tumor|mass|allerg|colitis|pancreatitis)\b/.test(cc);
  if (isSpecialty) return null;
  const isWell = /\b(wellness|well\s*(exam|visit|check)|annual\s*(wellness|exam|visit|check)|routine\s*(exam|visit|check)|preventive|preventative|health\s*(exam|check)|check.?up|vacc(ine|ination)?s?\s*(only|booster|due)?|booster|fvrcp)\b/.test(cc);
  return isWell ? { type: 'well', color: '#5a6e8c' } : null;
}

export function renderRecordsTree(tree) {
  const container = $('records-tree');
  const empty = $('records-empty');
  const cats = Object.keys(tree);
  if (!cats.length) { empty.style.display = 'flex'; container.innerHTML = ''; return; }
  empty.style.display = 'none';
  container.innerHTML = '';

  for (const cat of cats.sort()) {
    const dates = tree[cat];
    const sec = document.createElement('div');
    sec.className = 'cat-section';

    const heading = document.createElement('div');
    heading.className = 'cat-heading';
    heading.innerHTML = `<span class="cat-emoji">${catEmoji(cat)}</span><span>${cat}</span><span class="cat-age-label" data-cat="${cat}" style="font-family:'JetBrains Mono',monospace;font-size:0.55rem;color:var(--ink-muted);margin-left:0.3rem;"></span><span class="cat-arrow">▶</span>`;

    const cabinet = document.createElement('div');
    cabinet.className = 'cabinet visit-list';

    const currentYear = new Date().getFullYear();
    const yearMap = {};
    for (const date of Object.keys(dates).sort().reverse()) {
      const year = date ? date.slice(0, 4) : 'Unknown';
      if (!yearMap[year]) yearMap[year] = [];
      yearMap[year].push(date);
    }
    const years = Object.keys(yearMap).sort().reverse();

    const yearContentEls = {};
    for (const year of years) {
      const content = document.createElement('div');
      content.style.display = 'none';
      for (const date of yearMap[year]) {
        content.appendChild(buildDateGroup(dates[date], date));
      }
      yearContentEls[year] = content;
    }

    const cabinetBody = document.createElement('div');
    cabinetBody.className = 'cabinet-body';

    const tabsWrap = document.createElement('div');
    tabsWrap.className = 'cabinet-tabs-wrap';

    const leftBtn = document.createElement('button');
    leftBtn.className = 'cabinet-arrow';
    leftBtn.textContent = '‹';
    leftBtn.title = 'Older years';

    const tabsScroll = document.createElement('div');
    tabsScroll.className = 'cabinet-tabs-scroll';

    const rightBtn = document.createElement('button');
    rightBtn.className = 'cabinet-arrow';
    rightBtn.textContent = '›';
    rightBtn.title = 'Newer years';

    tabsWrap.appendChild(leftBtn);
    tabsWrap.appendChild(tabsScroll);
    tabsWrap.appendChild(rightBtn);

    let tabOffset = 0;
    const TABS_VISIBLE = 5;
    const tabEls = [];
    let activeYear = years[0];

    const selectYear = (year) => {
      activeYear = year;
      tabEls.forEach(t => t.el.classList.toggle('active', t.year === year));
      cabinetBody.innerHTML = '';
      const content = yearContentEls[year];
      content.style.display = 'block';
      cabinetBody.appendChild(content);
    };

    const renderTabs = () => {
      tabsScroll.innerHTML = '';
      const visible = tabEls.slice(tabOffset, tabOffset + TABS_VISIBLE);
      visible.forEach(t => tabsScroll.appendChild(t.el));
      leftBtn.disabled = tabOffset <= 0;
      rightBtn.disabled = tabOffset >= tabEls.length - TABS_VISIBLE;
    };

    years.forEach((year) => {
      const count = yearMap[year].reduce((sum, d) => sum + dates[d].length, 0);
      const tabEl = document.createElement('div');
      tabEl.className = 'cabinet-tab' + (year === activeYear ? ' active' : '');
      tabEl.textContent = `${year} (${count})`;
      tabEl.addEventListener('click', () => selectYear(year));
      tabEls.push({ year, el: tabEl });
    });

    tabOffset = 0;

    leftBtn.addEventListener('click', () => {
      tabOffset = Math.max(0, tabOffset - 1);
      renderTabs();
    });
    rightBtn.addEventListener('click', () => {
      tabOffset = Math.min(tabEls.length - TABS_VISIBLE, tabOffset + 1);
      renderTabs();
    });

    renderTabs();
    selectYear(activeYear);

    cabinet.appendChild(tabsWrap);
    cabinet.appendChild(cabinetBody);

    heading.onclick = () => {
      heading.classList.toggle('open');
      cabinet.classList.toggle('open');
    };

    sec.appendChild(heading);
    sec.appendChild(cabinet);
    container.appendChild(sec);
  }
  renderPetAges();
}

export function buildDateGroup(visits, date) {
  const dg = document.createElement('div');
  dg.className = 'visit-date-group';

  const dl = document.createElement('div');
  dl.className = 'visit-date-label';
  dl.style.cssText = 'display:flex;align-items:center;gap:0.4rem;cursor:pointer;user-select:none;padding:0.28rem 1rem 0.28rem 1.5rem;';

  const dlArrow = document.createElement('span');
  dlArrow.style.cssText = 'font-size:0.45rem;color:var(--ink-muted);transition:transform 0.15s;flex-shrink:0;padding:0.3rem 0.5rem 0.3rem 0;margin-left:-0.25rem;cursor:pointer;';
  dlArrow.textContent = '▶';

  const dlText = document.createElement('span');
  dlText.textContent = formatDate(date);
  dlText.style.cssText = 'flex-shrink:0;';

  const nonInvoiceVisits = visits.filter(v => v.docType !== 'Invoice');
  const invoiceOnlyVisits = visits.filter(v => v.docType === 'Invoice');
  const isInvoiceOnly = nonInvoiceVisits.length === 0 && invoiceOnlyVisits.length > 0;
  const isMultiple = nonInvoiceVisits.length > 1;
  const effectiveSingle = nonInvoiceVisits.length === 1 ? nonInvoiceVisits[0] : null;
  const singleVisit = visits.length === 1 ? visits[0] : (effectiveSingle || (isInvoiceOnly ? invoiceOnlyVisits[0] : null));
  const complaint = isInvoiceOnly ? briefInvoice(invoiceOnlyVisits[0]) : isMultiple ? 'multiple visits' : (singleVisit ? briefComplaint(singleVisit) : '');
  const complaintFull = isInvoiceOnly ? briefInvoice(invoiceOnlyVisits[0]) : isMultiple ? 'multiple visits' : (singleVisit?.chiefComplaint || complaint);
  const dateSuppressWell = isMultiple && nonInvoiceVisits.some(v => v.visitClass === 'problem' || visitTypeStyle(v) === null);
  const singleStyle = (!isInvoiceOnly && !isMultiple && singleVisit && !dateSuppressWell) ? visitTypeStyle(singleVisit) : null;

  if (singleStyle) {
    dl.style.borderLeft = `2px solid ${singleStyle.color}`;
    dl.style.paddingLeft = '0.85rem';
    dlText.style.color = singleStyle.color;
  }

  if (complaint) {
    const cc = document.createElement('span');
    cc.className = 'date-complaint-span';
    cc.textContent = complaint;
    if (complaintFull && complaintFull !== complaint) cc.title = complaintFull;
    const ccColor = isInvoiceOnly ? 'var(--ink-muted)' : isMultiple ? 'var(--ink-dim)' : (singleStyle ? singleStyle.color : 'var(--ink)');
    cc.style.cssText = `font-family:"JetBrains Mono",monospace;font-size:0.58rem;color:${ccColor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;opacity:${isInvoiceOnly ? '0.75' : '1'};cursor:default;${isMultiple ? 'font-style:italic;' : ''}`;
    if (isInvoiceOnly) dlText.style.color = 'var(--ink-muted)';
    dl.appendChild(dlArrow);
    dl.appendChild(dlText);
    dl.appendChild(cc);
  } else {
    dl.appendChild(dlArrow);
    dl.appendChild(dlText);
  }

  if (isInvoiceOnly && singleVisit) {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏';
    editBtn.title = 'Edit chief complaint';
    editBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:0.6rem;color:var(--ink-muted);padding:0.1rem 0.2rem;border-radius:3px;opacity:0;transition:opacity 0.15s;flex-shrink:0;line-height:1;';
    dl.appendChild(editBtn);
    dl.addEventListener('mouseenter', () => editBtn.style.opacity = '0.5');
    dl.addEventListener('mouseleave', () => editBtn.style.opacity = '0');
    editBtn.addEventListener('click', e => { e.stopPropagation(); openInvoiceComplaintEdit(singleVisit, dl); });
  }

  if (nonInvoiceVisits.length > 1) {
    const badge = document.createElement('span');
    badge.textContent = nonInvoiceVisits.length;
    badge.style.cssText = 'background:var(--surface2);border-radius:8px;padding:0 0.3rem;font-size:0.55rem;color:var(--ink-muted);flex-shrink:0;';
    dl.appendChild(badge);
  } else if (isInvoiceOnly || (visits.length > 1 && nonInvoiceVisits.length <= 1)) {
    const invBadge = document.createElement('span');
    invBadge.textContent = 'inv';
    invBadge.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.52rem;background:var(--amber-bg);color:var(--amber);border-radius:3px;padding:0 3px;flex-shrink:0;';
    dl.appendChild(invBadge);
  }
  dg.appendChild(dl);

  const entriesEl = document.createElement('div');
  entriesEl.style.display = 'none';

  const hasAnyProblem = nonInvoiceVisits.some(v => v.visitClass === 'problem' || (visitTypeStyle(v) === null && !v.docType));
  const suppressWell = nonInvoiceVisits.length > 1 && hasAnyProblem;

  for (const v of visits) {
    const ve = document.createElement('div');
    ve.className = 'visit-entry';
    ve.style.cssText = 'position:relative;cursor:pointer;';
    ve.dataset.visitId = v.id;
    const clinicDisplay = v.clinic ? abbreviateClinic(v.clinic) : 'Visit';
    const isInvoice = v.docType === 'Invoice';
    const isHome = v.source === 'home';
    const vStyle = suppressWell ? null : visitTypeStyle(v);
    if (vStyle) { ve.style.borderLeft = `2px solid ${vStyle.color}`; ve.style.paddingLeft = '0.85rem'; }
    const cc = (!isInvoice && !isHome && visits.filter(x => x.docType !== 'Invoice').length > 1) ? briefComplaint(v) : '';
    const ccFull = v.chiefComplaint || cc;
    const clinicColor = vStyle ? vStyle.color : 'var(--ink-dim)';
    ve.innerHTML = `<span class="visit-entry-type" title="${escHtml(v.synopsis||v.chiefComplaint||'')}">
        ${isInvoice ? '<span style="font-family:\'JetBrains Mono\',monospace;font-size:0.52rem;background:var(--amber-bg);color:var(--amber);border-radius:3px;padding:0 3px;margin-right:3px;vertical-align:middle;">inv</span>' : ''}
        ${isHome ? '<span class="home-badge">🏠 home</span>' : ''}
        <span style="color:${clinicColor};font-weight:400;">${isHome ? escHtml(v.chiefComplaint || v.issueType || 'Issue') : escHtml(clinicDisplay)}</span>${cc ? `<span style="color:var(--ink-muted);font-weight:400;font-size:0.57rem;font-family:'JetBrains Mono',monospace;" title="${escHtml(ccFull)}"> · ${escHtml(cc)}</span>` : ''}
      </span>
      <span class="visit-entry-actions" style="display:none;gap:0.2rem;flex-shrink:0;">
        <button class="visit-action-btn" title="Edit" style="background:none;border:none;cursor:pointer;font-size:0.65rem;color:var(--ink-muted);padding:0.1rem 0.2rem;border-radius:3px;line-height:1;" data-action="edit">✏</button>
        <button class="visit-action-btn" title="Delete" style="background:none;border:none;cursor:pointer;font-size:0.65rem;color:var(--red);padding:0.1rem 0.2rem;border-radius:3px;line-height:1;" data-action="delete">🗑</button>
      </span>`;
    ve.addEventListener('mouseenter', () => { ve.querySelector('.visit-entry-actions').style.display = 'flex'; });
    ve.addEventListener('mouseleave', () => { ve.querySelector('.visit-entry-actions').style.display = 'none'; });
    ve.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      e.stopPropagation();
      try { openVisit(v); } catch(err) { showAlert('Error opening visit: ' + err.message, 'warning'); console.error('openVisit error:', err); }
    });
    ve.querySelector('[data-action="edit"]').onclick = (e) => { e.stopPropagation(); openVisitEdit(v); };
    ve.querySelector('[data-action="delete"]').onclick = (e) => { e.stopPropagation(); confirmDeleteVisit(v); };
    attachVisitCtxMenu(ve, v);
    entriesEl.appendChild(ve);
  }
  dg.appendChild(entriesEl);

  dlArrow.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = entriesEl.style.display === 'none';
    entriesEl.style.display = open ? 'block' : 'none';
    dlArrow.style.transform = open ? 'rotate(90deg)' : '';
  });

  dl.addEventListener('click', () => {
    if (singleVisit && (nonInvoiceVisits.length <= 1 || isInvoiceOnly)) {
      try { openVisit(singleVisit); } catch(err) { showAlert('Error opening visit: ' + err.message, 'warning'); }
    } else {
      const open = entriesEl.style.display === 'none';
      entriesEl.style.display = open ? 'block' : 'none';
      dlArrow.style.transform = open ? 'rotate(90deg)' : '';
    }
  });

  return dg;
}

function openInvoiceComplaintEdit(visit, dlEl) {
  const existing = dlEl.querySelector('.date-complaint-span');
  const currentVal = visit.chiefComplaint || visit.invoiceSummary || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentVal;
  input.style.cssText = 'flex:1;min-width:0;font-family:"JetBrains Mono",monospace;font-size:0.58rem;background:var(--bg);border:1px solid var(--accent);border-radius:4px;padding:0.1rem 0.35rem;color:var(--ink);outline:none;';

  if (existing) existing.replaceWith(input);
  else dlEl.appendChild(input);
  input.focus();
  input.select();

  const save = async () => {
    const val = input.value.trim();
    if (val && val !== currentVal) {
      try {
        await setDoc(doc(db, 'visits', visit.id), { chiefComplaint: val, invoiceSummary: val }, { merge: true });
        visit.chiefComplaint = val;
        visit.invoiceSummary = val;
        showToast('Updated ✓', 'journal');
      } catch(e) { showAlert('Save failed: ' + e.message, 'warning'); }
    }
    const ccSpan = dlEl.querySelector('.date-complaint-span');
    if (ccSpan) ccSpan.textContent = val || currentVal;
    else {
      const span = document.createElement('span');
      span.className = 'date-complaint-span';
      span.textContent = val || currentVal;
      span.style.cssText = `font-family:"JetBrains Mono",monospace;font-size:0.58rem;color:var(--ink-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;opacity:0.75;cursor:default;`;
      input.replaceWith(span);
      return;
    }
    input.replaceWith(ccSpan);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentVal; input.blur(); }
  });
}

export function openVisitEdit(v) {
  setupClassicPopup();
  $('popup-title').textContent = v.source === 'home' ? `Edit Home Issue — ${v.cat} · ${v.date}` : `Edit — ${v.cat} · ${v.date}`;
  const body = $('popup-body');
  body.innerHTML = '';

  const fld = (label, key, type = 'text', value = '', rows = 6) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:0.65rem;';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.style.cssText = 'display:block;font-family:JetBrains Mono,monospace;font-size:0.6rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:0.25rem;';
    wrap.appendChild(lbl);
    let el;
    if (type === 'textarea') {
      el = document.createElement('textarea');
      el.rows = rows;
      el.style.cssText = 'width:100%;font-family:JetBrains Mono,monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:0.5rem;resize:vertical;outline:none;color:var(--ink);line-height:1.6;';
    } else if (type === 'select') {
      el = document.createElement('select');
      el.style.cssText = 'width:100%;font-family:JetBrains Mono,monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:0.4rem;outline:none;color:var(--ink);background:var(--bg);';
      APP_PETS.forEach(p => {
        const o = document.createElement('option');
        o.value = p; o.textContent = p;
        if (p === value) o.selected = true;
        el.appendChild(o);
      });
    } else {
      el = document.createElement('input');
      el.type = type;
      el.style.cssText = 'width:100%;font-family:JetBrains Mono,monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:0.4rem 0.6rem;outline:none;color:var(--ink);background:var(--bg);';
    }
    if (type !== 'select') el.value = value;
    el.dataset.key = key;
    wrap.appendChild(el);
    return wrap;
  };

  const form = document.createElement('div');
  form.appendChild(fld('Cat', 'cat', 'select', v.cat || ''));
  form.appendChild(fld('Date', 'date', 'date', v.date || ''));
  form.appendChild(fld('Clinic', 'clinic', 'text', v.clinic || ''));
  form.appendChild(fld('Doctor', 'doctor', 'text', v.doctor || ''));
  form.appendChild(fld('Chief Complaint', 'chiefComplaint', 'text', v.chiefComplaint || ''));
  form.appendChild(fld('Synopsis', 'synopsis', 'textarea', v.synopsis || '', 3));

  const medsWrap = document.createElement('div');
  medsWrap.style.cssText = 'margin-bottom:0.65rem;';
  const medsLbl = document.createElement('label');
  medsLbl.textContent = 'Medications';
  medsLbl.style.cssText = 'display:block;font-family:JetBrains Mono,monospace;font-size:0.6rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:0.35rem;';
  medsWrap.appendChild(medsLbl);

  let editMeds = JSON.parse(JSON.stringify(v.medications || []));
  const medsListEl = document.createElement('div');
  medsListEl.style.cssText = 'display:flex;flex-direction:column;gap:0.3rem;margin-bottom:0.4rem;';

  const renderMedsList = () => {
    medsListEl.innerHTML = '';
    editMeds.forEach((m, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:0.3rem;background:var(--surface);border-radius:6px;padding:0.3rem 0.5rem;';
      const info = document.createElement('span');
      info.style.cssText = 'font-family:JetBrains Mono,monospace;font-size:0.62rem;color:var(--ink-dim);flex:1;';
      info.textContent = `${m.name}${m.dose?' '+m.dose:''}${m.frequency?', '+m.frequency:''}${m.supplement?' (supp)':''}${m.continuing?' ✓':''}`;
      const delBtn = document.createElement('button');
      delBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--ink-muted);font-size:0.7rem;padding:0.1rem 0.2rem;border-radius:3px;transition:color 0.15s;';
      delBtn.textContent = '✕';
      delBtn.title = 'Remove';
      delBtn.onclick = () => { editMeds.splice(idx, 1); renderMedsList(); };
      row.appendChild(info);
      row.appendChild(delBtn);
      medsListEl.appendChild(row);
    });
    if (!editMeds.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-family:JetBrains Mono,monospace;font-size:0.6rem;color:var(--ink-muted);padding:0.2rem 0;';
      empty.textContent = 'No medications';
      medsListEl.appendChild(empty);
    }
  };
  renderMedsList();

  const addMedRow = document.createElement('div');
  addMedRow.style.cssText = 'display:flex;gap:0.25rem;flex-wrap:wrap;align-items:center;';
  const mkInput = (ph, w) => {
    const i = document.createElement('input');
    i.placeholder = ph;
    i.style.cssText = `font-family:JetBrains Mono,monospace;font-size:0.65rem;border:1px solid var(--border);border-radius:5px;padding:0.25rem 0.4rem;outline:none;color:var(--ink);background:var(--bg);width:${w};`;
    return i;
  };
  const nameI = mkInput('Name*', '90px');
  const doseI = mkInput('Dose', '60px');
  const freqI = mkInput('Freq', '55px');
  const suppChk = document.createElement('input'); suppChk.type = 'checkbox'; suppChk.title = 'Supplement';
  const suppLbl = document.createElement('label');
  suppLbl.style.cssText = 'font-family:JetBrains Mono,monospace;font-size:0.58rem;color:var(--ink-muted);display:flex;align-items:center;gap:0.2rem;cursor:pointer;';
  suppLbl.appendChild(suppChk); suppLbl.append('supp');
  const addMedBtn = document.createElement('button');
  addMedBtn.className = 'btn-icon free-icon';
  addMedBtn.style.cssText = 'font-size:0.58rem;padding:0.2rem 0.45rem;';
  addMedBtn.innerHTML = '+ Add';
  addMedBtn.onclick = () => {
    const name = nameI.value.trim();
    if (!name) return;
    editMeds.push({ name, dose: doseI.value.trim()||null, frequency: freqI.value.trim()||null, supplement: suppChk.checked, continuing: true, dispensed: false, route: null });
    nameI.value = ''; doseI.value = ''; freqI.value = ''; suppChk.checked = false;
    renderMedsList();
  };
  [nameI, doseI, freqI].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') addMedBtn.click(); }));
  addMedRow.append(nameI, doseI, freqI, suppLbl, addMedBtn);

  medsWrap.appendChild(medsListEl);
  medsWrap.appendChild(addMedRow);
  form.appendChild(medsWrap);
  form.appendChild(fld('Narrative', 'narrative', 'textarea', v.narrative || '', 10));
  body.appendChild(form);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-icon free-icon';
  saveBtn.style.cssText = 'margin-top:0.5rem;';
  saveBtn.innerHTML = '<span class="free-dot"></span> Save Changes';
  saveBtn.onclick = async () => {
    if (!v.id) { showAlert('Cannot edit — no Firestore ID', 'warning'); return; }
    const updates = {};
    form.querySelectorAll('[data-key]').forEach(el => {
      updates[el.dataset.key] = el.value;
    });
    updates.medications = editMeds;
    try {
      await setDoc(doc(db, 'visits', v.id), updates, { merge: true });
      setAllVisitsCache(null); invalidateChatContext(); dirtyRecordsSidebar();
      showToast('Visit updated ✓', 'journal');
      $('record-popup').classList.remove('open');
      loadRecordsSidebar();
    } catch(err) { showAlert('Save failed: ' + err.message, 'warning'); }
  };
  body.appendChild(saveBtn);

  const linkEl = $('popup-drive-link');
  if (linkEl) {
    if (v.driveFileIds?.[0]) {
      const fname = v.sourceFiles?.[0] || v.driveFileIds[0];
      linkEl.innerHTML = `<a href="https://drive.google.com/file/d/${v.driveFileIds[0]}/view" target="_blank" title="${escHtml(fname)}" style="color:var(--accent);text-decoration:none;">Open original in Drive ↗</a>`;
    } else {
      linkEl.textContent = v.sourceFiles?.[0] || '';
    }
  }

  $('record-popup').classList.add('open');
}

// ── VISIT CONTEXT MENU ──

export function attachVisitCtxMenu(el, visit) {
  el.addEventListener('contextmenu', e => {
    showCtxMenu(e, `${visit.cat} · ${formatDate(visit.date)}`, [
      { label: '👁 View', action: () => openVisit(visit) },
      { label: '✏ Edit', action: () => openVisitEdit(visit) },
      { label: '⊕ Merge with another visit…', action: () => openMergeModal(visit) },
      { label: '↗ Open source in Drive', disabled: !visit.driveFileIds?.[0],
        action: () => window.open(`https://drive.google.com/file/d/${visit.driveFileIds[0]}/view`, '_blank') },
      'sep',
      { label: '🗑 Delete visit', danger: true, action: () => confirmDeleteVisit(visit) }
    ]);
  });
}

export async function confirmDeleteVisit(visit) {
  if (!confirm(`Delete this visit record?\n${visit.cat} · ${formatDate(visit.date)}${visit.clinic ? ' · ' + visit.clinic : ''}\n\nThis cannot be undone.`)) return;
  await deleteDoc(doc(db, 'visits', visit.id));
  setAllVisitsCache(null); invalidateChatContext(); dirtyRecordsSidebar();
  await loadRecordsSidebar();
  showToast('Visit deleted ✓', 'journal');
}

// ── VISIT MERGE ──

export async function openMergeModal(visitA) {
  const modal = $('merge-modal');
  const body = $('merge-body');
  const status = $('merge-status');
  const confirmBtn = $('merge-confirm-btn');

  body.innerHTML = '<div style="padding:1.5rem;font-family:\'JetBrains Mono\',monospace;font-size:0.68rem;color:var(--ink-muted);">Loading visits for ' + escHtml(visitA.cat) + '…</div>';
  status.textContent = '';
  confirmBtn.disabled = true;
  modal.style.display = 'flex';

  const snap = await getDocs(query(collection(db, 'visits'), where('cat', '==', visitA.cat)));
  const candidates = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(v => v.id !== visitA.id)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (!candidates.length) {
    body.innerHTML = '<div style="padding:1.5rem;font-family:\'JetBrains Mono\',monospace;font-size:0.68rem;color:var(--ink-muted);">No other visits found for ' + escHtml(visitA.cat) + '.</div>';
    return;
  }

  body.innerHTML = '';
  const pickHdr = document.createElement('div');
  pickHdr.style.cssText = 'padding:0.75rem 1.25rem 0.5rem;font-family:"JetBrains Mono",monospace;font-size:0.63rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-muted);border-bottom:1px solid var(--surface2);';
  pickHdr.textContent = 'Select the visit to merge with:';
  body.appendChild(pickHdr);

  const list = document.createElement('div');
  list.style.cssText = 'max-height:300px;overflow-y:auto;';
  candidates.forEach(v => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.55rem 1.25rem;border-bottom:1px solid var(--surface2);cursor:pointer;transition:background 0.1s;';
    row.addEventListener('mouseenter', () => row.style.background = 'var(--surface)');
    row.addEventListener('mouseleave', () => row.style.background = '');
    const isSameDate = v.date === visitA.date;
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:${isSameDate ? 'var(--accent)' : 'var(--ink)'};">${escHtml(formatDate(v.date))}${v.clinic ? ' · ' + escHtml(abbreviateClinic(v.clinic)) : ''}${isSameDate ? ' <span style="color:var(--accent);font-size:0.6rem;">same date</span>' : ''}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--ink-muted);margin-top:0.1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(v.chiefComplaint || v.synopsis?.slice(0,60) || '(no summary)')}</div>
      </div>
      <span style="font-family:'JetBrains Mono',monospace;font-size:0.55rem;color:var(--ink-muted);">${(v.sourceFiles||[]).map(f=>f.slice(0,20)).join(', ')}</span>`;
    row.addEventListener('click', () => buildMergeFields(visitA, v));
    list.appendChild(row);
  });
  body.appendChild(list);
}

function buildMergeFields(visitA, visitB) {
  const body = $('merge-body');
  const status = $('merge-status');
  const confirmBtn = $('merge-confirm-btn');
  const selections = {};

  const FIELDS = [
    { key: 'chiefComplaint', label: 'Chief Complaint' },
    { key: 'synopsis', label: 'Synopsis', long: true },
    { key: 'narrative', label: 'Narrative', long: true },
    { key: 'vitals', label: 'Vitals', fmt: v => v ? Object.entries(v).filter(([,val])=>val).map(([k,val])=>`${k}: ${val}`).join(' · ') : '' },
    { key: 'medications', label: 'Medications', fmt: v => (v||[]).map(m=>m.name+(m.dose?' '+m.dose:'')).join(', ') },
    { key: 'procedures', label: 'Procedures', fmt: v => (v||[]).map(p=>p.name).join(', ') },
    { key: 'clinic', label: 'Clinic' },
    { key: 'doctor', label: 'Doctor' },
  ];

  body.innerHTML = '';

  const hdrRow = document.createElement('div');
  hdrRow.style.cssText = 'display:grid;grid-template-columns:120px 1fr 1fr;gap:0;border-bottom:2px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:1;';
  hdrRow.innerHTML = `
    <div style="padding:0.5rem 1rem;font-family:'JetBrains Mono',monospace;font-size:0.6rem;font-weight:700;color:var(--ink-muted);text-transform:uppercase;letter-spacing:0.08em;"></div>
    <div style="padding:0.5rem 1rem;font-family:'JetBrains Mono',monospace;font-size:0.65rem;font-weight:700;color:var(--ink);border-left:1px solid var(--border);">Visit A · ${escHtml(formatDate(visitA.date))} · ${escHtml(visitA.clinic ? abbreviateClinic(visitA.clinic) : 'Unknown')}<div style="font-size:0.58rem;font-weight:400;color:var(--ink-muted);margin-top:0.1rem;">${escHtml((visitA.sourceFiles||[]).map(f=>f.slice(0,25)).join(', '))}</div></div>
    <div style="padding:0.5rem 1rem;font-family:'JetBrains Mono',monospace;font-size:0.65rem;font-weight:700;color:var(--ink);border-left:1px solid var(--border);">Visit B · ${escHtml(formatDate(visitB.date))} · ${escHtml(visitB.clinic ? abbreviateClinic(visitB.clinic) : 'Unknown')}<div style="font-size:0.58rem;font-weight:400;color:var(--ink-muted);margin-top:0.1rem;">${escHtml((visitB.sourceFiles||[]).map(f=>f.slice(0,25)).join(', '))}</div></div>`;
  body.appendChild(hdrRow);

  const updateStatus = () => {
    const done = Object.keys(selections).length;
    const needed = FIELDS.filter(f => {
      const a = f.fmt ? f.fmt(visitA[f.key]) : (visitA[f.key] || '');
      const b = f.fmt ? f.fmt(visitB[f.key]) : (visitB[f.key] || '');
      return a && b && a !== b;
    }).length;
    status.textContent = needed ? `${done}/${needed} fields selected` : 'No conflicts — ready to merge';
    confirmBtn.disabled = needed > 0 && done < needed;
  };

  FIELDS.forEach(({ key, label, long, fmt }) => {
    const valA = fmt ? fmt(visitA[key]) : (visitA[key] || '');
    const valB = fmt ? fmt(visitB[key]) : (visitB[key] || '');
    const same = valA === valB;
    const bothEmpty = !valA && !valB;
    if (bothEmpty) return;

    if (!same && valA && valB) {
      selections[key] = valA.length >= valB.length ? 'A' : 'B';
    }

    const row = document.createElement('div');
    row.style.cssText = `display:grid;grid-template-columns:120px 1fr 1fr;gap:0;border-bottom:1px solid var(--surface2);${same ? 'opacity:0.5;' : ''}`;

    const mkCell = (val, side) => {
      const cell = document.createElement('div');
      const isSelected = selections[key] === side;
      cell.style.cssText = `padding:0.55rem 1rem;font-family:'JetBrains Mono',monospace;font-size:0.63rem;border-left:1px solid var(--border);line-height:1.5;word-break:break-word;${long ? 'max-height:80px;overflow:hidden;' : ''}${!same && val ? 'cursor:pointer;' : ''}${isSelected ? 'background:#edf5f0;border-left:3px solid #2e7d52;' : ''}`;
      cell.textContent = val || '(empty)';
      if (!val) cell.style.color = 'var(--ink-muted)';

      if (!same && val) {
        cell.addEventListener('click', () => {
          selections[key] = side;
          row.querySelectorAll('[data-side]').forEach(c => {
            const s = c.dataset.side;
            c.style.background = selections[key] === s ? '#edf5f0' : '';
            c.style.borderLeft = selections[key] === s ? '3px solid #2e7d52' : '1px solid var(--border)';
          });
          updateStatus();
        });
        cell.dataset.side = side;
      }
      return cell;
    };

    const labelCell = document.createElement('div');
    labelCell.style.cssText = 'padding:0.55rem 1rem;font-family:"JetBrains Mono",monospace;font-size:0.6rem;font-weight:700;color:var(--ink-muted);text-transform:uppercase;letter-spacing:0.06em;display:flex;align-items:flex-start;';
    labelCell.innerHTML = escHtml(label) + (same ? '' : ' <span style="color:var(--amber);margin-left:0.3rem;">⚠</span>');

    row.appendChild(labelCell);
    row.appendChild(mkCell(valA, 'A'));
    row.appendChild(mkCell(valB, 'B'));
    body.appendChild(row);
  });

  updateStatus();
  $('merge-confirm-btn').onclick = () => executeMerge(visitA, visitB, selections, FIELDS);
}

async function executeMerge(visitA, visitB, selections, FIELDS) {
  const confirmBtn = $('merge-confirm-btn');
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = '<span class="free-dot"></span> Merging…';

  try {
    const merged = { ...visitA };
    FIELDS.forEach(({ key }) => {
      const sel = selections[key];
      if (sel === 'B') merged[key] = visitB[key];
      else if (!sel) {
        if (!merged[key] && visitB[key]) merged[key] = visitB[key];
      }
    });

    merged.sourceFiles = [...new Set([...(visitA.sourceFiles||[]), ...(visitB.sourceFiles||[])])];
    merged.driveFileIds = [...new Set([...(visitA.driveFileIds||[]), ...(visitB.driveFileIds||[])])];
    merged.updatedAt = new Date().toISOString();

    const labsSnap = await getDocs(query(collection(db, 'labs'), where('driveFileId', 'in', (visitB.driveFileIds||[visitB.id]).slice(0,10))));

    const batch = writeBatch(db);
    batch.update(doc(db, 'visits', visitA.id), sanitizeForFirestore(merged));
    batch.delete(doc(db, 'visits', visitB.id));
    await batch.commit();

    $('merge-modal').style.display = 'none';
    setAllVisitsCache(null); invalidateChatContext(); dirtyRecordsSidebar();
    await loadRecordsSidebar();
    showToast('Visits merged ✓', 'journal');
  } catch(err) {
    showAlert('Merge failed: ' + err.message, 'warning');
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '<span class="free-dot"></span> Merge &amp; delete duplicate';
  }
}

// ── VISIT SEARCH ──

export function filterVisitsByKeyword(q) {
  if (!q) {
    setRecordsSidebarDirty(true);
    _loadRecordsSidebarImpl();
    return;
  }
  const ql = q.toLowerCase();
  const filtered = (_allVisitsCache || []).filter(v => {
    const fields = [
      v.cat, v.chiefComplaint, v.diagnosis, v.synopsis, v.clinic, v.date, v.docType,
      ...(v.medications || []).map(m => m.name),
      ...(v.procedures || []).map(p => p.name),
    ];
    return fields.some(f => f && f.toLowerCase().includes(ql));
  });
  if (!filtered.length) {
    $('records-empty').style.display = 'flex';
    $('records-tree').innerHTML = '';
    return;
  }
  const tree = {};
  filtered.forEach(v => {
    if (!tree[v.cat]) tree[v.cat] = {};
    if (!tree[v.cat][v.date]) tree[v.cat][v.date] = [];
    if (!tree[v.cat][v.date].find(x => x.id === v.id)) tree[v.cat][v.date].push(v);
  });
  renderRecordsTree(tree);
  document.querySelectorAll('#records-tree .cat-heading').forEach(h => {
    if (!h.classList.contains('open')) h.click();
  });
}

// ── HOME ISSUE MODAL ──

export function openHomeIssueModal() {
  const form = $('home-issue-form');
  form.innerHTML = '';

  const mkField = (label, id, type = 'text', opts = {}) => {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.style.cssText = 'display:block;font-family:"JetBrains Mono",monospace;font-size:0.6rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:0.2rem;';
    lbl.setAttribute('for', id);
    wrap.appendChild(lbl);
    let el;
    if (type === 'select') {
      el = document.createElement('select');
      el.style.cssText = 'width:100%;font-family:"JetBrains Mono",monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:0.4rem;outline:none;color:var(--ink);background:var(--bg);';
      (opts.options || []).forEach(o => {
        const opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        el.appendChild(opt);
      });
    } else if (type === 'textarea') {
      el = document.createElement('textarea');
      el.rows = opts.rows || 3;
      el.style.cssText = 'width:100%;font-family:"JetBrains Mono",monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:0.5rem;resize:vertical;outline:none;color:var(--ink);line-height:1.6;';
    } else {
      el = document.createElement('input');
      el.type = type;
      el.style.cssText = 'width:100%;font-family:"JetBrains Mono",monospace;font-size:0.72rem;border:1px solid var(--border);border-radius:6px;padding:0.4rem 0.6rem;outline:none;color:var(--ink);background:var(--bg);';
    }
    if (opts.placeholder) el.placeholder = opts.placeholder;
    if (opts.value !== undefined) el.value = opts.value;
    el.id = id;
    wrap.appendChild(el);
    return wrap;
  };

  const today = new Date().toISOString().slice(0, 10);
  form.appendChild(mkField('Cat', 'hi-cat', 'select', { options: APP_PETS.length ? APP_PETS : ['Cat'] }));
  form.appendChild(mkField('Date', 'hi-date', 'date', { value: today }));
  form.appendChild(mkField('Issue', 'hi-complaint', 'text', { placeholder: 'Describe the issue' }));
  form.appendChild(mkField('Observed', 'hi-synopsis', 'textarea', { rows: 2, placeholder: '' }));
  form.appendChild(mkField('Treatment', 'hi-treatment', 'textarea', { rows: 2, placeholder: '' }));

  $('home-issue-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('hi-complaint')?.focus(), 80);
}

export async function saveHomeIssue() {
  const cat = $('hi-cat')?.value?.trim();
  const date = $('hi-date')?.value?.trim();
  const complaint = $('hi-complaint')?.value?.trim();
  const synopsis = $('hi-synopsis')?.value?.trim();
  const treatment = $('hi-treatment')?.value?.trim();

  if (!cat || !date || !complaint) {
    showToast('Cat, date, and issue are required', 'warning');
    return;
  }

  const narrative = [
    synopsis ? `OBSERVED\n${synopsis}` : '',
    treatment ? `TREATMENT\n${treatment}` : '',
  ].filter(Boolean).join('\n\n');

  // sanitizeForFirestore imported lazily to avoid circular dep
  const { sanitizeForFirestore } = await import('./import.js');

  const record = sanitizeForFirestore({
    cat,
    date,
    source: 'home',
    chiefComplaint: complaint,
    issueType: complaint,
    synopsis: [synopsis, treatment ? `Treatment: ${treatment}` : ''].filter(Boolean).join(' '),
    narrative: narrative || null,
    createdAt: new Date().toISOString(),
    vitals: {},
    medications: [],
    procedures: [],
  });

  try {
    await addDoc(collection(db, 'visits'), record);
    setAllVisitsCache(null); invalidateChatContext(); dirtyRecordsSidebar();
    $('home-issue-modal').style.display = 'none';
    showToast(`Home issue logged for ${cat} ✓`, 'journal');
    loadRecordsSidebar();
  } catch(err) {
    showAlert('Failed to save: ' + err.message, 'warning');
  }
}

// ── POPUP HELPERS (shared with visit detail) ──

export function setupClassicPopup() {
  const box = document.querySelector('.record-popup-box');
  box.style.cssText = 'background:white;border-radius:13px;width:100%;max-width:700px;height:82vh;display:flex;flex-direction:column;box-shadow:0 10px 50px rgba(42,37,32,0.2);overflow:hidden;';
  box.innerHTML = [
    '<div id="classic-popup-header" style="background:white;padding:0.85rem 1.1rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0.6rem;flex-shrink:0;flex-wrap:wrap;">',
      '<div class="record-popup-title" id="popup-title"></div>',
      '<div class="record-popup-search">',
        '<input id="popup-search-input" placeholder="Search…">',
        '<button class="popup-search-nav" id="popup-prev">▲</button>',
        '<button class="popup-search-nav" id="popup-next">▼</button>',
        '<span id="popup-search-count"></span>',
      '</div>',
      '<button class="modal-close" id="popup-close">✕</button>',
    '</div>',
    '<div class="record-popup-body" id="popup-body" style="flex:1;overflow-y:auto;padding:1rem 1.1rem;background:white;"></div>',
    '<div id="classic-popup-footer" style="padding:0.65rem 1.1rem;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:white;">',
      '<span id="popup-drive-link" style="font-family:JetBrains Mono,monospace;font-size:0.58rem;color:var(--ink-muted);"></span>',
      '<button class="btn-icon" id="popup-close-btn">Close</button>',
    '</div>',
  ].join('');
  $('popup-close')?.addEventListener('click', () => $('record-popup').classList.remove('open'));
  $('popup-close-btn')?.addEventListener('click', () => $('record-popup').classList.remove('open'));
  wirePopupSearch();
}

function wirePopupSearch() {
  $('popup-search-input')?.addEventListener('input', runPopupSearch);
  $('popup-next')?.addEventListener('click', () => navigatePopup(1));
  $('popup-prev')?.addEventListener('click', () => navigatePopup(-1));
  $('popup-search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigatePopup(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') $('record-popup').classList.remove('open');
  });
}

function runPopupSearch() {
  const input = $('popup-search-input');
  const countEl = $('popup-search-count');
  const body = $('popup-body');
  if (!input || !body) return;
  const q = input.value.trim().toLowerCase();
  clearPopupHighlights(body);
  if (!q) { if (countEl) countEl.textContent = ''; setPopupMatches([]); setPopupMatchIdx(0); return; }
  renderPopupContent(body, popupRawText);
  const matches = highlightPopupMatches(body, q);
  setPopupMatches(matches);
  setPopupMatchIdx(0);
  if (countEl) countEl.textContent = matches.length ? `1 / ${matches.length}` : '0';
  if (matches.length) { matches[0].classList.add('current-match'); matches[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function navigatePopup(dir) {
  if (!popupMatches.length) return;
  popupMatches[popupMatchIdx]?.classList.remove('current-match');
  const newIdx = (popupMatchIdx + dir + popupMatches.length) % popupMatches.length;
  setPopupMatchIdx(newIdx);
  popupMatches[newIdx].classList.add('current-match');
  popupMatches[newIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  const countEl = $('popup-search-count');
  if (countEl) countEl.textContent = `${newIdx + 1} / ${popupMatches.length}`;
}

function clearPopupHighlights(body) {
  body.querySelectorAll('mark.popup-match').forEach(m => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
}

function highlightPopupMatches(body, q) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  const marks = [];
  for (const tn of textNodes) {
    const text = tn.textContent;
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) continue;
    const before = document.createTextNode(text.slice(0, idx));
    const mark = document.createElement('mark');
    mark.className = 'popup-match';
    mark.textContent = text.slice(idx, idx + q.length);
    const after = document.createTextNode(text.slice(idx + q.length));
    tn.parentNode.insertBefore(before, tn);
    tn.parentNode.insertBefore(mark, tn);
    tn.parentNode.insertBefore(after, tn);
    tn.parentNode.removeChild(tn);
    marks.push(mark);
  }
  return marks;
}

function renderPopupContent(body, text) {
  body.innerHTML = '';
  if (!text) return;
  const pre = document.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;font-family:JetBrains Mono,monospace;font-size:0.72rem;color:var(--ink);line-height:1.65;margin:0;';
  pre.textContent = text;
  body.appendChild(pre);
}

// ── FORWARD DECLARATIONS for functions used before definition ──
// These are imported lazily at call time to break circular deps.
function showCtxMenu(...args) {
  import('./ui.js').then(m => m.showCtxMenu(...args));
}

function sanitizeForFirestore(val, depth = 0) {
  // Inline copy — also defined in import.js. Kept here to avoid async import in sync context.
  if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'number') return val;
  if (typeof val === 'string') return val;
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) return val.map(v => sanitizeForFirestore(v, depth + 1)).filter(v => v !== undefined);
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const clean = sanitizeForFirestore(v, depth + 1);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return undefined;
}

// ── VISIT FOLDER POPUP ──
export function openVisit(visit) {
  try {
  function parseNarrativeSections(text) {
    if (!text) return {};
    const sectionHeaders = ['HISTORY', 'PHYSICAL EXAM', 'EXAM FINDINGS', 'ASSESSMENT', 'PLAN', 'DIET', 'DIAGNOSTICS', 'DIAGNOSTIC RESULTS', 'PROCEDURES'];
    const sections = {};
    const lines = text.split('\n');
    let currentKey = null;
    let buffer = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const matchedHeader = sectionHeaders.find(h => trimmed.toUpperCase() === h || trimmed.toUpperCase().startsWith(h + ':'));
      if (matchedHeader) {
        if (currentKey && buffer.join('\n').trim()) sections[currentKey] = buffer.join('\n').trim();
        currentKey = matchedHeader === 'EXAM FINDINGS' ? 'PHYSICAL EXAM' : matchedHeader;
        buffer = [];
      } else if (currentKey) {
        buffer.push(line);
      }
    }
    if (currentKey && buffer.join('\n').trim()) sections[currentKey] = buffer.join('\n').trim();
    return sections;
  }

  const sections = parseNarrativeSections(visit.narrative);
  const sameDateLabs = (_allLabsCache || []).filter(l =>
    l.cat === visit.cat && (l.resultDate === visit.date || l.visitDate === visit.date)
  );
  const labsByGroup = {};
  for (const lab of sameDateLabs) {
    const g = lab.labGroup || 'Other';
    if (!labsByGroup[g]) labsByGroup[g] = [];
    labsByGroup[g].push(lab);
  }

  const hasVitals = visit.vitals && Object.keys(visit.vitals).some(k => visit.vitals[k]);
  const tabs = [];
  tabs.push({ id: 'summary', label: 'Summary' });
  if (hasVitals) tabs.push({ id: 'vitals', label: 'Vitals' });
  if (sections['HISTORY']) tabs.push({ id: 'history', label: 'History' });
  if (sections['PHYSICAL EXAM']) tabs.push({ id: 'exam', label: 'Exam' });
  if (sections['ASSESSMENT'] || sections['DIAGNOSTICS'] || sections['DIAGNOSTIC RESULTS']) tabs.push({ id: 'assessment', label: 'Assessment' });
  if (sections['PLAN']) tabs.push({ id: 'plan', label: 'Plan' });
  if (visit.medications?.length) tabs.push({ id: 'meds', label: 'Medications' });
  if (sections['DIET'] || visit.diet) tabs.push({ id: 'diet', label: 'Diet' });
  if (sameDateLabs.length) tabs.push({ id: 'labs', label: 'Labs' });

  function renderTabContent(tabId, container) {
    container.innerHTML = '';
    const para = (text) => {
      if (!text?.trim()) return;
      const p = document.createElement('p');
      p.style.cssText = 'margin:0 0 0.75rem;white-space:pre-wrap;';
      p.textContent = text.trim();
      container.appendChild(p);
    };
    const sectionLabel = (txt) => {
      const d = document.createElement('div');
      d.className = 'folder-section-label';
      d.textContent = txt;
      container.appendChild(d);
    };

    if (tabId === 'summary') {
      if (visit.chiefComplaint) { sectionLabel('Chief Complaint'); para(visit.chiefComplaint); }
      if (visit.synopsis) { sectionLabel('Summary'); para(visit.synopsis); }
      if (visit.procedures?.length) {
        sectionLabel('Procedures');
        const ul = document.createElement('ul');
        ul.style.cssText = 'margin:0 0 0.75rem;padding-left:1.2rem;';
        for (const p of visit.procedures) {
          const li = document.createElement('li');
          li.style.cssText = 'margin-bottom:0.25rem;';
          li.textContent = p.name + (p.findings ? ' — ' + p.findings : '') + (p.date && p.date !== visit.date ? ' (' + formatDate(p.date) + ')' : '');
          ul.appendChild(li);
        }
        container.appendChild(ul);
      }
      if (!visit.chiefComplaint && !visit.synopsis && !visit.procedures?.length) para('No summary recorded.');
    }
    else if (tabId === 'vitals') {
      const v = visit.vitals || {};
      const vitalDefs = [['weight','Weight'],['HR','Heart Rate'],['RR','Resp Rate'],['temp','Temperature'],['BCS','BCS'],['muscleConditionScore','Muscle Score'],['BP','Blood Pressure'],['painScore','Pain Score'],['dentalScore','Dental Score']];
      const grid = document.createElement('div');
      grid.className = 'folder-vitals-grid';
      let any = false;
      for (const [key, label] of vitalDefs) {
        if (!v[key]) continue;
        any = true;
        const cell = document.createElement('div');
        cell.className = 'folder-vital';
        cell.innerHTML = `<div class="folder-vital-label">${label}</div><div class="folder-vital-val">${v[key]}</div>`;
        grid.appendChild(cell);
      }
      if (any) container.appendChild(grid);
      const allVisits = (_allVisitsCache || []).filter(vv => vv.cat === visit.cat && vv.vitals?.weight && vv.date).sort((a,b) => a.date.localeCompare(b.date));
      if (allVisits.length >= 2) {
        const parseWeight = (w) => { if (typeof w === 'number') return w; const m = String(w).match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };
        const weightPoints = allVisits.map(vv => ({ date: vv.date, val: parseWeight(vv.vitals.weight), isCurrent: vv.date === visit.date })).filter(p => p.val);
        if (weightPoints.length >= 2) {
          const hr = document.createElement('hr'); hr.className = 'folder-divider'; container.appendChild(hr);
          const lbl = document.createElement('div'); lbl.className = 'folder-section-label'; lbl.textContent = 'Weight Trend'; container.appendChild(lbl);
          const W = 560, H = 100, PAD = 28;
          const vals = weightPoints.map(p => p.val);
          const minV = Math.min(...vals), maxV = Math.max(...vals), range = maxV - minV || 1;
          const toX = (i) => PAD + (i / (weightPoints.length - 1)) * (W - PAD * 2);
          const toY = (v) => PAD + ((maxV - v) / range) * (H - PAD * 2);
          const pathD = weightPoints.map((p,i) => `${i===0?'M':'L'}${toX(i).toFixed(1)},${toY(p.val).toFixed(1)}`).join(' ');
          const areaD = pathD + ` L${toX(weightPoints.length-1).toFixed(1)},${H-4} L${PAD},${H-4} Z`;
          const svgNS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(svgNS, 'svg');
          svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
          svg.style.cssText = 'width:100%;height:auto;overflow:visible;';
          [0, 0.5, 1].forEach(t => {
            const y = PAD + t * (H - PAD * 2);
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', PAD); line.setAttribute('x2', W - PAD); line.setAttribute('y1', y); line.setAttribute('y2', y);
            line.setAttribute('stroke', 'rgba(140,110,70,0.15)'); line.setAttribute('stroke-width', '1'); svg.appendChild(line);
            const tv = document.createElementNS(svgNS, 'text');
            tv.setAttribute('x', PAD - 4); tv.setAttribute('y', y + 4); tv.setAttribute('text-anchor', 'end');
            tv.setAttribute('font-family', 'JetBrains Mono, monospace'); tv.setAttribute('font-size', '8'); tv.setAttribute('fill', 'rgba(100,80,50,0.6)');
            tv.textContent = (minV + (1-t)*range).toFixed(1); svg.appendChild(tv);
          });
          const area = document.createElementNS(svgNS, 'path'); area.setAttribute('d', areaD); area.setAttribute('fill', 'rgba(180,140,80,0.12)'); svg.appendChild(area);
          const path = document.createElementNS(svgNS, 'path'); path.setAttribute('d', pathD); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'rgba(140,90,40,0.7)'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); svg.appendChild(path);
          weightPoints.forEach((p, i) => {
            const cx = toX(i), cy = toY(p.val);
            const circle = document.createElementNS(svgNS, 'circle');
            circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', p.isCurrent ? '5' : '3');
            circle.setAttribute('fill', p.isCurrent ? 'rgba(120,70,30,0.9)' : 'rgba(140,100,50,0.6)'); circle.setAttribute('stroke', 'white'); circle.setAttribute('stroke-width', '1.5'); svg.appendChild(circle);
            if (i === 0 || i === weightPoints.length - 1 || p.isCurrent) {
              const dtxt = document.createElementNS(svgNS, 'text');
              const anchor = i === 0 ? 'start' : i === weightPoints.length - 1 ? 'end' : 'middle';
              dtxt.setAttribute('x', cx); dtxt.setAttribute('y', H - 4); dtxt.setAttribute('text-anchor', anchor);
              dtxt.setAttribute('font-family', 'JetBrains Mono, monospace'); dtxt.setAttribute('font-size', '7.5');
              dtxt.setAttribute('fill', p.isCurrent ? 'rgba(120,70,30,0.9)' : 'rgba(100,80,50,0.55)');
              dtxt.textContent = formatDateShort(p.date); svg.appendChild(dtxt);
            }
            if (p.isCurrent) {
              const vtxt = document.createElementNS(svgNS, 'text');
              vtxt.setAttribute('x', cx); vtxt.setAttribute('y', cy - 9); vtxt.setAttribute('text-anchor', 'middle');
              vtxt.setAttribute('font-family', 'JetBrains Mono, monospace'); vtxt.setAttribute('font-size', '9'); vtxt.setAttribute('font-weight', '700'); vtxt.setAttribute('fill', 'rgba(120,70,30,0.95)');
              vtxt.textContent = p.val + ' lbs'; svg.appendChild(vtxt);
            }
          });
          const wrap = document.createElement('div');
          wrap.style.cssText = 'background:rgba(255,255,255,0.35);border:1px solid rgba(180,155,110,0.25);border-radius:8px;padding:0.75rem;';
          wrap.appendChild(svg); container.appendChild(wrap);
        }
      }
    }
    else if (tabId === 'history') { para(sections['HISTORY']); }
    else if (tabId === 'exam') { para(sections['PHYSICAL EXAM']); }
    else if (tabId === 'assessment') {
      if (sections['ASSESSMENT']) { sectionLabel('Assessment'); para(sections['ASSESSMENT']); }
      if (sections['DIAGNOSTICS']) { sectionLabel('Diagnostics'); para(sections['DIAGNOSTICS']); }
      if (sections['DIAGNOSTIC RESULTS']) { sectionLabel('Diagnostic Results'); para(sections['DIAGNOSTIC RESULTS']); }
    }
    else if (tabId === 'plan') { para(sections['PLAN']); }
    else if (tabId === 'meds') {
      const meds = (visit.medications || []).filter(m => !m.supplement);
      const supps = (visit.medications || []).filter(m => m.supplement);
      if (meds.length) {
        sectionLabel('Medications');
        for (const m of meds) {
          const row = document.createElement('div'); row.className = 'folder-med-item';
          const detail = [m.dose, m.frequency, m.route].filter(Boolean).join(', ');
          const flags = [m.continuing ? 'continuing' : null, m.dispensed ? 'dispensed' : null].filter(Boolean).join(', ');
          row.innerHTML = `<span class="folder-med-name">${escHtml(m.name)}</span><span class="folder-med-detail">${escHtml(detail)}${flags ? ' · ' + flags : ''}</span>`;
          container.appendChild(row);
        }
      }
      if (supps.length) {
        sectionLabel('Supplements');
        for (const m of supps) {
          const row = document.createElement('div'); row.className = 'folder-med-item';
          const detail = [m.dose, m.frequency].filter(Boolean).join(', ');
          row.innerHTML = `<span class="folder-med-name">${escHtml(m.name)}</span><span class="folder-med-detail">${escHtml(detail)}</span>`;
          container.appendChild(row);
        }
      }
    }
    else if (tabId === 'diet') {
      if (sections['DIET']) para(sections['DIET']);
      if (visit.diet) para(visit.diet);
    }
    else if (tabId === 'labs') {
      for (const [group, labs] of Object.entries(labsByGroup)) {
        sectionLabel(group);
        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.65rem;margin-bottom:1rem;';
        for (const lab of labs.sort((a,b) => (a.test||'').localeCompare(b.test||''))) {
          const tr = document.createElement('tr');
          const abnColor = lab.abnormal === 'HIGH' || lab.abnormal === 'LOW' ? '#c04030' : 'inherit';
          tr.innerHTML = `<td style="padding:0.2rem 0.4rem 0.2rem 0;color:#5c4030;width:45%;">${escHtml(lab.test||'')}</td><td style="padding:0.2rem 0.4rem;font-weight:600;color:${abnColor};">${escHtml(String(lab.value ?? ''))}</td><td style="padding:0.2rem 0.4rem;color:#7a6a52;">${escHtml(lab.unit||'')}</td><td style="padding:0.2rem 0 0.2rem 0.4rem;color:#7a6a52;font-size:0.58rem;">${lab.refLow != null && lab.refHigh != null ? lab.refLow + ' – ' + lab.refHigh : (lab.abnormal || '')}</td>`;
          table.appendChild(tr);
        }
        container.appendChild(table);
      }
    }
  }

  const box = document.querySelector('.record-popup-box');
  box.style.cssText = '';
  box.innerHTML = '';

  const tabStrip = document.createElement('div');
  tabStrip.className = 'folder-tabs';
  box.appendChild(tabStrip);

  const header = document.createElement('div');
  header.className = 'folder-header';
  const titleBlock = document.createElement('div');
  titleBlock.style.cssText = 'flex:1;min-width:0;';
  titleBlock.innerHTML = `<div class="folder-title">${escHtml(visit.chiefComplaint || visit.synopsis?.slice(0,60) || 'Visit Record')}</div><div class="folder-meta">${escHtml(visit.cat)} · ${formatDate(visit.date)}${visit.doctor ? ' · ' + escHtml(visit.doctor) : ''}${visit.clinic ? ' · ' + escHtml(visit.clinic) : ''}</div>`;
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = 'background:rgba(180,155,110,0.2);border:1px solid rgba(180,155,110,0.4);border-radius:6px;width:26px;height:26px;cursor:pointer;color:#5c4030;font-size:0.75rem;flex-shrink:0;';
  closeBtn.onclick = () => $('record-popup').classList.remove('open');
  header.appendChild(titleBlock);
  header.appendChild(closeBtn);
  box.appendChild(header);

  const contentArea = document.createElement('div');
  contentArea.className = 'folder-content';
  box.appendChild(contentArea);

  const footer = document.createElement('div');
  footer.className = 'record-popup-footer';
  const linkEl = document.createElement('span');
  linkEl.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.58rem;color:#7a6a52;';
  if (visit.driveFileIds?.[0]) {
    linkEl.innerHTML = `<a href="https://drive.google.com/file/d/${visit.driveFileIds[0]}/view" target="_blank" style="color:var(--accent);text-decoration:none;">Open original in Drive ↗</a>`;
  } else {
    linkEl.textContent = visit.sourceFiles?.[0] || '';
  }
  const editBtn = document.createElement('button');
  editBtn.className = 'btn-icon';
  editBtn.style.cssText = 'font-size:0.6rem;padding:0.2rem 0.6rem;';
  editBtn.textContent = '✏ Edit';
  editBtn.onclick = () => openVisitEdit(visit);
  footer.appendChild(linkEl);
  footer.appendChild(editBtn);
  box.appendChild(footer);

  let activeTab = tabs[0]?.id;
  function switchTab(id) {
    activeTab = id;
    tabStrip.querySelectorAll('.folder-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
    renderTabContent(id, contentArea);
  }
  for (const tab of tabs) {
    const t = document.createElement('button');
    t.className = 'folder-tab' + (tab.id === activeTab ? ' active' : '');
    t.dataset.tab = tab.id;
    t.textContent = tab.label;
    t.onclick = () => switchTab(tab.id);
    tabStrip.appendChild(t);
  }
  if (activeTab) renderTabContent(activeTab, contentArea);
  $('record-popup').classList.add('open');
  } catch(e) {
    console.error('openVisit error:', e);
    import('./core.js').then(m => m.showAlert('Could not open visit: ' + e.message, 'warning'));
  }
}
