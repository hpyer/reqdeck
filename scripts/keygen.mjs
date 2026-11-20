#!/usr/bin/env node
/**
 * Generates this project's own stable Chromium extension key.
 *
 * The public key goes into the manifest at package time. Keep the private key
 * for signed CRX builds; never commit either file.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = resolve(ROOT, '.keys');
const privatePath = resolve(KEY_DIR, 'extension-private.pem');
const publicDerPath = resolve(KEY_DIR, 'extension-public.der');
const publicTextPath = resolve(KEY_DIR, 'extension-public.txt');
const force = process.argv.includes('--force');

function extensionId(publicKeyDer) {
  const hex = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
  return [...hex].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');
}

function printSetupInfo(id) {
  console.log(`Extension ID: ${id}`);
  console.log('');
  console.log('GitHub Actions secrets (Settings → Secrets and variables → Actions):');
  console.log('  EXTENSION_PUBLIC_KEY   = contents of .keys/extension-public.txt');
  console.log('  EXTENSION_PRIVATE_KEY  = contents of .keys/extension-private.pem (only if you sign CRX builds)');
  console.log('');
  console.log('Never commit .keys/. Back it up somewhere safe.');
}

if (!force && (existsSync(privatePath) || existsSync(publicTextPath))) {
  const key = existsSync(publicTextPath) ? readFileSync(publicTextPath, 'utf8').trim() : '';
  if (key) {
    console.log('A key already exists. Keeping it.');
    printSetupInfo(extensionId(Buffer.from(key, 'base64')));
    process.exit(0);
  }
  console.error('A partial key exists in .keys/. Re-run with --force to replace it, or remove .keys/ manually.');
  process.exit(1);
}

mkdirSync(KEY_DIR, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(publicDerPath, publicKey);
writeFileSync(publicTextPath, `${publicKey.toString('base64')}\n`);

console.log('Created .keys/extension-private.pem, .keys/extension-public.der and .keys/extension-public.txt');
console.log('');
printSetupInfo(extensionId(publicKey));
