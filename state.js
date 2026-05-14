// ── STATE ──
// All mutable globals shared across modules.
// Use exported setter functions to reassign primitives from outside this module.
// Arrays/objects exported as const can be mutated in-place (push, splice, etc.).

export let currentUser = null;
export function setCurrentUser(v) { currentUser = v; }

export let apiKey = (() => { try { return localStorage.getItem('pr_apikey') || ''; } catch(e) { return ''; } })();
export function setApiKey(v) { apiKey = v; }

export let driveAccessToken = (() => { try { return sessionStorage.getItem('pr_drive_token') || null; } catch(e) { return null; } })();
export function setDriveAccessToken(v) { driveAccessToken = v; }

export let sessionCost = 0;
export function setSessionCost(v) { sessionCost = v; }

export let convHistory = [];
export function setConvHistory(v) { convHistory = v; }

export let _chatFocusCats = null; // null = all cats; Set = focused subset
export function setChatFocusCats(v) { _chatFocusCats = v; }

export let _chatFullContext = false; // false = recent (6mo); true = full history
export function setChatFullContext(v) { _chatFullContext = v; }

export let pendingJournalItems = [];
export function setPendingJournalItems(v) { pendingJournalItems = v; }

export const APP_PETS = []; // populated from visits collection on load — never hardcoded

// Chat context cache
export let _chatContextCache = null;  // { cats: string, context: string }
export function setChatContextCache(v) { _chatContextCache = v; }

export let _chatContextDirty = true;  // true = must rebuild on next message
export function setChatContextDirty(v) { _chatContextDirty = v; }

export let _addPendingDebounce = null;
export function setAddPendingDebounce(v) { _addPendingDebounce = v; }

// Popup state
export let popupRawText = '';
export let popupMatches = [];
export let popupMatchIdx = 0;
export function setPopupRawText(v) { popupRawText = v; }
export function setPopupMatches(v) { popupMatches = v; }
export function setPopupMatchIdx(v) { popupMatchIdx = v; }

// Pet profiles
export let _petProfiles = {}; // { catName: { birthdate: 'YYYY-MM-DD' } }
export function setPetProfiles(v) { _petProfiles = v; }

// Records sidebar
export let _recordsSidebarDebounce = null;
export function setRecordsSidebarDebounce(v) { _recordsSidebarDebounce = v; }

export let _recordsSidebarLoading = false;
export function setRecordsSidebarLoading(v) { _recordsSidebarLoading = v; }

export let _recordsSidebarDirty = true;
export function setRecordsSidebarDirty(v) { _recordsSidebarDirty = v; }

// Labs
export let labDataCache = {};
export let _allLabsCache = null;
export function setAllLabsCache(v) { _allLabsCache = v; }

export let flowsheetCat = null;
export function setFlowsheetCat(v) { flowsheetCat = v; }

export let _labsSidebarDirty = true;
export function setLabsSidebarDirty(v) { _labsSidebarDirty = v; }

export let _labsSidebarDebounce = null;
export function setLabsSidebarDebounce(v) { _labsSidebarDebounce = v; }

export let _flowsheetSearchMatches = [];
export let _flowsheetSearchIdx = 0;
export function setFlowsheetSearchMatches(v) { _flowsheetSearchMatches = v; }
export function setFlowsheetSearchIdx(v) { _flowsheetSearchIdx = v; }

export let _flowsheetFilterMode = false;
export function setFlowsheetFilterMode(v) { _flowsheetFilterMode = v; }

// Journal
export let _journalDocsCache = null;
export function setJournalDocsCache(v) { _journalDocsCache = v; }

export let _journalSidebarDebounce = null;
export function setJournalSidebarDebounce(v) { _journalSidebarDebounce = v; }

export let _journalActiveCat = 'all';
export function setJournalActiveCat(v) { _journalActiveCat = v; }

// Notes
export let _notesCache = [];
export function setNotesCache(v) { _notesCache = v; }

export let _notesPinState = false;
export function setNotesPinState(v) { _notesPinState = v; }

export const _notesCatSelection = new Set();

// Session / chat
export let mentionTracker = {};
export function setMentionTracker(v) { mentionTracker = v; }

export let sessionActiveCat = null;
export function setSessionActiveCat(v) { sessionActiveCat = v; }

// Files
export let _fileStatusCache = null;
export function setFileStatusCache(v) { _fileStatusCache = v; }

export let _activeFileFilter = 'all';
export function setActiveFileFilter(v) { _activeFileFilter = v; }

export let _fileSort = 'name';
export function setFileSort(v) { _fileSort = v; }

export let _fileSortDir = 1;
export function setFileSortDir(v) { _fileSortDir = v; }

export let processingQueue = [];
export function setProcessingQueue(v) { processingQueue = v; }

export let processingActive = false;
export function setProcessingActive(v) { processingActive = v; }

export let processingStop = false;
export function setProcessingStop(v) { processingStop = v; }

// Lab groups and corrections
export let _labGroups = ['CBC', 'Chemistry', 'Urinalysis', 'GI Panel', 'T4', 'PCR', 'Imaging', 'Other'];
export function setLabGroups(v) { _labGroups = v; }

export let _labCorrections = {};
export function setLabCorrections(v) { _labCorrections = v; }

// Clinic abbreviations
export let _clinicAbbrev = {
  'Veterinary Emergency Group': 'VEG',
  'BluePearl': 'BluePearl',
  'VCA ': 'VCA',
  'Banfield': 'Banfield',
};
export function setClinicAbbrev(v) { _clinicAbbrev = v; }

// Active sidebar tab
export let _activeTab = 'records';
export function setActiveTab(v) { _activeTab = v; }

// Context builder cache
export let _allVisitsCache = null;
export function setAllVisitsCache(v) { _allVisitsCache = v; }

export let _journalCache = null;
export function setJournalCache(v) { _journalCache = v; }

export let _journalCacheTime = 0;
export function setJournalCacheTime(v) { _journalCacheTime = v; }

// Rate limit throttle
export let bucketReset = Date.now();
export let bucketUsed = 0;
export function setBucketReset(v) { bucketReset = v; }
export function setBucketUsed(v) { bucketUsed = v; }

export let pauseResolver = null;
export function setPauseResolver(v) { pauseResolver = v; }

// Chat search
export let chatSearchMatches = [];
export let chatSearchIdx = 0;
export function setChatSearchMatches(v) { chatSearchMatches = v; }
export function setChatSearchIdx(v) { chatSearchIdx = v; }

// Cost tracking
export let costWarnThreshold = 0.25;
export let costAlertThreshold = 1.00;
export let allTimeCost = 0;
export function setCostWarnThreshold(v) { costWarnThreshold = v; }
export function setCostAlertThreshold(v) { costAlertThreshold = v; }
export function setAllTimeCost(v) { allTimeCost = v; }

// Cache timer
export let _cacheTimerInterval = null;
export let _cacheExpiresAt = null;
export function setCacheTimerInterval(v) { _cacheTimerInterval = v; }
export function setCacheExpiresAt(v) { _cacheExpiresAt = v; }

// Wake lock
export let wakeLock = null;
export function setWakeLock(v) { wakeLock = v; }

// PDF.js
export let pdfjs = null;
export function setPdfjs(v) { pdfjs = v; }

// Context menu target
export let ctxTarget = null;
export function setCtxTarget(v) { ctxTarget = v; }
