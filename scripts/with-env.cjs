#!/usr/bin/env node
// Load KEY=VALUE pairs from a gitignored `.env` into process.env, then run the
// command passed as arguments. electron-builder reads GH_TOKEN from the
// environment but does NOT load .env files itself, so `pnpm release` pipes its
// final electron-builder call through this helper to pick up the token without a
// dotenv dependency. A missing .env is fine — CI (or a manually-set
// $env:GH_TOKEN) just provides the var directly, and existing env vars always
// win over the file.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes, if present.
    if (val.length >= 2 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) {
      val = val.slice(1, -1);
    }
    // Don't clobber a variable already set in the real environment.
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('[with-env] no command given');
  process.exit(1);
}

const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true });
if (result.error) {
  console.error('[with-env]', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
