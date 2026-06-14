// ── CHAT MODULE ──
// Claude API calls, buildChatContext, sendMessage, save/pause session, conversation history.

import { getDocs, collection, doc, getDoc, setDoc, addDoc, deleteDoc, writeBatch }
  from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

import {
  APP_PETS, _petProfiles,
  convHistory, setConvHistory,
  pendingJournalItems, setPendingJournalItems,
  apiKey,
  currentUser,
  _chatFullContext,
  _chatContextCache, setChatContextCache,
  _chatContextDirty, setChatContextDirty,
  _allVisitsCache, setAllVisitsCache,
  _allLabsCache, setAllLabsCache,
  _notesCache,
  _journalCache, setJournalCache,
  _journalCacheTime, setJournalCacheTime,
  _journalDocsCache, setJournalDocsCache,
  mentionTracker, setMentionTracker,
  sessionActiveCat, setSessionActiveCat,
} from './state.js';

import {
  db, $, showToast, showAlert, sleep,
  escHtml, jCats,
  updateSessionCost, updateJournalBadge,
  startCacheTimer, appendTyping, invalidateChatContext,
} from './core.js';

import { addPendingItem, renderJournalSidebar, loadJournalSidebar } from './journal.js';
import { buildNotesContext, addNote, deleteNote, showNoteArchiveReview } from './notes.js';

