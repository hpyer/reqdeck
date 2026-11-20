/**
 * ReqDeck core: rule model, validation, matching and DNR compilation.
 * Pure functions only. Safe to import from the popup, the service worker and tests.
 */

export const SCHEMA_VERSION = 1;

export const STORAGE_KEYS = Object.freeze({
  rules: 'reqdeck:rules',
  settings: 'reqdeck:settings',
  stats: 'reqdeck:stats',
  draft: 'reqdeck:draft',
  lastTests: 'reqdeck:lastTests',
  runtimeError: 'reqdeck:runtimeError',
});

export const RULE_TYPES = Object.freeze(['allow', 'redirect', 'block']);
export const MAX_RULES = 800;
export const MAX_PATTERN_LENGTH = 500;
export const MAX_HEADERS = 30;

export const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export const METHOD_ANY = 'ANY';

/** Resource types used by CORS response-header rules. Top-level documents are excluded. */
export const DEFAULT_RESOURCE_TYPES = Object.freeze([
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
]);

/**
 * Request-affecting rules (headers, cookies, redirects, blocks) also apply to
 * top-level navigations. CORS response headers don't need main_frame, but
 * request headers on a page load do, otherwise the hit counter says the rule
 * matched while the navigation carries none of the configured headers.
 */
export const REQUEST_RESOURCE_TYPES = Object.freeze(['main_frame', ...DEFAULT_RESOURCE_TYPES]);

export const DEFAULT_SETTINGS = Object.freeze({
  allowAllCors: false,
  countHits: true,
  theme: 'auto',
  lang: 'auto',
  seeded: false,
});

export const CORS_RESPONSE_HEADERS = Object.freeze([
  { header: 'access-control-allow-origin', operation: 'set', value: '*' },
  {
    header: 'access-control-allow-methods',
    operation: 'set',
    value: 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  },
  { header: 'access-control-allow-headers', operation: 'set', value: '*' },
  { header: 'access-control-expose-headers', operation: 'set', value: '*' },
  { header: 'access-control-max-age', operation: 'set', value: '86400' },
  { header: 'access-control-allow-private-network', operation: 'set', value: 'true' },
]);

/** Headers a fetch() call is not allowed to set. */
export const FORBIDDEN_REQUEST_HEADERS = Object.freeze([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
]);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REDIRECT_TYPES = new Set(['redirect']);

export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function toText(value, max = 2000) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
}

function toTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function normalizeMethod(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const label = toText(candidate, 16).trim().toUpperCase();
  if (!label || label === 'ANY' || label === '*' || label === 'ALL') return METHOD_ANY;
  return METHODS.includes(label) ? label : METHOD_ANY;
}

function normalizeHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .slice(0, MAX_HEADERS)
    .filter((header) => header && typeof header === 'object')
    .map((header) => {
      // DNR cannot append arbitrary custom headers, so "add" is normalized to "set".
      const op = header.op === 'remove' ? 'remove' : 'set';
      return {
        id: toText(header.id, 64) || uid(),
        key: toText(header.key ?? header.name, 256).trim(),
        value: op === 'remove' ? '' : toText(header.value, 4000),
        op,
      };
    })
    .filter((header) => header.key !== '' || header.value !== '');
}

/** Normalizes an arbitrary object into a safe rule. Generates a new id by default. */
export function normalizeRule(raw = {}, options = {}) {
  const { freshId = true } = options;
  const now = Date.now();
  const legacyStandalone = raw.type === 'headers' || raw.type === 'cookie';
  const type = RULE_TYPES.includes(raw.type) ? raw.type : 'allow';
  // Headers/Cookie used to be separate rule types. Keep those rules working by
  // folding them into an Allow rule without CORS response headers.
  const cors = type === 'allow' ? (raw.cors === undefined ? !legacyStandalone : Boolean(raw.cors)) : false;
  return {
    id: !freshId && raw.id ? toText(raw.id, 64) : uid(),
    type,
    cors,
    method: normalizeMethod(raw.method ?? raw.methods),
    label: toText(raw.label ?? raw.name, 80).trim(),
    pattern: toText(raw.pattern ?? raw.url, MAX_PATTERN_LENGTH).trim(),
    redirectTo: toText(raw.redirectTo ?? raw.redirectUrl, 2000).trim(),
    testUrl: toText(raw.testUrl, 2000).trim(),
    headers: normalizeHeaders(raw.headers),
    cookie: toText(raw.cookie, 8000),
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    createdAt: toTimestamp(raw.createdAt ?? now),
    updatedAt: toTimestamp(raw.updatedAt ?? now),
  };
}

/** Shallow-clones a rule and its header rows for editing. */
export function cloneRule(rule) {
  return {
    ...rule,
    headers: (rule.headers || []).map((header) => ({ ...header })),
  };
}

export function createRule(patch = {}) {
  return normalizeRule({ enabled: true, type: 'allow', ...patch });
}

/**
 * Validates a rule. Returns codes (the UI translates them), never strings.
 * @returns {{valid:boolean, patternError:?string, redirectError:?string,
 *   cookieError:?string, headersError:?string, headerErrors:Object<string,string>}}
 */
