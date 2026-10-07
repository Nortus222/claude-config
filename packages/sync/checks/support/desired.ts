import type { DesiredConfig, Origin, ResolvedFile, ResolvedIntegration, ResolvedSkill } from '@nortuscc/profile-engine';

export const origin: Origin = { layer: 'base', source: 'test' };

const file = (id: string, src: string, dest: string, mode: 'copy' | 'merge-keys', managed = true): ResolvedFile => ({
  id,
  target: id.startsWith('codex:') ? 'codex' : 'claude',
  home: id.startsWith('codex:') ? 'codex-openrouter' : 'claude',
  src, dest, mode, preserveProjects: false, capture: true, managed, from: origin,
});

export const claudeMd = (managed = true): ResolvedFile => file('claude:CLAUDE.md', 'claude/CLAUDE.md', 'CLAUDE.md', 'copy', managed);
export const configToml = (): ResolvedFile => file('codex:config.toml', 'codex/openrouter-glm/config.toml', 'config.toml', 'copy');
export const settingsFile = (keys: Readonly<Record<string, unknown>>, managed = true): ResolvedFile => ({
  ...file('claude:settings.json', 'claude/settings.keys.json', 'settings.json', 'merge-keys', managed),
  keys: Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, { value, from: origin }])),
});

export const skill = (name: string, source: string, pin?: string): ResolvedSkill => ({
  name, source, exact: false, optional: false, install: true, from: origin, ...(pin ? { pin: { ref: pin, from: origin } } : {}),
});

export const hook = (id: string): ResolvedIntegration => ({
  id,
  declaration: { id, label: id, target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: `claude/hooks/${id}.mjs` },
  enabled: true,
  from: origin,
});

// A resolved configuration: CLAUDE.md, the OpenRouter config.toml and settings.json by default.
export const desiredOf = (parts: {
  readonly files?: ReadonlyArray<ResolvedFile>;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly skills?: ReadonlyArray<ResolvedSkill>;
  readonly integrations?: ReadonlyArray<ResolvedIntegration>;
} = {}): DesiredConfig => ({
  files: parts.files ?? [claudeMd(), configToml(), settingsFile(parts.settings ?? {})],
  skills: parts.skills ?? [],
  integrations: parts.integrations ?? [],
  allow: {},
  issues: [],
});