// ── DATA CACHE ──
export async function ensureDataCache() {
  if (!_allVisitsCache) {
    const snap = await getDocs(collection(db, 'visits'));
    setAllVisitsCache(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }
  if (!_allLabsCache) {
    const snap = await getDocs(collection(db, 'labs'));
    setAllLabsCache(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }
}

export function searchVisits(query) {
  if (!_allVisitsCache) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  return _allVisitsCache.filter(v => {
    const text = `${v.synopsis||''} ${v.narrative||''} ${v.chiefComplaint||''}`.toLowerCase();
    return terms.every(t => text.includes(t));
  });
}

const JOURNAL_CACHE_TTL = 60000;

export async function buildChatContext(userMessage) {
  const targetCats = APP_PETS.length ? APP_PETS : [];
  if (!targetCats.length) return '';

  const isSearchQuery = /search|find|mention|history|all visit|every time|when did|has she ever|back in|years? ago|look(ing)? for/i.test(userMessage);
  const isFullHistoryRequest = /full history|load (all|everything)|all records|complete history/i.test(userMessage);
  const catsKey = targetCats.slice().sort().join(',');
  const needsRebuild = _chatContextDirty || isSearchQuery || isFullHistoryRequest ||
    !_chatContextCache || _chatContextCache.cats !== catsKey;

  if (!needsRebuild) return _chatContextCache.context;

  await ensureDataCache();

  const petIntro = targetCats.map(cat => {
    const profile = _petProfiles[cat] || {};
    let ageStr = '';
    if (profile.birthdate) {
      const birth = new Date(profile.birthdate + 'T12:00:00');
      const ageMs = Date.now() - birth;
      const years = Math.floor(ageMs / (365.25 * 24 * 3600 * 1000));
      const months = Math.floor((ageMs % (365.25 * 24 * 3600 * 1000)) / (30.44 * 24 * 3600 * 1000));
      ageStr = years >= 1 ? ` (${years}y ${months}m old)` : ` (${months}m old)`;
    }
    return `${cat}${ageStr}`;
  }).join(', ');
  let context = `## Pets: ${petIntro}\n`;

  context += buildNotesContext();

  try {
    const now = Date.now();
    if (!_journalCache || now - _journalCacheTime > JOURNAL_CACHE_TTL) {
      const snap = await getDocs(collection(db, 'journal'));
      setJournalCache(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setJournalCacheTime(now);
    }
    const jDocs = _journalCache.filter(j => {
      if (j.status === 'past') return false;
      return jCats(j).some(c => targetCats.includes(c));
    });
    if (jDocs.length) {
      const shared = jDocs.filter(j => targetCats.length > 1 && targetCats.every(c => jCats(j).includes(c)));
      const perCat = {};
      for (const j of jDocs) {
        if (shared.includes(j)) continue;
        for (const c of jCats(j)) {
          if (!targetCats.includes(c)) continue;
          if (!perCat[c]) perCat[c] = {};
          if (!perCat[c][j.list]) perCat[c][j.list] = [];
          const sTag = j.status === 'plan' ? '[PLANNED/NOT STARTED] '
            : j.status === 'maybe' ? '[UNCERTAIN/CONSIDERING] '
            : j.status === 'past' ? '[DISCONTINUED] '
            : j.status === 'rejected' ? '[REJECTED - DO NOT SUGGEST] ' : '';
          perCat[c][j.list].push(`${sTag}${j.text}${j.dose?' ('+j.dose+')':''}`);
        }
      }
      context += '\n\n## Care Journal\n# IMPORTANT: Items with no prefix = CURRENTLY ACTIVE (cat is on this now).\n# [PLANNED/NOT STARTED] = owner considering but NOT yet giving.\n# [UNCERTAIN/CONSIDERING] = discussed but undecided.\n# [DISCONTINUED] = was given, now stopped.\n# [REJECTED - DO NOT SUGGEST] = consciously decided against - never recommend these.\n# Never describe a PLANNED or UNCERTAIN item as something the cat currently takes.\n';
      if (shared.length) {
        const sharedByList = {};
        for (const j of shared) {
          if (!sharedByList[j.list]) sharedByList[j.list] = [];
          const sTag2 = j.status === 'plan' ? '[PLANNED/NOT STARTED] '
            : j.status === 'maybe' ? '[UNCERTAIN/CONSIDERING] '
            : j.status === 'past' ? '[DISCONTINUED] '
            : j.status === 'rejected' ? '[REJECTED - DO NOT SUGGEST] ' : '';
          sharedByList[j.list].push(`${sTag2}${j.text}${j.dose?' ('+j.dose+')':''}`);
        }
        context += `All cats / `;
        for (const [list, items] of Object.entries(sharedByList)) {
          context += `${list}: ${items.join(', ')}\n`;
        }
      }
      for (const [cat, lists] of Object.entries(perCat)) {
        for (const [list, items] of Object.entries(lists)) {
          context += `${cat} / ${list}: ${items.join(', ')}\n`;
        }
      }
    }
  } catch(e) { console.warn('Journal context failed:', e); }

  if (isFullHistoryRequest) {
    for (const cat of targetCats) {
      const visits = _allVisitsCache.filter(v => v.cat === cat).sort((a,b) => (b.date||'') > (a.date||'') ? 1 : -1);
      if (visits.length) {
        context += `\n\n## ${cat} — Full Visit History (${visits.length} visits)\n`;
        for (const v of visits) {
          context += `\n### ${v.date}${v.clinic ? ' · ' + v.clinic : ''}${v.doctor ? ' · ' + v.doctor : ''}\n`;
          if (v.chiefComplaint) context += `Chief complaint: ${v.chiefComplaint}\n`;
          if (v.synopsis) context += `${v.synopsis}\n`;
          if (v.narrative) context += `\n${v.narrative}\n`;
        }
      }
    }
  } else if (isSearchQuery) {
    const matches = searchVisits(userMessage).filter(v => targetCats.includes(v.cat));
    if (matches.length) {
      context += `\n\n## Search Results for "${userMessage.slice(0,50)}"\n`;
      for (const v of matches.slice(0, 8)) {
        context += `\n### ${v.cat} · ${v.date}${v.clinic ? ' · ' + v.clinic : ''}\n`;
        if (v.synopsis) context += `${v.synopsis}\n`;
        if (v.narrative) context += `\n${v.narrative}\n`;
      }
    } else {
      context += `\n\n(No visits matched the search query in records)\n`;
    }
  } else {
    for (const cat of targetCats) {
      const visits = _allVisitsCache
        .filter(v => v.cat === cat)
        .sort((a,b) => (b.date||'') > (a.date||'') ? 1 : -1);
      if (!visits.length) continue;
      context += `\n\n## ${cat} — Visits\n`;
      const recentVisits = _chatFullContext ? visits : visits.slice(0, 3);
      for (const v of recentVisits) {
        const location = v.source === 'home' ? '🏠 Home' : (v.clinic || '');
        context += `\n### ${v.date}${location ? ' · ' + location : ''}${v.doctor ? ' · ' + v.doctor : ''}${v.homeStatus ? ' [' + v.homeStatus + ']' : ''}\n`;
        if (v.chiefComplaint) context += `Chief complaint: ${v.chiefComplaint}\n`;
        if (v.synopsis) context += `${v.synopsis}\n`;
        if (v.medications?.length) {
          const meds = v.medications.map(m => `${m.name}${m.dose?' '+m.dose:''}`).join(', ');
          context += `Medications: ${meds}\n`;
        }
      }
      if (!_chatFullContext && visits.length > 3) {
        context += `\nOlder visits:\n`;
        for (const v of visits.slice(3, 23)) {
          const synopsis = v.synopsis ? v.synopsis.split('.')[0] : (v.chiefComplaint || 'visit');
          const location = v.source === 'home' ? '🏠 Home' : (v.clinic || '');
          context += `- ${v.date}${location ? ' · ' + location : ''}${v.homeStatus ? ' [' + v.homeStatus + ']' : ''}: ${synopsis}\n`;
        }
        if (visits.length > 23) context += `- (${visits.length - 23} older visits not shown — ask to search for specifics)\n`;
      }
    }
  }

  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const cutoff = sixMonthsAgo.toISOString().slice(0, 10);
    for (const cat of targetCats) {
      const allCatLabs = _allLabsCache
        .filter(l => l.cat === cat)
        .sort((a,b) => (b.resultDate||'') > (a.resultDate||'') ? 1 : -1);

      let labs;
      if (_chatFullContext) {
        labs = allCatLabs;
      } else {
        // Always include the most recent result per test (even if older than 6 mo),
        // plus everything within the 6-month window.
        const seenTest = new Set();
        const pinned = new Set();
        for (const l of allCatLabs) {
          const tk = (l.test || '').toLowerCase().trim();
          if (!seenTest.has(tk)) { seenTest.add(tk); pinned.add(l.id || l); }
        }
        labs = allCatLabs.filter(l =>
          pinned.has(l.id || l) || (l.resultDate || l.visitDate || '') >= cutoff
        );
      }
      if (!labs.length) continue;
      const byDate = {};
      for (const l of labs) {
        const dk = l.resultDate || 'unknown';
        const gk = l.labGroup || 'Other';
        if (!byDate[dk]) byDate[dk] = {};
        if (!byDate[dk][gk]) byDate[dk][gk] = [];
        byDate[dk][gk].push(`${l.test}: ${l.value}${l.unit?' '+l.unit:''}${l.abnormal?' ['+l.abnormal+']':''}`);
      }
      context += `\n\n## ${cat} — Labs\n`;
      for (const [date, groups] of Object.entries(byDate)) {
        context += `\n### ${date}\n`;
        for (const [group, rows] of Object.entries(groups)) {
          context += `${group}: ${rows.join(', ')}\n`;
        }
      }
    }
  } catch(e) { console.warn('Lab context failed:', e); }

  if (!isSearchQuery && !isFullHistoryRequest) {
    setChatContextCache({ cats: catsKey, context });
    setChatContextDirty(false);
  }
  return context;
}

// ── CLAUDE API ──
function _messageHasJournalIntent(userMessage) {
  return /\b(start|started|starting|stopped|stopping|added|adding|switched|switching|prescribed|tried|trying|gave|giving|taking|on |diagnosed|diagnosed with|new med|new food|new diet|new supplement|vomit|diarrhea|seizure|limp|not eating|lethargy|lethargic|weight|dose|mg|every|daily|weekly|morning|evening|twice)\b/i.test(userMessage);
}

export async function callClaude(history, context, userMessage) {
  const journalInstruction = `

JOURNAL HINTS: If this conversation mentions anything new or changed that should be tracked in the care journal (medications, diet, supplements, symptoms, status changes), append a <journal> block at the very end of your response — after all your normal text. Only include it when there is genuinely something new to track. Never include it for purely informational questions with no actionable updates.
<journal>
[{"cats":["Luna"],"list":"Medications","text":"Mirtazapine 1.875mg","dose":"every 3 days","status":"current"},{"cats":["Bella","Luna","Felix"],"list":"Supplements","text":"Psyllium husk","dose":"2.5g","status":"current"}]
</journal>
The block must be a valid JSON array. Use cats array — include multiple cats when an item applies to all. Lists: Medications, Supplements, Diet, Foods, or custom. Status: current/past/plan/maybe. Keep text under 60 chars. Do not show the journal block to the user — it is parsed silently.`;

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZoneName:'short' });
  const staticInstruction = `You are a veterinary care assistant for ${APP_PETS.length ? APP_PETS.join(', ') : 'the pets in this account'}.
Today is ${todayStr} at ${timeStr}. Use this when answering questions about timing, schedules, or how long ago something occurred.
You have access to their complete medical records, lab results, and care journal below. The records are loaded — you do not need to be told what they contain, you already have them.
Be precise — cite specific cats, dates, values, and sources. Note abnormal lab values clearly.
If asked about supplements or nutrition, discuss thoroughly with context from their specific conditions and records.
On your FIRST response in a session, briefly demonstrate awareness of each pet's current situation — their active conditions, recent visits, and anything flagged. Do not wait to be asked. Be concise but show you have reviewed the records.

CARE JOURNAL STATUS — this is critical for accuracy:
Items with NO status tag are CURRENTLY ACTIVE — the cat is taking/eating/doing this right now.
Items tagged [PLAN] are PLANNED or UNDER CONSIDERATION — not yet started, owner is thinking about it.
Items tagged [MAYBE] are UNCERTAIN or POTENTIAL — discussed but not decided.
Items tagged [PAST] are DISCONTINUED or RESOLVED — no longer active.
Items tagged [REJECTED - DO NOT SUGGEST] were consciously decided against — never suggest these again.
Never describe a [PLAN] or [MAYBE] item as something the cat is currently on. Never omit the distinction when it matters clinically.`;

  const contextBlock = context || '(No records loaded yet — records will appear after files are processed)';
  const systemBlocks = [
    { type: 'text', text: staticInstruction },
    { type: 'text', text: contextBlock + journalInstruction, cache_control: { type: 'ephemeral' } }
  ];

  const model = window._useSonnet ? 'claude-sonnet-4-20250514' : 'claude-haiku-4-5-20251001';
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model, max_tokens: 1024, system: systemBlocks, messages: history })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.usage) {
        updateSessionCost(data.usage.input_tokens||0, data.usage.output_tokens||0, data.usage.cache_read_input_tokens||0, data.usage.cache_creation_input_tokens||0);
        if (data.usage.cache_read_input_tokens) console.log(`Cache hit: ${data.usage.cache_read_input_tokens} tokens read`);
      }
      startCacheTimer();
      return data.content.map(b => b.text || '').join('').trim();
    }
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
      await sleep(15 * Math.pow(2, attempt) * 1000);
      continue;
    }
    throw new Error(msg);
  }
}

