/**
 * ReqDeck background service worker.
 * Keeps declarativeNetRequest dynamic rules in sync with local storage,
 * counts rule hits locally, and runs the popup's "send request" tests.
 */

import {
  DEFAULT_SETTINGS,
  FORBIDDEN_REQUEST_HEADERS,
  METHOD_ANY,
  METHODS,
  STORAGE_KEYS,
  buildMatchers,
  compileRules,
  escapeRegExp,
  isHttpUrl,
  normalizeRule,
  toText,
  validateRule,
} from './core.js';

const MAX_RULES = 800;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_DISPLAY_CHARS = 160 * 1024;
const FETCH_TIMEOUT_MS = 25_000;
const BINARY_TYPE_RE =
  /^(image|audio|video|font)\/|application\/(octet-stream|zip|pdf|gzip|x-rar|wasm|vnd\.)/i;
const FORBIDDEN = new Set(FORBIDDEN_REQUEST_HEADERS);

let initialized = false;
let bootPromise = null;
let applying = false;
let applyAgain = false;
let applyTimer = null;
let flushTimer = null;
let statsDirty = false;
let rulesEpoch = 0;
let settingsEpoch = 0;

const state = {
  rules: [],
  settings: { ...DEFAULT_SETTINGS },
  stats: emptyStats(),
};
let matchers = [];

function emptyStats() {
  return { minutes: {}, rules: {}, updatedAt: 0 };
}

function capRules(rules) {
  return (Array.isArray(rules) ? rules : []).slice(0, MAX_RULES).map((rule) => normalizeRule(rule, { freshId: false }));
}

function mergeSettings(value) {
  const settings = { ...DEFAULT_SETTINGS, ...(value && typeof value === 'object' ? value : {}) };
  settings.allowAllCors = Boolean(settings.allowAllCors);
  settings.countHits = settings.countHits !== false;
  if (!['auto', 'light', 'dark'].includes(settings.theme)) settings.theme = 'auto';
  if (!['auto', 'en', 'zh'].includes(settings.lang)) settings.lang = 'auto';
  settings.seeded = Boolean(settings.seeded);
  return settings;
}

function pruneMinutes(minutes, now = Date.now()) {
  const current = Math.floor(now / 60_000);
  for (const key of Object.keys(minutes)) {
    const minute = Number(key);
    if (!Number.isFinite(minute) || minute < current - 120) delete minutes[key];
  }
}

function loadStats(value) {
  const stats = emptyStats();
  if (value && typeof value === 'object') {
    if (value.minutes && typeof value.minutes === 'object') {
      for (const [key, count] of Object.entries(value.minutes)) {
        const minute = Number(key);
        if (Number.isFinite(minute) && Number(count) > 0) {
          stats.minutes[minute] = Number(count);
        }
      }
    }
    if (value.rules && typeof value.rules === 'object') {
      for (const [id, entry] of Object.entries(value.rules)) {
        const total = Number(entry && typeof entry === 'object' ? entry.total : entry);
        if (total > 0) stats.rules[id] = { total };
      }
    }
  }
  pruneMinutes(stats.minutes);
  return stats;
}

async function bootstrap() {
  if (initialized) return;
  try {
    const rulesEpochAtRead = rulesEpoch;
    const settingsEpochAtRead = settingsEpoch;
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.rules,
      STORAGE_KEYS.settings,
      STORAGE_KEYS.stats,
    ]);
    // A storage change may have arrived while we were reading it (the worker
    // was asleep). In that case the change handler owns the changed slice.
    const rulesRaced = rulesEpoch !== rulesEpochAtRead;
    const settingsRaced = settingsEpoch !== settingsEpochAtRead;
    if (!rulesRaced) state.rules = capRules(stored[STORAGE_KEYS.rules]);
    if (!settingsRaced) state.settings = mergeSettings(stored[STORAGE_KEYS.settings]);
    state.stats = loadStats(stored[STORAGE_KEYS.stats]);
    matchers = buildMatchers(state.rules);
    initialized = true;

    const patch = {};
    if (!rulesRaced && !Array.isArray(stored[STORAGE_KEYS.rules])) patch[STORAGE_KEYS.rules] = state.rules;
    if (!settingsRaced && !stored[STORAGE_KEYS.settings]) patch[STORAGE_KEYS.settings] = state.settings;
    if (!stored[STORAGE_KEYS.stats]) patch[STORAGE_KEYS.stats] = state.stats;
    if (Object.keys(patch).length) {
      try {
        await chrome.storage.local.set(patch);
      } catch (error) {
        console.warn('[ReqDeck] Could not seed storage', error);
      }
    }

    await updateBadge();
    await applyRules();
    await cleanupSessionRules();
  } catch (error) {
    console.error('[ReqDeck] Bootstrap failed', error);
  }
}

function ensureReady() {
  if (!bootPromise) bootPromise = bootstrap();
  return bootPromise;
}

