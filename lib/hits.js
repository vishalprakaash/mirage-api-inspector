/**
 * Mirage — hit counters.
 *
 * Counts how often each rule has fired. Stored separately from the rule data
 * and unencrypted: these are integers keyed by opaque rule ids, they carry no
 * request content, and a mocked endpoint can fire hundreds of times a minute —
 * running PBKDF2/AES on that path would be wasteful.
 *
 * Writes are coalesced behind a short timer so a burst of requests costs one
 * write, and callers that are about to read (the popup) flush first.
 */

const HITS_KEY = '__mirage_hits__';
const FLUSH_MS = 400;

let _hits = null;
let _loaded = false;
let _flushTimer = null;

function chromeGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key] ?? null));
  });
}

function chromeSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

async function loadHits() {
  if (_loaded) return _hits;
  const stored = await chromeGet(HITS_KEY);
  _hits = stored && typeof stored === 'object' ? stored : {};
  _loaded = true;
  return _hits;
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushHits();
  }, FLUSH_MS);
}

async function flushHits() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (!_loaded) return;
  await chromeSet(HITS_KEY, _hits);
}

/** Increments the counter for one rule. */
async function recordHit(ruleId, amount = 1) {
  if (!ruleId) return;
  const hits = await loadHits();
  hits[ruleId] = (hits[ruleId] || 0) + amount;
  scheduleFlush();
}

/** Current counts, flushed so the caller sees everything recorded so far. */
async function getHits() {
  const hits = await loadHits();
  await flushHits();
  return { ...hits };
}

/** Clears counters — all of them, or just the given rule ids. */
async function resetHits(ruleIds) {
  await loadHits();
  if (!ruleIds) {
    _hits = {};
  } else {
    for (const id of ruleIds) delete _hits[id];
  }
  await flushHits();
}

/** Drops counters for rules that no longer exist, so storage cannot grow forever. */
async function pruneHits(validIds) {
  const hits = await loadHits();
  let changed = false;
  for (const id of Object.keys(hits)) {
    if (!validIds.has(id)) {
      delete hits[id];
      changed = true;
    }
  }
  if (changed) await flushHits();
}

export { HITS_KEY, recordHit, getHits, resetHits, pruneHits, flushHits };
