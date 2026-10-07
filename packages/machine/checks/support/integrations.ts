import { after } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { Declaration } from '../../src/integrations/declaration.ts';

const directories: string[] = [];
after(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); });

// Fake agent CLIs log their argv, then run the supplied JavaScript with an absolute Node path.
export const fakeBin = () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-agents-'));
  directories.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const tool = (name: string, body = 'process.exit(0)') => {
    const file = join(bin, name);
    const script = `const fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name + ' ')} + args.join(' ') + '\\n');\n${body}\n`;
    writeFileSync(`${file}.cjs`, script);
    if (process.platform === 'win32') {
      writeFileSync(`${file}.cmd`, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
    } else {
      writeFileSync(file, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${file.replaceAll("'", "'\\''")}.cjs' "$@"\n`);
      chmodSync(file, 0o755);
    }
  };
  // A fake codex answering the three --json list commands from fixture files.
  const codex = (plugins: unknown, marketplaces: unknown, installBody = 'process.exit(0)', mcp: unknown = []) => {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify(mcp));
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify(plugins));
    writeFileSync(join(dir, 'marketplaces.json'), JSON.stringify(marketplaces));
    tool('codex', [
      'switch (args.join(" ")) {',
      `  case "plugin list --json --available": process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'plugins.json'))})); break;`,
      `  case "plugin marketplace list --json": process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'marketplaces.json'))})); break;`,
      `  case "mcp list --json": process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'mcp.json'))})); break;`,
      `  default: ${installBody};`,
      '}',
    ].join('\n'));
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  // Do not inherit the user's PATH: an absent fake must never reach an installed agent CLI.
  const path = [bin, ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : [])].join(delimiter);
  return { dir, bin, path, tool, codex, calls };
};

export const CLAUDE_MARKETPLACE: Declaration = {
  id: 'cm-market', label: 'context-mode marketplace', target: 'claude', type: 'marketplace', default: true,
  marketplace: 'mksglu/context-mode', name: 'context-mode',
};
export const CLAUDE_PLUGIN: Declaration = {
  id: 'cm', label: 'context-mode', target: 'claude', type: 'plugin', default: true, plugin: 'context-mode@context-mode',
};
export const CODEX_MARKETPLACE: Declaration = { ...CLAUDE_MARKETPLACE, id: 'cm-market-codex', target: 'codex' };
export const CODEX_PLUGIN: Declaration = { ...CLAUDE_PLUGIN, id: 'cm-codex', target: 'codex' };
export const MCP: Declaration = { id: 'srv', label: 'srv', target: 'codex', type: 'mcp', default: true, command: 'srv' };
export const HOOK: Declaration = {
  id: 'hk', label: 'hk', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/h.mjs',
};

// A resolved profile holding exactly these declarations; `enabled` overrides `default` per id.
export const desiredOf = (declarations: Declaration[], enabled: Record<string, boolean> = {}): DesiredConfig => ({
  files: [], skills: [], allow: {}, issues: [],
  integrations: declarations.map((d) => ({
    id: d.id,
    declaration: d,
    enabled: enabled[d.id] ?? d.default,
    from: { layer: 'base' as const, source: 'integrations.json' },
  })),
});
