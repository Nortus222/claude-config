import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { Declaration } from '../../src/integrations/declaration.ts';

// A temp bin of fake agent CLIs. Each records "<name> <args>" to a log, then runs `body` (sh).
export const fakeBin = () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-agents-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const tool = (name: string, body = 'exit 0') => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // A fake codex answering the three --json list commands from fixture files.
  const codex = (plugins: unknown, marketplaces: unknown, installBody = 'exit 0', mcp: unknown = []) => {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify(mcp));
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify(plugins));
    writeFileSync(join(dir, 'marketplaces.json'), JSON.stringify(marketplaces));
    tool('codex', [
      'case "$*" in',
      `  "plugin list --json") cat '${join(dir, 'plugins.json')}' ;;`,
      `  "plugin marketplace list --json") cat '${join(dir, 'marketplaces.json')}' ;;`,
      `  "mcp list --json") cat '${join(dir, 'mcp.json')}' ;;`,
      `  *) ${installBody} ;;`,
      'esac',
    ].join('\n'));
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, bin, path: `${bin}:/usr/bin:/bin`, tool, codex, calls };
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
