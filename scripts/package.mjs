#!/usr/bin/env node
/** Builds dist/reqdeck-<version>.zip from the files Chrome needs. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const outDir = resolve(ROOT, 'dist');
const outFile = resolve(outDir, `reqdeck-${manifest.version}.zip`);
const entries = ['manifest.json', 'src', 'icons', 'docs', 'README.md', 'LICENSE', 'NOTICE'];

mkdirSync(outDir, { recursive: true });
if (existsSync(outFile)) rmSync(outFile);

// Stage the package so the local build carries a stable manifest key while
// the source manifest stays clean for development.
const stage = resolve(ROOT, '.tmp', 'package');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of entries) {
  cpSync(resolve(ROOT, entry), resolve(stage, entry), { recursive: true });
}

const envKey = (process.env.EXTENSION_PUBLIC_KEY || '').trim();
const localKeyPath = resolve(ROOT, '.keys', 'extension-public.txt');
const key = envKey || (existsSync(localKeyPath) ? readFileSync(localKeyPath, 'utf8').trim() : '');
if (!key) {
  console.error(
    [
      'No extension public key found.',
      'Local build: run `npm run keygen` once. It creates .keys/extension-public.txt and gives this clone its own extension ID.',
      'CI: set the EXTENSION_PUBLIC_KEY repository secret to your public key.',
    ].join('\n'),
  );
  process.exit(1);
}
const keyedManifest = { ...manifest, key };
writeFileSync(resolve(stage, 'manifest.json'), `${JSON.stringify(keyedManifest, null, 2)}\n`);
const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
const id = [...hex].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');
console.log(`Stable extension ID: ${id}`);

const result = spawnSync(
  'zip',
  ['-r', '-X', outFile, ...entries, '-x', '*.DS_Store', '*/.*'],
  { cwd: stage, stdio: 'inherit' },
);
if (result.error) {
  console.error('Could not run zip. Install zip or archive these paths manually:', entries.join(', '));
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
rmSync(stage, { recursive: true, force: true });
console.log(`\nPackaged ${outFile}`);