export async function callClaudeRaw(messages, systemPrompt, maxTokens) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system: systemPrompt, messages })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.usage) updateSessionCost(data.usage.input_tokens||0, data.usage.output_tokens||0);
      return { text: data.content.map(b => b.text||'').join('').trim(), stopReason: data.stop_reason };
    }
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
      showToast(`Rate limited — retrying in ${15 * Math.pow(2, attempt)}s…`, 'warning');
      await sleep(15 * Math.pow(2, attempt) * 1000);
      continue;
    }
    throw new Error(msg);
  }
}

// Retry bar shown under the chat when a message fails to send.
// `hint` is a short instruction line (e.g. "wait 60s" vs "top up credits").
function _showRetryBar(text, hint) {
  const retryBar = document.createElement('div');
  retryBar.style.cssText = 'display:flex;gap:0.5rem;padding:0.5rem 1.25rem;background:var(--surface);border-top:1px solid var(--border);flex-shrink:0;align-items:center;flex-wrap:wrap;';
  const preview = text.length > 50 ? text.slice(0, 50) + '…' : text;
  retryBar.innerHTML =
    `<span style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:var(--ink-muted);flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(preview)}</span>` +
    (hint ? `<span style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--amber);flex-basis:100%;">${escHtml(hint)}</span>` : '');
  const continueBtn = document.createElement('button');
  continueBtn.className = 'btn-icon free-icon';
  continueBtn.innerHTML = '<span class="free-dot"></span> Retry';
  continueBtn.addEventListener('click', () => {
    retryBar.remove();
    $('user-input').value = text;
    $('user-input').dispatchEvent(new Event('input'));
    $('user-input').focus();
  });
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn-icon';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => retryBar.remove());
  retryBar.appendChild(continueBtn);
  retryBar.appendChild(dismissBtn);
  $('chat-body').after(retryBar);
}

