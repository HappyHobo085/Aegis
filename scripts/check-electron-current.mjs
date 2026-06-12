#!/usr/bin/env node
// scripts/check-electron-current.mjs
// CI gate: warn when the installed Electron is behind the latest stable, and
// FAIL when it has fallen outside Electron's 3-major security-support window.
// Pure classification lives in ./electronCurrency.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyElectronCurrency } from './electronCurrency.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function installedElectronVersion() {
  const pkgPath = join(__dirname, '..', 'node_modules', 'electron', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

function latestStableElectronVersion() {
  // npm `latest` dist-tag = newest STABLE (betas live under the `beta` tag).
  return execFileSync('npm', ['view', 'electron', 'version'], { encoding: 'utf8' }).trim();
}

function main() {
  let installed;
  try {
    installed = installedElectronVersion();
  } catch (err) {
    console.error('[check-electron-current] cannot read installed electron version:', err.message);
    process.exitCode = 1;
    return;
  }

  let latest;
  try {
    latest = latestStableElectronVersion();
  } catch (err) {
    // Registry unreachable — do not block CI on a network blip; warn and pass.
    console.warn('[check-electron-current] could not query npm for latest electron; skipping:', err.message);
    return;
  }

  const r = classifyElectronCurrency(installed, latest);
  const line = `[check-electron-current] installed=${r.installed} latest=${r.latest} behindMajors=${r.behindMajors} -> ${r.status.toUpperCase()}`;
  if (r.status === 'fail') {
    console.error(line);
    console.error(r.reason);
    process.exitCode = 1;
  } else if (r.status === 'warn') {
    console.warn(line);
    console.warn(r.reason);
  } else {
    console.log(line);
    console.log(r.reason);
  }
}

main();
