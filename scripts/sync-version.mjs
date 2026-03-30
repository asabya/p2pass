#!/usr/bin/env node
/**
 * Keep `export const VERSION` in src/lib/index.js in sync with package.json.
 * Invoked by `prepackage` (before svelte-package) and `version` (after npm version bump).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const indexPath = join(root, 'src', 'lib', 'index.js');

const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('[sync-version] Invalid or missing package.json version');
  process.exit(1);
}

let src = readFileSync(indexPath, 'utf8');
const re = /export const VERSION = '[^']*';/;
if (!re.test(src)) {
  console.error('[sync-version] Could not find export const VERSION in src/lib/index.js');
  process.exit(1);
}

const next = src.replace(re, `export const VERSION = '${version}';`);
if (src === next) {
  console.log('[sync-version] VERSION already', version);
  process.exit(0);
}

writeFileSync(indexPath, next, 'utf8');
console.log('[sync-version] Wrote VERSION =', version, '→ src/lib/index.js');
