/** Local-first persistence. chrome.storage.local in the extension, localStorage in previews. */

import {
  DEFAULT_SETTINGS,
  MAX_RULES,
  STORAGE_KEYS,
  normalizeRule,
  toText,
  uid,
} from './core.js';

const FALLBACK_KEY = 'reqdeck:preview-storage';
const DRAFT_MAX_AGE = 1000 * 60 * 60 * 24 * 14;

function hasExtensionStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

function readFallback() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FALLBACK_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeFallback(db) {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(db));
}

async function storageGet(keys) {
  if (hasExtensionStorage()) return chrome.storage.local.get(keys);
  const db = readFallback();
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(db, key)) result[key] = db[key];
  }
  return result;
}

async function storageSet(values) {
  if (hasExtensionStorage()) return chrome.storage.local.set(values);
  writeFallback({ ...readFallback(), ...values });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('reqdeck:storage', { detail: values }));
  }
}

async function storageRemove(keys) {
  if (hasExtensionStorage()) return chrome.storage.local.remove(keys);
  const db = readFallback();
  for (const key of Array.isArray(keys) ? keys : [keys]) delete db[key];
  writeFallback(db);
}

export function mergeSettings(value) {
  const settings = { ...DEFAULT_SETTINGS, ...(value && typeof value === 'object' ? value : {}) };
  settings.allowAllCors = Boolean(settings.allowAllCors);
  settings.countHits = settings.countHits !== false;
  settings.seeded = Boolean(settings.seeded);
  if (!['auto', 'light', 'dark'].includes(settings.theme)) settings.theme = 'auto';
  if (!['auto', 'en', 'zh'].includes(settings.lang)) settings.lang = 'auto';
  return settings;
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const rules = [];
  for (const raw of value.slice(0, MAX_RULES)) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = normalizeRule(raw, { freshId: false });
    if (!rule.id || seen.has(rule.id)) rule.id = uid();
    seen.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

function normalizeDraft(value) {
  if (!value || typeof value !== 'object' || !value.rule || typeof value.rule !== 'object') return null;
  const savedAt = Number(value.savedAt) || 0;
  if (!savedAt || Date.now() - savedAt > DRAFT_MAX_AGE) return null;
  return {
    rule: normalizeRule(value.rule, { freshId: false }),
    savedAt,
    origin: value.origin === 'new' ? 'new' : 'new',
  };
}

function normalizeLastTests(value) {
  if (!value || typeof value !== 'object') return {};
  const output = {};
  let count = 0;
  for (const [id, entry] of Object.entries(value)) {
    if (count >= 300) break;
    if (!entry || typeof entry !== 'object') continue;
    output[toText(id, 64)] = {
      url: toText(entry.url, 4000),
      method: toText(entry.method, 10).toUpperCase(),
      body: toText(entry.body, 512 * 1024),
      at: Number(entry.at) || Date.now(),
    };
    count += 1;
  }
  return output;
}

export async function loadState() {
  const stored = await storageGet(Object.values(STORAGE_KEYS));
  return {
    rules: normalizeRules(stored[STORAGE_KEYS.rules]),
    settings: mergeSettings(stored[STORAGE_KEYS.settings]),
    draft: normalizeDraft(stored[STORAGE_KEYS.draft]),
    lastTests: normalizeLastTests(stored[STORAGE_KEYS.lastTests]),
    runtimeError: stored[STORAGE_KEYS.runtimeError] || null,
  };
}

export async function saveRules(rules) {
  const serializable = (Array.isArray(rules) ? rules : []).map((rule) =>
    normalizeRule(rule, { freshId: false }),
  );
  await storageSet({ [STORAGE_KEYS.rules]: serializable });
  return serializable;
}

export async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await storageSet({ [STORAGE_KEYS.settings]: merged });
  return merged;
}

export async function saveDraft(rule) {
  const draft = {
    rule: normalizeRule(rule, { freshId: false }),
    savedAt: Date.now(),
    origin: 'new',
  };
  await storageSet({ [STORAGE_KEYS.draft]: draft });
  return draft;
}

export async function clearDraft() {
  await storageRemove(STORAGE_KEYS.draft);
}

export async function saveLastTests(tests) {
  await storageSet({ [STORAGE_KEYS.lastTests]: normalizeLastTests(tests) });
}

export async function clearStats() {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      await chrome.runtime.sendMessage({ type: 'clearStats' });
    } catch {
      /* fall through to storage clear */
    }
  }
  await storageSet({ [STORAGE_KEYS.stats]: { minutes: {}, rules: {}, updatedAt: 0 } });
}

export function subscribe(callback) {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    const handler = (changes, areaName) => {
      if (areaName !== 'local') return;
      const relevant = {};
      let hasRelevant = false;
      for (const key of Object.values(STORAGE_KEYS)) {
        if (changes[key]) {
          relevant[key] = changes[key].newValue;
          hasRelevant = true;
        }
      }
      if (hasRelevant) callback(relevant);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }
  if (typeof window === 'undefined') return () => {};
  const handler = (event) => {
    if (event.detail) callback(event.detail);
  };
  window.addEventListener('reqdeck:storage', handler);
  return () => window.removeEventListener('reqdeck:storage', handler);
}
