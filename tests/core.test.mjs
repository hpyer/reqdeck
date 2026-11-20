import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORS_RESPONSE_HEADERS,
  DEFAULT_RESOURCE_TYPES,
  MAX_RULES,
  buildMatchers,
  cloneRule,
  compileGlobalCors,
  compileRule,
  compileRules,
  createRule,
  headerSummary,
  makeSampleRules,
  normalizeRule,
  sampleUrlFromPattern,
  urlFilterToRegExp,
  usableHeaders,
  validatePattern,
  validateRule,
} from '../src/core.js';

const validAllow = (patch = {}) =>
  normalizeRule({
    type: 'allow',
    pattern: 'https://api.example.com/*',
    enabled: true,
    ...patch,
  });

test('normalizeRule assigns ids, defaults and normalizes legacy "add" operations', () => {
  const rule = normalizeRule({
    type: 'headers',
    pattern: ' https://x.test/* ',
    headers: [
      { key: 'A', value: '1', op: 'add' },
      { key: 'B', value: '2', op: 'remove' },
      { key: '', value: '', op: 'set' },
    ],
    enabled: false,
  });
  assert.match(rule.id, /\w/);
  assert.equal(rule.pattern, 'https://x.test/*');
  assert.equal(rule.enabled, false);
  assert.equal(rule.headers.length, 2);
  assert.equal(rule.headers[0].op, 'set');
  assert.equal(rule.headers[1].op, 'remove');
  assert.ok(rule.createdAt > 0);
});

test('normalizeRule with freshId=false preserves ids and timestamps', () => {
  const rule = normalizeRule({ id: 'keep-me', pattern: 'https://x.test/*', createdAt: 123, updatedAt: 456 }, { freshId: false });
  assert.equal(rule.id, 'keep-me');
  assert.equal(rule.createdAt, 123);
  assert.equal(rule.updatedAt, 456);
});

test('validatePattern rejects spaces, non-ASCII and misplaced anchors', () => {
  assert.equal(validatePattern(''), 'required');
  assert.equal(validatePattern('https://x.test/a b'), 'ascii');
  assert.equal(validatePattern('https://x.test/中文'), 'ascii');
  assert.equal(validatePattern('https://x.test/a|b'), 'syntax');
  assert.equal(validatePattern('|https://x.test/*'), null);
  assert.equal(validatePattern('https://x.test/*|'), null);
  assert.equal(validatePattern('||example.com^'), null);
});

test('validateRule covers every rule type', () => {
  assert.equal(validateRule(validAllow()).valid, true);

  const noPattern = validAllow({ pattern: '' });
  assert.equal(validateRule(noPattern).valid, false);
  assert.equal(validateRule(noPattern).patternError, 'required');

  const redirect = validAllow({ type: 'redirect', redirectTo: '' });
  assert.equal(validateRule(redirect).valid, false);
  assert.equal(validateRule(redirect).redirectError, 'required');
  assert.equal(validateRule(validAllow({ type: 'redirect', redirectTo: 'ftp://x' })).redirectError, 'invalidUrl');

  const noHeaders = validAllow({ headers: [] });
  assert.equal(validateRule(noHeaders).valid, true);

  const badHeader = validAllow({ headers: [{ id: 'h', key: 'Bad Header', value: 'x', op: 'set' }] });
  const badHeaderResult = validateRule(badHeader);
  assert.equal(badHeaderResult.valid, false);
  assert.equal(badHeaderResult.headerErrors.h, 'keyInvalid');

  const noKey = validAllow({ headers: [{ id: 'h', key: '', value: 'x', op: 'set' }] });
  assert.equal(validateRule(noKey).headerErrors.h, 'keyRequired');

  const badValue = validAllow({ headers: [{ id: 'h', key: 'X-Test', value: 'a\nb', op: 'set' }] });
  assert.equal(validateRule(badValue).headerErrors.h, 'valueInvalid');

  assert.equal(validateRule(validAllow({ cookie: '' })).valid, true);
  assert.equal(validateRule(validAllow({ cookie: 'a=1; b=2' })).valid, true);

  const blocked = validAllow({ type: 'block' });
  assert.equal(validateRule(blocked).valid, true);

  // Headers/Cookie are Allow-only modifiers; hidden legacy values must not
  // invalidate a Redirect or Block rule.
  assert.equal(
    validateRule(
      validAllow({
        type: 'redirect',
        redirectTo: 'https://y.test/*',
        headers: [{ id: 'h', key: 'Bad Header', value: 'x', op: 'set' }],
      }),
    ).valid,
    true,
  );
});

