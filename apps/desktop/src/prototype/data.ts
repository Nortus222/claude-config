// PROTOTYPE — throwaway mock data for the UI variants. Shapes follow issues #41–#44
// (profiles, overrides with provenance, apply preview, sync conflicts, sharing);
// values mirror this repo's skills-manifest.txt, integrations.json and settings.keys.json.

export type Screen =
  | 'dashboard'
  | 'profile'
  | 'skills'
  | 'integrations'
  | 'changes'
  | 'sync'
  | 'machines'
  | 'sharing';

export const screens: { key: Screen; label: string; hint: string }[] = [
  { key: 'dashboard', label: 'Overview', hint: 'Health of this machine and the fleet' },
  { key: 'profile', label: 'Profile', hint: 'Resolved settings and where each value comes from' },
  { key: 'skills', label: 'Skills', hint: 'Agent skills grouped by source repo' },
  { key: 'integrations', label: 'Integrations', hint: 'Plugins, marketplaces, hooks and MCP servers' },
  { key: 'changes', label: 'Changes', hint: 'Preview and apply to this machine' },
  { key: 'sync', label: 'Sync', hint: 'Upstream updates and override conflicts' },
  { key: 'machines', label: 'Machines', hint: 'Every machine using this profile' },
  { key: 'sharing', label: 'Sharing', hint: 'Publish, follow or copy profiles' },
];

export type Target = 'claude' | 'codex';
export type Source = 'base' | 'override' | 'pinned' | 'default';
export type Value = string | boolean | number | string[];

export const account = { name: 'Ihor Sherstiuk', handle: 'nortus222', initials: 'IS' };

export const profile = {
  name: 'nortus/base',
  description: 'Personal Claude Code and Codex setup, synced across machines.',
  repo: 'Nortus222/claude-config',
  branch: 'main',
  revision: '618c2f0',
  upstreamRevision: 'a41d9e2',
  updatedAt: '2026-10-05T18:40:00Z',
  visibility: 'public' as 'public' | 'private',
};

export type MachineStatus = 'in-sync' | 'behind' | 'drift' | 'offline';
export type Machine = {
  id: string;
  name: string;
  os: string;
  arch: string;
  current: boolean;
  status: MachineStatus;
  appliedRevision: string;
  lastSeen: string;
  overrides: number;
  targets: Target[];
};

export const machines: Machine[] = [
  { id: 'm1', name: 'ihor-mbp', os: 'macOS 27.0', arch: 'arm64', current: true, status: 'behind', appliedRevision: '618c2f0', lastSeen: 'now', overrides: 3, targets: ['claude', 'codex'] },
  { id: 'm2', name: 'studio-mini', os: 'macOS 26.4', arch: 'arm64', current: false, status: 'in-sync', appliedRevision: 'a41d9e2', lastSeen: '12 min ago', overrides: 1, targets: ['claude'] },
  { id: 'm3', name: 'win-workstation', os: 'Windows 11', arch: 'x64', current: false, status: 'drift', appliedRevision: '264dea5', lastSeen: '2 days ago', overrides: 4, targets: ['claude', 'codex'] },
  { id: 'm4', name: 'ci-runner-02', os: 'Ubuntu 24.04', arch: 'x64', current: false, status: 'offline', appliedRevision: 'cf264eb', lastSeen: '9 days ago', overrides: 0, targets: ['codex'] },
];

export type Setting = {
  key: string;
  target: Target;
  base: Value | null;
  override: Value | null;
  desired: Value;
  current: Value | null;
  source: Source;
  note?: string;
};

export const settings: Setting[] = [
  { key: 'effortLevel', target: 'claude', base: 'high', override: null, desired: 'high', current: 'high', source: 'base' },
  { key: 'tui', target: 'claude', base: 'fullscreen', override: null, desired: 'fullscreen', current: 'fullscreen', source: 'base' },
  { key: 'theme', target: 'claude', base: 'auto', override: 'dark', desired: 'dark', current: 'dark', source: 'override', note: 'Overridden on this machine' },
  { key: 'attribution.commit', target: 'claude', base: '', override: null, desired: '', current: '', source: 'base' },
  { key: 'attribution.pr', target: 'claude', base: '', override: null, desired: '', current: 'Generated with Claude Code', source: 'base' },
  { key: 'worktree.symlinkDirectories', target: 'claude', base: ['node_modules', '.cache'], override: ['node_modules', '.cache', '.venv'], desired: ['node_modules', '.cache', '.venv'], current: ['node_modules', '.cache'], source: 'override' },
  { key: 'model', target: 'codex', base: 'gpt-5.5-codex', override: null, desired: 'gpt-5.5-codex', current: 'gpt-5.5-codex', source: 'base' },
  { key: 'approval_policy', target: 'codex', base: 'on-request', override: 'never', desired: 'never', current: 'on-request', source: 'override' },
  { key: 'sandbox_mode', target: 'codex', base: 'workspace-write', override: null, desired: 'workspace-write', current: 'workspace-write', source: 'default' },
];

