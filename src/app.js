/**
 * ReqDeck popup controller.
 * Local-first: every editor change is persisted to chrome.storage.local.
 */

import {
  MAX_RULES,
  METHOD_ANY,
  METHODS,
  RULE_TYPES,
  SCHEMA_VERSION,
  STORAGE_KEYS,
  cloneRule,
  createRule,
  headerSummary,
  isHttpUrl,
  makeSampleRules,
  normalizeRule,
  sampleTarget,
  toText,
  uid,
  usableHeaders,
  validateRule,
} from './core.js';
import {
  clearDraft,
  clearStats,
  loadState,
  mergeSettings,
  saveDraft,
  saveLastTests,
  saveRules,
  saveSettings,
  subscribe,
} from './store.js';
import { errorMessage, localizeDom, setLanguage, t } from './i18n.js';
import { TYPE_ICON, brandMark, emptyArt, icon } from './icons.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const dom = {
  app: $('#app'),
  workspace: $('#workspace'),
  searchInput: $('#searchInput'),
  typeFilter: $('#typeFilter'),
  stateFilter: $('#stateFilter'),
  ruleList: $('#ruleList'),
  listScroll: $('#listScroll'),
  emptyState: $('#emptyState'),
  noticeZone: $('#noticeZone'),
  statRules: $('#statRules'),
  statRulesLabel: $('#statRulesLabel'),
  statActive: $('#statActive'),
  statHits: $('#statHits'),
  hitStat: $('#hitStat'),
  statusLocalIcon: $('#statusLocalIcon'),
  corsState: $('#corsState'),
  corsStateLabel: $('#corsStateLabel'),
  corsAll: $('#corsAll'),
  corsHelp: $('#corsHelp'),
  corsHelpIcon: $('#corsHelpIcon'),
  newRuleBtn: $('#newRuleBtn'),
  settingsBtn: $('#settingsBtn'),
  brandMark: $('#brandMark'),
  plusIcon: $('#plusIcon'),
  settingsIcon: $('#settingsIcon'),
  searchIcon: $('#searchIcon'),
  typeChevron: $('#typeChevron'),
  stateChevron: $('#stateChevron'),
  versionLabel: $('#versionLabel'),
  overlayRoot: $('#overlayRoot'),
  modalRoot: $('#modalRoot'),
  menuRoot: $('#menuRoot'),
  toastRoot: $('#toastRoot'),
  importInput: $('#importInput'),
};

const state = {
  ready: false,
  pageMode: new URLSearchParams(location.search).get('view') === 'page',
  rules: [],
  settings: mergeSettings({}),
  draft: null,
  lastTests: {},
  runtimeError: null,
  meta: { lastHour: 0, ruleHits: {}, version: '1.0.0' },
  filters: { q: '', type: 'all', status: 'all' },
  sheet: null,
  drawer: null,
  menu: null,
  modal: null,
  dismissedErrorAt: 0,
  metaTimer: null,
};

let rulesWriteChain = Promise.resolve();

const EMPTY_VALIDATION = {
  valid: true,
  patternError: null,
  redirectError: null,
  cookieError: null,
  headersError: null,
  headerErrors: {},
};

/* ------------------------------------------------------------------ helpers */

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function compactNumber(value) {
  const n = Number(value) || 0;
  if (n < 10000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '1.0.0';
  }
}

function typeLabel(type) {
  return t(`type.${type}`);
}

function pluralize(count, pluralKey) {
  const singularKey = {
    rules: 'ruleSingular',
    headersShort: 'headerSingular',
    hits: 'hitSingular',
  }[pluralKey];
  return t(count === 1 && singularKey ? singularKey : pluralKey);
}