export function validateRule(rule) {
  const result = {
    valid: true,
    patternError: null,
    redirectError: null,
    cookieError: null,
    headersError: null,
    headerErrors: {},
  };

  const patternError = validatePattern(rule.pattern);
  if (patternError) {
    result.patternError = patternError;
    result.valid = false;
  }

  if (REDIRECT_TYPES.has(rule.type)) {
    const redirect = toText(rule.redirectTo, 2000).trim();
    if (!redirect) {
      result.redirectError = 'required';
      result.valid = false;
    } else if (!isHttpUrl(redirect)) {
      result.redirectError = 'invalidUrl';
      result.valid = false;
    }
  }

  // Headers and Cookie are modifiers on Allow rules. Redirect/Block are
  // terminal actions, so hidden legacy values must not invalidate the rule.
  if (rule.type === 'allow') {
    const headerRows = (rule.headers || []).filter((header) => header.key.trim() || header.value.trim());
    for (const header of headerRows) {
      const key = header.key.trim();
      if (!key) {
        result.headerErrors[header.id] = 'keyRequired';
        result.valid = false;
        continue;
      }
      if (!HEADER_NAME_RE.test(key)) {
        result.headerErrors[header.id] = 'keyInvalid';
        result.valid = false;
        continue;
      }
      if (header.op !== 'remove' && !validHeaderValue(header.value)) {
        result.headerErrors[header.id] = 'valueInvalid';
        result.valid = false;
      }
    }

    if (!validHeaderValue(rule.cookie)) {
      result.cookieError = 'invalid';
      result.valid = false;
    }
  }

  return result;
}

export function validatePattern(pattern) {
  const value = toText(pattern, MAX_PATTERN_LENGTH).trim();
  if (!value) return 'required';
  if (!/^[\x21-\x7E]+$/.test(value)) return 'ascii';
  const bars = [...value].reduce((count, char) => count + (char === '|' ? 1 : 0), 0);
  const wildcardAnchor = value.startsWith('||');
  const startsWithBar = value.startsWith('|');
  const endsWithBar = value.endsWith('|') && !value.endsWith('||');
  const allowedBars = (wildcardAnchor ? 2 : startsWithBar ? 1 : 0) + (endsWithBar ? 1 : 0);
  if (bars > allowedBars) return 'syntax';
  if (value.includes('|') && !startsWithBar && !endsWithBar) return 'syntax';
  return null;
}

export function validHeaderValue(value) {
  const text = toText(value, 8000);
  return !/[\r\n\x00]/.test(text) && /^[\x20-\x7E]*$/.test(text);
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Header rows that will actually be sent / applied (non empty, key present). */
export function usableHeaders(rule) {
  // A header with an empty value is still meaningful (the server receives an empty value).
  return (rule.headers || []).filter((header) => header.key.trim() !== '');
}

/** Compiles one rule into 1..3 declarativeNetRequest rules. Invalid rules compile to []. */
export function compileRule(rule, index, options = {}) {
  const { basePriority = 100 } = options;
  const validation = validateRule(rule);
  if (!validation.valid) return [];
  const baseId = 1000 + index * 8;
  const priority = basePriority + index;
  const method = METHODS.includes(rule.method) ? rule.method.toLowerCase() : null;
  const requestCondition = () => {
    const condition = {
      urlFilter: rule.pattern,
      resourceTypes: [...REQUEST_RESOURCE_TYPES],
    };
    if (method) condition.requestMethods = [method];
    return condition;
  };
  const corsCondition = () => {
    const condition = {
      urlFilter: rule.pattern,
      resourceTypes: [...DEFAULT_RESOURCE_TYPES],
    };
    // A method-filtered CORS rule still has to decorate the preflight OPTIONS
    // response, otherwise a POST/PUT with custom headers is rejected by CORS.
    if (method) condition.requestMethods = method === 'options' ? ['options'] : [method, 'options'];
    return condition;
  };
  const subRules = [];

  if (rule.type === 'redirect') {
    subRules.push({
      action: { type: 'redirect', redirect: { url: rule.redirectTo.trim() } },
      condition: requestCondition(),
    });
  }

  if (rule.type === 'block') {
    subRules.push({ action: { type: 'block' }, condition: requestCondition() });
  }

  const requestHeaders = usableHeaders(rule).map((header) => ({
    header: header.key.trim(),
    operation: header.op === 'remove' ? 'remove' : 'set',
    ...(header.op === 'remove' ? {} : { value: header.value }),
  }));

  if (rule.type === 'allow' && requestHeaders.length > 0) {
    subRules.push({
      action: { type: 'modifyHeaders', requestHeaders },
      condition: requestCondition(),
    });
  }

  // A cookie string can accompany any rule type. It is sent as a request Cookie header.
  if (rule.type === 'allow' && rule.cookie.trim()) {
    subRules.push({
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'set', value: rule.cookie.trim() }],
      },
      condition: requestCondition(),
    });
  }

  if (rule.type === 'allow' && rule.cors !== false) {
    subRules.push({
      action: {
        type: 'modifyHeaders',
        responseHeaders: CORS_RESPONSE_HEADERS.map((header) => ({ ...header })),
      },
      condition: corsCondition(),
    });
  }

  return subRules.map((subRule, subIndex) => ({
    id: baseId + subIndex,
    priority,
    action: subRule.action,
    condition: subRule.condition,
  }));
}