// ── SEND MESSAGE ──
export function appendMsg(role, text) {
  const chatBody = $('chat-body');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  div.innerHTML = `<div class="msg-avatar">${role === 'user' ? 'you' : 'pr'}</div>`;
  div.appendChild(bubble);
  chatBody.appendChild(div);
  chatBody.scrollTop = chatBody.scrollHeight;
  return div;
}

export async function sendMessage() {
  const text = $('user-input').value.trim();
  if (!text || !apiKey) return;
  $('user-input').value = '';
  $('user-input').style.height = 'auto';
  $('chat-welcome').style.display = 'none';
  appendMsg('user', text);
  convHistory.push({ role: 'user', content: text });
  $('send-btn').disabled = true;
  const typingEl = appendTyping();
  try {
    const context = await buildChatContext(text);
    const trimmedHistory = convHistory.length > 10 ? convHistory.slice(-10) : convHistory;
    let response = await callClaude(trimmedHistory, context, text);
    typingEl.remove();

    const journalMatch = response.match(/<journal>\s*([\s\S]*?)\s*<\/journal>/);
    if (journalMatch) {
      response = response.replace(/<journal>[\s\S]*?<\/journal>/g, '').trim();
      try {
        const hints = JSON.parse(journalMatch[1]);
        if (Array.isArray(hints)) {
          const today = new Date().toISOString().split('T')[0];
          hints.forEach(h => {
            const hCats = Array.isArray(h.cats) ? h.cats : (h.cat ? [h.cat] : []);
            if (hCats.length && h.text) addPendingItem({ cats: hCats, list: h.list || 'General', text: h.text, dose: h.dose || null, status: h.status || 'current', startDate: today, _source: 'chat' });
          });
        }
      } catch(e) { console.warn('Journal block parse error:', e, journalMatch[1]?.slice(0,200)); }
    }

    appendMsg('assistant', response);
    convHistory.push({ role: 'assistant', content: response });
    if (convHistory.length >= 2) {
      $('save-session-btn').style.display = 'inline-flex';
      $('pause-session-btn').style.display = 'inline-flex';
    }
  } catch (err) {
    typingEl.remove();
    const msg = err.message || '';
    const lower = msg.toLowerCase();

    // Classify the failure so we don't tell the user to "wait" on a problem
    // that waiting can't fix (out of credits, bad key, spend cap).
    const isCredit = lower.includes('credit balance') || lower.includes('billing') || lower.includes('purchase credits');
    const isSpendCap = lower.includes('spend') && lower.includes('limit');
    const isAuth = lower.includes('invalid x-api-key') || lower.includes('authentication') || msg.includes('401');
    const isRate = !isCredit && !isSpendCap && (lower.includes('rate limit') || msg.includes('429') || msg.includes('529') || lower.includes('overloaded'));

    if (isCredit || isSpendCap || isAuth) {
      // Account-level block — the message was not sent and retrying won't help.
      convHistory.pop();
      let banner, hint;
      if (isCredit) {
        banner = '⚠ Out of API credits — your message was not sent.';
        hint = 'Top up at console.anthropic.com → Billing, then Retry.';
      } else if (isSpendCap) {
        banner = '⚠ Monthly spend limit reached — your message was not sent.';
        hint = 'Raise the limit at console.anthropic.com → Limits, then Retry.';
      } else {
        banner = '⚠ API key rejected — your message was not sent.';
        hint = 'Check your key in the status bar (click "API key"), then Retry.';
      }
      appendMsg('assistant', banner);
      _showRetryBar(text, hint);
    } else if (isRate) {
      convHistory.pop();
      appendMsg('assistant', '⏸ Rate limit reached — your message was not sent.');
      _showRetryBar(text, 'Per-minute limit — wait ~60s, then Retry.');
    } else {
      appendMsg('assistant', `Sorry, I hit an error: ${msg}`);
    }
  }
  $('send-btn').disabled = !apiKey;
}