function scheduleApply(delay = 150) {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    void applyRules();
  }, delay);
}

async function applyRules() {
  let dnr;
  try {
    dnr = chrome.declarativeNetRequest;
  } catch {
    return;
  }
  if (!dnr) return;
  if (applying) {
    applyAgain = true;
    return;
  }
  applying = true;
  try {
    const addRules = compileRules(state.rules, state.settings);
    const existing = await dnr.getDynamicRules();
    await dnr.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules,
    });
    await chrome.storage.local.remove(STORAGE_KEYS.runtimeError);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn('[ReqDeck] Could not apply rules', error);
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.runtimeError]: { message, at: Date.now() },
      });
    } catch {
      /* ignore secondary failure */
    }
  } finally {
    applying = false;
    if (applyAgain) {
      applyAgain = false;
      scheduleApply(80);
    }
  }
}

async function updateBadge() {
  try {
    const active = state.rules.filter((rule) => rule.enabled && validateRule(rule).valid).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#151917' });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#C8F45A' });
    }
    await chrome.action.setBadgeText({ text: active > 0 ? String(Math.min(active, 99)) : '' });
  } catch {
    /* action APIs are optional in some contexts */
  }
}

function countHit(details) {
  if (!initialized || !state.settings.countHits) return;
  if (details.tabId < 0) return;
  const url = details.url || '';
  if (!/^https?:/i.test(url)) return;
  const method = String(details.method || '').toUpperCase();
  let hits = 0;
  const minute = Math.floor(Date.now() / 60_000);
  for (const matcher of matchers) {
    if (matcher.method && matcher.method !== METHOD_ANY && matcher.method !== method) continue;
    if (!matcher.regex.test(url)) continue;
    hits += 1;
    const entry = state.stats.rules[matcher.id] || { total: 0 };
    entry.total += 1;
    state.stats.rules[matcher.id] = entry;
  }
  if (hits === 0) return;
  state.stats.minutes[minute] = (state.stats.minutes[minute] || 0) + 1;
  statsDirty = true;
  scheduleFlush();
}

function scheduleFlush(delay = 2500) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushStats();
  }, delay);
}

async function flushStats() {
  if (!statsDirty) return;
  statsDirty = false;
  pruneMinutes(state.stats.minutes);
  state.stats.updatedAt = Date.now();
  const snapshot = {
    minutes: { ...state.stats.minutes },
    rules: Object.fromEntries(Object.entries(state.stats.rules).map(([id, entry]) => [id, { ...entry }])),
    updatedAt: state.stats.updatedAt,
  };
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.stats]: snapshot });
  } catch {
    statsDirty = true;
  }
  if (statsDirty) scheduleFlush();
}

function lastHourCount() {
  const current = Math.floor(Date.now() / 60_000);
  let total = 0;
  for (const [key, count] of Object.entries(state.stats.minutes)) {
    const minute = Number(key);
    if (minute >= current - 59) total += Number(count) || 0;
  }
  return total;
}

async function meta() {
  await ensureReady();
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    lastHour: lastHourCount(),
    ruleHits: Object.fromEntries(
      Object.entries(state.stats.rules).map(([id, entry]) => [id, Number(entry.total) || 0]),
    ),
    countHits: state.settings.countHits,
    activeRules: state.rules.filter((rule) => rule.enabled && validateRule(rule).valid).length,
  };
}

function charsetOf(contentType) {
  const match = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (!match) return 'utf-8';
  try {
    new TextDecoder(match[1]);
    return match[1];
  } catch {
    return 'utf-8';
  }
}

async function readBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.body) {
    return { text: '', bytes: 0, truncated: false, binary: false, contentType };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      bytes += value.byteLength;
    }
    if (bytes >= MAX_BODY_BYTES) {
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* partial reads are still useful */
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes) break;
    const slice = chunk.byteLength > bytes - offset ? chunk.slice(0, bytes - offset) : chunk;
    merged.set(slice, offset);
    offset += slice.byteLength;
  }
  const binary = BINARY_TYPE_RE.test(contentType) && !/json|text|xml|javascript/i.test(contentType);
  let text = '';
  if (!binary) {
    try {
      text = new TextDecoder(charsetOf(contentType), { fatal: false }).decode(merged);
    } catch {
      text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
    }
    if (text.length > MAX_DISPLAY_CHARS) {
      text = text.slice(0, MAX_DISPLAY_CHARS);
      truncated = true;
    }
  }
  return { text, bytes, truncated, binary, contentType };
}

