import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { MESSAGES } from '../src/i18n.js';
import { RULE_TYPES } from '../src/core.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function lookup(table, key) {
  let value = table;
  for (const part of key.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

function flattenKeys(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenKeys(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (prefix) {
    out.push(prefix);
  }
  return out;
}

function usedKeys() {
  const sources = [
    readFileSync(resolve(ROOT, 'src/app.js'), 'utf8'),
    readFileSync(resolve(ROOT, 'src/popup.html'), 'utf8'),
  ].join('\n');
  const keys = new Set();
  for (const match of sources.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g)) {
    if (!match[1].includes('${')) keys.add(match[1]);
  }
  for (const match of sources.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)) {
    keys.add(match[1]);
  }
  for (const type of RULE_TYPES) {
    keys.add(`type.${type}`);
    keys.add(`typeHint.${type}`);
  }
  keys.add('opSet');
  keys.add('opRemove');
  return [...keys].sort();
}

test('every referenced UI key exists in English and Chinese', () => {
  const missing = [];
  for (const key of usedKeys()) {
    for (const lang of ['en', 'zh']) {
      if (typeof lookup(MESSAGES[lang], key) !== 'string') missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('English and Chinese message trees have the same shape', () => {
  const en = flattenKeys(MESSAGES.en).sort();
  const zh = flattenKeys(MESSAGES.zh).sort();
  assert.deepEqual(zh, en);
});

test('pluralized strings stay meaningful in both languages', () => {
  for (const lang of ['en', 'zh']) {
    for (const key of ['ruleSingular', 'rules', 'hitSingular', 'hits', 'headerSingular', 'headersShort']) {
      assert.equal(typeof lookup(MESSAGES[lang], key), 'string', `${lang}:${key}`);
      assert.ok(lookup(MESSAGES[lang], key).length > 0, `${lang}:${key}`);
    }
  }
});