// ── PAUSE / RESTORE SESSION ──
export async function checkPausedSession() {
  try {
    const snap = await getDoc(doc(db, 'app_config', 'paused_session'));
    if (!snap.exists()) return;
    const data = snap.data();
    if (!data.convHistory || data.userId !== currentUser?.uid) return;
    const pausedAt = new Date(data.pausedAt);
    const ageHours = (Date.now() - pausedAt) / 3600000;
    if (ageHours > 24) { await deleteDoc(doc(db, 'app_config', 'paused_session')); return; }
    const mins = Math.round((Date.now() - pausedAt) / 60000);
    const timeStr = mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;
    const msgCount = JSON.parse(data.convHistory).length;
    const restore = confirm(`Paused session found (${timeStr}, ${msgCount} messages). Restore it?`);
    if (!restore) { await deleteDoc(doc(db, 'app_config', 'paused_session')); return; }
    setConvHistory(JSON.parse(data.convHistory));
    setPendingJournalItems(JSON.parse(data.pendingItems || '[]'));
    $('chat-welcome')?.remove();
    for (const msg of convHistory) appendMsg(msg.role, msg.content);
    if (pendingJournalItems.length) { updateJournalBadge(); renderJournalSidebar(_journalDocsCache || []); }
    if (convHistory.length >= 2) {
      $('save-session-btn').style.display = 'inline-flex';
      $('pause-session-btn').style.display = 'inline-flex';
    }
    await deleteDoc(doc(db, 'app_config', 'paused_session'));
    showToast(`Session restored — ${msgCount} messages`, 'journal');
  } catch(e) { console.warn('Pause restore failed:', e); }
}

// ── SAVE SESSION ──
function buildSaveSessionPrompt(journalContext, pendingContext, notesContext, conversationText, today) {
  return `You are reviewing a veterinary care session to extract ONLY genuinely new journal entries for cats: ${APP_PETS.join(', ')}.
Be conservative — it is better to miss a marginal item than to add noise.

EXISTING JOURNAL (DO NOT RE-ADD ANY OF THESE):
${journalContext}

ALREADY PENDING (already queued — do NOT re-add these either):
${pendingContext}

CURRENT CONTEXT NOTES:
${notesContext}

CONVERSATION:
${conversationText}

Rules:
- Only extract items that are NEW — not already in the existing journal or pending list above
- Only extract items with a CLEAR OUTCOME: decided to start → status 'plan' or 'current'; decided to stop → status 'past'
- DO NOT add items that were discussed but rejected, ruled out, or left completely undecided
- DO NOT add items that were mentioned only as context or background — they must be actionable decisions
- If something was considered AND rejected in the same conversation, add it with status 'rejected'
- Status 'maybe' is only for items the owner explicitly said they are still thinking about
- Status 'rejected' = consciously decided not to use — include the reason in the text if given
- If an item applies to multiple cats with the same dose, use cats array with all of them
- If doses differ per cat, create separate entries per cat
- Include dose and frequency whenever mentioned
- Track which cats each item belongs to — resolve all pronouns using context
- Never suggest removing pinned notes
- When in doubt, OMIT — the owner can add items manually

Return ONLY valid JSON — no markdown fences, no preamble:
{
  "journalUpdates": [
    {
      "cats": ["Bella", "Luna"],
      "list": "Medications|Supplements|Diet|Foods|<custom>",
      "text": "terse factual entry",
      "dose": "dose/frequency or null",
      "status": "current|past|plan|maybe|rejected",
      "startDate": "${today}",
      "endDate": "YYYY-MM-DD or null",
      "updateOf": "exact text of existing entry this replaces, or null"
    }
  ],
  "noteSuggestions": [
    {
      "action": "add|remove",
      "text": "terse fragment",
      "cats": ["Bella"],
      "pinned": false,
      "removeText": "exact text to remove if action=remove"
    }
  ],
  "highlights": ["key clinical decision or conclusion"],
  "incomplete": false
}

IMPORTANT: If you reach the end of the conversation and believe you may have missed items due to length, set "incomplete": true.`;
}

