#!/usr/bin/env node
// Disable individual hooks a Claude Code plugin declares in its hooks.json.
//
// Claude Code has no per-hook switch — "There is no way to disable an individual
// hook while keeping it in the configuration" (hooks docs). `disableAllHooks` is
// all-or-nothing. The only granular lever is the plugin's own hooks.json inside
// the plugin cache, which this edits.
//
// The edit survives the plugin's heal layers (heal-partial-install only re-copies
// *missing* files; the integrity check only asserts existence), but NOT a plugin
// update, which replaces the whole cache directory. Re-run after updating.
//
// Usage:
//   disable-plugin-hooks.mjs --plugin <name@marketplace> --disable <Event[:matcher]> [...]
//   disable-plugin-hooks.mjs --plugin <name@marketplace> --list
//   disable-plugin-hooks.mjs --plugin <name@marketplace> --restore
//   ... add --dry-run to preview without writing.
//
// Example:
//   disable-plugin-hooks.mjs --plugin context-mode@context-mode --disable PreToolUse:Agent

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';

function cfgDir() {
  const e = process.env.CLAUDE_CONFIG_DIR;
  if (e && e.trim() !== '') return e.startsWith('~') ? resolve(homedir(), e.replace(/^~[/\\]?/, '')) : resolve(e);
  return resolve(homedir(), '.claude');
}

function parseArgs(argv) {
  const out = { disable: [], dryRun: false, list: false, restore: false, plugin: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plugin') out.plugin = argv[++i];
    else if (a === '--disable') out.disable.push(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list') out.list = true;
    else if (a === '--restore') out.restore = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else die(`unknown argument: ${a}`);
  }
  return out;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Resolve a plugin's live install path from installed_plugins.json. */
function installPathFor(pluginKey) {
  const f = resolve(cfgDir(), 'plugins', 'installed_plugins.json');
  if (!existsSync(f)) die(`no installed_plugins.json at ${f}`);
  const ip = JSON.parse(readFileSync(f, 'utf8'));
  const entries = (ip.plugins || {})[pluginKey];
  if (!entries?.length) {
    die(`plugin ${pluginKey} not installed. Known: ${Object.keys(ip.plugins || {}).join(', ')}`);
  }
  const p = entries[0].installPath;
  if (!p || !existsSync(p)) die(`install path missing or stale: ${p}`);
  return p;
}

/** A hook entry's stable identity: "<Event>" or "<Event>:<matcher>". */
function selectorsFor(event, entry) {
  const m = entry.matcher;
  return m ? [`${event}:${m}`, event] : [event];
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.plugin) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n')
    .filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(args.plugin ? 0 : 1);
}

const root = installPathFor(args.plugin);
const hooksJson = join(root, 'hooks', 'hooks.json');
if (!existsSync(hooksJson)) die(`no hooks/hooks.json under ${root}`);

const backupDir = join(cfgDir(), 'backups', `plugin-hooks-${args.plugin.replace(/[@/]/g, '_')}`);
const backupFile = join(backupDir, 'hooks.json.orig');

if (args.restore) {
  if (!existsSync(backupFile)) die(`no backup at ${backupFile}`);
  if (args.dryRun) { console.log(`[dry-run] would restore ${hooksJson} from ${backupFile}`); process.exit(0); }
  copyFileSync(backupFile, hooksJson);
  console.log(`restored ${hooksJson}`);
  process.exit(0);
}

const doc = JSON.parse(readFileSync(hooksJson, 'utf8'));
const events = doc.hooks || {};

if (args.list) {
  console.log(`${args.plugin}\n  ${root}\n`);
  for (const [event, entries] of Object.entries(events)) {
    for (const e of entries) {
      const cmd = (e.hooks || []).map(h => h.command || '').join('; ');
      console.log(`  ${selectorsFor(event, e)[0].padEnd(34)} ${cmd.slice(0, 70)}`);
    }
  }
  process.exit(0);
}

if (!args.disable.length) die('nothing to do — pass --disable, --list or --restore');

// Back up the pristine file once, before the first edit ever lands.
if (!existsSync(backupFile) && !args.dryRun) {
  mkdirSync(dirname(backupFile), { recursive: true });
  copyFileSync(hooksJson, backupFile);
  console.log(`backed up original -> ${backupFile}`);
}

const wanted = new Set(args.disable);
const removed = [];
for (const [event, entries] of Object.entries(events)) {
  const kept = entries.filter(e => {
    const hit = selectorsFor(event, e).find(s => wanted.has(s));
    if (hit) removed.push(hit);
    return !hit;
  });
  if (kept.length) events[event] = kept;
  else delete events[event];
}

const unmatched = [...wanted].filter(w => !removed.includes(w));

if (!removed.length) {
  console.log(`no change — ${[...wanted].join(', ')} not present (already disabled?)`);
  if (unmatched.length) console.log(`  not found: ${unmatched.join(', ')}`);
  process.exit(0);
}

if (args.dryRun) {
  console.log(`[dry-run] would remove: ${removed.join(', ')}`);
  process.exit(0);
}

doc.hooks = events;
writeFileSync(hooksJson, JSON.stringify(doc, null, 2) + '\n');
console.log(`removed ${removed.length} hook entr${removed.length === 1 ? 'y' : 'ies'}: ${removed.join(', ')}`);
console.log(`wrote ${hooksJson}`);
if (unmatched.length) console.log(`note: not found, ignored: ${unmatched.join(', ')}`);
console.log('restart Claude Code for this to take effect.');