test('three rule types, CORS flag and methods are normalized', () => {
  const legacyHeaders = normalizeRule({
    type: 'headers',
    pattern: 'https://x.test/*',
    headers: [{ key: 'X-Test', value: '1', op: 'set' }],
  });
  assert.equal(legacyHeaders.type, 'allow');
  assert.equal(legacyHeaders.cors, false);
  assert.equal(legacyHeaders.headers.length, 1);
  assert.equal(legacyHeaders.method, 'ANY');

  const legacyCookie = normalizeRule({ type: 'cookie', pattern: 'https://x.test/*', cookie: 'a=1' });
  assert.equal(legacyCookie.type, 'allow');
  assert.equal(legacyCookie.cors, false);
  assert.equal(legacyCookie.cookie, 'a=1');

  assert.equal(normalizeRule({ type: 'allow', pattern: 'https://x.test/*' }).cors, true);
  assert.equal(normalizeRule({ type: 'allow', cors: false, pattern: 'https://x.test/*' }).cors, false);
  assert.equal(
    normalizeRule({ type: 'redirect', redirectTo: 'https://y.test', pattern: 'https://x.test/*' }).cors,
    false,
  );

  assert.equal(normalizeRule({ pattern: 'https://x.test/*', method: 'post' }).method, 'POST');
  assert.equal(normalizeRule({ pattern: 'https://x.test/*', method: 'ANY' }).method, 'ANY');
  assert.equal(normalizeRule({ pattern: 'https://x.test/*', method: 'nope' }).method, 'ANY');
  assert.equal(normalizeRule({ pattern: 'https://x.test/*', methods: ['put'] }).method, 'PUT');
  assert.equal(createRule().method, 'ANY');
});

test('compileRule for an allow rule produces request headers, cookie and CORS response rules', () => {
  const rule = validAllow({
    headers: [
      { id: 'h1', key: 'X-Client', value: 'reqdeck', op: 'set' },
      { id: 'h2', key: 'X-Remove', value: '', op: 'remove' },
    ],
    cookie: 'session=abc',
  });
  const compiled = compileRule(rule, 0);
  assert.equal(compiled.length, 3);
  assert.deepEqual(
    compiled.map((r) => r.action.type),
    ['modifyHeaders', 'modifyHeaders', 'modifyHeaders'],
  );
  const requestRule = compiled[0];
  assert.deepEqual(requestRule.action.requestHeaders, [
    { header: 'X-Client', operation: 'set', value: 'reqdeck' },
    { header: 'X-Remove', operation: 'remove' },
  ]);
  const cookieRule = compiled[1];
  assert.deepEqual(cookieRule.action.requestHeaders, [
    { header: 'cookie', operation: 'set', value: 'session=abc' },
  ]);
  const corsRule = compiled[2];
  assert.equal(corsRule.action.responseHeaders.length, CORS_RESPONSE_HEADERS.length);
  assert.equal(corsRule.action.responseHeaders[0].header, 'access-control-allow-origin');
  assert.equal(corsRule.action.responseHeaders[0].value, '*');
  assert.deepEqual(corsRule.condition.resourceTypes, [...DEFAULT_RESOURCE_TYPES]);
  assert.equal(corsRule.condition.resourceTypes.includes('main_frame'), false);
  assert.equal(compiled[0].condition.resourceTypes.includes('main_frame'), true);
  assert.equal(compiled[1].condition.resourceTypes.includes('main_frame'), true);
  assert.equal(compiled[0].priority, 100);
  assert.ok(compiled.every((r) => r.condition.urlFilter === 'https://api.example.com/*'));
});

