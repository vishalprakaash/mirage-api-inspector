/**
 * Mirage — Background Service Worker
 *
 * Responsibilities:
 *  1. Manage declarativeNetRequest dynamic rules for header modification
 *  2. Push mock rules to content scripts on all tabs
 *  3. Handle messages from popup and content scripts
 *  4. Draw badge/icon to indicate active state
 */

import { getState, setState, makeProfile } from './lib/storage.js';
import { patternToDeclarativeFilter } from './lib/url-matcher.js';

// ─── Initialization ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await getState(); // initializes default state if needed
  await syncAllRules();
  updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAllRules();
  updateBadge();
});

// ─── Message Handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    console.error('[Mirage BG] Error handling message:', err);
    sendResponse({ ok: false, error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'GET_STATE':
      return { ok: true, state: await getState() };

    case 'SET_GLOBAL_ENABLED':
      await setState((s) => { s.globalEnabled = msg.enabled; });
      await syncAllRules();
      await pushMockRulesToTabs();
      updateBadge();
      return { ok: true };

    case 'SET_ACTIVE_PROFILE':
      await setState((s) => { s.activeProfileId = msg.profileId; });
      await syncAllRules();
      await pushMockRulesToTabs();
      updateBadge();
      return { ok: true };

    case 'CREATE_PROFILE': {
      const profile = makeProfile(msg.name);
      await setState((s) => { s.profiles.push(profile); s.activeProfileId = profile.id; });
      await syncAllRules();
      return { ok: true, profile };
    }

    case 'UPDATE_PROFILE':
      await setState((s) => {
        const p = s.profiles.find((x) => x.id === msg.profileId);
        if (p) Object.assign(p, msg.changes);
      });
      await syncAllRules();
      await pushMockRulesToTabs();
      updateBadge();
      return { ok: true };

    case 'DELETE_PROFILE':
      await setState((s) => {
        s.profiles = s.profiles.filter((p) => p.id !== msg.profileId);
        s.headerRules = s.headerRules.filter((r) => r.profileId !== msg.profileId);
        s.mockRules = s.mockRules.filter((r) => r.profileId !== msg.profileId);
        if (s.activeProfileId === msg.profileId) {
          s.activeProfileId = s.profiles[0]?.id ?? null;
        }
      });
      await syncAllRules();
      await pushMockRulesToTabs();
      return { ok: true };

    // Header rules
    case 'UPSERT_HEADER_RULE':
      await setState((s) => {
        const idx = s.headerRules.findIndex((r) => r.id === msg.rule.id);
        if (idx >= 0) s.headerRules[idx] = msg.rule;
        else s.headerRules.push(msg.rule);
      });
      await syncAllRules();
      return { ok: true };

    case 'DELETE_HEADER_RULE':
      await setState((s) => { s.headerRules = s.headerRules.filter((r) => r.id !== msg.ruleId); });
      await syncAllRules();
      return { ok: true };

    // Mock rules
    case 'UPSERT_MOCK_RULE':
      await setState((s) => {
        const idx = s.mockRules.findIndex((r) => r.id === msg.rule.id);
        if (idx >= 0) s.mockRules[idx] = msg.rule;
        else s.mockRules.push(msg.rule);
      });
      await pushMockRulesToTabs();
      return { ok: true };

    case 'DELETE_MOCK_RULE':
      await setState((s) => { s.mockRules = s.mockRules.filter((r) => r.id !== msg.ruleId); });
      await pushMockRulesToTabs();
      return { ok: true };

    case 'GET_MOCK_RULES':
      return { ok: true, rules: await getActiveMockRules() };

    case 'IMPORT_DATA':
      await setState((s) => Object.assign(s, msg.data));
      await syncAllRules();
      await pushMockRulesToTabs();
      updateBadge();
      return { ok: true };

    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

// ─── declarativeNetRequest sync ───────────────────────────────────────────────

async function syncAllRules() {
  const state = await getState();

  // Remove all existing dynamic rules
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((r) => r.id);

  if (!state.globalEnabled) {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    }
    return;
  }

  const activeProfile = state.profiles.find(
    (p) => p.id === state.activeProfileId && p.enabled
  );
  if (!activeProfile) {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    }
    return;
  }

  const addRules = buildDeclarativeRules(state.headerRules, activeProfile.id);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    // A single invalid rule (e.g. bad regex pattern) rejects the whole batch —
    // retry one-by-one so valid rules still apply.
    console.warn('[Mirage BG] Batch rule update failed, retrying individually:', err.message);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    for (const rule of addRules) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [], addRules: [rule] });
      } catch (e) {
        console.warn('[Mirage BG] Skipping invalid rule:', rule, e.message);
      }
    }
  }
}

