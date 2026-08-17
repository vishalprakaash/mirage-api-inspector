/**
 * Encrypted storage layer for Mirage.
 * All user data (profiles, rules) is encrypted with AES-256-GCM before
 * being written to chrome.storage.local. No data ever leaves the device.
 */

import { encrypt, decrypt } from './crypto.js';

const STORAGE_KEY = '__mirage_data__';
const SCHEMA_VERSION = 1;

const DEFAULT_STATE = {
  version: SCHEMA_VERSION,
  globalEnabled: true,
  activeProfileId: null,
  profiles: [],
  headerRules: [],
  mockRules: []
};

// In-memory cache to avoid repeated decryption
let _cache = null;
let _dirty = false;
let _saveTimer = null;

async function load() {
  if (_cache) return _cache;

  const raw = await chromeGet(STORAGE_KEY);

  if (!raw) {
    _cache = structuredClone(DEFAULT_STATE);
    // Create a default profile
    const defaultProfile = makeProfile('Default');
    _cache.profiles.push(defaultProfile);
    _cache.activeProfileId = defaultProfile.id;
    await save();
    return _cache;
  }

  try {
    _cache = await decrypt(raw);
    // Migrate if needed
    if (!_cache.version || _cache.version < SCHEMA_VERSION) {
      _cache = { ...DEFAULT_STATE, ..._cache, version: SCHEMA_VERSION };
    }
  } catch {
    // Decryption failed (corrupted or different extension ID) - reset
    _cache = structuredClone(DEFAULT_STATE);
    const defaultProfile = makeProfile('Default');
    _cache.profiles.push(defaultProfile);
    _cache.activeProfileId = defaultProfile.id;
    await save();
  }

  return _cache;
}

async function save() {
  if (!_cache) return;
  const encrypted = await encrypt(_cache);
  await chromeSet(STORAGE_KEY, encrypted);
  _dirty = false;
}

function scheduleSave() {
  _dirty = true;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(save, 300);
}

async function getState() {
  return structuredClone(await load());
}

async function setState(updater) {
  const state = await load();
  updater(state);
  _cache = state;
  scheduleSave();
  return structuredClone(state);
}

async function flushSave() {
  clearTimeout(_saveTimer);
  if (_dirty || _cache) await save();
}

// --- Profile helpers ---

function makeProfile(name) {
  return {
    id: uid(),
    name,
    enabled: true,
    color: randomColor(),
    createdAt: Date.now()
  };
}

// --- Utility ---

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const PROFILE_COLORS = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#db2777', '#0891b2'];
function randomColor() {
  return PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)];
}

// Promisified chrome.storage wrappers
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

export { getState, setState, flushSave, makeProfile, uid, save };