export type SkillStatus = 'installed' | 'missing' | 'outdated' | 'optional';
export type Skill = { name: string; source: string; status: SkillStatus; pinned?: string; description: string };
export type SkillSource = { repo: string; mode: 'all' | 'exact' | 'optional'; skills: Skill[] };

const s = (name: string, source: string, status: SkillStatus, description: string, pinned?: string): Skill => ({ name, source, status, description, pinned });

export const skillSources: SkillSource[] = [
  {
    repo: 'Nortus222/agent-skills',
    mode: 'optional',
    skills: [
      s('deploy-mobile-apps', 'Nortus222/agent-skills', 'optional', 'Deploy managed Pocket Manage mobile apps'),
      s('explain', 'Nortus222/agent-skills', 'installed', 'Explain code, diffs and PRs so they stick'),
      s('share-artifacts', 'Nortus222/agent-skills', 'installed', 'Share local artifacts over Tailscale'),
    ],
  },
  { repo: 'cursor/plugins', mode: 'exact', skills: [s('unslop', 'cursor/plugins', 'installed', 'Remove generic AI phrasing from prose')] },
  { repo: 'humanlayer/skills', mode: 'all', skills: [s('show-me', 'humanlayer/skills', 'outdated', 'Visual walkthrough of finished work', 'v1.2.0')] },
  {
    repo: 'mattpocock/skills',
    mode: 'all',
    skills: [
      s('code-review', 'mattpocock/skills', 'installed', 'Review against standards and spec'),
      s('codebase-design', 'mattpocock/skills', 'installed', 'Vocabulary for deep modules'),
      s('diagnosing-bugs', 'mattpocock/skills', 'installed', 'Diagnosis loop for hard bugs'),
      s('domain-modeling', 'mattpocock/skills', 'installed', 'Glossaries and ADRs'),
      s('grilling', 'mattpocock/skills', 'installed', 'Stress-test a plan'),
      s('prototype', 'mattpocock/skills', 'installed', 'Throwaway prototypes that answer a question'),
      s('research', 'mattpocock/skills', 'installed', 'Primary-source research to Markdown'),
      s('resolving-merge-conflicts', 'mattpocock/skills', 'installed', 'Resolve an in-progress merge'),
      s('tdd', 'mattpocock/skills', 'installed', 'Red-green-refactor'),
      s('triage', 'mattpocock/skills', 'missing', 'Triage incoming issues'),
      s('wayfinder', 'mattpocock/skills', 'missing', 'Find your way in a new codebase'),
      s('wizard', 'mattpocock/skills', 'installed', 'Interactive bash wizards'),
      s('writing-for-agents', 'mattpocock/skills', 'installed', 'Write skills and AGENTS.md', 'a91c03f'),
    ],
  },
  { repo: 'vercel-labs/skills', mode: 'all', skills: [s('find-skills', 'vercel-labs/skills', 'installed', 'Discover and install skills')] },
];

export type IntegrationKind = 'plugin' | 'marketplace' | 'hook' | 'mcp';
export type IntegrationStatus = 'installed' | 'missing' | 'allowed-extra' | 'drift';
export type Integration = { id: string; label: string; kind: IntegrationKind; target: Target; status: IntegrationStatus; detail: string; env?: string[] };

export const integrations: Integration[] = [
  { id: 'superpowers-claude', label: 'superpowers', kind: 'plugin', target: 'claude', status: 'installed', detail: 'superpowers@claude-plugins-official' },
  { id: 'superpowers-codex', label: 'superpowers', kind: 'plugin', target: 'codex', status: 'installed', detail: 'superpowers@openai-curated' },
  { id: 'openrouter-glm', label: 'OpenRouter GLM 5.3 Flash', kind: 'mcp', target: 'codex', status: 'missing', detail: 'Separate Codex home', env: ['OPENROUTER_API_KEY'] },
  { id: 'session-start', label: 'session-start', kind: 'hook', target: 'claude', status: 'installed', detail: 'Loads superpowers context' },
  { id: 'devexpress', label: 'DevExpress-agent-skills', kind: 'marketplace', target: 'claude', status: 'allowed-extra', detail: 'Present on purpose; never installed' },
  { id: 'context-mode', label: 'context-mode', kind: 'plugin', target: 'claude', status: 'drift', detail: 'Removed from profile 2026-08-20 — still on this machine' },
];

export type ChangeKind = 'add' | 'remove' | 'modify';
export type Change = { id: string; kind: ChangeKind; area: 'setting' | 'skill' | 'integration'; target: Target; path: string; before?: string; after?: string; destructive?: boolean };