test('compileRule handles redirect, block and invalid rules', () => {
  const redirect = compileRule(validAllow({ type: 'redirect', redirectTo: 'https://staging.test/api' }), 0);
  assert.equal(redirect.length, 1);
  assert.equal(redirect[0].action.type, 'redirect');
  assert.equal(redirect[0].action.redirect.url, 'https://staging.test/api');

  assert.equal(redirect[0].condition.resourceTypes.includes('main_frame'), true);

  const block = compileRule(validAllow({ type: 'block' }), 4);
  assert.equal(block[0].action.type, 'block');
  assert.equal(block[0].priority, 104);
  assert.equal(block[0].condition.resourceTypes.includes('main_frame'), true);

  assert.deepEqual(compileRule(validAllow({ pattern: '' }), 0), []);
});

test('method filters and the CORS toggle compile correctly', () => {
  const postAllow = validAllow({
    method: 'POST',
    headers: [{ id: 'h', key: 'X-Test', value: '1', op: 'set' }],
    cookie: 'a=1',
  });
  const compiled = compileRule(postAllow, 0);
  assert.equal(compiled.length, 3);

  const headerRule = compiled.find(
    (rule) => rule.action.requestHeaders && !rule.action.requestHeaders.some((h) => h.header === 'cookie'),
  );
  const cookieRule = compiled.find(
    (rule) => rule.action.requestHeaders && rule.action.requestHeaders.some((h) => h.header === 'cookie'),
  );
  const corsRule = compiled.find((rule) => rule.action.responseHeaders);
  assert.deepEqual(headerRule.condition.requestMethods, ['post']);
  assert.deepEqual(cookieRule.condition.requestMethods, ['post']);
  assert.deepEqual(corsRule.condition.requestMethods, ['post', 'options']);

  const optionsCors = compileRule(validAllow({ method: 'OPTIONS' }), 0)[0];
  assert.deepEqual(optionsCors.condition.requestMethods, ['options']);

  const noCors = compileRule(
    validAllow({ cors: false, headers: [{ id: 'h', key: 'X-Test', value: '1', op: 'set' }] }),
    0,
  );
  assert.equal(noCors.length, 1);
  assert.equal(noCors[0].action.responseHeaders, undefined);

  const anyRule = compileRule(validAllow(), 0)[0];
  assert.equal(anyRule.condition.requestMethods, undefined);

  const getRedirect = compileRule(
    validAllow({ type: 'redirect', redirectTo: 'https://y.test/*', method: 'GET' }),
    0,
  )[0];
  assert.deepEqual(getRedirect.condition.requestMethods, ['get']);

  const postBlock = compileRule(validAllow({ type: 'block', method: 'POST' }), 0)[0];
  assert.deepEqual(postBlock.condition.requestMethods, ['post']);

  const redirectWithPayload = compileRule(
    validAllow({
      type: 'redirect',
      redirectTo: 'https://y.test/*',
      headers: [{ id: 'h', key: 'X-Test', value: '1', op: 'set' }],
      cookie: 'a=1',
    }),
    0,
  );
  assert.equal(redirectWithPayload.length, 1);
  assert.equal(redirectWithPayload[0].action.type, 'redirect');

  const blockWithPayload = compileRule(
    validAllow({
      type: 'block',
      headers: [{ id: 'h', key: 'X-Test', value: '1', op: 'set' }],
      cookie: 'a=1',
    }),
    0,
  );
  assert.equal(blockWithPayload.length, 1);
  assert.equal(blockWithPayload[0].action.type, 'block');
});

test('compileRules honours disabled rules, rule order/priority and global CORS', () => {
  const rules = [
    validAllow({ pattern: 'https://one.test/*' }),
    validAllow({ pattern: 'https://two.test/*', enabled: false }),
    validAllow({ pattern: 'https://three.test/*' }),
  ];
  const compiled = compileRules(rules, { allowAllCors: false });
  assert.equal(compiled.length, 2);
  assert.equal(compiled[0].priority, 100);
  assert.equal(compiled[1].priority, 102);
  assert.ok(compiled[1].priority > compiled[0].priority);

  const withGlobal = compileRules(rules, { allowAllCors: true });
  assert.equal(withGlobal[0].id, 1);
  assert.equal(withGlobal[0].priority, 1);
  assert.equal(withGlobal[0].condition.urlFilter, '*');
  assert.equal(withGlobal.length, 3);

  assert.deepEqual(compileGlobalCors(false), []);
});