export function showConfirmDialog(title, message, confirmLabel, cancelLabel) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(42,37,32,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:white;border-radius:12px;padding:1.5rem;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(42,37,32,0.2);font-family:JetBrains Mono,monospace;';
    box.innerHTML = `
      <div style="font-size:0.85rem;font-weight:600;color:var(--ink);margin-bottom:0.6rem;">${escHtml(title)}</div>
      <div style="font-size:0.72rem;color:var(--ink-dim);white-space:pre-wrap;margin-bottom:1.2rem;line-height:1.5;">${escHtml(message)}</div>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
        <button id="_cdCancel" style="padding:0.4rem 0.9rem;border:1px solid var(--border);border-radius:7px;background:var(--surface);font-family:inherit;font-size:0.7rem;cursor:pointer;color:var(--ink-dim);">${escHtml(cancelLabel||'Cancel')}</button>
        <button id="_cdConfirm" style="padding:0.4rem 0.9rem;border:none;border-radius:7px;background:var(--accent);font-family:inherit;font-size:0.7rem;cursor:pointer;color:white;font-weight:600;">${escHtml(confirmLabel||'OK')}</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('#_cdConfirm').onclick = () => { overlay.remove(); resolve(true); };
    box.querySelector('#_cdCancel').onclick = () => { overlay.remove(); resolve(false); };
  });
}

export function showJournalReview(items) {
  return new Promise((resolve) => {
    const modal = $('journal-review-modal');
    const body = $('journal-review-body');
    const countEl = $('journal-review-count');
    body.innerHTML = '';
    const working = items.map(item => ({ ...item, _dismissed: false }));
    const updateCount = () => {
      const n = working.filter(i => !i._dismissed).length;
      countEl.textContent = `${n} of ${working.length} entries`;
      $('journal-review-commit').disabled = n === 0;
      $('journal-review-commit').innerHTML = `<span class="free-dot"></span> Commit ${n} checked`;
    };
    const STATUS_OPTS = [['current','current'],['past','past'],['plan','planned'],['maybe','potential'],['rejected','rejected']];
    working.forEach((item, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:0.5rem;padding:0.5rem 1.25rem;border-bottom:1px solid var(--surface2);transition:opacity 0.15s;';
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      const topLine = document.createElement('div');
      topLine.style.cssText = 'display:flex;align-items:center;gap:0.35rem;margin-bottom:0.2rem;flex-wrap:wrap;';
      const catSpan = document.createElement('span');
      catSpan.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.58rem;color:var(--accent);font-weight:700;';
      const itemCatsArr = Array.isArray(item.cats) ? item.cats : (item.cat ? [item.cat] : []);
      catSpan.textContent = itemCatsArr.join(', ') || '?';
      topLine.appendChild(catSpan);
      const listSpan = document.createElement('span');
      listSpan.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.58rem;color:var(--ink-muted);';
      listSpan.textContent = '→ ' + (item.list || 'General');
      topLine.appendChild(listSpan);
      const statusSel = document.createElement('select');
      statusSel.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.55rem;border:1px solid var(--border);border-radius:3px;padding:1px 4px;background:var(--surface);color:var(--ink);outline:none;cursor:pointer;';
      STATUS_OPTS.forEach(([val, lbl]) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = lbl;
        if ((item.status || 'current') === val) o.selected = true;
        statusSel.appendChild(o);
      });
      statusSel.addEventListener('change', () => { working[idx].status = statusSel.value; });
      topLine.appendChild(statusSel);
      info.appendChild(topLine);
      const textEl = document.createElement('div');
      textEl.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.68rem;color:var(--ink);line-height:1.5;word-break:break-word;';
      textEl.textContent = item.text;
      info.appendChild(textEl);
      if (item.dose) {
        const doseEl = document.createElement('div');
        doseEl.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.58rem;color:var(--accent2);margin-top:0.1rem;';
        doseEl.textContent = item.dose;
        info.appendChild(doseEl);
      }
      if (item.startDate) {
        const dateEl = document.createElement('div');
        dateEl.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.55rem;color:var(--ink-muted);margin-top:0.1rem;';
        dateEl.textContent = item.startDate + (item.endDate ? ' → ' + item.endDate : '');
        info.appendChild(dateEl);
      }
      const dismissBtn = document.createElement('button');
      dismissBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:0.7rem;color:var(--ink-muted);padding:0.1rem 0.2rem;flex-shrink:0;line-height:1;';
      dismissBtn.textContent = '✕';
      dismissBtn.title = 'Dismiss this entry';
      dismissBtn.addEventListener('click', () => { working[idx]._dismissed = true; row.style.opacity = '0.3'; row.style.pointerEvents = 'none'; updateCount(); });
      row.appendChild(info);
      row.appendChild(dismissBtn);
      body.appendChild(row);
    });
    updateCount();
    modal.style.display = 'flex';
    const cancel = () => { modal.style.display = 'none'; resolve(null); };
    const commit = () => { modal.style.display = 'none'; resolve(working.filter(i => !i._dismissed)); };
    $('journal-review-cancel').onclick = cancel;
    $('journal-review-commit').onclick = commit;
    modal.onclick = (e) => { if (e.target === modal) cancel(); };
  });
}

export async function runSaveSession(resumeData) {
  const today = new Date().toISOString().split('T')[0];
  const jSnap = await getDocs(collection(db, 'journal'));
  const existingJournal = [];
  jSnap.forEach(d => existingJournal.push({ id: d.id, ...d.data() }));
  const journalContext = existingJournal.length
    ? existingJournal.map(j => `${jCats(j).join(', ')||'?'} / ${j.list} [${j.status}]: ${j.text}${j.dose?' ('+j.dose+')':''}`)
        .join('\n')
    : '(empty)';
  const pendingContext = pendingJournalItems.length
    ? pendingJournalItems.map(p => `${jCats(p).join(', ')||'?'} / ${p.list} [${p.status}]: ${p.text}`).join('\n')
    : '(none)';
  const notesContext = _notesCache.length
    ? _notesCache.map(n => `${n.pinned?'[PINNED] ':''}${n.cats?.length?'['+n.cats.join('/')+'] ':''}${n.text}`).join('\n')
    : '(empty)';

  const CHUNK_SIZE = 6000;
  const fullConv = convHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  const chunks = [];
  if (fullConv.length <= CHUNK_SIZE) {
    chunks.push(fullConv);
  } else {
    let pos = 0;
    while (pos < fullConv.length) {
      let end = pos + CHUNK_SIZE;
      if (end < fullConv.length) {
        const boundary = fullConv.lastIndexOf('\nUSER:', end);
        const boundary2 = fullConv.lastIndexOf('\nASSISTANT:', end);
        const breakAt = Math.max(boundary, boundary2);
        if (breakAt > pos) end = breakAt;
      }
      chunks.push(fullConv.slice(pos, end));
      pos = end;
    }
  }

  let allUpdates = resumeData?.updates || [];
  let allHighlights = resumeData?.highlights || [];
  let allNoteSuggestions = resumeData?.notes || [];
  const startChunk = resumeData?.nextChunk || 0;

  for (let i = startChunk; i < chunks.length; i++) {
    const chunkLabel = chunks.length > 1 ? ` (part ${i+1}/${chunks.length})` : '';
    $('save-session-btn').innerHTML = `<span class="free-dot"></span> Saving${chunkLabel}…`;
    const priorContext = allUpdates.length
      ? `\nALREADY EXTRACTED FROM PRIOR CHUNKS:\n${allUpdates.map(u => `${(Array.isArray(u.cats)?u.cats:[u.cat||'?']).join(', ')} / ${u.list}: ${u.text}`).join('\n')}\n`
      : '';
    const convText = priorContext + (chunks.length > 1 ? `[Conversation part ${i+1} of ${chunks.length}]\n` : '') + chunks[i];
    const prompt = buildSaveSessionPrompt(journalContext, pendingContext, notesContext, convText, today);
    let result;
    try {
      result = await callClaudeRaw([{ role: 'user', content: prompt }], '', 6000);
    } catch(err) {
      const resume = await showConfirmDialog(`Save paused on part ${i+1}/${chunks.length}`, `${err.message}\n\nItems extracted so far: ${allUpdates.length}. Resume from here?`, 'Resume', 'Cancel');
      if (resume) { await sleep(30000); i--; continue; }
      else throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(result.text.replace(/```json|```/g, '').trim());
    } catch(parseErr) {
      console.error('JSON parse error on chunk', i, result.text.slice(0, 200));
      const skip = await showConfirmDialog(`Parse error on part ${i+1}/${chunks.length}`, `Could not read Claude's response for this chunk. Skip and continue, or abort?`, 'Skip chunk', 'Abort');
      if (skip) continue;
      else throw new Error('Aborted at parse error');
    }
    allUpdates = allUpdates.concat(parsed.journalUpdates || []);
    allHighlights = allHighlights.concat(parsed.highlights || []);
    allNoteSuggestions = allNoteSuggestions.concat(parsed.noteSuggestions || []);
    if (parsed.incomplete || result.stopReason === 'max_tokens') {
      const cont = await showConfirmDialog('Response may be incomplete', `Claude indicated it may have missed items in part ${i+1}/${chunks.length} (${allUpdates.length} items extracted so far). Continue to next part?`, 'Continue', 'Stop here');
      if (!cont) break;
    }
  }

  const seen = new Set();
  const deduped = allUpdates.filter(u => {
    const cats = Array.isArray(u.cats) ? u.cats : (u.cat ? [u.cat] : []);
    const key = cats.sort().join(',') + '||' + (u.text||'').toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).filter(u => (u.cats?.length || u.cat) && u.text);

  if (!deduped.length && !allNoteSuggestions.length) {
    showToast('Nothing new to save', 'journal');
    setPendingJournalItems([]);
    updateJournalBadge();
    return;
  }

  const confirmed = await showJournalReview(deduped);
  if (!confirmed) return;

  const fsBatch = writeBatch(db);
  for (const item of confirmed) {
    const itemCatsArr = Array.isArray(item.cats) ? item.cats : (item.cat ? [item.cat] : []);
    if (!itemCatsArr.length || !item.text) continue;
    if (item.updateOf) {
      const existing = existingJournal.find(j => {
        const jc = jCats(j);
        return itemCatsArr.some(c => jc.includes(c)) && j.text === item.updateOf;
      });
      if (existing) {
        fsBatch.update(doc(db, 'journal', existing.id), { status: item.status || existing.status, endDate: item.endDate || existing.endDate, dose: item.dose || existing.dose, updatedDate: today, updates: [...(existing.updates||[]), { date: today, note: item.text }] });
        continue;
      }
    }
    const alreadyExists = existingJournal.some(j => {
      const jc = jCats(j);
      return (j.text||'').toLowerCase().trim() === (item.text||'').toLowerCase().trim()
        && itemCatsArr.some(c => jc.includes(c))
        && j.status !== 'past';
    });
    if (alreadyExists) continue;
    fsBatch.set(doc(collection(db, 'journal')), { cats: itemCatsArr, list: item.list || 'General', text: item.text, dose: item.dose || null, status: item.status || 'current', startDate: item.startDate || today, endDate: item.endDate || null, addedDate: today, updatedDate: today, updates: [] });
  }
  await fsBatch.commit();
  setJournalDocsCache(null); invalidateChatContext();

  let noteAdds = 0, noteRemovals = 0;
  for (const sug of allNoteSuggestions) {
    if (!sug.text && sug.action !== 'remove') continue;
    if (sug.action === 'add') { await addNote(sug.text, sug.cats||[], sug.pinned||false); noteAdds++; }
    else if (sug.action === 'remove' && sug.removeText) {
      const match = _notesCache.find(n => !n.pinned && n.text === sug.removeText);
      if (match) { await deleteNote(match); noteRemovals++; }
    }
  }

  await setDoc(doc(collection(db, 'sessions')), { date: new Date().toISOString(), userId: currentUser?.uid, highlights: allHighlights, journalChanges: deduped.length, noteChanges: noteAdds + noteRemovals, messageCount: convHistory.length });

  setPendingJournalItems([]);
  setConvHistory([]);
  $('pause-session-btn').style.display = 'none';

  const activeNotes = (_notesCache || []).filter(n => !n.pinned);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
  const oldNotes = activeNotes.filter(n => n.addedDate && new Date(n.addedDate) < cutoff);
  if (oldNotes.length >= 3) showNoteArchiveReview(oldNotes);

  setMentionTracker({});
  setSessionActiveCat(null);
  updateJournalBadge();
  await loadJournalSidebar();

  const noteMsg = (noteAdds||noteRemovals) ? `, ${noteAdds+noteRemovals} note update${(noteAdds+noteRemovals)!==1?'s':''}` : '';
  showToast(`Session saved — ${deduped.length} journal update${deduped.length!==1?'s':''}${noteMsg} ✓`, 'journal');
}