export const changes: Change[] = [
  { id: 'c1', kind: 'modify', area: 'setting', target: 'claude', path: 'attribution.pr', before: '"Generated with Claude Code"', after: '""' },
  { id: 'c2', kind: 'modify', area: 'setting', target: 'claude', path: 'worktree.symlinkDirectories', before: '["node_modules", ".cache"]', after: '["node_modules", ".cache", ".venv"]' },
  { id: 'c3', kind: 'modify', area: 'setting', target: 'codex', path: 'approval_policy', before: '"on-request"', after: '"never"' },
  { id: 'c4', kind: 'add', area: 'skill', target: 'claude', path: 'mattpocock/skills/triage' },
  { id: 'c5', kind: 'add', area: 'skill', target: 'claude', path: 'mattpocock/skills/wayfinder' },
  { id: 'c6', kind: 'modify', area: 'skill', target: 'claude', path: 'humanlayer/skills/show-me', before: 'v1.1.4', after: 'v1.2.0' },
  { id: 'c7', kind: 'add', area: 'integration', target: 'codex', path: 'mcp · openrouter-glm' },
  { id: 'c8', kind: 'remove', area: 'integration', target: 'claude', path: 'plugin · context-mode', destructive: true },
];

export const applySteps = ['Back up ~/.claude to ~/.claude/backups', 'Write settings', 'Install skills', 'Install integrations', 'Verify'];

export type UpstreamCommit = { sha: string; message: string; author: string; when: string; touches: string[] };
export const upstream: UpstreamCommit[] = [
  { sha: 'a41d9e2', message: 'feat: default theme to light for daytime sessions', author: 'Nortus222', when: '2 h ago', touches: ['theme'] },
  { sha: '9be1f40', message: 'feat: add wayfinder and triage skills', author: 'Nortus222', when: '5 h ago', touches: ['skills'] },
  { sha: '77c0d1a', message: 'chore: bump show-me to v1.2.0', author: 'Nortus222', when: 'yesterday', touches: ['skills'] },
];

export type Conflict = { key: string; base: string; upstream: string; local: string; resolution: 'keep-local' | 'take-upstream' | null };
export const conflicts: Conflict[] = [
  { key: 'theme', base: '"auto"', upstream: '"light"', local: '"dark"', resolution: null },
];

export type Activity = { id: string; when: string; who: string; text: string; kind: 'apply' | 'sync' | 'override' | 'publish' | 'drift' };
export const activity: Activity[] = [
  { id: 'a1', when: '18:40', who: 'studio-mini', text: 'Applied a41d9e2 — 3 changes', kind: 'apply' },
  { id: 'a2', when: '16:02', who: 'ihor-mbp', text: 'Added override worktree.symlinkDirectories', kind: 'override' },
  { id: 'a3', when: '14:15', who: 'nortus/base', text: 'Published revision 618c2f0', kind: 'publish' },
  { id: 'a4', when: 'Yesterday', who: 'win-workstation', text: 'Drift detected: context-mode plugin', kind: 'drift' },
  { id: 'a5', when: 'Yesterday', who: 'ihor-mbp', text: 'Synced 2 upstream commits', kind: 'sync' },
];

export type PublishedProfile = { name: string; owner: string; description: string; followers: number; skills: number; updated: string; relation: 'mine' | 'following' | 'none' };
export const community: PublishedProfile[] = [
  { name: 'nortus/base', owner: 'nortus222', description: 'Claude Code + Codex, superpowers, strict review workflow', followers: 38, skills: 21, updated: '2 h ago', relation: 'mine' },
  { name: 'mattpocock/ts-dev', owner: 'mattpocock', description: 'TypeScript-first skills: tdd, codebase-design, grilling', followers: 1240, skills: 24, updated: '3 days ago', relation: 'following' },
  { name: 'vercel/agents', owner: 'vercel-labs', description: 'Skill discovery and deployment helpers', followers: 812, skills: 9, updated: 'last week', relation: 'none' },
  { name: 'humanlayer/ops', owner: 'humanlayer', description: 'Show-me walkthroughs and human-in-the-loop hooks', followers: 455, skills: 7, updated: '2 weeks ago', relation: 'none' },
];

/** Readable form of any setting value. */
export const show = (v: Value | null | undefined) =>
  v === null || v === undefined ? '—' : Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'string' ? (v === '' ? '""' : v) : String(v);

export const counts = {
  pendingChanges: changes.length,
  destructive: changes.filter((c) => c.destructive).length,
  overrides: settings.filter((x) => x.source === 'override').length,
  skillsInstalled: skillSources.flatMap((x) => x.skills).filter((x) => x.status === 'installed').length,
  skillsTotal: skillSources.flatMap((x) => x.skills).length,
  upstreamBehind: upstream.length,
  conflicts: conflicts.length,
};