function rulesFromValue(value) {
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

function draftFromValue(value) {
  if (!value || typeof value !== 'object' || !value.rule || typeof value.rule !== 'object') return null;
  const savedAt = Number(value.savedAt) || 0;
  if (!savedAt) return null;
  return {
    rule: normalizeRule(value.rule, { freshId: false }),
    savedAt,
    origin: 'new',
  };
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function filteredRules() {
  const query = state.filters.q.trim().toLowerCase();
  const type = state.filters.type;
  const status = state.filters.status;
  return state.rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => {
      if (type !== 'all' && rule.type !== type) return false;
      if (status === 'active' && !rule.enabled) return false;
      if (status === 'paused' && rule.enabled) return false;
      if (!query) return true;
      const haystack = [
        rule.label,
        rule.pattern,
        rule.redirectTo,
        rule.method === METHOD_ANY ? '' : rule.method,
        rule.cookie,
        ...(rule.headers || []).flatMap((header) => [header.key, header.value]),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
}

function getRule(id) {
  return state.rules.find((rule) => rule.id === id) || null;
}

function extensionRuntimeAvailable() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
}

/* -------------------------------------------------------------------- theme */

function applyTheme(preference = state.settings.theme) {
  const dark =
    preference === 'dark' ||
    (preference === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function adjustPopupWidth() {
  if (state.pageMode) return;
  // Some Chromium shells render action popups inside a narrow fixed panel.
  // Chrome normally expands us to 780px; if that did not happen, fit the panel.
  document.documentElement.classList.toggle('popup-narrow', window.innerWidth < 760);
}

function registerThemeListener() {
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', () => {
      if (state.settings.theme === 'auto') applyTheme('auto');
    });
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- static ui */

function injectIcons() {
  dom.brandMark.innerHTML = brandMark(30);
  dom.plusIcon.innerHTML = icon('plus', 14);
  dom.settingsIcon.innerHTML = icon('settings', 16);
  dom.searchIcon.innerHTML = icon('search', 14);
  dom.corsHelpIcon.innerHTML = icon('info', 13);
  dom.statusLocalIcon.innerHTML = icon('lock', 10);
  dom.typeChevron.innerHTML = icon('chevronDown', 12);
  dom.stateChevron.innerHTML = icon('chevronDown', 12);
}

function rebuildFilters() {
  const type = state.filters.type;
  const status = state.filters.status;
  dom.typeFilter.innerHTML =
    `<option value="all">${esc(t('filterType'))}</option>` +
    RULE_TYPES.map((value) => `<option value="${value}">${esc(t(`type.${value}`))}</option>`).join('');
  dom.stateFilter.innerHTML =
    `<option value="all">${esc(t('filterStatus'))}</option>` +
    `<option value="active">${esc(t('statusActive'))}</option>` +
    `<option value="paused">${esc(t('statusPaused'))}</option>`;
  dom.typeFilter.value = type;
  dom.stateFilter.value = status;
}

function applyStaticLocale() {
  setLanguage(state.settings.lang);
  localizeDom(document);
  document.title = `${t('appName')} · ${t('tagline')}`;
  dom.corsHelp.title = t('corsAllHint');
  dom.corsHelp.setAttribute('aria-label', t('corsAllHint'));
  rebuildFilters();
  dom.versionLabel.textContent = `v${state.meta.version || extensionVersion()}`;
  renderAll();
  if (state.sheet) renderOverlay();
  if (state.drawer) renderOverlay();
}

/* ------------------------------------------------------------------- render */

function renderAll() {
  renderList();
  renderNotices();
  renderStatus();
  updateCorsUi();
  updateHitLabels();
}

function renderList() {
  const rows = filteredRules();
  const noRules = state.rules.length === 0;
  dom.workspace.classList.toggle('is-empty', noRules);

  if (rows.length === 0) {
    dom.ruleList.innerHTML = '';
    dom.emptyState.hidden = false;
    dom.emptyState.innerHTML = noRules ? emptyStateHtml() : noResultsHtml();
    return;
  }

  dom.emptyState.hidden = true;
  dom.emptyState.innerHTML = '';
  dom.ruleList.innerHTML = rows.map(({ rule, index }) => ruleRowHtml(rule, index)).join('');
}

function ruleRowHtml(rule, index) {
  const validation = validateRule(rule);
  const summary = headerSummary(rule);
  const hits = Number(state.meta.ruleHits[rule.id]) || 0;
  const enabledLabel = rule.enabled ? t('disableRule') : t('enableRule');
  const meta = [`<span class="meta-type">${esc(typeLabel(rule.type))}</span>`];
  if (rule.type === 'allow' && rule.cors !== false) {
    meta.push(`<span class="meta-tag">${esc(t('corsTag'))}</span>`);
  }
  if (rule.method && rule.method !== METHOD_ANY) {
    meta.push(`<span class="meta-method">${esc(rule.method)}</span>`);
  }
  if (rule.label) {
    meta.push(
      `<span class="meta-sep"></span><span class="meta-label" title="${esc(rule.label)}">${esc(rule.label)}</span>`,
    );
  }
  if (rule.type === 'allow' && summary.headers > 0) {
    meta.push(
      `<span class="meta-sep"></span><span>${summary.headers} ${esc(pluralize(summary.headers, 'headersShort'))}</span>`,
    );
  }
  if (rule.type === 'allow' && summary.cookies > 0) {
    meta.push(`<span class="meta-sep"></span><span>${summary.cookies} ${esc(t('cookieLabel'))}</span>`);
  }
  meta.push(
    `<span class="meta-hits" data-hits-for="${esc(rule.id)}" title="${esc(t('hitsSinceInstall'))}" ${hits ? '' : 'hidden'}>${
      hits ? esc(`${compactNumber(hits)} ${pluralize(hits, 'hits')}`) : ''
    }</span>`,
  );
  if (!validation.valid) {
    meta.push(
      `<span class="meta-sep"></span><span class="meta-warn">${icon('alert', 10)}${esc(t('invalidRule'))}</span>`,
    );
  }

  return `<div class="rule-row tone-${rule.type} ${rule.enabled ? '' : 'is-disabled'} ${validation.valid ? '' : 'is-invalid'}" data-rule-id="${esc(rule.id)}">
    <span class="rule-index">${String(index + 1).padStart(2, '0')}</span>
    <span class="type-chip" title="${esc(typeLabel(rule.type))}">${icon(TYPE_ICON[rule.type], 15)}</span>
    <button class="rule-main" type="button" data-action="open" title="${esc(rule.pattern)}">
      <span class="rule-url">${rule.pattern ? esc(rule.pattern) : '—'}</span>
      <span class="rule-meta">${meta.join('')}</span>
    </button>
    <button
      class="switch switch-sm"
      type="button"
      role="switch"
      data-action="toggle"
      aria-checked="${rule.enabled}"
      aria-label="${esc(enabledLabel)}"
      title="${esc(enabledLabel)}"
    ><span class="switch-thumb"></span></button>
    <button class="row-send" type="button" data-action="test" aria-label="${esc(`${t('sendTitle')}: ${rule.pattern}`)}">
      ${icon('send', 12)}<span>${esc(t('sendSend'))}</span>
    </button>
    <button class="icon-btn icon-btn-sm row-more" type="button" data-action="more" aria-label="${esc(t('moreActions'))}" data-menu-anchor="row">
      ${icon('more', 15)}
    </button>
  </div>`;
}

function emptyStateHtml() {
  return `${emptyArt()}
    <p class="empty-title">${esc(t('emptyTitle'))}</p>
    <p class="empty-body">${esc(t('emptyBody'))}</p>
    <div class="empty-actions">
      <button class="btn btn-primary" type="button" data-empty="new">${icon('plus', 14)}${esc(t('emptyCta'))}</button>
      <button class="btn btn-ghost" type="button" data-empty="import">${icon('upload', 14)}${esc(t('emptyImport'))}</button>
    </div>
    <div class="empty-links">
      <button class="link-btn" type="button" data-empty="samples">${esc(t('emptySamples'))}</button>
      <span class="link-dot" aria-hidden="true">·</span>
      <button class="link-btn" type="button" data-empty="open-tab">${icon('external', 11)}${esc(t('menuOpenTab'))}</button>
    </div>`;
}

function noResultsHtml() {
  return `<div class="no-results-art">${icon('filter', 18)}</div>
    <p class="empty-title">${esc(t('noResultsTitle'))}</p>
    <p class="empty-body">${esc(t('noResultsBody'))}</p>
    <button class="btn btn-ghost btn-sm" type="button" data-empty="reset">${esc(t('clearFilters'))}</button>`;
}

function renderStatus() {
  const active = state.rules.filter((rule) => rule.enabled).length;
  dom.statRules.textContent = String(state.rules.length);
  dom.statRulesLabel.textContent = pluralize(state.rules.length, 'rules');
  dom.statActive.textContent = String(active);
  const lastHour = Number(state.meta.lastHour) || 0;
  dom.statHits.textContent = compactNumber(lastHour);
  dom.hitStat.classList.toggle('is-live', lastHour > 0);
  dom.hitStat.title = t('lastHourHint');
  dom.versionLabel.textContent = `v${state.meta.version || extensionVersion()}`;
}

function updateCorsUi() {
  const on = Boolean(state.settings.allowAllCors);
  dom.corsAll.setAttribute('aria-checked', String(on));
  dom.corsState.classList.toggle('is-on', on);
  dom.corsStateLabel.textContent = on ? t('corsOn') : t('corsOff');
}

function updateHitLabels() {
  for (const node of $$('[data-hits-for]')) {
    const hits = Number(state.meta.ruleHits[node.dataset.hitsFor]) || 0;
    node.hidden = hits <= 0;
    node.textContent = hits > 0 ? `${compactNumber(hits)} ${pluralize(hits, 'hits')}` : '';
  }
}

function renderNotices() {
  const notices = [];
  if (state.draft && !state.sheet) {
    const draftLabel = state.draft.rule.label || state.draft.rule.pattern || t('sheetNew');
    notices.push(`<div class="notice">
      <span class="notice-icon">${icon('file', 13)}</span>
      <div class="notice-text"><strong>${esc(t('draftTitle'))}</strong> <span>· ${esc(draftLabel)}</span></div>
      <div class="notice-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-notice-action="resume">${esc(t('draftResume'))}</button>
        <button class="icon-btn icon-btn-sm" type="button" data-notice-action="discard" title="${esc(t('draftDiscard'))}" aria-label="${esc(t('draftDiscard'))}">${icon('x', 13)}</button>
      </div>
    </div>`);
  }
  if (state.runtimeError && state.runtimeError.at !== state.dismissedErrorAt) {
    notices.push(`<div class="notice">
      <span class="notice-icon">${icon('alert', 13)}</span>
      <div class="notice-text"><strong>${esc(t('syncErrorTitle'))}</strong> <span>· ${esc(state.runtimeError.message || '')}</span></div>
      <div class="notice-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-notice-action="retry">${esc(t('retry'))}</button>
        <button class="icon-btn icon-btn-sm" type="button" data-notice-action="dismiss-error" title="${esc(t('close'))}" aria-label="${esc(t('close'))}">${icon('x', 13)}</button>
      </div>
    </div>`);
  }
  dom.noticeZone.innerHTML = notices.join('');
}

/* -------------------------------------------------------------------- sheet */

function openSheet(mode, sourceRule) {
  if (mode === 'edit' && !sourceRule) return;
  if (state.drawer) closeDrawer({ remember: true });
  closeMenu();

  const lastFocus = document.activeElement;
  let rule;
  let restored = false;
  if (mode === 'new') {
    if (state.draft && state.draft.rule) {
      rule = cloneRule(state.draft.rule);
      restored = true;
    } else {
      rule = createRule({ type: 'allow' });
    }
  } else {
    rule = cloneRule(sourceRule);
  }

  const errors = validateRule(rule);
  state.sheet = {
    mode,
    rule,
    errors,
    showErrors: mode === 'edit',
    touched: mode === 'edit' || restored,
    restored,
    saveState: mode === 'edit' ? 'saved' : restored ? 'draft' : 'idle',
    timer: null,
    chain: Promise.resolve(),
    version: 0,
    closing: false,
    lastFocus,
  };

  renderOverlay();
  requestAnimationFrame(() => {
    const field = dom.overlayRoot.querySelector('[data-sheet-field="pattern"]');
    if (field) {
      field.focus();
      const length = field.value.length;
      try {
        field.setSelectionRange(length, length);
      } catch {
        /* ignore */
      }
    }
  });
}

function renderOverlay() {
  if (state.sheet) {
    dom.overlayRoot.innerHTML = sheetHtml(state.sheet);
  } else if (state.drawer) {
    dom.overlayRoot.innerHTML = drawerHtml(state.drawer);
  } else {
    dom.overlayRoot.innerHTML = '';
  }
}

function saveStateHtml(kind) {
  if (kind === 'saving') return `${icon('rotate', 11)}<span>${esc(t('saveStateSaving'))}</span>`;
  if (kind === 'draft') return `${icon('file', 11)}<span>${esc(t('saveStateDraft'))}</span>`;
  if (kind === 'saved') return `${icon('check', 11)}<span>${esc(t('saveStateSaved'))}</span>`;
  return '';
}

function saveStateClass(kind) {
  if (kind === 'saving') return 'is-saving';
  if (kind === 'draft') return 'is-draft';
  return '';
}

function sheetHtml(sheet) {
  const rule = sheet.rule;
  const show = sheet.showErrors;
  const errors = sheet.errors;
  const isEdit = sheet.mode === 'edit';
  const saveKind = sheet.saveState;
  const typeHint = t(`typeHint.${rule.type}`);

  return `<div class="scrim" data-overlay-close="sheet"></div>
  <aside class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="sheet-head">
      <div>
        <h2 id="sheetTitle">${esc(isEdit ? t('sheetEdit') : t('sheetNew'))}</h2>
      </div>
      <div class="sheet-head-right">
        <span class="save-state ${saveStateClass(saveKind)}" id="sheetSaveState" title="${esc(t('autosaveNote'))}">${saveStateHtml(saveKind)}</span>
        <div class="enable-control">
          <span>${esc(t('enabled'))}</span>
          <button class="switch switch-sm" type="button" role="switch" data-sheet-action="toggle-enabled" aria-checked="${rule.enabled}" aria-label="${esc(t('enabled'))}">
            <span class="switch-thumb"></span>
          </button>
        </div>
        <button class="icon-btn" type="button" data-overlay-close="sheet" aria-label="${esc(t('close'))}" title="${esc(t('close'))}">${icon('x', 16)}</button>
      </div>
    </div>

    <div class="sheet-body">
      <div class="field">
        <div class="label-row type-label-row">
          <span class="label">${esc(t('sheetType'))}</span>
          <span class="type-summary" id="sheetTypeSummary">${esc(typeHint)}</span>
        </div>
        <div class="type-grid" role="radiogroup" aria-label="${esc(t('sheetType'))}">
          ${RULE_TYPES.map(
            (type) => `<button class="type-card tone-${type}" type="button" role="radio" aria-checked="${rule.type === type}" data-sheet-type="${type}">
              ${icon(TYPE_ICON[type], 16)}<span>${esc(typeLabel(type))}</span>
            </button>`,
          ).join('')}
        </div>
        <div class="cors-option" id="sheetCorsOption" ${rule.type === 'allow' ? '' : 'hidden'}>
          <label class="check"><input type="checkbox" data-sheet-cors ${rule.cors !== false ? 'checked' : ''} />${esc(t('corsOption'))}</label>
          <span class="hint">${esc(t('corsOptionHint'))}</span>
        </div>
      </div>

      <div class="field">
        <label class="label" for="sheetLabel">${esc(t('sheetLabel'))} <span class="opt">${esc(t('optional'))}</span></label>
        <input class="input" id="sheetLabel" data-sheet-field="label" maxlength="80" autocomplete="off" placeholder="${esc(t('labelPlaceholder'))}" value="${esc(rule.label)}" />
      </div>

      <div class="field">
        <label class="label" for="sheetPattern">${esc(t('sheetUrl'))} <span class="req">*</span></label>
        <div class="url-row">
          <div class="select-field method-inline" title="${esc(t('sheetMethod'))}">
            <select id="sheetMethod" data-sheet-method aria-label="${esc(t('sheetMethod'))}">
              <option value="ANY" ${rule.method === METHOD_ANY ? 'selected' : ''}>${esc(t('methodAny'))}</option>
              ${METHODS.map((method) => `<option value="${method}" ${rule.method === method ? 'selected' : ''}>${method}</option>`).join('')}
            </select>
            <span class="select-chevron">${icon('chevronDown', 12)}</span>
          </div>
          <input class="input mono ${show && errors.patternError ? 'is-invalid' : ''}" id="sheetPattern" data-sheet-field="pattern" maxlength="500" spellcheck="false" autocomplete="off" placeholder="${esc(t('urlPlaceholder'))}" value="${esc(rule.pattern)}" />
        </div>
        <p class="hint">${esc(t('urlHelp'))} ${esc(t('methodHelp'))}</p>
        <p class="error-text" id="sheetPatternError" ${show && errors.patternError ? '' : 'hidden'}>${icon('alert', 11)}<span>${esc(errors.patternError ? errorMessage(errors.patternError, 'pattern') : '')}</span></p>
      </div>

      <div class="field" id="sheetRedirectField" ${rule.type === 'redirect' ? '' : 'hidden'}>
        <label class="label" for="sheetRedirect">${esc(t('redirectTo'))} <span class="req">*</span></label>
        <input class="input mono ${show && errors.redirectError ? 'is-invalid' : ''}" id="sheetRedirect" data-sheet-field="redirectTo" maxlength="2000" spellcheck="false" autocomplete="off" placeholder="${esc(t('redirectPlaceholder'))}" value="${esc(rule.redirectTo)}" />
        <p class="hint">${esc(t('redirectHelp'))}</p>
        <p class="error-text" id="sheetRedirectError" ${show && errors.redirectError ? '' : 'hidden'}>${icon('alert', 11)}<span>${esc(errors.redirectError ? errorMessage(errors.redirectError, 'redirect') : '')}</span></p>
      </div>

      <div id="sheetPayloadFields" ${rule.type === 'allow' ? '' : 'hidden'}>
        <div class="field">
          <div class="label-row">
            <span class="label">${esc(t('requestHeaders'))} <span class="opt">${esc(t('optional'))}</span></span>
            <button class="btn btn-ghost btn-sm" type="button" data-sheet-action="add-header">${icon('plus', 12)}${esc(t('addHeader'))}</button>
          </div>
          <div class="headers-editor" id="sheetHeaders">${headerRowsHtml(sheet)}</div>
        </div>

        <div class="field">
          <label class="label" for="sheetCookie">${esc(t('cookieLabel'))} <span class="opt">${esc(t('optional'))}</span></label>
          <input class="input mono ${show && errors.cookieError ? 'is-invalid' : ''}" id="sheetCookie" data-sheet-field="cookie" maxlength="8000" spellcheck="false" autocomplete="off" placeholder="${esc(t('cookiePlaceholder'))}" value="${esc(rule.cookie)}" />
          <p class="hint">${esc(t('cookieHelp'))}</p>
          <p class="error-text" id="sheetCookieError" ${show && errors.cookieError ? '' : 'hidden'}>${icon('alert', 11)}<span>${esc(errors.cookieError ? errorMessage(errors.cookieError, 'cookie') : '')}</span></p>
        </div>
      </div>

      <details class="details">
        <summary>${icon('chevronRight', 12)}${esc(t('advanced'))}</summary>
        <div class="field">
          <label class="label" for="sheetTestUrl">${esc(t('testUrl'))}</label>
          <input class="input mono" id="sheetTestUrl" data-sheet-field="testUrl" maxlength="2000" spellcheck="false" autocomplete="off" placeholder="${esc(t('testUrlPlaceholder'))}" value="${esc(rule.testUrl || '')}" />
          <p class="hint">${esc(t('testUrlHelp'))}</p>
        </div>
      </details>

      <p class="note-line" id="sheetInvalidNote" ${isEdit && !errors.valid ? '' : 'hidden'}>${icon('info', 11)}${esc(t('invalidNote'))}</p>
    </div>

    <div class="sheet-foot">
      ${
        isEdit
          ? `<button class="btn btn-quiet btn-danger btn-sm" type="button" data-sheet-action="delete">${icon('trash', 13)}${esc(t('sheetDelete'))}</button>`
          : `<button class="btn btn-quiet btn-sm" type="button" data-sheet-action="discard">${esc(t('discardDraft'))}</button>`
      }
      <span class="autosave-note">${icon('lock', 11)}${esc(t('autosaveNote'))}</span>
      <div class="foot-actions">
        ${
          isEdit
            ? `<button class="btn btn-primary" type="button" data-sheet-action="done">${esc(t('done'))}</button>`
            : `<button class="btn btn-ghost" type="button" data-sheet-action="cancel">${esc(t('cancel'))}</button>
               <button class="btn btn-primary" type="button" data-sheet-action="add">${esc(t('addRule'))}</button>`
        }
      </div>
    </div>
  </aside>`;
}

function headerRowsHtml(sheet) {
  const show = sheet.showErrors;
  return sheet.rule.headers
    .map((header) => {
      const error = show ? sheet.errors.headerErrors[header.id] : null;
      const disabled = header.op === 'remove';
      return `<div class="header-row ${error ? 'has-error' : ''}" data-header-id="${esc(header.id)}">
        <input class="input mono" data-header-field="key" maxlength="256" spellcheck="false" autocomplete="off" placeholder="${esc(t('headerKey'))}" aria-label="${esc(t('headerKey'))}" value="${esc(header.key)}" />
        <input class="input mono" data-header-field="value" maxlength="4000" spellcheck="false" autocomplete="off" ${disabled ? 'disabled' : ''} placeholder="${disabled ? '—' : esc(t('headerValue'))}" aria-label="${esc(t('headerValue'))}" value="${esc(header.value)}" />
        <select class="select-input" data-header-field="op" aria-label="${esc(t('headerKey'))}">
          ${['set', 'remove']
            .map((op) => `<option value="${op}" ${header.op === op ? 'selected' : ''}>${esc(t(`op${op[0].toUpperCase()}${op.slice(1)}`))}</option>`)
            .join('')}
        </select>
        <button class="icon-btn" type="button" data-sheet-action="remove-header" aria-label="${esc(t('delete'))}" title="${esc(t('delete'))}">${icon('trash', 13)}</button>
        <p class="error-text header-error" data-header-error="${esc(header.id)}" ${error ? '' : 'hidden'}>${error ? esc(errorMessage(error, 'header')) : ''}</p>
      </div>`;
    })
    .join('');
}

function setSheetSaveState(kind) {
  const sheet = state.sheet;
  if (sheet) sheet.saveState = kind;
  const node = dom.overlayRoot.querySelector('#sheetSaveState');
  if (!node) return;
  node.className = `save-state ${saveStateClass(kind)}`;
  node.innerHTML = saveStateHtml(kind);
  node.title = t('autosaveNote');
}

function updateFieldErrors() {
  const sheet = state.sheet;
  if (!sheet) return;
  const show = sheet.showErrors;
  const errors = sheet.errors;

  const mark = (inputSelector, errorSelector, code, field) => {
    const input = dom.overlayRoot.querySelector(inputSelector);
    const error = dom.overlayRoot.querySelector(errorSelector);
    if (input) input.classList.toggle('is-invalid', Boolean(show && code));
    if (error) {
      error.hidden = !(show && code);
      error.innerHTML = show && code ? `${icon('alert', 11)}<span>${esc(errorMessage(code, field))}</span>` : '';
    }
  };

  mark('#sheetPattern', '#sheetPatternError', errors.patternError, 'pattern');
  mark('#sheetRedirect', '#sheetRedirectError', errors.redirectError, 'redirect');
  mark('#sheetCookie', '#sheetCookieError', errors.cookieError, 'cookie');

  for (const row of dom.overlayRoot.querySelectorAll('[data-header-id]')) {
    const id = row.dataset.headerId;
    const code = show ? errors.headerErrors[id] : null;
    row.classList.toggle('has-error', Boolean(code));
    const errorNode = row.querySelector('[data-header-error]');
    if (errorNode) {
      errorNode.hidden = !code;
      errorNode.textContent = code ? errorMessage(code, 'header') : '';
    }
  }

  const invalidNote = dom.overlayRoot.querySelector('#sheetInvalidNote');
  if (invalidNote) invalidNote.hidden = !(sheet.mode === 'edit' && !errors.valid);
}

function updateSheetTypeUi() {
  const sheet = state.sheet;
  if (!sheet) return;
  for (const card of dom.overlayRoot.querySelectorAll('[data-sheet-type]')) {
    card.setAttribute('aria-checked', String(card.dataset.sheetType === sheet.rule.type));
  }
  const summary = dom.overlayRoot.querySelector('#sheetTypeSummary');
  if (summary) summary.textContent = t(`typeHint.${sheet.rule.type}`);
  const redirectField = dom.overlayRoot.querySelector('#sheetRedirectField');
  if (redirectField) redirectField.hidden = sheet.rule.type !== 'redirect';
  const corsOption = dom.overlayRoot.querySelector('#sheetCorsOption');
  if (corsOption) corsOption.hidden = sheet.rule.type !== 'allow';
  const payloadFields = dom.overlayRoot.querySelector('#sheetPayloadFields');
  if (payloadFields) payloadFields.hidden = sheet.rule.type !== 'allow';
  updateFieldErrors();
}

function refreshHeaderRows() {
  const sheet = state.sheet;
  if (!sheet) return;
  const container = dom.overlayRoot.querySelector('#sheetHeaders');
  if (container) container.innerHTML = headerRowsHtml(sheet);
  updateFieldErrors();
}

function addHeaderRow() {
  const sheet = state.sheet;
  if (!sheet) return;
  if (sheet.rule.headers.length >= 30) return;
  sheet.rule.headers.push({ id: uid(), key: '', value: '', op: 'set' });
  sheet.errors = validateRule(sheet.rule);
  refreshHeaderRows();
  const rows = dom.overlayRoot.querySelectorAll('.header-row');
  const last = rows[rows.length - 1];
  last?.querySelector('[data-header-field="key"]')?.focus();
  scheduleSheetPersist();
}

function removeHeaderRow(id) {
  const sheet = state.sheet;
  if (!sheet) return;
  sheet.rule.headers = sheet.rule.headers.filter((header) => header.id !== id);
  sheet.errors = validateRule(sheet.rule);
  refreshHeaderRows();
  dom.overlayRoot.querySelector('[data-sheet-action="add-header"]')?.focus();
  scheduleSheetPersist();
}

function setSheetType(type) {
  const sheet = state.sheet;
  if (!sheet || !RULE_TYPES.includes(type) || sheet.rule.type === type) return;
  sheet.rule.type = type;
  sheet.errors = validateRule(sheet.rule);
  updateSheetTypeUi();
  scheduleSheetPersist();
}

function scheduleSheetPersist() {
  const sheet = state.sheet;
  if (!sheet) return;
  sheet.touched = true;
  sheet.version += 1;
  setSheetSaveState('saving');
  if (sheet.timer) clearTimeout(sheet.timer);
  const version = sheet.version;
  sheet.timer = setTimeout(() => {
    sheet.timer = null;
    queueSheetWrite(sheet, version);
  }, 300);
}

function queueSheetWrite(sheet, version) {
  sheet.chain = sheet.chain
    .then(async () => {
      await persistSheetNow(sheet);
      if (state.sheet === sheet && sheet.version === version) {
        setSheetSaveState(sheet.mode === 'edit' ? 'saved' : 'draft');
      }
    })
    .catch((error) => {
      console.warn('[ReqDeck] autosave failed', error);
      showToast(t('saveFailed'), { icon: 'alert' });
      if (state.sheet === sheet) setSheetSaveState('idle');
    });
}

async function persistSheetNow(sheet) {
  if (!sheet || !sheet.touched) return;
  const snapshot = cloneRule(sheet.rule);
  snapshot.updatedAt = Date.now();
  if (sheet.mode === 'edit') {
    const index = state.rules.findIndex((rule) => rule.id === snapshot.id);
    if (index < 0) return;
    state.rules[index] = snapshot;
    await saveRules(state.rules);
    renderList();
    renderStatus();
  } else {
    state.draft = { rule: cloneRule(snapshot), savedAt: Date.now(), origin: 'new' };
    await saveDraft(snapshot);
    renderNotices();
  }
}

function flushSheetSync() {
  const sheet = state.sheet;
  if (!sheet || !sheet.touched) return;
  if (sheet.timer) {
    clearTimeout(sheet.timer);
    sheet.timer = null;
  }
  const snapshot = cloneRule(sheet.rule);
  snapshot.updatedAt = Date.now();
  if (sheet.mode === 'edit') {
    const index = state.rules.findIndex((rule) => rule.id === snapshot.id);
    if (index >= 0) {
      state.rules[index] = snapshot;
      void saveRules(state.rules);
    }
  } else {
    void saveDraft(snapshot);
  }
}

async function closeSheet(options = {}) {
  const sheet = state.sheet;
  if (!sheet || sheet.closing) return;
  const { discard = false, restoreFocus = true } = options;
  sheet.closing = true;
  if (sheet.timer) {
    clearTimeout(sheet.timer);
    sheet.timer = null;
  }
  try {
    if (discard) {
      await sheet.chain.catch(() => {});
      if (sheet.mode === 'new') {
        await clearDraft().catch(() => {});
        state.draft = null;
      }
    } else if (sheet.touched) {
      sheet.chain = sheet.chain.then(() => persistSheetNow(sheet)).catch(() => {});
      await sheet.chain;
    }
  } catch (error) {
    console.warn('[ReqDeck] close save failed', error);
  }
  state.sheet = null;
  dom.overlayRoot.innerHTML = '';
  if (restoreFocus) sheet.lastFocus?.focus?.();
  renderAll();
}

async function commitNewRule() {
  const sheet = state.sheet;
  if (!sheet || sheet.mode !== 'new') return;
  sheet.showErrors = true;
  sheet.rule.label = sheet.rule.label.trim();
  sheet.rule.pattern = sheet.rule.pattern.trim();
  sheet.rule.redirectTo = sheet.rule.redirectTo.trim();
  sheet.rule.cookie = sheet.rule.cookie.trim();
  sheet.rule.testUrl = (sheet.rule.testUrl || '').trim();
  sheet.rule.headers = sheet.rule.headers.filter((header) => header.key.trim() || header.value.trim());
  sheet.errors = validateRule(sheet.rule);
  updateFieldErrors();
  if (!sheet.errors.valid) {
    focusFirstSheetError();
    return;
  }
  if (state.rules.length >= MAX_RULES) {
    showToast(t('toastLimit', { max: MAX_RULES }), { iconName: 'alert' });
    return;
  }

  if (sheet.timer) {
    clearTimeout(sheet.timer);
    sheet.timer = null;
  }
  await sheet.chain.catch(() => {});

  const now = Date.now();
  const rule = cloneRule(sheet.rule);
  rule.id = rule.id || uid();
  rule.createdAt = rule.createdAt || now;
  rule.updatedAt = now;
  sheet.closing = true;
  state.rules.push(rule);
  try {
    await saveRules(state.rules);
    await clearDraft().catch(() => {});
  } catch (error) {
    console.warn('[ReqDeck] could not add rule', error);
    state.rules = state.rules.filter((item) => item.id !== rule.id);
    sheet.closing = false;
    showToast(t('saveFailed'), { icon: 'alert' });
    return;
  }
  state.rules[state.rules.length - 1] = rule;
  state.draft = null;
  state.sheet = null;
  dom.overlayRoot.innerHTML = '';
  const lastFocus = sheet.lastFocus;
  renderAll();
  lastFocus?.focus?.();
  showToast(t('toastAdded'), { icon: 'check' });
}

async function deleteCurrentRule() {
  const sheet = state.sheet;
  if (!sheet || sheet.mode !== 'edit') return;
  if (sheet.timer) {
    clearTimeout(sheet.timer);
    sheet.timer = null;
  }
  await sheet.chain.catch(() => {});
  sheet.closing = true;
  const index = state.rules.findIndex((rule) => rule.id === sheet.rule.id);
  const lastFocus = sheet.lastFocus;
  state.sheet = null;
  dom.overlayRoot.innerHTML = '';
  if (index >= 0) {
    await deleteRuleAt(index, { restoreFocus: lastFocus });
  } else {
    renderAll();
  }
}

function focusFirstSheetError() {
  const sheet = state.sheet;
  if (!sheet) return;
  const selectors = [];
  if (sheet.errors.patternError) selectors.push('[data-sheet-field="pattern"]');
  if (sheet.errors.redirectError) selectors.push('[data-sheet-field="redirectTo"]');
  if (sheet.errors.headersError || Object.keys(sheet.errors.headerErrors).length) {
    selectors.push('[data-header-field="key"]');
  }
  if (sheet.errors.cookieError) selectors.push('[data-sheet-field="cookie"]');
  const target = selectors.map((selector) => dom.overlayRoot.querySelector(selector)).find(Boolean);
  if (target) {
    target.focus();
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function handleSheetClick(event) {
  const sheet = state.sheet;
  if (!sheet) return;
  const typeButton = event.target.closest('[data-sheet-type]');
  if (typeButton) {
    setSheetType(typeButton.dataset.sheetType);
    return;
  }
  const actionEl = event.target.closest('[data-sheet-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.sheetAction;
  switch (action) {
    case 'toggle-enabled': {
      sheet.rule.enabled = !sheet.rule.enabled;
      actionEl.setAttribute('aria-checked', String(sheet.rule.enabled));
      scheduleSheetPersist();
      break;
    }
    case 'add-header':
      addHeaderRow();
      break;
    case 'remove-header': {
      const row = actionEl.closest('[data-header-id]');
      if (row) removeHeaderRow(row.dataset.headerId);
      break;
    }
    case 'delete':
      void deleteCurrentRule();
      break;
    case 'discard':
      void closeSheet({ discard: true });
      break;
    case 'cancel':
    case 'done':
      void closeSheet();
      break;
    case 'add':
      void commitNewRule();
      break;
    default:
      break;
  }
}

function handleSheetInput(event) {
  const sheet = state.sheet;
  if (!sheet) return;
  const fieldEl = event.target.closest('[data-sheet-field]');
  if (fieldEl) {
    const field = fieldEl.dataset.sheetField;
    if (!['label', 'pattern', 'redirectTo', 'cookie', 'testUrl'].includes(field)) return;
    sheet.rule[field] = fieldEl.value;
    sheet.errors = validateRule(sheet.rule);
    updateFieldErrors();
    scheduleSheetPersist();
    return;
  }
  const headerEl = event.target.closest('[data-header-field]');
  if (headerEl && headerEl.dataset.headerField !== 'op') {
    const row = headerEl.closest('[data-header-id]');
    const header = sheet.rule.headers.find((item) => item.id === row?.dataset.headerId);
    if (!header) return;
    header[headerEl.dataset.headerField] = headerEl.value;
    sheet.errors = validateRule(sheet.rule);
    updateFieldErrors();
    scheduleSheetPersist();
  }
}

function handleSheetChange(event) {
  const sheet = state.sheet;
  if (!sheet) return;
  const methodEl = event.target.closest('[data-sheet-method]');
  if (methodEl) {
    sheet.rule.method = methodEl.value === METHOD_ANY ? METHOD_ANY : METHODS.includes(methodEl.value) ? methodEl.value : METHOD_ANY;
    scheduleSheetPersist();
    return;
  }
  if (event.target.matches('[data-sheet-cors]')) {
    sheet.rule.cors = Boolean(event.target.checked);
    scheduleSheetPersist();
    return;
  }
  const headerEl = event.target.closest('[data-header-field="op"]');
  if (!headerEl) return;
  const row = headerEl.closest('[data-header-id]');
  const header = sheet.rule.headers.find((item) => item.id === row?.dataset.headerId);
  if (!header) return;
  header.op = headerEl.value;
  if (header.op === 'remove') {
    header.value = '';
  }
  const valueInput = row.querySelector('[data-header-field="value"]');
  if (valueInput) {
    valueInput.disabled = header.op === 'remove';
    valueInput.value = header.value;
    valueInput.placeholder = header.op === 'remove' ? '—' : t('headerValue');
  }
  sheet.errors = validateRule(sheet.rule);
  updateFieldErrors();
  scheduleSheetPersist();
}

/* ------------------------------------------------------------------- drawer */

function openDrawer(rule) {
  if (state.sheet) return;
  closeMenu();
  const last = state.lastTests[rule.id] || {};
  const ruleMethod = METHODS.includes(rule.method) ? rule.method : null;
  const method =
    ruleMethod ||
    (METHODS.includes(String(last.method || '').toUpperCase()) ? String(last.method).toUpperCase() : 'GET');
  const url = String(last.url || rule.testUrl || sampleTarget(rule) || '').trim();
  state.drawer = {
    rule: cloneRule(rule),
    method,
    url,
    body: toText(last.body, 200 * 1024),
    useRuleHeaders: true,
    withCredentials: false,
    showBody: ['POST', 'PUT', 'PATCH'].includes(method) || Boolean(last.body),
    response: null,
    loading: false,
    error: null,
    urlError: null,
    tab: 'body',
    pretty: true,
    token: 0,
    lastFocus: document.activeElement,
  };
  renderOverlay();
  requestAnimationFrame(() => {
    const input = dom.overlayRoot.querySelector('#drawerUrl');
    if (!input) return;
    input.focus();
    const length = input.value.length;
    try {
      input.setSelectionRange(length, length);
    } catch {
      /* ignore */
    }
  });
}

function drawerBodyAllowed(drawer) {
  return !['GET', 'HEAD'].includes(drawer.method);
}

function drawerHtml(drawer) {
  const headers = drawer.rule.type === 'allow' ? usableHeaders(drawer.rule) : [];
  const bodyAllowed = drawerBodyAllowed(drawer);
  return `<div class="scrim" data-overlay-close="drawer"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
    <div class="drawer-head">
      <div class="drawer-title">
        <span class="type-chip tone-${drawer.rule.type}">${icon(TYPE_ICON[drawer.rule.type], 15)}</span>
        <div>
          <p class="kicker">${esc(t('sendKicker'))}</p>
          <h2 id="drawerTitle">${esc(t('sendTitle'))}</h2>
        </div>
      </div>
      <button class="icon-btn" type="button" data-overlay-close="drawer" aria-label="${esc(t('close'))}" title="${esc(t('close'))}">${icon('x', 16)}</button>
    </div>

    <div class="drawer-body">
      <div>
        <div class="request-row">
          <div class="method-field">
            <select id="drawerMethod" aria-label="HTTP method">
              ${METHODS.map((method) => `<option value="${method}" ${drawer.method === method ? 'selected' : ''}>${method}</option>`).join('')}
            </select>
            <span class="select-chevron">${icon('chevronDown', 12)}</span>
          </div>
          <input class="input mono request-url ${drawer.urlError ? 'is-invalid' : ''}" id="drawerUrl" spellcheck="false" autocomplete="off" placeholder="${esc(t('sendUrlPlaceholder'))}" value="${esc(drawer.url)}" aria-label="URL" />
          <button class="btn btn-primary drawer-send" id="drawerSend" type="button" ${drawer.loading ? 'disabled aria-busy="true"' : ''}>
            ${icon('send', 13)}<span>${esc(drawer.loading ? t('sendSending') : t('sendSend'))}</span>
          </button>
        </div>
        <p class="error-text" id="drawerUrlError" ${drawer.urlError ? '' : 'hidden'}>${drawer.urlError ? `${icon('alert', 11)}<span>${esc(t('sendErrInvalidUrl'))}</span>` : ''}</p>
      </div>

      <div class="request-options">
        ${
          headers.length
            ? `<label class="check">
                <input type="checkbox" id="drawerUseHeaders" ${drawer.useRuleHeaders ? 'checked' : ''} />
                ${esc(t('sendRuleHeaders'))}
              </label>`
            : ''
        }
        <label class="check">
          <input type="checkbox" id="drawerCredentials" ${drawer.withCredentials ? 'checked' : ''} />
          ${esc(t('sendIncludeCookies'))}
        </label>
        <span class="response-fact">${headers.length} ${esc(pluralize(headers.length, 'headersShort'))}</span>
      </div>

      <div id="drawerNotes">${drawerNotesHtml(drawer)}</div>

      <details class="body-details" id="drawerBodyDetails" data-has-body="${drawer.body.trim() ? 'true' : 'false'}" ${drawer.showBody ? 'open' : ''}>
        <summary>${icon('chevronRight', 12)}<span>${esc(t('sendBodyLabel'))}</span></summary>
        <textarea class="textarea mono" id="drawerBody" spellcheck="false" placeholder="${esc(t('sendBodyPlaceholder'))}" ${bodyAllowed ? '' : 'disabled'}>${esc(drawer.body)}</textarea>
      </details>

      <div class="response-panel" id="responsePanel">${responsePanelHtml(drawer)}</div>
    </div>

    <div class="drawer-foot">
      <span class="note-line">${icon('globe', 11)}${esc(t('sendNote'))}</span>
    </div>
  </aside>`;
}

function drawerNotesHtml(drawer) {
  const headers = drawer.rule.type === 'allow' ? usableHeaders(drawer.rule) : [];
  const shownHeaders = drawer.useRuleHeaders ? headers : [];
  const pills = shownHeaders
    .slice(0, 5)
    .map(
      (header) =>
        `<span class="header-pill"><b>${esc(header.key)}</b><span>${esc(header.value || '—')}</span></span>`,
    )
    .join('');
  const extra =
    shownHeaders.length > 5 ? `<span class="header-pill">+${shownHeaders.length - 5}</span>` : '';
  const label = drawer.rule.label ? `${drawer.rule.label} · ` : '';
  return `
    <div class="rule-context">
      ${icon('terminal', 12)}
      <span>${esc(t('sendRule'))}</span>
      <code title="${esc(drawer.rule.pattern)}">${esc(label)}${esc(drawer.rule.pattern)}</code>
    </div>
    ${pills ? `<div class="sent-headers">${pills}${extra}</div>` : ''}
    ${drawer.useRuleHeaders && drawer.rule.type === 'allow' && drawer.rule.cookie.trim() ? `<p class="note-line">${icon('info', 11)}${esc(t('sendCookieNote'))}</p>` : ''}
    ${
      drawer.response && drawer.response.ignoredHeaders && drawer.response.ignoredHeaders.length
        ? `<p class="note-line">${icon('alert', 11)}${esc(t('sendIgnored', { headers: drawer.response.ignoredHeaders.join(', ') }))}</p>`
        : ''
    }
    ${
      drawer.response && drawer.response.bypassedRules === false
        ? `<p class="note-line">${icon('alert', 11)}${esc(t('sendBypassFailed'))}</p>`
        : ''
    }
  `;
}

function responseBodyView(drawer) {
  const response = drawer.response;
  if (!response || !response.body) return { raw: '', shown: '', json: false };
  if (response.body.binary) return { raw: '', shown: '', json: false };
  const raw = response.body.text || '';
  let json = false;
  let pretty = raw;
  const trimmed = raw.trim();
  if (trimmed && (/json/i.test(response.body.contentType || '') || trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
      json = true;
    } catch {
      json = false;
    }
  }
  return { raw, shown: json && drawer.pretty ? pretty : raw, json };
}

function responsePanelHtml(drawer) {
  if (drawer.loading) {
    return `<div class="response-loading">
      <div class="skeleton w-40"></div>
      <div class="skeleton w-90"></div>
      <div class="skeleton w-70"></div>
      <div class="skeleton tall"></div>
    </div>`;
  }

  if (drawer.error) {
    const error = drawer.error;
    const message =
      error.error === 'timeout'
        ? t('sendErrTimeout')
        : error.error === 'invalidUrl'
          ? t('sendErrInvalidUrl')
          : t('sendErrNetwork');
    return `<div class="response-error">
      <strong>${icon('alert', 13)}${esc(t('sendErrTitle'))}</strong>
      <span>${esc(message)}</span>
      ${error.detail ? `<code>${esc(error.detail)}</code>` : ''}
      <div style="margin-top: 4px">
        <button class="btn btn-ghost btn-sm" type="button" data-drawer-retry>${icon('rotate', 12)}${esc(t('sendRetry'))}</button>
      </div>
    </div>`;
  }

  const response = drawer.response;
  if (!response) {
    return `<div class="response-empty">
      <div class="response-empty-icon">${icon('terminal', 16)}</div>
      <p class="response-empty-title">${esc(t('sendEmptyTitle'))}</p>
      <p class="response-empty-body">${esc(t('sendEmptyBody'))}</p>
    </div>`;
  }

  const statusClass =
    response.status >= 200 && response.status < 300
      ? 'is-ok'
      : response.status >= 300 && response.status < 400
        ? 'is-warn'
        : 'is-bad';
  const body = responseBodyView(drawer);
  const responseHeaders = Array.isArray(response.headers) ? response.headers : [];
  const activeTab = drawer.tab === 'headers' ? 'headers' : 'body';
  const size = formatBytes(response.body ? response.body.bytes : 0);
  const truncated = Boolean(response.body && response.body.truncated);
  const finalUrl = response.finalUrl || drawer.url;

  let content = '';
  if (activeTab === 'headers') {
    content = `<table class="headers-table"><tbody>${
      responseHeaders.length
        ? responseHeaders
            .map(
              (header) =>
                `<tr><td>${esc(header.name)}</td><td>${esc(header.value)}</td></tr>`,
            )
            .join('')
        : `<tr><td colspan="2">—</td></tr>`
    }</tbody></table>`;
  } else if (response.body && response.body.binary) {
    content = `<div class="binary-note">${icon('file', 14)}<span>${esc(t('sendBinary', { size }))}</span></div>`;
  } else if (!body.shown) {
    content = `<div class="binary-note">${icon('terminal', 14)}<span>${esc(t('sendNoBody'))}</span></div>`;
  } else {
    content = `<pre class="body-pre">${esc(body.shown)}</pre>`;
  }

  return `<div class="response-top">
      <span class="status-pill ${statusClass}">${esc(String(response.status))} ${esc(response.statusText || '')}</span>
      <span class="response-fact">${esc(t('sendTime'))} <b>${Number(response.duration) || 0} ${esc(t('ms'))}</b></span>
      <span class="response-fact">${esc(t('sendSize'))} <b>${esc(size)}${truncated ? '+' : ''}</b></span>
      ${response.redirected ? `<span class="response-fact">${esc(t('sendRedirected'))}</span>` : ''}
      <span class="response-final" title="${esc(finalUrl)}">${esc(finalUrl)}</span>
    </div>
    <div class="response-tabs" role="tablist">
      <button class="tab" type="button" role="tab" data-drawer-tab="body" aria-selected="${activeTab === 'body'}">${esc(t('sendBodyTab'))}</button>
      <button class="tab" type="button" role="tab" data-drawer-tab="headers" aria-selected="${activeTab === 'headers'}">${esc(t('sendResHeaders'))} (${responseHeaders.length})</button>
      <div class="response-tools">
        ${body.json ? `<button class="tool-btn" type="button" data-drawer-pretty aria-pressed="${drawer.pretty}">${esc(drawer.pretty ? t('sendRaw') : t('sendPretty'))}</button>` : ''}
        <button class="tool-btn" type="button" data-drawer-copy title="${esc(t('sendCopyBody'))}">${icon('copy', 11)}${esc(t('copy'))}</button>
      </div>
    </div>
    <div class="response-content">${content}</div>
    ${
      truncated
        ? `<div class="response-note">${icon('info', 11)}${esc(t('sendTruncated'))}</div>`
        : ''
    }`;
}

function refreshResponse() {
  const drawer = state.drawer;
  if (!drawer) return;
  const panel = dom.overlayRoot.querySelector('#responsePanel');
  if (panel) panel.innerHTML = responsePanelHtml(drawer);
  refreshDrawerNotes();
  refreshSendButton();
}

function refreshDrawerNotes() {
  const drawer = state.drawer;
  const notes = dom.overlayRoot.querySelector('#drawerNotes');
  if (drawer && notes) notes.innerHTML = drawerNotesHtml(drawer);
}

function refreshSendButton() {
  const drawer = state.drawer;
  const button = dom.overlayRoot.querySelector('#drawerSend');
  if (!drawer || !button) return;
  button.disabled = drawer.loading;
  button.toggleAttribute('aria-busy', drawer.loading);
  button.innerHTML = `${icon('send', 13)}<span>${esc(drawer.loading ? t('sendSending') : t('sendSend'))}</span>`;
}

function showDrawerUrlError() {
  const input = dom.overlayRoot.querySelector('#drawerUrl');
  const error = dom.overlayRoot.querySelector('#drawerUrlError');
  input?.classList.add('is-invalid');
  if (error) {
    error.hidden = false;
    error.innerHTML = `${icon('alert', 11)}<span>${esc(t('sendErrInvalidUrl'))}</span>`;
  }
  input?.focus();
}

function rememberTest() {
  const drawer = state.drawer;
  if (!drawer || !drawer.url.trim()) return;
  state.lastTests[drawer.rule.id] = {
    url: drawer.url.trim(),
    method: drawer.method,
    body: drawer.body,
    at: Date.now(),
  };
  void saveLastTests(state.lastTests).catch(() => {});
}

async function sendRequest() {
  const drawer = state.drawer;
  if (!drawer || drawer.loading) return;
  const url = drawer.url.trim();
  if (!isHttpUrl(url)) {
    drawer.urlError = 'invalidUrl';
    showDrawerUrlError();
    return;
  }

  const token = ++drawer.token;
  drawer.loading = true;
  drawer.error = null;
  drawer.response = null;
  drawer.urlError = null;
  drawer.tab = 'body';
  refreshResponse();
  refreshSendButton();

  const payload = {
    url,
    method: drawer.method,
    withCredentials: drawer.withCredentials,
    body: drawerBodyAllowed(drawer) ? drawer.body : '',
    headers: drawer.useRuleHeaders
      ? usableHeaders(drawer.rule)
          .filter((header) => header.op !== 'remove')
          .map((header) => ({ key: header.key, value: header.value }))
      : [],
  };

  let result;
  try {
    if (!extensionRuntimeAvailable()) throw new Error('Extension runtime unavailable');
    result = await chrome.runtime.sendMessage({ type: 'testRequest', payload });
  } catch (error) {
    result = { ok: false, error: 'internal', detail: error?.message || String(error) };
  }

  if (state.drawer !== drawer || drawer.token !== token) return;

  drawer.loading = false;
  if (!result || typeof result !== 'object') {
    result = { ok: false, error: 'internal' };
  }
  if (result.ok) {
    drawer.response = result;
    drawer.error = null;
  } else {
    drawer.error = result;
    drawer.response = null;
  }
  rememberTest();
  refreshResponse();
  refreshSendButton();
  requestAnimationFrame(() => {
    dom.overlayRoot.querySelector('#responsePanel')?.scrollIntoView({ block: 'nearest' });
  });
}

function closeDrawer(options = {}) {
  const drawer = state.drawer;
  if (!drawer) return;
  if (options.remember !== false && drawer.url.trim()) {
    state.lastTests[drawer.rule.id] = {
      url: drawer.url.trim(),
      method: drawer.method,
      body: drawer.body,
      at: Date.now(),
    };
    void saveLastTests(state.lastTests).catch(() => {});
  }
  state.drawer = null;
  dom.overlayRoot.innerHTML = '';
  drawer.lastFocus?.focus?.();
}

function handleDrawerClick(event) {
  const drawer = state.drawer;
  if (!drawer) return;
  if (event.target.closest('#drawerSend')) {
    void sendRequest();
    return;
  }
  const tab = event.target.closest('[data-drawer-tab]');
  if (tab) {
    drawer.tab = tab.dataset.drawerTab;
    refreshResponse();
    return;
  }
  if (event.target.closest('[data-drawer-pretty]')) {
    drawer.pretty = !drawer.pretty;
    refreshResponse();
    return;
  }
  if (event.target.closest('[data-drawer-copy]')) {
    const view = responseBodyView(drawer);
    void copyText(view.raw || '');
    return;
  }
  if (event.target.closest('[data-drawer-retry]')) {
    void sendRequest();
  }
}

function handleDrawerInput(event) {
  const drawer = state.drawer;
  if (!drawer) return;
  if (event.target.id === 'drawerUrl') {
    drawer.url = event.target.value;
    if (drawer.urlError) {
      drawer.urlError = null;
      const error = dom.overlayRoot.querySelector('#drawerUrlError');
      if (error) error.hidden = true;
      event.target.classList.remove('is-invalid');
    }
    return;
  }
  if (event.target.id === 'drawerBody') {
    drawer.body = event.target.value;
    const details = dom.overlayRoot.querySelector('#drawerBodyDetails');
    if (details) details.dataset.hasBody = drawer.body.trim() ? 'true' : 'false';
  }
}

function handleDrawerChange(event) {
  const drawer = state.drawer;
  if (!drawer) return;
  if (event.target.id === 'drawerMethod') {
    drawer.method = event.target.value;
    const allowed = drawerBodyAllowed(drawer);
    const bodyEl = dom.overlayRoot.querySelector('#drawerBody');
    if (bodyEl) bodyEl.disabled = !allowed;
    const details = dom.overlayRoot.querySelector('#drawerBodyDetails');
    if (details && allowed && ['POST', 'PUT', 'PATCH'].includes(drawer.method)) {
      details.open = true;
      drawer.showBody = true;
    }
    return;
  }
  if (event.target.id === 'drawerUseHeaders') {
    drawer.useRuleHeaders = event.target.checked;
    refreshDrawerNotes();
    return;
  }
  if (event.target.id === 'drawerCredentials') {
    drawer.withCredentials = event.target.checked;
  }
}

/* -------------------------------------------------------------------- toast */

function showToast(message, options = {}) {
  const { iconName = 'check', action, onAction, duration = action ? 6000 : 3200 } = options;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `${icon(iconName, 13)}<span>${esc(message)}</span>`;
  let remove = () => {};
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action;
    button.addEventListener('click', () => {
      remove();
      onAction?.();
    });
    toast.append(button);
  }
  dom.toastRoot.append(toast);
  while (dom.toastRoot.children.length > 3) dom.toastRoot.firstElementChild?.remove();
  const timer = setTimeout(() => remove(), duration);
  remove = () => {
    clearTimeout(timer);
    if (toast.isConnected) toast.remove();
  };
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    showToast(t('copied'), { iconName: 'copy' });
  } catch {
    showToast(t('toastCopyFailed'), { iconName: 'alert' });
  }
}

/* -------------------------------------------------------------------- menus */

function positionMenu(menu, anchor) {
  if (!menu || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  menu.style.left = 'auto';
  menu.style.top = `${rect.bottom + 7}px`;
  menu.style.right = `${Math.max(margin, window.innerWidth - rect.right)}px`;
  requestAnimationFrame(() => {
    if (!menu.isConnected) return;
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - margin) {
      const above = rect.top - menuRect.height - 7;
      menu.style.top = `${Math.max(margin, above)}px`;
    }
    if (menuRect.right > window.innerWidth - margin) {
      menu.style.right = `${margin}px`;
    }
  });
}

function closeMenu() {
  state.menu = null;
  dom.menuRoot.innerHTML = '';
  dom.settingsBtn.setAttribute('aria-expanded', 'false');
}

function settingsMenuHtml() {
  return `<div class="menu" role="menu" style="width: 238px">
    ${state.pageMode ? '' : `<button class="menu-item" type="button" data-menu-action="open-tab">${icon('external', 14)}${esc(t('menuOpenTab'))}</button>`}
    <button class="menu-item" type="button" data-menu-action="enable-all" ${state.rules.length ? '' : 'disabled'}>${icon('check', 14)}${esc(t('menuEnableAll'))}</button>
    <button class="menu-item" type="button" data-menu-action="disable-all" ${state.rules.length ? '' : 'disabled'}>${icon('block', 14)}${esc(t('menuDisableAll'))}</button>
    <div class="menu-sep"></div>
    <button class="menu-item" type="button" data-menu-action="export">${icon('download', 14)}${esc(t('menuExport'))}</button>
    <button class="menu-item" type="button" data-menu-action="import">${icon('upload', 14)}${esc(t('menuImport'))}</button>
    <button class="menu-item is-danger" type="button" data-menu-action="clear-all" ${state.rules.length ? '' : 'disabled'}>${icon('trash', 14)}${esc(t('menuClearAll'))}</button>
    <div class="menu-sep"></div>
    <div class="menu-row">
      <span>${esc(t('menuLanguage'))}</span>
      <div class="seg" role="group" aria-label="${esc(t('menuLanguage'))}">
        ${['auto', 'en', 'zh']
          .map(
            (lang) =>
              `<button type="button" data-menu-lang="${lang}" aria-pressed="${state.settings.lang === lang}">${esc(
                lang === 'auto' ? t('langAuto') : lang === 'en' ? 'English' : '中文',
              )}</button>`,
          )
          .join('')}
      </div>
    </div>
    <div class="menu-row">
      <span>${esc(t('menuTheme'))}</span>
      <div class="seg" role="group" aria-label="${esc(t('menuTheme'))}">
        ${[
          ['auto', 'auto', t('themeAuto')],
          ['light', 'sun', t('themeLight')],
          ['dark', 'moon', t('themeDark')],
        ]
          .map(
            ([value, iconName, label]) =>
              `<button type="button" data-menu-theme="${value}" aria-pressed="${state.settings.theme === value}" title="${esc(label)}" aria-label="${esc(label)}">${icon(iconName, 12)}</button>`,
          )
          .join('')}
      </div>
    </div>
    <div class="menu-row">
      <span>${esc(t('menuHitCounting'))}</span>
      <button class="switch switch-sm" type="button" role="switch" data-menu-action="toggle-hits" aria-checked="${state.settings.countHits}" aria-label="${esc(t('menuHitCounting'))}">
        <span class="switch-thumb"></span>
      </button>
    </div>
    <button class="menu-item" type="button" data-menu-action="reset-hits">${icon('rotate', 14)}${esc(t('menuResetHits'))}</button>
  </div>`;
}

function openSettingsMenu(anchor) {
  if (state.menu && state.menu.type === 'settings') {
    closeMenu();
    return;
  }
  closeMenu();
  state.menu = { type: 'settings', anchor };
  dom.menuRoot.innerHTML = settingsMenuHtml();
  dom.settingsBtn.setAttribute('aria-expanded', 'true');
  positionMenu(dom.menuRoot.querySelector('.menu'), anchor);
}

function refreshSettingsMenu() {
  if (!state.menu || state.menu.type !== 'settings') return;
  const anchor = state.menu.anchor;
  dom.menuRoot.innerHTML = settingsMenuHtml();
  positionMenu(dom.menuRoot.querySelector('.menu'), anchor);
}

function openRuleMenu(anchor, rule) {
  if (state.menu && state.menu.type === 'rule' && state.menu.ruleId === rule.id) {
    closeMenu();
    return;
  }
  closeMenu();
  state.menu = { type: 'rule', anchor, ruleId: rule.id };
  dom.menuRoot.innerHTML = `<div class="menu" role="menu" style="width: 206px">
    <button class="menu-item" type="button" data-rule-menu-action="duplicate">${icon('copy', 14)}${esc(t('duplicateRule'))}</button>
    <button class="menu-item" type="button" data-rule-menu-action="copy-pattern">${icon('terminal', 14)}${esc(t('copyPattern'))}</button>
    <div class="menu-sep"></div>
    <button class="menu-item is-danger" type="button" data-rule-menu-action="delete">${icon('trash', 14)}${esc(t('delete'))}</button>
  </div>`;
  positionMenu(dom.menuRoot.querySelector('.menu'), anchor);
}

function handleMenuClick(event) {
  const langButton = event.target.closest('[data-menu-lang]');
  if (langButton) {
    void changeLanguage(langButton.dataset.menuLang);
    return;
  }
  const themeButton = event.target.closest('[data-menu-theme]');
  if (themeButton) {
    void changeTheme(themeButton.dataset.menuTheme);
    return;
  }
  const ruleAction = event.target.closest('[data-rule-menu-action]');
  if (ruleAction) {
    const menu = state.menu;
    closeMenu();
    const rule = menu ? getRule(menu.ruleId) : null;
    if (!rule) return;
    switch (ruleAction.dataset.ruleMenuAction) {
      case 'duplicate':
        void duplicateRule(rule);
        break;
      case 'copy-pattern':
        void copyText(rule.pattern);
        break;
      case 'delete': {
        const index = state.rules.findIndex((item) => item.id === rule.id);
        if (index >= 0) void deleteRuleAt(index);
        break;
      }
      default:
        break;
    }
    return;
  }
  const actionEl = event.target.closest('[data-menu-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.menuAction;
  switch (action) {
    case 'toggle-hits':
      state.settings = mergeSettings({ ...state.settings, countHits: !state.settings.countHits });
      void saveSettings(state.settings).catch(() => showToast(t('saveFailed'), { icon: 'alert' }));
      refreshSettingsMenu();
      break;
    case 'reset-hits':
      closeMenu();
      void resetHits();
      break;
    case 'open-tab':
      closeMenu();
      openInTab();
      break;
    case 'enable-all':
      closeMenu();
      void setAllRulesEnabled(true);
      break;
    case 'disable-all':
      closeMenu();
      void setAllRulesEnabled(false);
      break;
    case 'export':
      closeMenu();
      exportRules();
      break;
    case 'import':
      closeMenu();
      dom.importInput.value = '';
      dom.importInput.click();
      break;
    case 'clear-all':
      closeMenu();
      confirmClearAll();
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------- modals */

function showConfirm(options) {
  const { title, body, actions, onAction } = options;
  const lastFocus = document.activeElement;
  const buttons = (actions || [
    { value: 'cancel', label: t('cancel') },
    { value: 'confirm', label: t('confirm'), kind: 'primary' },
  ])
    .map((action) => {
      const cls =
        action.kind === 'primary' ? 'btn-primary' : action.kind === 'danger' ? 'btn-danger-solid' : 'btn-ghost';
      return `<button class="btn ${cls}" type="button" data-modal-value="${esc(action.value)}">${esc(action.label)}</button>`;
    })
    .join('');
  state.modal = { onAction, lastFocus };
  dom.modalRoot.innerHTML = `<div class="modal-scrim" data-modal-scrim>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <h3 id="modalTitle">${esc(title)}</h3>
      <p>${esc(body)}</p>
      <div class="modal-actions">${buttons}</div>
    </div>
  </div>`;
  requestAnimationFrame(() => {
    const focusTarget = dom.modalRoot.querySelector('.modal-actions .btn');
    focusTarget?.focus();
  });
}

function closeModal(options = {}) {
  const modal = state.modal;
  state.modal = null;
  dom.modalRoot.innerHTML = '';
  if (options.restoreFocus !== false) modal?.lastFocus?.focus?.();
}

function confirmClearAll() {
  showConfirm({
    title: t('confirmClearTitle'),
    body: t('confirmClearBody'),
    actions: [
      { value: 'cancel', label: t('cancel') },
      { value: 'clear', label: t('menuClearAll'), kind: 'danger' },
    ],
    onAction: (value) => {
      if (value === 'clear') void clearAllRules();
    },
  });
}

/* ------------------------------------------------------------------ actions */

function persistRules() {
  const snapshot = state.rules.map(cloneRule);
  rulesWriteChain = rulesWriteChain
    .then(async () => {
      await saveRules(snapshot);
    })
    .catch((error) => {
      console.warn('[ReqDeck] rules save failed', error);
      showToast(t('saveFailed'), { icon: 'alert' });
    });
  return rulesWriteChain;
}

function startNewRule() {
  if (state.rules.length >= MAX_RULES) {
    showToast(t('toastLimit', { max: MAX_RULES }), { iconName: 'alert' });
    return;
  }
  openSheet('new');
}

async function toggleRule(rule) {
  rule.enabled = !rule.enabled;
  rule.updatedAt = Date.now();
  renderList();
  renderStatus();
  await persistRules();
}

async function deleteRuleAt(index, options = {}) {
  const rule = state.rules[index];
  if (!rule) return;
  const removed = cloneRule(rule);
  const test = state.lastTests[rule.id];
  state.rules.splice(index, 1);
  delete state.lastTests[rule.id];
  renderAll();
  options.restoreFocus?.focus?.();
  await persistRules();
  if (test) void saveLastTests(state.lastTests).catch(() => {});
  showToast(t('toastRuleDeleted'), {
    iconName: 'trash',
    action: t('undo'),
    duration: 6500,
    onAction: () => {
      const insertAt = Math.min(index, state.rules.length);
      state.rules.splice(insertAt, 0, removed);
      if (test) state.lastTests[removed.id] = test;
      renderAll();
      void persistRules();
      if (test) void saveLastTests(state.lastTests).catch(() => {});
    },
  });
}

async function duplicateRule(rule) {
  const index = state.rules.findIndex((item) => item.id === rule.id);
  if (index < 0 || state.rules.length >= MAX_RULES) return;
  const copy = cloneRule(rule);
  copy.id = uid();
  copy.label = rule.label ? `${rule.label} ${t('copySuffix')}` : '';
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  state.rules.splice(index + 1, 0, copy);
  renderAll();
  await persistRules();
  showToast(t('toastDuplicated'), { iconName: 'copy' });
}

async function setAllRulesEnabled(enabled) {
  if (!state.rules.length) return;
  for (const rule of state.rules) {
    rule.enabled = enabled;
    rule.updatedAt = Date.now();
  }
  renderAll();
  await persistRules();
  showToast(enabled ? t('toastAllEnabled') : t('toastAllDisabled'), {
    iconName: enabled ? 'check' : 'block',
  });
}

async function setCorsAll(enabled) {
  state.settings = mergeSettings({ ...state.settings, allowAllCors: enabled });
  updateCorsUi();
  try {
    await saveSettings(state.settings);
  } catch {
    state.settings = mergeSettings({ ...state.settings, allowAllCors: !enabled });
    updateCorsUi();
    showToast(t('saveFailed'), { icon: 'alert' });
  }
}

async function changeLanguage(lang) {
  if (state.settings.lang === lang) {
    closeMenu();
    return;
  }
  state.settings = mergeSettings({ ...state.settings, lang });
  closeMenu();
  setLanguage(lang);
  applyStaticLocale();
  try {
    await saveSettings(state.settings);
  } catch {
    showToast(t('saveFailed'), { icon: 'alert' });
  }
}

async function changeTheme(theme) {
  state.settings = mergeSettings({ ...state.settings, theme });
  applyTheme(theme);
  refreshSettingsMenu();
  try {
    await saveSettings(state.settings);
  } catch {
    showToast(t('saveFailed'), { icon: 'alert' });
  }
}

async function resetHits() {
  try {
    await clearStats();
    state.meta.lastHour = 0;
    state.meta.ruleHits = {};
    renderStatus();
    updateHitLabels();
    showToast(t('toastStatsCleared'), { iconName: 'rotate' });
  } catch {
    showToast(t('saveFailed'), { icon: 'alert' });
  }
}

function openInTab() {
  try {
    const base = chrome.runtime.getURL('src/popup.html');
    chrome.tabs.create({ url: `${base}?view=page` });
  } catch {
    window.open(`${location.pathname}?view=page`, '_blank');
  }
}

function exportRules() {
  const payload = {
    format: 'reqdeck.rules',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    rules: state.rules,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  anchor.href = url;
  anchor.download = `${t('exportFileName')}-${stamp}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast(t('toastExported'), { iconName: 'download' });
}

function extractImportRules(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules)) list = parsed.rules;
  if (!list) return null;
  const rules = [];
  for (const raw of list.slice(0, MAX_RULES)) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = normalizeRule(raw);
    rule.pattern = rule.pattern.trim();
    if (!rule.pattern) continue;
    rules.push(rule);
  }
  return rules;
}

async function handleImportFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    showToast(t('toastInvalidFile'), { icon: 'alert' });
    return;
  }
  const rules = extractImportRules(text);
  if (rules === null) {
    showToast(t('toastImportInvalid'), { icon: 'alert' });
    return;
  }
  if (!rules.length) {
    showToast(t('toastImportEmpty'), { icon: 'alert' });
    return;
  }
  showConfirm({
    title: t('confirmImportTitle'),
    body: `${t('confirmImportBody')} · ${rules.length}`,
    actions: [
      { value: 'cancel', label: t('cancel') },
      { value: 'merge', label: t('confirmMerge'), kind: 'primary' },
      { value: 'replace', label: t('confirmReplace'), kind: 'danger' },
    ],
    onAction: (value) => {
      if (value === 'merge' || value === 'replace') void importRules(rules, value);
    },
  });
}

async function importRules(rules, mode) {
  let accepted;
  if (mode === 'replace') {
    accepted = rules.slice(0, MAX_RULES);
    state.rules = accepted;
  } else {
    const room = Math.max(0, MAX_RULES - state.rules.length);
    accepted = rules.slice(0, room);
    state.rules = [...state.rules, ...accepted];
  }
  renderAll();
  await persistRules();
  if (accepted.length === 0) {
    showToast(t('toastLimit', { max: MAX_RULES }), { iconName: 'alert' });
    return;
  }
  showToast(t(accepted.length === 1 ? 'toastImportedOne' : 'toastImported', { count: accepted.length }), {
    iconName: 'upload',
  });
}

async function clearAllRules() {
  state.rules = [];
  state.draft = null;
  state.lastTests = {};
  if (state.sheet) {
    state.sheet = null;
    dom.overlayRoot.innerHTML = '';
  }
  if (state.drawer) closeDrawer({ remember: false });
  renderAll();
  try {
    await saveRules([]);
    await clearDraft();
    await saveLastTests({});
    showToast(t('toastCleared'), { iconName: 'trash' });
  } catch {
    showToast(t('saveFailed'), { icon: 'alert' });
  }
}

function loadSamples() {
  const samples = makeSampleRules();
  if (state.rules.length + samples.length > MAX_RULES) {
    showToast(t('toastLimit', { max: MAX_RULES }), { iconName: 'alert' });
    return;
  }
  state.rules.push(...samples);
  renderAll();
  void persistRules();
  showToast(t('toastSamplesAdded'), { iconName: 'file' });
}

/* --------------------------------------------------------------------- meta */

async function refreshMeta() {
  if (!extensionRuntimeAvailable() || !chrome.runtime.sendMessage) {
    state.meta.version = extensionVersion();
    renderStatus();
    return;
  }
  try {
    const meta = await chrome.runtime.sendMessage({ type: 'meta' });
    if (meta && meta.ok) {
      state.meta = {
        lastHour: Number(meta.lastHour) || 0,
        ruleHits: meta.ruleHits && typeof meta.ruleHits === 'object' ? meta.ruleHits : {},
        version: meta.version || extensionVersion(),
      };
      renderStatus();
      updateHitLabels();
    }
  } catch {
    /* background may be waking up */
  }
}

/* ------------------------------------------------------------ storage sync */

function handleStorageChange(changes) {
  if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.rules)) {
    const incoming = rulesFromValue(changes[STORAGE_KEYS.rules]);
    if (!state.sheet) {
      if (JSON.stringify(incoming) !== JSON.stringify(state.rules)) {
        state.rules = incoming;
        renderAll();
      }
    } else if (state.sheet.mode === 'new') {
      // Keep changes made in another window while a new-rule draft is open.
      state.rules = incoming;
      renderStatus();
    } else {
      // Preserve the rule being edited locally, but absorb everything else.
      const local = cloneRule(state.sheet.rule);
      const localIndex = state.rules.findIndex((rule) => rule.id === local.id);
      const merged = incoming.map((rule) => (rule.id === local.id ? local : rule));
      if (!merged.some((rule) => rule.id === local.id) && localIndex >= 0) {
        merged.splice(Math.min(localIndex, merged.length), 0, local);
      }
      state.rules = merged;
      renderStatus();
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.settings)) {
    const incoming = mergeSettings(changes[STORAGE_KEYS.settings]);
    const previous = state.settings;
    if (JSON.stringify(incoming) !== JSON.stringify(previous)) {
      const languageChanged = incoming.lang !== previous.lang;
      state.settings = incoming;
      applyTheme(incoming.theme);
      if (languageChanged) {
        setLanguage(incoming.lang);
        localizeDom(document);
        document.title = `${t('appName')} · ${t('tagline')}`;
        dom.corsHelp.title = t('corsAllHint');
        dom.corsHelp.setAttribute('aria-label', t('corsAllHint'));
        rebuildFilters();
      }
      if (state.menu) closeMenu();
      renderAll();
      if (languageChanged && state.sheet) renderOverlay();
      if (languageChanged && state.drawer) renderOverlay();
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.draft) && !state.sheet) {
    const incoming = draftFromValue(changes[STORAGE_KEYS.draft]);
    if (JSON.stringify(incoming) !== JSON.stringify(state.draft)) {
      state.draft = incoming;
      renderNotices();
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.lastTests) && !state.drawer) {
    const incoming = changes[STORAGE_KEYS.lastTests];
    state.lastTests = incoming && typeof incoming === 'object' ? incoming : {};
  }

  if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.runtimeError)) {
    state.runtimeError = changes[STORAGE_KEYS.runtimeError] || null;
    renderNotices();
  }
}

/* --------------------------------------------------------------- keyboard */

function activeDialog() {
  if (state.modal) return dom.modalRoot.querySelector('.modal');
  if (state.sheet) return dom.overlayRoot.querySelector('.sheet');
  if (state.drawer) return dom.overlayRoot.querySelector('.drawer');
  return null;
}

function trapFocus(event) {
  const container = activeDialog();
  if (!container) return false;
  const focusable = $$(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    container,
  ).filter((node) => node.getClientRects().length > 0 && !node.hidden);
  if (!focusable.length) return false;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

function focusSearch() {
  if (state.sheet || state.drawer || state.modal) return;
  dom.searchInput.focus();
  dom.searchInput.select();
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    if (state.modal) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (state.menu) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (state.sheet) {
      event.preventDefault();
      void closeSheet();
      return;
    }
    if (state.drawer) {
      event.preventDefault();
      closeDrawer();
      return;
    }
  }

  if (event.key === 'Tab' && trapFocus(event)) return;

  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key === 'Enter') {
    if (state.drawer) {
      event.preventDefault();
      void sendRequest();
      return;
    }
    if (state.sheet) {
      event.preventDefault();
      if (state.sheet.mode === 'new') void commitNewRule();
      else void closeSheet();
      return;
    }
  }
  if (mod && (event.key === 'k' || event.key === 'K')) {
    if (state.sheet || state.drawer || state.modal) return;
    event.preventDefault();
    focusSearch();
    return;
  }
  if (mod && (event.key === 'n' || event.key === 'N')) {
    if (state.sheet || state.drawer || state.modal) return;
    event.preventDefault();
    startNewRule();
    return;
  }
  if (mod && (event.key === 's' || event.key === 'S')) {
    if (state.sheet) {
      event.preventDefault();
      flushSheetSync();
      showToast(t('saveStateSaved'), { icon: 'check', duration: 1600 });
    }
    return;
  }
  if (event.key === '/' && !isTypingTarget(event.target) && !state.sheet && !state.drawer && !state.modal) {
    event.preventDefault();
    focusSearch();
  }
}

/* ------------------------------------------------------------------ events */

function flushOnHide() {
  flushSheetSync();
  const drawer = state.drawer;
  if (drawer && drawer.url.trim()) {
    state.lastTests[drawer.rule.id] = {
      url: drawer.url.trim(),
      method: drawer.method,
      body: drawer.body,
      at: Date.now(),
    };
    void saveLastTests(state.lastTests).catch(() => {});
  }
}

function bindEvents() {
  dom.searchInput.addEventListener('input', () => {
    state.filters.q = dom.searchInput.value;
    renderList();
  });

  dom.typeFilter.addEventListener('change', () => {
    state.filters.type = dom.typeFilter.value;
    renderList();
  });

  dom.stateFilter.addEventListener('change', () => {
    state.filters.status = dom.stateFilter.value;
    renderList();
  });

  dom.corsAll.addEventListener('click', () => {
    void setCorsAll(!state.settings.allowAllCors);
  });

  dom.corsHelp.addEventListener('click', () => {
    showToast(t('corsAllHint'), { iconName: 'info', duration: 4800 });
  });

  dom.newRuleBtn.addEventListener('click', () => startNewRule());

  dom.settingsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openSettingsMenu(dom.settingsBtn);
  });

  dom.ruleList.addEventListener('click', (event) => {
    const row = event.target.closest('.rule-row');
    if (!row) return;
    const rule = getRule(row.dataset.ruleId);
    if (!rule) return;
    const actionEl = event.target.closest('[data-action]');
    const action = actionEl ? actionEl.dataset.action : 'open';
    switch (action) {
      case 'open':
        openSheet('edit', rule);
        break;
      case 'test':
        openDrawer(rule);
        break;
      case 'toggle':
        void toggleRule(rule);
        break;
      case 'more':
        event.stopPropagation();
        openRuleMenu(actionEl, rule);
        break;
      default:
        break;
    }
  });

  dom.emptyState.addEventListener('click', (event) => {
    const button = event.target.closest('[data-empty]');
    if (!button) return;
    switch (button.dataset.empty) {
      case 'new':
        startNewRule();
        break;
      case 'import':
        dom.importInput.value = '';
        dom.importInput.click();
        break;
      case 'samples':
        loadSamples();
        break;
      case 'open-tab':
        openInTab();
        break;
      case 'reset':
        state.filters = { q: '', type: 'all', status: 'all' };
        dom.searchInput.value = '';
        rebuildFilters();
        renderList();
        break;
      default:
        break;
    }
  });

  dom.noticeZone.addEventListener('click', (event) => {
    const button = event.target.closest('[data-notice-action]');
    if (!button) return;
    switch (button.dataset.noticeAction) {
      case 'resume':
        openSheet('new');
        break;
      case 'discard':
        void clearDraft()
          .then(() => {
            state.draft = null;
            renderNotices();
            showToast(t('toastDraftDiscarded'), { iconName: 'trash' });
          })
          .catch(() => showToast(t('saveFailed'), { icon: 'alert' }));
        break;
      case 'retry':
        state.dismissedErrorAt = state.runtimeError?.at || 0;
        renderNotices();
        if (extensionRuntimeAvailable()) {
          void chrome.runtime.sendMessage({ type: 'resync' }).catch(() => {});
        }
        break;
      case 'dismiss-error':
        state.dismissedErrorAt = state.runtimeError?.at || 0;
        renderNotices();
        break;
      default:
        break;
    }
  });

  dom.overlayRoot.addEventListener('click', (event) => {
    const close = event.target.closest('[data-overlay-close]');
    if (close) {
      if (close.dataset.overlayClose === 'sheet' && state.sheet) void closeSheet();
      else if (close.dataset.overlayClose === 'drawer' && state.drawer) closeDrawer();
      return;
    }
    if (state.sheet) handleSheetClick(event);
    else if (state.drawer) handleDrawerClick(event);
  });

  dom.overlayRoot.addEventListener('input', (event) => {
    if (state.sheet) handleSheetInput(event);
    else if (state.drawer) handleDrawerInput(event);
  });

  dom.overlayRoot.addEventListener('change', (event) => {
    if (state.sheet) handleSheetChange(event);
    else if (state.drawer) handleDrawerChange(event);
  });

  dom.menuRoot.addEventListener('click', handleMenuClick);

  dom.modalRoot.addEventListener('click', (event) => {
    const modal = state.modal;
    if (!modal) return;
    const button = event.target.closest('[data-modal-value]');
    if (button) {
      const value = button.dataset.modalValue;
      closeModal({ restoreFocus: false });
      modal.onAction?.(value);
      return;
    }
    if (event.target.hasAttribute('data-modal-scrim')) closeModal();
  });

  dom.importInput.addEventListener('change', () => {
    const file = dom.importInput.files && dom.importInput.files[0];
    dom.importInput.value = '';
    if (file) void handleImportFile(file);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!state.menu) return;
    if (event.target.closest('.menu')) return;
    if (state.menu.anchor && state.menu.anchor.contains(event.target)) return;
    closeMenu();
  });

  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', () => closeMenu());
  dom.listScroll.addEventListener('scroll', () => closeMenu(), { passive: true });
  window.addEventListener('pagehide', flushOnHide);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide();
    else if (state.ready) void refreshMeta();
  });
}

/* -------------------------------------------------------------------- init */

async function init() {
  document.body.classList.toggle('page-mode', state.pageMode);
  applyTheme('auto');
  injectIcons();
  rebuildFilters();
  bindEvents();

  let loaded = null;
  let loadFailed = false;
  try {
    loaded = await loadState();
  } catch (error) {
    console.warn('[ReqDeck] could not load local state', error);
    loadFailed = true;
  }

  state.rules = loaded ? loaded.rules : [];
  state.settings = mergeSettings(loaded ? loaded.settings : {});
  state.draft = loaded ? loaded.draft : null;
  state.lastTests = loaded ? loaded.lastTests : {};
  state.runtimeError = loaded ? loaded.runtimeError : null;
  state.meta.version = extensionVersion();

  setLanguage(state.settings.lang);
  applyTheme(state.settings.theme);
  applyStaticLocale();
  dom.app.setAttribute('aria-busy', 'false');
  state.ready = true;

  subscribe(handleStorageChange);
  registerThemeListener();
  setTimeout(adjustPopupWidth, 500);
  window.addEventListener('resize', adjustPopupWidth);
  void refreshMeta();
  if (state.metaTimer) clearInterval(state.metaTimer);
  state.metaTimer = setInterval(() => {
    if (!document.hidden) void refreshMeta();
  }, 4000);

  if (loadFailed) {
    showToast(t('saveFailed'), { icon: 'alert' });
  }
}

init();