async function testRequest(payload = {}) {
  const url = toText(payload.url, 4000).trim();
  if (!isHttpUrl(url)) {
    return { ok: false, error: 'invalidUrl' };
  }
  const method = METHODS.includes(String(payload.method).toUpperCase())
    ? String(payload.method).toUpperCase()
    : 'GET';
  const headers = new Headers();
  const ignoredHeaders = [];
  for (const raw of Array.isArray(payload.headers) ? payload.headers.slice(0, 50) : []) {
    const key = toText(raw && raw.key, 256).trim();
    if (!key) continue;
    const value = toText(raw && raw.value, 4000);
    if (FORBIDDEN.has(key.toLowerCase()) || key.startsWith(':') || key.toLowerCase().startsWith('proxy-')) {
      ignoredHeaders.push(key);
      continue;
    }
    try {
      headers.set(key, value);
    } catch {
      ignoredHeaders.push(key);
    }
  }

  return withBypassRule(url, async (bypassedRules) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const started = performance.now();
    try {
      const init = {
        method,
        headers,
        redirect: 'follow',
        credentials: payload.withCredentials ? 'include' : 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      };
      if (payload.body && !['GET', 'HEAD'].includes(method)) {
        init.body = toText(payload.body, 512 * 1024);
      }
      const response = await fetch(url, init);
      const body = await readBody(response);
      const duration = Math.round(performance.now() - started);
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        okStatus: response.ok,
        finalUrl: response.url || url,
        redirected: response.redirected,
        duration,
        headers: [...response.headers.entries()].map(([name, value]) => ({ name, value })),
        body,
        method,
        ignoredHeaders,
        bypassedRules,
      };
    } catch (error) {
      const duration = Math.round(performance.now() - started);
      const aborted = error && (error.name === 'AbortError' || controller.signal.aborted);
      return {
        ok: false,
        error: aborted ? 'timeout' : 'network',
        detail: error && error.message ? error.message : String(error),
        duration,
        ignoredHeaders,
        bypassedRules,
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

let bypassRuleId = 900000;

/**
 * The tester sends a request from the extension, and that request is normally
 * subject to our own DNR rules. Add a short-lived, exact-URL session allow rule
 * so a block/redirect rule cannot swallow the user's manual test.
 */
async function withBypassRule(url, task) {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr || !dnr.updateSessionRules) return task(false);
  const id = bypassRuleId++;
  let installed = false;
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1_000_000,
          action: { type: 'allow' },
          condition: { regexFilter: `^${escapeRegExp(url)}$` },
        },
      ],
    });
    installed = true;
  } catch (error) {
    console.warn('[ReqDeck] could not add the tester bypass rule', error);
  }
  try {
    return await task(installed);
  } finally {
    if (installed) {
      try {
        await dnr.updateSessionRules({ removeRuleIds: [id] });
      } catch {
        /* ignore */
      }
    }
  }
}

async function cleanupSessionRules() {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr || !dnr.getSessionRules) return;
  try {
    const session = await dnr.getSessionRules();
    const stale = session.filter((rule) => rule.id >= 900000 && rule.id < 1000000).map((rule) => rule.id);
    if (stale.length) await dnr.updateSessionRules({ removeRuleIds: stale });
  } catch {
    /* ignore */
  }
}

async function clearStats() {
  state.stats = emptyStats();
  statsDirty = false;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.stats]: state.stats });
  } catch {
    /* ignore */
  }
  return { ok: true };
}

async function handleMessage(message) {
  await ensureReady();
  switch (message && message.type) {
    case 'meta':
      return meta();
    case 'testRequest':
      return testRequest(message.payload);
    case 'clearStats':
      return clearStats();
    case 'resync':
      await applyRules();
      return { ok: true };
    case 'ping':
      return { ok: true };
    default:
      return { ok: false, error: 'unknownMessage' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({ ok: false, error: 'internal', detail: error && error.message ? error.message : String(error) });
    });
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.rules]) {
    rulesEpoch += 1;
    state.rules = capRules(changes[STORAGE_KEYS.rules].newValue);
    matchers = buildMatchers(state.rules);
    const ids = new Set(state.rules.map((rule) => rule.id));
    let pruned = false;
    for (const id of Object.keys(state.stats.rules)) {
      if (!ids.has(id)) {
        delete state.stats.rules[id];
        pruned = true;
      }
    }
    if (pruned) {
      statsDirty = true;
      scheduleFlush();
    }
    void updateBadge();
    scheduleApply();
  }
  if (changes[STORAGE_KEYS.settings]) {
    settingsEpoch += 1;
    const previous = state.settings;
    state.settings = mergeSettings(changes[STORAGE_KEYS.settings].newValue);
    void updateBadge();
    // Theme/language changes do not affect network rules.
    if (previous.allowAllCors !== state.settings.allowAllCors) scheduleApply();
  }
});

try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => countHit(details),
    { urls: ['http://*/*', 'https://*/*'] },
    [],
  );
} catch (error) {
  console.warn('[ReqDeck] webRequest unavailable', error);
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureReady().then(() => {
    void updateBadge();
    scheduleApply(50);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureReady().then(() => {
    void updateBadge();
    scheduleApply(50);
  });
});

// Wake up on service worker start.
void ensureReady();