/** The single global "allow CORS everywhere" rule. */
export function compileGlobalCors(enabled) {
  if (!enabled) return [];
  return [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: CORS_RESPONSE_HEADERS.map((header) => ({ ...header })),
      },
      condition: {
        urlFilter: '*',
        resourceTypes: [...DEFAULT_RESOURCE_TYPES],
      },
    },
  ];
}

/** Compiles the whole list. Rules keep their array position as precedence (later wins). */
export function compileRules(rules, settings = DEFAULT_SETTINGS) {
  const output = compileGlobalCors(Boolean(settings && settings.allowAllCors));
  (rules || []).forEach((rule, index) => {
    if (!rule.enabled) return;
    output.push(...compileRule(rule, index));
  });
  return output;
}

/** Turns a DNR urlFilter into a RegExp for local hit counting. */
export function urlFilterToRegExp(filter) {
  let value = toText(filter, MAX_PATTERN_LENGTH);
  let source = '';
  if (value === '*') return /^https?:/i;
  if (value.startsWith('||')) {
    source += '^(?:[a-z][a-z0-9+.-]*:)?//(?:[^/?#]*\\.)?';
    value = value.slice(2);
  } else if (value.startsWith('|')) {
    source += '^';
    value = value.slice(1);
  }
  let anchoredEnd = false;
  if (value.endsWith('|')) {
    anchoredEnd = true;
    value = value.slice(0, -1);
  }
  for (const char of value) {
    if (char === '*') source += '.*';
    else if (char === '^') source += '(?:[^a-zA-Z0-9_\\-.%]|$)';
    else source += char.replace(/[\\^$+?.(){}[\]]/g, '\\$&');
  }
  if (anchoredEnd) source += '$';
  return new RegExp(source, 'i');
}

export function buildMatchers(rules) {
  return (rules || [])
    .filter((rule) => rule.enabled && validateRule(rule).valid)
    .map((rule) => {
      try {
        return { id: rule.id, regex: urlFilterToRegExp(rule.pattern), method: rule.method || METHOD_ANY };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** A concrete URL to test against, derived from the DNR filter. */
export function sampleUrlFromPattern(pattern, fallback = '') {
  let value = toText(pattern, MAX_PATTERN_LENGTH).trim();
  if (!value || value === '*') return fallback;
  if (value.startsWith('||')) {
    value = `https://${value.slice(2)}`;
  } else if (value.startsWith('|')) {
    value = value.slice(1);
  } else if (/^\*:\/\//.test(value)) {
    value = value.replace(/^\*:\/\//, 'https://');
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  value = value
    .replace(/\.?\*+/g, '')
    .replace(/\^/g, '/')
    .replace(/\|/g, '');
  value = value.replace(/^https:\/\/\./, 'https://').replace(/^https:\/\/\//, 'https://');
  if (!isHttpUrl(value)) return fallback;
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return fallback;
  }
}

/** Best guess at the URL a rule is meant to act on, for the request tester. */
export function sampleTarget(rule) {
  const fallback = rule.type === 'redirect' && isHttpUrl(rule.redirectTo) ? rule.redirectTo : '';
  return sampleUrlFromPattern(rule.pattern, fallback);
}

export function headerSummary(rule) {
  const headers = usableHeaders(rule);
  const cookies = rule.cookie.trim() ? 1 : 0;
  return { headers: headers.length, cookies, total: headers.length + cookies };
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const SAMPLE_RULES = Object.freeze([
  {
    type: 'allow',
    cors: true,
    label: 'Unlock API CORS',
    pattern: 'https://api.example.com/*',
    method: 'ANY',
    headers: [{ key: 'X-Client', value: 'reqdeck', op: 'set' }],
    enabled: false,
  },
  {
    type: 'allow',
    cors: false,
    label: 'Attach API key',
    pattern: '*://*.example.com/api/*',
    method: 'POST',
    headers: [{ key: 'X-API-Key', value: 'replace-me', op: 'set' }],
    enabled: false,
  },
  {
    type: 'redirect',
    label: 'Point to staging',
    pattern: 'https://httpbin.org/anything*',
    redirectTo: 'https://httpbin.org/get',
    method: 'ANY',
    enabled: false,
  },
  {
    type: 'block',
    label: 'Mute ad pings',
    pattern: 'https://ads.example.com/*',
    method: 'ANY',
    enabled: false,
  },
  {
    type: 'allow',
    cors: false,
    label: 'Inject demo cookie',
    pattern: 'https://app.example.com/*',
    method: 'ANY',
    cookie: 'session=demo; theme=dark',
    enabled: false,
  },
]);

export function makeSampleRules() {
  return SAMPLE_RULES.map((sample, index) =>
    normalizeRule({ ...sample, createdAt: Date.now() + index, updatedAt: Date.now() + index }),
  );
}