// ── INIT (called from main.js after DOM is ready) ──
export function initChat() {
  $('user-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('send-btn').addEventListener('click', sendMessage);

  $('save-session-btn').addEventListener('click', async () => {
    if (!convHistory.length && !pendingJournalItems.length) return;
    $('save-session-btn').disabled = true;
    $('save-session-btn').innerHTML = '<span class="free-dot"></span> Saving…';
    try {
      await runSaveSession();
    } catch(err) {
      console.error('Save session error:', err);
      showAlert('Save session failed: ' + err.message, 'warning');
    }
    $('save-session-btn').disabled = false;
    $('save-session-btn').innerHTML = '<span class="free-dot"></span> Save Session';
  });

  $('pause-session-btn').addEventListener('click', async () => {
    if (!convHistory.length) return;
    const btn = $('pause-session-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="free-dot"></span> Pausing…';
    try {
      await setDoc(doc(db, 'app_config', 'paused_session'), { convHistory: JSON.stringify(convHistory), pendingItems: JSON.stringify(pendingJournalItems), pausedAt: new Date().toISOString(), userId: currentUser?.uid });
      btn.innerHTML = '<span class="free-dot"></span> ✓ Paused';
      showToast('Session paused — open the new version and click Restore Session', 'journal');
      setTimeout(() => { btn.disabled = false; btn.innerHTML = '<span class="free-dot"></span> ⏸ Pause'; }, 3000);
    } catch(e) {
      btn.disabled = false;
      btn.innerHTML = '<span class="free-dot"></span> ⏸ Pause';
      showToast('Pause failed: ' + e.message, 'warning');
    }
  });

  // Scroll nav buttons
  const cb = $('chat-body');
  const topBtn = $('scroll-top-btn');
  const botBtn = $('scroll-bot-btn');
  const updateScrollBtns = () => {
    const fromTop = cb.scrollTop;
    const fromBot = cb.scrollHeight - cb.scrollTop - cb.clientHeight;
    topBtn.style.display = fromTop > 200 ? 'flex' : 'none';
    botBtn.style.display = fromBot > 200 ? 'flex' : 'none';
  };
  cb.addEventListener('scroll', updateScrollBtns, { passive: true });
  topBtn.addEventListener('click', () => cb.scrollTo({ top: 0, behavior: 'smooth' }));
  botBtn.addEventListener('click', () => cb.scrollTo({ top: cb.scrollHeight, behavior: 'smooth' }));

  // Model toggle
  window._useSonnet = false;
  $('model-toggle-btn').addEventListener('click', () => {
    window._useSonnet = !window._useSonnet;
    const btn = $('model-toggle-btn');
    btn.textContent = window._useSonnet ? 'S' : 'H';
    btn.style.color = window._useSonnet ? 'var(--accent)' : 'var(--ink-muted)';
    btn.style.borderColor = window._useSonnet ? 'var(--accent)' : 'var(--border)';
    btn.title = window._useSonnet ? 'Sonnet: deeper reasoning (more $)\nClick for Haiku' : 'Haiku: fast & cheap\nClick for Sonnet: deeper reasoning';
  });

  $('user-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  document.querySelectorAll('.chat-hint').forEach(h => {
    h.addEventListener('click', () => { $('user-input').value = h.dataset.prompt; sendMessage(); });
  });

  window.addEventListener('beforeunload', e => {
    if (pendingJournalItems.length > 0) {
      e.preventDefault();
      e.returnValue = `You have ${pendingJournalItems.length} unsaved journal item${pendingJournalItems.length !== 1 ? 's' : ''}. Click "Save Session" before closing to keep them.`;
    }
  });
}
