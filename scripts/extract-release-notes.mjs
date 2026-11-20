#!/usr/bin/env node
/** Prints the release notes section for a version from CHANGELOG.md. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = String(process.argv[2] || '').trim();
if (!version) {
  console.error('Usage: node scripts/extract-release-notes.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}. Run npm run release first.`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith('## [')) {
    end = i;
    break;
  }
}
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