let _ruleIdCounter = 1;

function buildDeclarativeRules(headerRules, profileId) {
  const rules = [];
  _ruleIdCounter = 1;

  for (const rule of headerRules) {
    if (rule.profileId !== profileId || !rule.enabled) continue;

    const requestHeaders = [];
    const responseHeaders = [];

    for (const h of rule.headers) {
      if (!h.enabled || !h.name) continue;

      const entry = buildHeaderOperation(h);
      if (!entry) continue;

      if (h.type === 'request') requestHeaders.push(entry);
      else responseHeaders.push(entry);
    }

    if (requestHeaders.length === 0 && responseHeaders.length === 0) continue;

    const condition = buildCondition(rule.urlFilter);

    if (requestHeaders.length > 0) {
      rules.push({
        id: _ruleIdCounter++,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition
      });
    }

    if (responseHeaders.length > 0) {
      rules.push({
        id: _ruleIdCounter++,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders },
        condition
      });
    }
  }

  return rules;
}

function buildHeaderOperation(h) {
  const op = h.operation || 'set';
  if (op === 'set') return { header: h.name, operation: 'set', value: h.value };
  if (op === 'append') return { header: h.name, operation: 'append', value: h.value };
  if (op === 'remove') return { header: h.name, operation: 'remove' };
  return null;
}

function buildCondition(urlFilter) {
  // Note: fetch() requests are classified as 'xmlhttprequest' in declarativeNetRequest
  const base = { resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'other'] };

  if (!urlFilter || urlFilter === '*' || urlFilter === '') return base;

  const filterOpts = patternToDeclarativeFilter(urlFilter);
  return { ...base, ...filterOpts };
}

// ─── Mock rule broadcasting ───────────────────────────────────────────────────

async function getActiveMockRules() {
  const state = await getState();
  if (!state.globalEnabled) return [];

  const activeProfile = state.profiles.find(
    (p) => p.id === state.activeProfileId && p.enabled
  );
  if (!activeProfile) return [];

  return state.mockRules.filter((r) => r.profileId === activeProfile.id && r.enabled);
}

async function pushMockRulesToTabs() {
  const rules = await getActiveMockRules();
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (!tab.id || tab.id < 0) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_MOCK_RULES', rules }).catch(() => {
      // Tab may not have content script — ignore
    });
  }
}

// Inject mock rules into newly navigated tabs
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  if (frameId !== 0) return; // top frame only
  const rules = await getActiveMockRules();
  chrome.tabs.sendMessage(tabId, { type: 'UPDATE_MOCK_RULES', rules }).catch(() => {});
});

// ─── Badge / Icon ─────────────────────────────────────────────────────────────

async function updateBadge() {
  const state = await getState();
  const profile = state.profiles.find((p) => p.id === state.activeProfileId);
  const enabled = state.globalEnabled && profile?.enabled;

  const activeHeaderRules = state.headerRules.filter(
    (r) => r.profileId === state.activeProfileId && r.enabled && r.headers?.some((h) => h.enabled)
  );
  const activeMockRules = state.mockRules.filter(
    (r) => r.profileId === state.activeProfileId && r.enabled
  );
  const total = activeHeaderRules.length + activeMockRules.length;

  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#7c3aed' : '#64748b' });
  await chrome.action.setBadgeText({ text: enabled && total > 0 ? String(total) : '' });
  await chrome.action.setTitle({
    title: enabled
      ? `Mirage — ${total} active rule${total !== 1 ? 's' : ''}`
      : 'Mirage — Disabled'
  });
}