test('all compiled rule ids stay unique and below the DNR limit', () => {
  const rules = Array.from({ length: MAX_RULES }, (_, i) =>
    validAllow({
      pattern: `https://rule-${i}.test/*`,
      headers: [
        { id: `a${i}`, key: 'A', value: '1', op: 'set' },
        { id: `b${i}`, key: 'B', value: '2', op: 'set' },
      ],
      cookie: 'c=1',
    }),
  );
  const compiled = compileRules(rules, { allowAllCors: true });
  assert.ok(compiled.length <= 5000);
  const ids = new Set(compiled.map((rule) => rule.id));
  assert.equal(ids.size, compiled.length);
  assert.ok([...ids].every((id) => id >= 1 && id < 2 ** 31));
});

test('sample URLs are derived from URL filters', () => {
  assert.equal(sampleUrlFromPattern('https://api.example.com/*'), 'https://api.example.com/');
  assert.equal(sampleUrlFromPattern('https://api.example.com/v1/*'), 'https://api.example.com/v1/');
  assert.equal(sampleUrlFromPattern('*://*.example.com/*'), 'https://example.com/');
  assert.equal(sampleUrlFromPattern('||example.com/v1/*'), 'https://example.com/v1/');
  assert.equal(sampleUrlFromPattern('example.com/api'), 'https://example.com/api');
  assert.equal(sampleUrlFromPattern('|https://example.com/path|'), 'https://example.com/path');
  assert.equal(sampleUrlFromPattern('*', 'fallback'), 'fallback');
  assert.equal(sampleUrlFromPattern('https://api.example.com/*', 'fallback'), 'https://api.example.com/');
  assert.equal(sampleUrlFromPattern('not a url with spaces', 'fallback'), 'fallback');
});

test('urlFilterToRegExp and buildMatchers follow Chrome URL filter semantics', () => {
  const exact = urlFilterToRegExp('https://api.example.com/*');
  assert.equal(exact.test('https://api.example.com/users'), true);
  assert.equal(exact.test('https://other.example.com/users'), false);

  const domain = urlFilterToRegExp('||example.com');
  assert.equal(domain.test('https://example.com/x'), true);
  assert.equal(domain.test('https://api.example.com/x'), true);
  assert.equal(domain.test('https://evil-example.com/x'), false);

  const all = urlFilterToRegExp('*');
  assert.equal(all.test('https://anything.test/'), true);
  assert.equal(all.test('ftp://anything.test/'), false);

  const rules = [
    { ...validAllow({ pattern: 'https://on.test/*', enabled: true, method: 'POST' }), id: 'on' },
    { ...validAllow({ pattern: 'https://off.test/*', enabled: false }), id: 'off' },
    { ...validAllow({ pattern: '', enabled: true }), id: 'bad' },
  ];
  const matchers = buildMatchers(rules);
  assert.equal(matchers.length, 1);
  assert.equal(matchers[0].id, 'on');
  assert.equal(matchers[0].method, 'POST');
});

test('usableHeaders and headerSummary count only complete rows', () => {
  const rule = validAllow({
    headers: [
      { id: '1', key: 'A', value: '1', op: 'set' },
      { id: '2', key: 'B', value: '', op: 'set' },
      { id: '3', key: '', value: 'orphan', op: 'set' },
      { id: '4', key: 'C', value: '', op: 'remove' },
    ],
    cookie: 'x=1',
  });
  assert.equal(usableHeaders(rule).length, 3);
  assert.deepEqual(headerSummary(rule), { headers: 3, cookies: 1, total: 4 });
});

test('sample rules are safe defaults and cloneRule is deep', () => {
  const samples = makeSampleRules();
  assert.equal(samples.length, 5);
  assert.ok(samples.every((rule) => rule.enabled === false));
  assert.ok(samples.every((rule) => validateRule(rule).valid));
  assert.ok(samples.every((rule) => ['allow', 'redirect', 'block'].includes(rule.type)));
  assert.ok(samples.some((rule) => rule.method === 'POST'));
  const clone = cloneRule(samples[0]);
  clone.headers[0].key = 'Mutated';
  assert.notEqual(clone.headers[0].key, samples[0].headers[0].key);
});

test('createRule returns a fresh editable allow rule', () => {
  const a = createRule();
  const b = createRule();
  assert.equal(a.type, 'allow');
  assert.equal(a.enabled, true);
  assert.equal(a.pattern, '');
  assert.notEqual(a.id, b.id);
});
