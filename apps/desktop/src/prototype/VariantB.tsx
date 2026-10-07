// PROTOTYPE — Variant B "Review inbox": a macOS-native three-pane shell
// (source list | item list | inspector) where every screen is reviewed one item at a time.
import { useEffect, useState, type ReactNode } from 'react';
import type { VariantProps } from './main.tsx';
import {
  account,
  activity,
  applySteps,
  changes,
  community,
  conflicts,
  integrations,
  machines,
  profile,
  screens,
  settings,
  show,
  skillSources,
  upstream,
  type Change,
  type Integration,
  type Machine,
  type MachineStatus,
  type PublishedProfile,
  type Screen,
  type Setting,
  type Skill,
  type Source,
  type Target,
  type Value,
} from './data.ts';
import './VariantB.css';

export const name = 'Review inbox';

/* ───────────────────────── Icons ───────────────────────── */

const paths = {
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" />
    </>
  ),
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  sparkles: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 3v4M17 5h4M5 17v4M3 19h4" />
    </>
  ),
  plug: <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />,
  diff: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 12h6M12 9v6M9 18h6" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" />
      <path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" />
      <path d="M21 3v5h-5M3 21v-5h5" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  laptop: (
    <>
      <rect x="4" y="4" width="16" height="11" rx="2" />
      <path d="M2 20h20" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="3" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="7" rx="2" />
      <path d="M7 6.5h.01M7 17.5h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  merge: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
  commit: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" />
    </>
  ),
  download: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
    </>
  ),
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronUp: <path d="m18 15-6-6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  sidebar: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 10 5-10 5L2 7z" />
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
    </>
  ),
  trash: <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  pkg: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z" />
      <path d="M3.3 7 12 12l8.7-5M12 22V12" />
    </>
  ),
  hook: (
    <>
      <path d="M18 17h-6c-1.1 0-1.9.9-2.5 1.9A4 4 0 0 1 2 17c0-.7.2-1.4.6-2" />
      <path d="m6 17 3.1-5.8c.5-1 .1-2.2-.5-3.1a4 4 0 1 1 6.9-4.1" />
      <path d="m12 6 3.1 5.7c.5 1 1.8 1.3 2.9 1.3a4 4 0 0 1 0 8" />
    </>
  ),
  store: <path d="M3 9l1.5-5h15L21 9M3 9h18v1a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 13v8h14v-8" />,
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  arrowDown: <path d="M12 5v14M5 12l7 7 7-7" />,
  branch: (
    <>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  wifiOff: <path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.2-1.6M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 11 5M12 20h.01" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  pin: <path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v3H6v-3z" />,
  circleCheck: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  terminal: <path d="m4 17 6-6-6-6M12 19h8" />,
} satisfies Record<string, ReactNode>;

type IconName = keyof typeof paths;

function Icon({ n, size = 16, className }: { n: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[n]}
    </svg>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Tone = 'blue' | 'orange' | 'red' | 'green' | 'purple' | 'teal' | 'yellow' | 'gray' | 'indigo';

const machineTone: Record<MachineStatus, Tone> = { 'in-sync': 'green', behind: 'blue', drift: 'red', offline: 'gray' };
const machineLabel: Record<MachineStatus, string> = { 'in-sync': 'In sync', behind: 'Behind', drift: 'Drift', offline: 'Offline' };
const sourceTone: Record<Source, Tone> = { base: 'blue', override: 'purple', pinned: 'teal', default: 'gray' };
const targetLabel: Record<Target, string> = { claude: 'Claude Code', codex: 'Codex' };
const machineIcon = (m: Machine): IconName => (m.os.startsWith('Ubuntu') ? 'server' : m.os.startsWith('Windows') ? 'monitor' : 'laptop');

const allSkills: Skill[] = skillSources.flatMap((x) => x.skills);
const backupPath = '~/.claude/backups/2026-10-05T18-42-07';

function Pill({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: IconName }) {
  return (
    <span className={cx('vb-pill', `t-${tone}`)}>
      {icon && <Icon n={icon} size={11} />}
      {children}
    </span>
  );
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={cx('vb-dot', `t-${tone}`)} />;
}

function Tile({ icon, tone, size = 'md' }: { icon: IconName; tone: Tone; size?: 'md' | 'lg' }) {
  return (
    <span className={cx('vb-tile', `t-${tone}`, size === 'lg' && 'lg')}>
      <Icon n={icon} size={size === 'lg' ? 22 : 15} />
    </span>
  );
}

function TargetChip({ target }: { target: Target }) {
  return <span className={cx('vb-target', target)}>{target === 'claude' ? 'Claude' : 'Codex'}</span>;
}

function KindBadge({ kind }: { kind: Change['kind'] }) {
  const label = kind === 'add' ? 'Added' : kind === 'remove' ? 'Removed' : 'Modified';
  return (
    <span className={cx('vb-kind', kind)} title={label}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <rect x="0.75" y="0.75" width="10.5" height="10.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        {kind === 'modify' && <circle cx="6" cy="6" r="2" fill="currentColor" />}
        {kind !== 'modify' && <path d="M3.5 6h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
        {kind === 'add' && <path d="M6 3.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      </svg>
    </span>
  );
}

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={cx('vb-switch', on && 'on')}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
    >
      <i />
    </button>
  );
}

function Check({ on, mixed, onChange, disabled, label }: { on: boolean; mixed?: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : on}
      aria-label={label}
      disabled={disabled}
      className={cx('vb-check', (on || mixed) && 'on')}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
    >
      {mixed ? <Icon n="minus" size={10} /> : on ? <Icon n="check" size={10} /> : null}
    </button>
  );
}

function Empty({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="vb-empty">
      <Icon n={icon} size={30} />
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="vb-sec">
      <header>
        <h4>{title}</h4>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="vb-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Callout({ tone, icon, title, children }: { tone: Tone; icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className={cx('vb-callout', `t-${tone}`)}>
      <Icon n={icon} />
      <div>
        <b>{title}</b>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

/** Arrow keys / j k move the selection through a list, Mail-style, and keep the row in view. */
function useListKeys(ids: string[], current: string | undefined, select: (id: string) => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const step = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
      if (!step || ids.length === 0) return;
      event.preventDefault();
      const i = current ? ids.indexOf(current) : -1;
      const next = ids[Math.min(ids.length - 1, Math.max(0, i + step))];
      if (next) select(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids.join('|'), current, select]);
  useEffect(() => {
    if (current) document.querySelector(`.vb [data-row="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);
}

function Row({ id, selected, onSelect, className, children }: { id: string; selected: boolean; onSelect: (id: string) => void; className?: string; children: ReactNode }) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-row={id}
      className={cx('vb-row', selected && 'is-sel', className)}
      onClick={() => onSelect(id)}
    >
      {children}
    </div>
  );
}

/* ───────────────────────── Diffs ───────────────────────── */

type DiffLine = { t: ' ' | '+' | '-'; s: string; a?: number; b?: number };
type DiffFile = { file: string; start: number; lines: string[] };

/** Hand-written hunks: the first character of each line is ' ', '+' or '-'. */
const changeDiffs: Record<string, DiffFile> = {
  c1: {
    file: '~/.claude/settings.json',
    start: 18,
    lines: ['   "effortLevel": "high",', '   "attribution": {', '     "commit": "",', '-    "pr": "Generated with Claude Code"', '+    "pr": ""', '   },', '   "theme": "dark",'],
  },
  c2: {
    file: '~/.claude/settings.json',
    start: 31,
    lines: ['   "worktree": {', '     "symlinkDirectories": [', '       "node_modules",', '-      ".cache"', '+      ".cache",', '+      ".venv"', '     ]', '   },'],
  },
  c3: {
    file: '~/.codex/config.toml',
    start: 1,
    lines: [' model = "gpt-5.5-codex"', '-approval_policy = "on-request"', '+approval_policy = "never"', ' sandbox_mode = "workspace-write"'],
  },
  c4: {
    file: '~/.claude/skills/triage/SKILL.md',
    start: 0,
    lines: ['+---', '+name: triage', '+description: Triage incoming issues', '+source: mattpocock/skills', '+---', '+', '+# Triage', '+Sort incoming issues into actionable buckets.'],
  },
  c5: {
    file: '~/.claude/skills/wayfinder/SKILL.md',
    start: 0,
    lines: ['+---', '+name: wayfinder', '+description: Find your way in a new codebase', '+source: mattpocock/skills', '+---', '+', '+# Wayfinder', '+Map an unfamiliar repository before changing it.'],
  },
  c6: {
    file: '~/.claude/skills/show-me/.nortuscc-lock',
    start: 1,
    lines: [' source = "humanlayer/skills"', ' name = "show-me"', '-version = "v1.1.4"', '+version = "v1.2.0"', ' pinned = true'],
  },
  c7: {
    file: '~/.codex-openrouter/config.toml',
    start: 12,
    lines: [' [profiles.default]', ' model_provider = "openrouter"', ' ', '+[mcp_servers.openrouter-glm]', '+command = "openrouter-mcp"', '+args = ["--model", "glm-5.3-flash"]', '+env_vars = ["OPENROUTER_API_KEY"]'],
  },
  c8: {
    file: '~/.claude/settings.json',
    start: 42,
    lines: ['   "enabledPlugins": {', '-    "superpowers@claude-plugins-official": true,', '-    "context-mode@context-mode": true', '+    "superpowers@claude-plugins-official": true', '   },'],
  },
};

const commitDiffs: Record<string, DiffFile> = {
  a41d9e2: {
    file: 'claude/settings.keys.json',
    start: 3,
    lines: ['   "effortLevel": "high",', '-  "theme": "auto",', '+  "theme": "light",', '   "tui": "fullscreen",'],
  },
  '9be1f40': {
    file: 'skills-manifest.txt',
    start: 22,
    lines: [' mattpocock/skills', '   resolving-merge-conflicts', '   tdd', '+  triage', '+  wayfinder', '   wizard'],
  },
  '77c0d1a': {
    file: 'skills-manifest.txt',
    start: 14,
    lines: [' humanlayer/skills', '-  show-me@v1.1.4', '+  show-me@v1.2.0'],
  },
};

function numberLines(d: DiffFile): DiffLine[] {
  let a = d.start;
  let b = Math.max(1, d.start);
  return d.lines.map((raw) => {
    const t = raw[0] as DiffLine['t'];
    const s = raw.slice(1);
    if (t === ' ') return { t, s, a: a++, b: b++ };
    if (t === '-') return { t, s, a: a++ };
    return { t, s, b: b++ };
  });
}

function hunkHeader(d: DiffFile, lines: DiffLine[]) {
  const olds = lines.filter((l) => l.t !== '+').length;
  const news = lines.filter((l) => l.t !== '-').length;
  return `@@ -${olds ? d.start : 0},${olds} +${Math.max(1, d.start)},${news} @@`;
}

function Diff({ d, split }: { d: DiffFile; split: boolean }) {
  const lines = numberLines(d);
  const added = lines.filter((l) => l.t === '+').length;
  const removed = lines.filter((l) => l.t === '-').length;
  const rows: [DiffLine | null, DiffLine | null][] = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!;
    if (l.t === ' ') {
      rows.push([l, l]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.t === '-') dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.t === '+') adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
  }
  const cell = (l: DiffLine | null, side: 'a' | 'b') =>
    l ? (
      <>
        <span className="ln">{side === 'a' ? l.a : l.b}</span>
        <code className={cx('tx', l.t === '-' && 'del', l.t === '+' && 'add')}>{l.s || ' '}</code>
      </>
    ) : (
      <>
        <span className="ln empty" />
        <code className="tx empty"> </code>
      </>
    );
  return (
    <div className="vb-diff">
      <div className="vb-diff-file">
        <Icon n="diff" size={13} />
        <span>{d.file}</span>
        <em>
          {added > 0 && <b className="add">+{added}</b>}
          {removed > 0 && <b className="del">−{removed}</b>}
        </em>
      </div>
      <div className="vb-diff-hunk">{hunkHeader(d, lines)}</div>
      {split ? (
        <div className="vb-diff-body split">
          {rows.map(([l, r], i) => (
            <div key={i} className="dl">
              {cell(l && l.t !== '+' ? l : null, 'a')}
              {cell(r && r.t !== '-' ? r : null, 'b')}
            </div>
          ))}
        </div>
      ) : (
        <div className="vb-diff-body">
          {lines.map((l, i) => (
            <div key={i} className={cx('dl', l.t === '-' && 'del', l.t === '+' && 'add')}>
              <span className="ln">{l.a ?? ''}</span>
              <span className="ln">{l.b ?? ''}</span>
              <code className="tx">
                <i>{l.t === ' ' ? ' ' : l.t === '-' ? '−' : '+'}</i>
                {l.s || ' '}
              </code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── App state ───────────────────────── */

type RunState = 'idle' | 'running' | 'completed' | 'cancelled';
type Run = { state: RunState; step: number; ids: string[] };
type Resolution = 'keep-local' | 'take-upstream' | null;
type Relation = PublishedProfile['relation'];
type Confirm = { title: string; body: ReactNode; action: string; onConfirm: () => void };
type Phase = 'idle' | 'running' | 'done';

type InboxId = 'conflict' | 'changes' | 'drift' | 'mcp-key' | 'upstream' | 'skills-missing' | 'skill-outdated' | 'offline';
type InboxGroup = 'Needs you' | 'Updates' | 'FYI';
type InboxItem = { id: InboxId; group: InboxGroup; icon: IconName; tone: Tone; title: string; sub: string; time: string };

const initialSegments = Object.fromEntries(screens.map((s) => [s.key, 0])) as Record<Screen, number>;

function useApp() {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(changes.filter((c) => !c.destructive).map((c) => c.id)));
  const [applied, setApplied] = useState<Set<string>>(() => new Set());
  const [run, setRun] = useState<Run>({ state: 'idle', step: 0, ids: [] });
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>(() => Object.fromEntries(conflicts.map((c) => [c.key, c.resolution])));
  const [sync, setSync] = useState<Phase>('idle');
  const [fetching, setFetching] = useState<Phase>('idle');
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(allSkills.map((s) => [s.name, s.status !== 'optional'])));
  const [relations, setRelations] = useState<Record<string, Relation>>(() => Object.fromEntries(community.map((p) => [p.name, p.relation])));
  const [copies, setCopies] = useState<string[]>([]);
  const [visibility, setVisibility] = useState(profile.visibility);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [forgotten, setForgotten] = useState<Set<string>>(() => new Set());
  const [requested, setRequested] = useState<Set<string>>(() => new Set());
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  const [machineId, setMachineId] = useState('m1');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [seg, setSegState] = useState(initialSegments);
  const [query, setQuery] = useState('');

  // Apply walks applySteps on a timer; cancelling stops it where it is.
  useEffect(() => {
    if (run.state !== 'running') return;
    const id = window.setInterval(() => {
      setRun((r) => {
        if (r.state !== 'running') return r;
        const step = r.step + 1;
        return step >= applySteps.length ? { ...r, state: 'completed', step } : { ...r, step };
      });
    }, 850);
    return () => window.clearInterval(id);
  }, [run.state]);

  useEffect(() => {
    if (run.state !== 'completed') return;
    setApplied((prev) => new Set([...prev, ...run.ids]));
    setChecked((prev) => new Set([...prev].filter((id) => !run.ids.includes(id))));
  }, [run.state, run.ids]);

  useEffect(() => {
    if (sync !== 'running') return;
    const t = window.setTimeout(() => setSync('done'), 1800);
    return () => window.clearTimeout(t);
  }, [sync]);

  useEffect(() => {
    if (fetching !== 'running') return;
    const t = window.setTimeout(() => setFetching('done'), 1200);
    return () => window.clearTimeout(t);
  }, [fetching]);

  const pending = changes.filter((c) => !applied.has(c.id));
  const selected = pending.filter((c) => checked.has(c.id));
  const unresolved = conflicts.filter((c) => !resolutions[c.key]);
  const busy = run.state === 'running';

  const toggleChange = (c: Change) => {
    if (busy) return;
    if (checked.has(c.id)) {
      setChecked((prev) => new Set([...prev].filter((x) => x !== c.id)));
      return;
    }
    const add = () => setChecked((prev) => new Set([...prev, c.id]));
    if (!c.destructive) return add();
    setConfirm({
      title: `Remove ${c.path.replace('plugin · ', '')} from this Mac?`,
      body: (
        <>
          This change <b>deletes</b> the plugin and its entry in <code>enabledPlugins</code>. It was removed from <b>{profile.name}</b> on
          2026-08-20. nortuscc backs up <code>~/.claude</code> before anything is deleted.
        </>
      ),
      action: 'Include removal',
      onConfirm: add,
    });
  };

  const setAll = (on: boolean) => {
    if (busy) return;
    if (!on) return setChecked(new Set());
    const safe = pending.filter((c) => !c.destructive).map((c) => c.id);
    const destructive = pending.filter((c) => c.destructive && !checked.has(c.id));
    setChecked((prev) => new Set([...prev, ...safe]));
    if (destructive.length) toggleChange(destructive[0]!);
  };

  const machineStatus = (m: Machine): MachineStatus =>
    m.current && pending.length === 0 && sync === 'done' ? 'in-sync' : m.status;
  const fleet = machines.filter((m) => !forgotten.has(m.id));

  const inbox = (
    [
      unresolved.length > 0 &&
        sync !== 'done' && {
          id: 'conflict',
          group: 'Needs you',
          icon: 'merge',
          tone: 'orange',
          title: 'Sync conflict on theme',
          sub: 'Upstream sets "light" — this Mac overrides it to "dark"',
          time: '2h',
        },
      pending.length > 0 && {
        id: 'changes',
        group: 'Needs you',
        icon: 'diff',
        tone: 'blue',
        title: `${pending.length} change${pending.length === 1 ? '' : 's'} ready to apply`,
        sub: pending.some((c) => c.destructive) ? '1 removal · a backup is taken first' : 'Settings, skills and integrations',
        time: 'now',
      },
      !forgotten.has('m3') && {
        id: 'drift',
        group: 'Needs you',
        icon: 'alert',
        tone: 'red',
        title: 'Drift on win-workstation',
        sub: 'context-mode plugin is still installed',
        time: '2d',
      },
      !applied.has('c7') && {
        id: 'mcp-key',
        group: 'Needs you',
        icon: 'key',
        tone: 'yellow',
        title: 'OpenRouter GLM needs an API key',
        sub: 'Set OPENROUTER_API_KEY before applying',
        time: '1d',
      },
      sync !== 'done' && {
        id: 'upstream',
        group: 'Updates',
        icon: 'download',
        tone: 'purple',
        title: `${upstream.length} upstream commits on ${profile.branch}`,
        sub: upstream[0]!.message,
        time: '2h',
      },
      (!applied.has('c4') || !applied.has('c5')) && {
        id: 'skills-missing',
        group: 'Updates',
        icon: 'sparkles',
        tone: 'teal',
        title: '2 skills missing on this Mac',
        sub: 'triage and wayfinder from mattpocock/skills',
        time: '5h',
      },
      !applied.has('c6') && {
        id: 'skill-outdated',
        group: 'Updates',
        icon: 'pin',
        tone: 'indigo',
        title: 'show-me has a pinned update',
        sub: 'humanlayer/skills · v1.1.4 → v1.2.0',
        time: '1d',
      },
      !forgotten.has('m4') && {
        id: 'offline',
        group: 'FYI',
        icon: 'wifiOff',
        tone: 'gray',
        title: "ci-runner-02 hasn't checked in",
        sub: 'Last seen 9 days ago on cf264eb',
        time: '9d',
      },
    ] as (InboxItem | false)[]
  ).filter((x): x is InboxItem => !!x);
  const openInbox = inbox.filter((i) => !dismissed.has(i.id));

  return {
    checked,
    applied,
    pending,
    selected,
    run,
    busy,
    resolutions,
    unresolved,
    sync,
    fetching,
    enabled,
    relations,
    copies,
    visibility,
    dismissed,
    forgotten,
    requested,
    cleared,
    machineId,
    confirm,
    seg,
    query,
    fleet,
    inbox,
    openInbox,
    machineStatus,
    toggleChange,
    setAll,
    setChecked,
    setMachineId,
    setConfirm,
    setQuery,
    setVisibility,
    setSeg: (screen: Screen, i: number) => setSegState((s) => ({ ...s, [screen]: i })),
    startApply: () => selected.length > 0 && setRun({ state: 'running', step: 0, ids: selected.map((c) => c.id) }),
    cancelApply: () => setRun((r) => (r.state === 'running' ? { ...r, state: 'cancelled' } : r)),
    resetApply: () => setRun({ state: 'idle', step: 0, ids: [] }),
    resolve: (key: string, r: Resolution) => setResolutions((x) => ({ ...x, [key]: r })),
    startSync: () => unresolved.length === 0 && setSync('running'),
    startFetch: () => setFetching('running'),
    toggleSkill: (s: Skill) => {
      const on = enabled[s.name] ?? false;
      const flip = () => setEnabled((x) => ({ ...x, [s.name]: !on }));
      if (on && s.status === 'installed')
        return setConfirm({
          title: `Remove ${s.name} from this Mac?`,
          body: (
            <>
              <code>~/.claude/skills/{s.name}</code> is deleted on the next apply, after a backup. The skill stays listed in{' '}
              <b>{s.source}</b> so you can turn it back on.
            </>
          ),
          action: 'Remove skill',
          onConfirm: flip,
        });
      flip();
    },
    follow: (p: string) => setRelations((x) => ({ ...x, [p]: x[p] === 'following' ? 'none' : 'following' })),
    copy: (p: string) => setCopies((x) => (x.includes(p) ? x : [...x, p])),
    dismiss: (id: string) => setDismissed((x) => new Set([...x, id])),
    restoreDismissed: () => setDismissed(new Set()),
    forget: (id: string) => setForgotten((x) => new Set([...x, id])),
    request: (id: string) => setRequested((x) => new Set([...x, id])),
    toggleOverride: (key: string) => setCleared((x) => (x.has(key) ? new Set([...x].filter((k) => k !== key)) : new Set([...x, key]))),
  };
}

type App = ReturnType<typeof useApp>;
type ScreenProps = { app: App; go: (s: Screen) => void };

/* ───────────────────────── Shell ───────────────────────── */

const segmentsFor: Partial<Record<Screen, string[]>> = {
  dashboard: ['All', 'Needs you', 'Updates'],
  profile: ['All', 'Claude Code', 'Codex', 'Overrides'],
  skills: ['All', 'Installed', 'Attention'],
  integrations: ['All', 'Claude Code', 'Codex'],
  changes: ['Unified', 'Split'],
  sync: ['All', 'Conflicts'],
  machines: ['All', 'Attention'],
  sharing: ['Discover', 'Following', 'Mine'],
};
const searchable: Partial<Record<Screen, string>> = {
  profile: 'Filter settings',
  skills: 'Search skills',
  integrations: 'Search integrations',
  sharing: 'Search profiles',
};

const nav: { section: string; items: { key: Screen; icon: IconName; label: string }[] }[] = [
  {
    section: 'Review',
    items: [
      { key: 'dashboard', icon: 'inbox', label: 'Today' },
      { key: 'changes', icon: 'diff', label: 'Changes' },
      { key: 'sync', icon: 'refresh', label: 'Sync' },
    ],
  },
  {
    section: profile.name,
    items: [
      { key: 'profile', icon: 'sliders', label: 'Settings' },
      { key: 'skills', icon: 'sparkles', label: 'Skills' },
      { key: 'integrations', icon: 'plug', label: 'Integrations' },
    ],
  },
];

export function VariantB({ screen, go }: VariantProps) {
  const app = useApp();
  useEffect(() => app.setQuery(''), [screen]);

  const title: Record<Screen, [string, string]> = {
    dashboard: ['Today', `${app.openInbox.length} to review · Monday, 5 October`],
    profile: ['Settings', `${profile.name} @ ${profile.revision}`],
    skills: ['Skills', `${allSkills.filter((s) => app.enabled[s.name]).length} of ${allSkills.length} enabled`],
    integrations: ['Integrations', `${integrations.length} declared in integrations.json`],
    changes: ['Changes', app.pending.length ? `${app.pending.length} pending on ihor-mbp` : 'ihor-mbp matches the profile'],
    sync: ['Sync', app.sync === 'done' ? `Up to date with ${profile.upstreamRevision}` : `${upstream.length} incoming · ${app.unresolved.length} conflict${app.unresolved.length === 1 ? '' : 's'}`],
    machines: ['Machines', `${app.fleet.length} using ${profile.name}`],
    sharing: ['Sharing', `${profile.name} is ${app.visibility}`],
  };
  const segments = segmentsFor[screen];
  const search = searchable[screen];
  const badge = (key: Screen) =>
    key === 'dashboard'
      ? app.openInbox.length
      : key === 'changes'
        ? app.pending.length
        : key === 'sync'
          ? app.unresolved.length || (app.sync === 'done' ? 0 : upstream.length)
          : 0;
  const props = { app, go };

  return (
    <div className="vb">
      {/* Unified toolbar, split to line up with the panes below */}
      <header className="vb-tb-side">
        <div className="vb-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <button className="vb-tbtn icon" title="Toggle sidebar">
          <Icon n="sidebar" />
        </button>
      </header>
      <header className="vb-tb-list">
        <h1>{title[screen][0]}</h1>
        <span>{title[screen][1]}</span>
      </header>
      <header className="vb-tb-insp">
        {segments && (
          <div className="vb-seg" role="tablist">
            {segments.map((s, i) => (
              <button key={s} role="tab" aria-selected={app.seg[screen] === i} className={cx(app.seg[screen] === i && 'on')} onClick={() => app.setSeg(screen, i)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="vb-tb-spacer" />
        <button className={cx('vb-tbtn', app.fetching === 'running' && 'spin')} onClick={app.startFetch} disabled={app.fetching === 'running'} title="Fetch upstream">
          <Icon n="refresh" />
          <span>Fetch</span>
        </button>
        <button className="vb-tbtn" onClick={() => go('changes')} title="Review changes">
          <Icon n="diff" />
          <span>Review</span>
          {app.pending.length > 0 && <em>{app.pending.length}</em>}
        </button>
        {search && (
          <label className="vb-search">
            <Icon n="search" size={13} />
            <input value={app.query} onChange={(e) => app.setQuery(e.target.value)} placeholder={search} />
            {app.query && (
              <button onClick={() => app.setQuery('')} aria-label="Clear search">
                <Icon n="x" size={11} />
              </button>
            )}
          </label>
        )}
      </header>

      {/* Source list */}
      <nav className="vb-side">
        <div className="vb-side-scroll">
          {nav.map((g) => (
            <div key={g.section} className="vb-side-group">
              <h5>{g.section}</h5>
              {g.items.map((it) => (
                <button key={it.key} className={cx('vb-side-item', screen === it.key && 'on')} onClick={() => go(it.key)}>
                  <Icon n={it.icon} />
                  <span>{it.label}</span>
                  {badge(it.key) > 0 && <em className={cx(it.key === 'sync' && app.unresolved.length > 0 && 'warn')}>{badge(it.key)}</em>}
                </button>
              ))}
            </div>
          ))}
          <div className="vb-side-group">
            <h5>
              <button className="vb-side-h" onClick={() => go('machines')}>
                Machines
              </button>
            </h5>
            {app.fleet.map((m) => {
              const st = app.machineStatus(m);
              return (
                <button
                  key={m.id}
                  className={cx('vb-side-item', screen === 'machines' && app.machineId === m.id && 'on')}
                  onClick={() => {
                    app.setMachineId(m.id);
                    go('machines');
                  }}
                >
                  <Icon n={machineIcon(m)} />
                  <span>
                    {m.name}
                    {m.current && <small> · This Mac</small>}
                  </span>
                  <Dot tone={machineTone[st]} />
                </button>
              );
            })}
          </div>
          <div className="vb-side-group">
            <h5>Community</h5>
            <button className={cx('vb-side-item', screen === 'sharing' && 'on')} onClick={() => go('sharing')}>
              <Icon n="globe" />
              <span>Sharing</span>
            </button>
          </div>
        </div>
        <footer className="vb-side-foot">
          <span className="vb-avatar">{account.initials}</span>
          <div>
            <b>{account.name}</b>
            <small>@{account.handle}</small>
          </div>
        </footer>
      </nav>

      {screen === 'dashboard' && <Dashboard {...props} />}
      {screen === 'changes' && <Changes {...props} />}
      {screen === 'sync' && <Sync {...props} />}
      {screen === 'profile' && <Profile {...props} />}
      {screen === 'skills' && <Skills {...props} />}
      {screen === 'integrations' && <Integrations {...props} />}
      {screen === 'machines' && <Machines {...props} />}
      {screen === 'sharing' && <Sharing {...props} />}

      <footer className="vb-status">
        <div>
          {app.busy ? (
            <>
              <span className="vb-spinner" /> Applying · step {Math.min(app.run.step + 1, applySteps.length)} of {applySteps.length}
            </>
          ) : app.sync === 'running' ? (
            <>
              <span className="vb-spinner" /> Syncing with {profile.repo}
            </>
          ) : (
            <>
              <Icon n="branch" size={13} />
              {profile.branch} @ <code>{app.sync === 'done' ? profile.upstreamRevision : profile.revision}</code>
              {app.sync !== 'done' && <span className="vb-status-dim">· {upstream.length} behind</span>}
            </>
          )}
        </div>
        <div className="vb-status-r">
          <code>{profile.repo}</code>
          <span className="vb-status-dim">·</span>
          <Icon n="clock" size={13} />
          {app.fetching === 'running' ? 'Fetching…' : app.fetching === 'done' ? 'Fetched just now' : 'Fetched 2 min ago'}
        </div>
      </footer>

      {app.confirm && <Sheet confirm={app.confirm} close={() => app.setConfirm(null)} />}
    </div>
  );
}

function Sheet({ confirm, close }: { confirm: Confirm; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="vb-sheet-wrap" onClick={close}>
      <div className="vb-sheet" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <span className="vb-sheet-icon">
          <Icon n="alert" size={26} />
        </span>
        <h3>{confirm.title}</h3>
        <p>{confirm.body}</p>
        <div className="vb-sheet-actions">
          <button className="vb-btn" onClick={close} autoFocus>
            Cancel
          </button>
          <button
            className="vb-btn danger-fill"
            onClick={() => {
              confirm.onConfirm();
              close();
            }}
          >
            {confirm.action}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shared inspector header for every screen. */
function InspHead({ icon, tone, title, meta, right }: { icon: IconName; tone: Tone; title: ReactNode; meta: ReactNode; right?: ReactNode }) {
  return (
    <header className="vb-ihead">
      <Tile icon={icon} tone={tone} size="lg" />
      <div className="vb-ihead-t">
        <h2>{title}</h2>
        <div className="vb-ihead-m">{meta}</div>
      </div>
      {right}
    </header>
  );
}

function Pager({ index, total, move }: { index: number; total: number; move: (step: number) => void }) {
  return (
    <div className="vb-pager">
      <span>
        {index + 1} of {total}
      </span>
      <button className="vb-btn icon" onClick={() => move(-1)} disabled={index <= 0} aria-label="Previous">
        <Icon n="chevronUp" size={13} />
      </button>
      <button className="vb-btn icon" onClick={() => move(1)} disabled={index >= total - 1} aria-label="Next">
        <Icon n="chevronDown" size={13} />
      </button>
    </div>
  );
}

/* ───────────────────────── Today (dashboard) ───────────────────────── */

function FleetHealth({ app, go }: ScreenProps) {
  const counts = (['in-sync', 'behind', 'drift', 'offline'] as MachineStatus[]).map((st) => ({
    st,
    n: app.fleet.filter((m) => app.machineStatus(m) === st).length,
  }));
  return (
    <div className="vb-health">
      <div className="vb-health-head">
        <b>Fleet health</b>
        <span>{app.fleet.length} machines</span>
        <button className="vb-link" onClick={() => go('machines')}>
          Show all
        </button>
      </div>
      <div className="vb-health-bar">
        {counts.map((c) => c.n > 0 && <i key={c.st} className={`t-${machineTone[c.st]}`} style={{ flex: c.n }} title={`${c.n} ${machineLabel[c.st]}`} />)}
      </div>
      <div className="vb-health-grid">
        {app.fleet.map((m) => {
          const st = app.machineStatus(m);
          return (
            <button
              key={m.id}
              onClick={() => {
                app.setMachineId(m.id);
                go('machines');
              }}
            >
              <Dot tone={machineTone[st]} />
              <b>{m.name}</b>
              <small>{machineLabel[st]}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Dashboard({ app, go }: ScreenProps) {
  const filter = app.seg.dashboard;
  const items = app.openInbox.filter((i) => filter === 0 || (filter === 1 ? i.group === 'Needs you' : i.group !== 'Needs you'));
  const [sel, setSel] = useState('');
  const current = items.find((i) => i.id === sel) ?? items[0];
  const index = current ? items.indexOf(current) : -1;
  useListKeys(
    items.map((i) => i.id),
    current?.id,
    setSel,
  );
  const move = (step: number) => {
    const next = items[index + step];
    if (next) setSel(next.id);
  };
  const dismiss = (id: string) => {
    const next = items[index + 1] ?? items[index - 1];
    app.dismiss(id);
    if (next) setSel(next.id);
  };

  return (
    <>
      <section className="vb-list">
        <div className="vb-list-scroll">
          <FleetHealth app={app} go={go} />
          {(['Needs you', 'Updates', 'FYI'] as InboxGroup[]).map((g) => {
            const gi = items.filter((i) => i.group === g);
            if (!gi.length) return null;
            return (
              <div key={g}>
                <div className="vb-group">
                  {g}
                  <span>{gi.length}</span>
                </div>
                {gi.map((i) => (
                  <Row key={i.id} id={i.id} selected={current?.id === i.id} onSelect={setSel} className="vb-mail">
                    <Tile icon={i.icon} tone={i.tone} />
                    <div className="vb-mail-t">
                      <div className="vb-mail-l1">
                        <b>{i.title}</b>
                        <time>{i.time}</time>
                      </div>
                      <span>{i.sub}</span>
                    </div>
                  </Row>
                ))}
              </div>
            );
          })}
          {items.length === 0 && (
            <Empty icon="circleCheck" title="All caught up" text="Nothing on this profile needs your review." />
          )}
          {app.dismissed.size > 0 && (
            <div className="vb-dismissed">
              {app.dismissed.size} dismissed
              <button className="vb-link" onClick={app.restoreDismissed}>
                Restore
              </button>
            </div>
          )}
        </div>
      </section>
      <section className="vb-insp">
        {current ? (
          <div className="vb-insp-in" key={current.id}>
            <InspHead
              icon={current.icon}
              tone={current.tone}
              title={current.title}
              meta={
                <>
                  <span>{current.group}</span>
                  <span>·</span>
                  <span>{current.time === 'now' ? 'Just now' : `${current.time} ago`}</span>
                </>
              }
              right={<Pager index={index} total={items.length} move={move} />}
            />
            <InboxDetail item={current} app={app} go={go} dismiss={() => dismiss(current.id)} />
          </div>
        ) : (
          <Empty icon="inbox" title="Inbox zero" text="When upstream moves or a machine drifts, it lands here for review." />
        )}
      </section>
    </>
  );
}

function InboxDetail({ item, app, go, dismiss }: ScreenProps & { item: InboxItem; dismiss: () => void }) {
  const dismissBtn = (
    <button className="vb-btn" onClick={dismiss}>
      Dismiss
    </button>
  );
  switch (item.id) {
    case 'conflict': {
      const c = conflicts[0]!;
      const r = app.resolutions[c.key];
      return (
        <>
          <div className="vb-actions">
            <button className="vb-btn primary" onClick={() => go('sync')}>
              Resolve in Sync
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">
            Upstream commit <code>a41d9e2</code> changed the base value of <code>theme</code>, which this Mac overrides. nortuscc never overwrites an
            override silently, so you choose.
          </p>
          <ThreeWay conflict={c} resolution={r} onResolve={(x) => app.resolve(c.key, x)} compact />
        </>
      );
    }
    case 'changes': {
      const by = (area: Change['area']) => app.pending.filter((c) => c.area === area);
      return (
        <>
          <div className="vb-actions">
            <button className="vb-btn primary" onClick={() => go('changes')}>
              Review &amp; apply
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">
            The profile resolves to {app.pending.length} differences from what is on disk. Review each diff, then apply. Everything is backed up to{' '}
            <code>~/.claude/backups/</code> first.
          </p>
          <div className="vb-stats">
            {(['setting', 'skill', 'integration'] as const).map((a) => (
              <div key={a}>
                <b>{by(a).length}</b>
                <span>{a === 'setting' ? 'Settings' : a === 'skill' ? 'Skills' : 'Integrations'}</span>
              </div>
            ))}
          </div>
          <Section title="Pending">
            <div className="vb-mini-list">
              {app.pending.map((c) => (
                <div key={c.id}>
                  <KindBadge kind={c.kind} />
                  <code>{c.path}</code>
                  {c.destructive && <Pill tone="red">Removal</Pill>}
                  <TargetChip target={c.target} />
                </div>
              ))}
            </div>
          </Section>
          {app.pending.some((c) => c.destructive) && (
            <Callout tone="red" icon="alert" title="1 change removes something">
              plugin · context-mode is unchecked until you confirm it explicitly.
            </Callout>
          )}
        </>
      );
    }
    case 'drift': {
      const m = machines.find((x) => x.id === 'm3')!;
      return (
        <>
          <div className="vb-actions">
            <button
              className="vb-btn primary"
              onClick={() => {
                app.setMachineId(m.id);
                go('machines');
              }}
            >
              Open machine
            </button>
            <button className="vb-btn" disabled={app.requested.has(m.id)} onClick={() => app.request(m.id)}>
              {app.requested.has(m.id) ? 'Re-apply requested' : 'Request re-apply'}
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">
            win-workstation reports a plugin that the profile no longer declares. It was removed from {profile.name} on 2026-08-20.
          </p>
          <div className="vb-card">
            <div className="vb-card-row">
              <Tile icon="plug" tone="red" />
              <div>
                <b>plugin · context-mode</b>
                <small>Claude Code · still enabled in settings.json</small>
              </div>
              <Pill tone="red">Drift</Pill>
            </div>
          </div>
          <Facts
            rows={[
              ['Machine', `${m.name} · ${m.os} ${m.arch}`],
              ['Applied revision', <code key="r">{m.appliedRevision}</code>],
              ['Profile revision', <code key="p">{profile.revision}</code>],
              ['Last seen', m.lastSeen],
            ]}
          />
        </>
      );
    }
    case 'mcp-key':
      return (
        <>
          <div className="vb-actions">
            <button className="vb-btn primary" onClick={() => go('integrations')}>
              Open integration
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">
            The <b>OpenRouter GLM 5.3 Flash</b> MCP server is declared for Codex. It reads its key from the environment; the value never leaves this
            machine and is never written to the profile.
          </p>
          <div className="vb-env">
            <code>OPENROUTER_API_KEY</code>
            <Pill tone="orange" icon="alert">
              Not set
            </Pill>
          </div>
          <pre className="vb-code">
            <span className="c"># add to ~/.zshenv, then Fetch again</span>
            {'\n'}export OPENROUTER_API_KEY=sk-or-…
          </pre>
        </>
      );
    case 'upstream':
      return (
        <>
          <div className="vb-actions">
            <button className="vb-btn primary" onClick={() => go('sync')}>
              Review &amp; sync
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">
            {profile.repo} moved from <code>{profile.revision}</code> to <code>{profile.upstreamRevision}</code>. Sync previews each commit before
            anything changes here.
          </p>
          <div className="vb-commits">
            {upstream.map((u) => (
              <div key={u.sha}>
                <Icon n="commit" />
                <div>
                  <b>{u.message}</b>
                  <small>
                    <code>{u.sha}</code> · {u.author} · {u.when}
                  </small>
                </div>
                {u.touches.includes('theme') && <Pill tone="orange">Conflict</Pill>}
              </div>
            ))}
          </div>
        </>
      );
    case 'skills-missing':
      return (
        <>
          <div className="vb-actions">
            <button className="vb-btn primary" onClick={() => go('changes')}>
              Review &amp; apply
            </button>
            <button className="vb-btn" onClick={() => go('skills')}>
              Open Skills
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">The manifest lists every skill from mattpocock/skills, and two of them are not installed on this Mac yet.</p>
          <div className="vb-card">
            {allSkills
              .filter((s) => s.status === 'missing')
              .map((s) => (
                <div key={s.name} className="vb-card-row">
                  <Tile icon="sparkles" tone="teal" />
                  <div>
                    <b>{s.name}</b>
                    <small>{s.description}</small>
                  </div>
                  <Pill tone="orange">Missing</Pill>
                </div>
              ))}
          </div>
        </>
      );
    case 'skill-outdated':
      return (
        <>
          <div className="vb-actions">
            <button className="vb-btn primary" onClick={() => go('changes')}>
              Review &amp; apply
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">
            <b>show-me</b> is pinned to <code>v1.2.0</code> in the profile, and this Mac still has <code>v1.1.4</code>.
          </p>
          <Diff d={changeDiffs.c6!} split={false} />
        </>
      );
    case 'offline': {
      const m = machines.find((x) => x.id === 'm4')!;
      return (
        <>
          <div className="vb-actions">
            <button
              className="vb-btn primary"
              onClick={() => {
                app.setMachineId(m.id);
                go('machines');
              }}
            >
              Open machine
            </button>
            <button
              className="vb-btn danger"
              onClick={() =>
                app.setConfirm({
                  title: `Forget ${m.name}?`,
                  body: (
                    <>
                      It stops appearing in the fleet. Its {m.overrides} overrides are deleted from the profile. The machine itself is not touched.
                    </>
                  ),
                  action: 'Forget machine',
                  onConfirm: () => app.forget(m.id),
                })
              }
            >
              Forget…
            </button>
            {dismissBtn}
          </div>
          <p className="vb-lead">
            {m.name} last reported 9 days ago, on revision <code>{m.appliedRevision}</code>. It will catch up the next time it checks in.
          </p>
          <Facts
            rows={[
              ['OS', `${m.os} · ${m.arch}`],
              ['Targets', m.targets.map((t) => targetLabel[t]).join(', ')],
              ['Last seen', m.lastSeen],
            ]}
          />
        </>
      );
    }
  }
}

/* ───────────────────────── Changes ───────────────────────── */

const areaLabel: Record<Change['area'], string> = { setting: 'Settings', skill: 'Skills', integration: 'Integrations' };

function Changes({ app, go }: ScreenProps) {
  const [sel, setSel] = useState('');
  const list = app.pending;
  const current = list.find((c) => c.id === sel) ?? list[0];
  useListKeys(
    list.map((c) => c.id),
    current?.id,
    setSel,
  );
  const n = app.selected.length;
  const all = n === list.length && n > 0;
  const destructiveOn = app.selected.some((c) => c.destructive);
  const { run } = app;

  return (
    <>
      <section className="vb-list">
        {list.length > 0 && (
          <div className="vb-list-head">
            <Check on={all} mixed={!all && n > 0} onChange={() => app.setAll(!all)} disabled={app.busy} label="Select all" />
            <span>
              <b>{list.length} changed</b> · {n} selected
            </span>
          </div>
        )}
        <div className="vb-list-scroll">
          {(['setting', 'skill', 'integration'] as const).map((area) => {
            const rows = list.filter((c) => c.area === area);
            if (!rows.length) return null;
            return (
              <div key={area}>
                <div className="vb-group">
                  {areaLabel[area]}
                  <span>{rows.length}</span>
                </div>
                {rows.map((c) => (
                  <Row key={c.id} id={c.id} selected={current?.id === c.id} onSelect={setSel} className={cx('vb-file', c.destructive && 'destructive')}>
                    <Check on={app.checked.has(c.id)} onChange={() => app.toggleChange(c)} disabled={app.busy} label={`Include ${c.path}`} />
                    <span className="vb-file-p" title={c.path}>
                      {c.path}
                    </span>
                    {c.destructive && <Pill tone="red">Removal</Pill>}
                    <TargetChip target={c.target} />
                    <KindBadge kind={c.kind} />
                  </Row>
                ))}
              </div>
            );
          })}
          {list.length === 0 && (
            <Empty icon="circleCheck" title="No local changes" text="ihor-mbp matches everything the profile declares.">
              <button className="vb-btn" onClick={() => go('dashboard')}>
                Back to Today
              </button>
            </Empty>
          )}
        </div>

        {/* Sticky commit-box footer */}
        {(list.length > 0 || run.state !== 'idle') && (
          <div className="vb-list-foot">
            {run.state === 'idle' && (
              <>
                <div className="vb-foot-note">
                  <Icon n="archive" size={13} />
                  <span>
                    Backs up to <code>{backupPath}</code>
                  </span>
                </div>
                {destructiveOn && (
                  <div className="vb-foot-note red">
                    <Icon n="alert" size={13} />
                    <span>Includes 1 confirmed removal</span>
                  </div>
                )}
                <button className="vb-btn primary lg block" disabled={n === 0} onClick={app.startApply}>
                  Back up &amp; apply {n} change{n === 1 ? '' : 's'}
                </button>
              </>
            )}
            {run.state === 'running' && (
              <>
                <div className="vb-progress-h">
                  <span className="vb-spinner" />
                  <b>{applySteps[run.step]}</b>
                  <span>
                    {run.step + 1}/{applySteps.length}
                  </span>
                </div>
                <div className="vb-progress">
                  <i style={{ width: `${((run.step + 0.5) / applySteps.length) * 100}%` }} />
                </div>
                <button className="vb-btn lg block" onClick={app.cancelApply}>
                  <Icon n="stop" size={12} /> Cancel apply
                </button>
              </>
            )}
            {run.state === 'completed' && (
              <>
                <div className="vb-result green">
                  <Icon n="circleCheck" />
                  <div>
                    <b>
                      Applied {run.ids.length} change{run.ids.length === 1 ? '' : 's'}
                    </b>
                    <small>
                      Backup at <code>{backupPath}</code>
                    </small>
                  </div>
                </div>
                <button className="vb-btn lg block" onClick={app.resetApply}>
                  Done
                </button>
              </>
            )}
            {run.state === 'cancelled' && (
              <>
                <div className="vb-result orange">
                  <Icon n="alert" />
                  <div>
                    <b>Cancelled during “{applySteps[run.step]}”</b>
                    <small>
                      {run.step} of {applySteps.length} steps finished. Nothing is marked applied; restore the backup or run again.
                    </small>
                  </div>
                </div>
                <div className="vb-foot-row">
                  <button className="vb-btn lg" onClick={app.resetApply}>
                    <Icon n="undo" size={12} /> Restore backup
                  </button>
                  <button className="vb-btn primary lg" onClick={app.startApply} disabled={n === 0}>
                    Run again
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="vb-insp">
        {app.busy || run.state === 'completed' || run.state === 'cancelled' ? (
          <div className="vb-insp-in">
            <InspHead
              icon="archive"
              tone={run.state === 'completed' ? 'green' : run.state === 'cancelled' ? 'orange' : 'blue'}
              title={run.state === 'completed' ? 'Apply finished' : run.state === 'cancelled' ? 'Apply cancelled' : 'Applying to ihor-mbp'}
              meta={<span>{run.ids.length} changes · backup first, verify last</span>}
            />
            <ol className="vb-steps">
              {applySteps.map((s, i) => {
                const st = i < run.step ? 'done' : i === run.step ? (run.state === 'running' ? 'run' : run.state === 'cancelled' ? 'stop' : 'done') : run.state === 'completed' ? 'done' : 'todo';
                return (
                  <li key={s} className={st}>
                    <span className="vb-step-i">
                      {st === 'done' ? <Icon n="check" size={12} /> : st === 'run' ? <span className="vb-spinner" /> : st === 'stop' ? <Icon n="x" size={12} /> : i + 1}
                    </span>
                    <span>{s}</span>
                    <small>{st === 'done' ? 'Done' : st === 'run' ? 'Running…' : st === 'stop' ? 'Cancelled' : 'Waiting'}</small>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : current ? (
          <div className="vb-insp-in wide" key={current.id}>
            <InspHead
              icon={current.area === 'setting' ? 'sliders' : current.area === 'skill' ? 'sparkles' : 'plug'}
              tone={current.kind === 'remove' ? 'red' : current.kind === 'add' ? 'green' : 'orange'}
              title={<span className="mono">{current.path}</span>}
              meta={
                <>
                  <KindBadge kind={current.kind} />
                  <span>{current.kind === 'add' ? 'Add' : current.kind === 'remove' ? 'Remove' : 'Modify'}</span>
                  <span>·</span>
                  <span>{areaLabel[current.area].replace(/s$/, '')}</span>
                  <span>·</span>
                  <TargetChip target={current.target} />
                </>
              }
              right={
                <label className="vb-include">
                  <Check on={app.checked.has(current.id)} onChange={() => app.toggleChange(current)} label="Include in apply" />
                  Include
                </label>
              }
            />
            {current.destructive && (
              <Callout tone="red" icon="trash" title="Destructive — removes a plugin from this Mac">
                context-mode was removed from the profile on 2026-08-20 but is still installed. Including this deletes it after the backup. You will be
                asked to confirm.
              </Callout>
            )}
            {current.id === 'c7' && (
              <Callout tone="yellow" icon="key" title="Needs OPENROUTER_API_KEY">
                The server installs, but cannot start until the variable is set in this machine's environment.
              </Callout>
            )}
            {current.before && current.after && (
              <div className="vb-beforeafter">
                <code className="del">{current.before}</code>
                <Icon n="arrowRight" size={13} />
                <code className="add">{current.after}</code>
              </div>
            )}
            <Diff d={changeDiffs[current.id]!} split={app.seg.changes === 1} />
          </div>
        ) : (
          <Empty icon="diff" title="Nothing to preview" text="Pick a change to see its diff." />
        )}
      </section>
    </>
  );
}

/* ───────────────────────── Sync ───────────────────────── */

function ThreeWay({
  conflict,
  resolution,
  onResolve,
  compact,
}: {
  conflict: (typeof conflicts)[number];
  resolution: Resolution;
  onResolve: (r: Resolution) => void;
  compact?: boolean;
}) {
  const result = resolution === 'keep-local' ? conflict.local : resolution === 'take-upstream' ? conflict.upstream : null;
  return (
    <div className={cx('vb-3way', compact && 'compact')}>
      <div className="vb-3way-base">
        <small>Base · {profile.revision}</small>
        <code>{conflict.base}</code>
      </div>
      <div className="vb-3way-fork" aria-hidden="true">
        <svg viewBox="0 0 200 28" preserveAspectRatio="none">
          <path d="M100 0 V8 Q100 14 92 14 H58 Q50 14 50 22 V28 M100 8 Q100 14 108 14 H142 Q150 14 150 22 V28" fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="vb-3way-sides">
        <button className={cx('vb-3way-side', 'up', resolution === 'take-upstream' && 'picked', resolution === 'keep-local' && 'lost')} onClick={() => onResolve('take-upstream')}>
          <small>
            <Icon n="download" size={12} /> Upstream · {profile.upstreamRevision}
          </small>
          <code>{conflict.upstream}</code>
          <span>Nortus222 · 2 h ago</span>
        </button>
        <button className={cx('vb-3way-side', 'mine', resolution === 'keep-local' && 'picked', resolution === 'take-upstream' && 'lost')} onClick={() => onResolve('keep-local')}>
          <small>
            <Icon n="laptop" size={12} /> Your override · ihor-mbp
          </small>
          <code>{conflict.local}</code>
          <span>Set on this Mac</span>
        </button>
      </div>
      <div className={cx('vb-3way-result', result && 'done')}>
        <small>Result on this Mac</small>
        {result ? <code>{result}</code> : <span>Choose a side</span>}
        {resolution && (
          <button className="vb-link" onClick={() => onResolve(null)}>
            Undo
          </button>
        )}
      </div>
      <div className="vb-actions">
        <button className={cx('vb-btn', resolution === 'keep-local' ? 'primary' : '')} onClick={() => onResolve('keep-local')}>
          {resolution === 'keep-local' && <Icon n="check" size={12} />} Keep mine
        </button>
        <button className={cx('vb-btn', resolution === 'take-upstream' ? 'primary' : '')} onClick={() => onResolve('take-upstream')}>
          {resolution === 'take-upstream' && <Icon n="check" size={12} />} Take upstream
        </button>
      </div>
      {!compact && (
        <p className="vb-help">
          <b>Keep mine</b> leaves the override in place and records that you saw upstream's change. <b>Take upstream</b> deletes the override on
          this Mac so the base value applies.
        </p>
      )}
    </div>
  );
}

function Sync({ app, go }: ScreenProps) {
  const onlyConflicts = app.seg.sync === 1;
  const ids = [...conflicts.map((c) => `conflict:${c.key}`), ...(onlyConflicts ? [] : upstream.map((u) => u.sha))];
  const [sel, setSel] = useState('');
  const current = ids.includes(sel) ? sel : ids[0];
  useListKeys(ids, current, setSel);
  const done = app.sync === 'done';
  const blocked = app.unresolved.length > 0;
  const commit = upstream.find((u) => u.sha === current);
  const conflict = conflicts.find((c) => `conflict:${c.key}` === current);

  return (
    <>
      <section className="vb-list">
        <div className="vb-list-head col">
          <div className="vb-branch">
            <Icon n="branch" size={13} />
            <code>{profile.branch}</code>
            <span>
              <code>{profile.revision}</code>
              <Icon n="arrowRight" size={11} />
              <code>{profile.upstreamRevision}</code>
            </span>
          </div>
        </div>
        <div className="vb-list-scroll">
          <div className="vb-group">
            Conflicts<span>{conflicts.length}</span>
          </div>
          {conflicts.map((c) => {
            const r = app.resolutions[c.key];
            const id = `conflict:${c.key}`;
            return (
              <Row key={id} id={id} selected={current === id} onSelect={setSel} className="vb-mail">
                <Tile icon="merge" tone={r ? 'green' : 'orange'} />
                <div className="vb-mail-t">
                  <div className="vb-mail-l1">
                    <b className="mono">{c.key}</b>
                    {r ? <Pill tone="green">{r === 'keep-local' ? 'Keeping mine' : 'Taking upstream'}</Pill> : <Pill tone="orange">Unresolved</Pill>}
                  </div>
                  <span>
                    base {c.base} · upstream {c.upstream} · yours {c.local}
                  </span>
                </div>
              </Row>
            );
          })}
          {!onlyConflicts && (
            <>
              <div className="vb-group">
                {done ? 'Merged' : 'Incoming'}
                <span>{upstream.length}</span>
              </div>
              {upstream.map((u) => (
                <Row key={u.sha} id={u.sha} selected={current === u.sha} onSelect={setSel} className={cx('vb-mail', done && 'muted')}>
                  <Tile icon={done ? 'check' : 'commit'} tone={done ? 'green' : 'purple'} />
                  <div className="vb-mail-t">
                    <div className="vb-mail-l1">
                      <b>{u.message}</b>
                      <time>{u.when}</time>
                    </div>
                    <span>
                      <code>{u.sha}</code> · {u.author} · touches {u.touches.join(', ')}
                    </span>
                  </div>
                </Row>
              ))}
            </>
          )}
        </div>
        <div className="vb-list-foot">
          {done ? (
            <>
              <div className="vb-result green">
                <Icon n="circleCheck" />
                <div>
                  <b>Up to date with {profile.upstreamRevision}</b>
                  <small>Your override decisions were recorded.</small>
                </div>
              </div>
              <button className="vb-btn lg block" onClick={() => go('changes')}>
                Review changes on this Mac
              </button>
            </>
          ) : app.sync === 'running' ? (
            <>
              <div className="vb-progress-h">
                <span className="vb-spinner" />
                <b>Merging {upstream.length} commits</b>
              </div>
              <div className="vb-progress indeterminate">
                <i />
              </div>
            </>
          ) : (
            <>
              {blocked && (
                <div className="vb-foot-note orange">
                  <Icon n="alert" size={13} />
                  <span>
                    Resolve {app.unresolved.length} conflict{app.unresolved.length === 1 ? '' : 's'} to continue
                  </span>
                </div>
              )}
              <button className="vb-btn primary lg block" disabled={blocked} onClick={app.startSync}>
                Sync {upstream.length} commits
              </button>
            </>
          )}
        </div>
      </section>
      <section className="vb-insp">
        {conflict && (
          <div className="vb-insp-in" key={current}>
            <InspHead
              icon="merge"
              tone={app.resolutions[conflict.key] ? 'green' : 'orange'}
              title={<span className="mono">{conflict.key}</span>}
              meta={
                <>
                  <TargetChip target="claude" />
                  <span>settings.json · three-way compare</span>
                </>
              }
            />
            <ThreeWay conflict={conflict} resolution={app.resolutions[conflict.key] ?? null} onResolve={(r) => app.resolve(conflict.key, r)} />
          </div>
        )}
        {commit && (
          <div className="vb-insp-in wide" key={current}>
            <InspHead
              icon="commit"
              tone="purple"
              title={commit.message}
              meta={
                <>
                  <code>{commit.sha}</code>
                  <span>·</span>
                  <span>{commit.author}</span>
                  <span>·</span>
                  <span>{commit.when}</span>
                </>
              }
            />
            {commit.touches.includes('theme') && (
              <Callout tone="orange" icon="merge" title="Touches a value you override">
                This Mac overrides <code>theme</code>. The commit is held until you resolve the conflict.
              </Callout>
            )}
            <Diff d={commitDiffs[commit.sha]!} split={false} />
          </div>
        )}
      </section>
    </>
  );
}

/* ───────────────────────── Profile (settings) ───────────────────────── */

function resolveSetting(s: Setting, cleared: Set<string>): { value: Value; source: Source } {
  if (cleared.has(s.key) && s.override !== null) return { value: s.base ?? s.desired, source: 'base' };
  return { value: s.desired, source: s.source };
}

function Profile({ app }: ScreenProps) {
  const f = app.seg.profile;
  const q = app.query.toLowerCase();
  const list = settings.filter(
    (s) =>
      (f === 0 || (f === 1 && s.target === 'claude') || (f === 2 && s.target === 'codex') || (f === 3 && s.override !== null)) &&
      (!q || s.key.toLowerCase().includes(q)),
  );
  const id = (s: Setting) => `${s.target}:${s.key}`;
  const [sel, setSel] = useState('');
  const current = list.find((s) => id(s) === sel) ?? list[0];
  useListKeys(list.map(id), current && id(current), setSel);

  return (
    <>
      <section className="vb-list">
        <div className="vb-list-scroll">
          {(['claude', 'codex'] as Target[]).map((t) => {
            const rows = list.filter((s) => s.target === t);
            if (!rows.length) return null;
            return (
              <div key={t}>
                <div className="vb-group">
                  {targetLabel[t]}
                  <span>{rows.length}</span>
                </div>
                {rows.map((s) => {
                  const r = resolveSetting(s, app.cleared);
                  const differs = show(r.value) !== show(s.current);
                  return (
                    <Row key={id(s)} id={id(s)} selected={current === s} onSelect={setSel} className="vb-setting">
                      <div className="vb-setting-t">
                        <b className="mono">{s.key}</b>
                        <span className="mono">{show(r.value)}</span>
                      </div>
                      {differs && <span className="vb-diffdot" title="Differs from disk" />}
                      <Pill tone={sourceTone[r.source]}>{r.source}</Pill>
                    </Row>
                  );
                })}
              </div>
            );
          })}
          {list.length === 0 && <Empty icon="search" title="No matching settings" text="Try another filter or search." />}
        </div>
      </section>
      <section className="vb-insp">{current ? <SettingDetail s={current} app={app} key={id(current)} /> : null}</section>
    </>
  );
}

function SettingDetail({ s, app }: { s: Setting; app: App }) {
  const cleared = app.cleared.has(s.key);
  const r = resolveSetting(s, app.cleared);
  const differs = show(r.value) !== show(s.current);
  const layers: { id: Source; label: string; where: string; icon: IconName; value: Value | null }[] = [
    { id: 'override', label: 'Machine override', where: 'ihor-mbp · stored locally', icon: 'laptop', value: cleared ? null : s.override },
    { id: 'base', label: 'Profile base', where: `${profile.name} @ ${profile.revision}`, icon: 'layers', value: s.source === 'default' ? null : s.base },
    { id: 'default', label: 'Built-in default', where: targetLabel[s.target], icon: 'pkg', value: s.source === 'default' ? s.desired : null },
  ];
  const winner = layers.findIndex((l) => l.value !== null);
  return (
    <div className="vb-insp-in">
      <InspHead
        icon="sliders"
        tone={sourceTone[r.source]}
        title={<span className="mono">{s.key}</span>}
        meta={
          <>
            <TargetChip target={s.target} />
            <span>{s.target === 'claude' ? '~/.claude/settings.json' : '~/.codex/config.toml'}</span>
          </>
        }
      />
      <div className="vb-resolved">
        <small>Resolved value</small>
        <code>{show(r.value)}</code>
        <div className={cx('vb-resolved-disk', differs ? 'warn' : 'ok')}>
          <Icon n={differs ? 'alert' : 'circleCheck'} size={13} />
          {differs ? (
            <span>
              On disk: <code>{show(s.current)}</code> — changes on next apply
            </span>
          ) : (
            <span>Matches what is on disk</span>
          )}
        </div>
      </div>
      <Section title="Provenance" aside={<span className="vb-sec-aside">Highest layer wins</span>}>
        <div className="vb-tower">
          {layers.map((l, i) => {
            const state = i === winner ? 'win' : l.value === null ? 'unset' : i > winner ? 'shadow' : 'unset';
            return (
              <div key={l.id} className={cx('vb-layer', state)}>
                <span className="vb-layer-i">
                  <Icon n={l.icon} size={14} />
                </span>
                <div className="vb-layer-t">
                  <b>{l.label}</b>
                  <small>{l.where}</small>
                </div>
                <code>{l.value === null ? 'not set' : show(l.value)}</code>
                {state === 'win' && <Pill tone="blue">Wins</Pill>}
                {state === 'shadow' && <Pill tone="gray">Shadowed</Pill>}
              </div>
            );
          })}
        </div>
      </Section>
      {s.override !== null && (
        <div className="vb-actions">
          <button className="vb-btn" onClick={() => app.toggleOverride(s.key)}>
            <Icon n={cleared ? 'undo' : 'x'} size={12} /> {cleared ? 'Restore override' : 'Remove override'}
          </button>
          {cleared && <span className="vb-hint">Base value applies on next apply.</span>}
        </div>
      )}
      {s.note && !cleared && <p className="vb-help">{s.note}.</p>}
    </div>
  );
}

/* ───────────────────────── Skills ───────────────────────── */

const skillTone: Record<Skill['status'], Tone> = { installed: 'green', missing: 'orange', outdated: 'blue', optional: 'gray' };
const skillLabel: Record<Skill['status'], string> = { installed: 'Installed', missing: 'Missing', outdated: 'Update', optional: 'Optional' };

function Skills({ app }: ScreenProps) {
  const f = app.seg.skills;
  const q = app.query.toLowerCase();
  const match = (s: Skill) =>
    (f === 0 || (f === 1 && s.status === 'installed') || (f === 2 && (s.status === 'missing' || s.status === 'outdated'))) &&
    (!q || s.name.includes(q) || s.description.toLowerCase().includes(q));
  const list = allSkills.filter(match);
  const [sel, setSel] = useState('');
  const current = list.find((s) => s.name === sel) ?? list[0];
  useListKeys(
    list.map((s) => s.name),
    current?.name,
    setSel,
  );

  return (
    <>
      <section className="vb-list">
        <div className="vb-list-scroll">
          {skillSources.map((src) => {
            const rows = src.skills.filter(match);
            if (!rows.length) return null;
            return (
              <div key={src.repo}>
                <div className="vb-group">
                  {src.repo}
                  <span className="vb-mode">{src.mode}</span>
                </div>
                {rows.map((s) => (
                  <Row key={s.name} id={s.name} selected={current?.name === s.name} onSelect={setSel} className="vb-skill">
                    <Toggle on={!!app.enabled[s.name]} onChange={() => app.toggleSkill(s)} label={`Enable ${s.name}`} />
                    <div className="vb-mail-t">
                      <div className="vb-mail-l1">
                        <b>
                          {s.name}
                          {s.pinned && <Icon n="pin" size={11} className="vb-pin" />}
                        </b>
                      </div>
                      <span>{s.description}</span>
                    </div>
                    {s.status !== 'installed' && <Pill tone={skillTone[s.status]}>{skillLabel[s.status]}</Pill>}
                  </Row>
                ))}
              </div>
            );
          })}
          {list.length === 0 && <Empty icon="search" title="No skills match" text={`Nothing matches “${app.query}”.`} />}
        </div>
      </section>
      <section className="vb-insp">
        {current && (
          <div className="vb-insp-in" key={current.name}>
            <SkillDetail s={current} app={app} />
          </div>
        )}
      </section>
    </>
  );
}

function SkillDetail({ s, app }: { s: Skill; app: App }) {
  const on = !!app.enabled[s.name];
  const initial = s.status !== 'optional';
  const src = skillSources.find((x) => x.repo === s.source)!;
  return (
    <>
      <InspHead
        icon="sparkles"
        tone={skillTone[s.status] === 'gray' ? 'indigo' : skillTone[s.status]}
        title={s.name}
        meta={
          <>
            <span>{s.source}</span>
            <span>·</span>
            <Pill tone={skillTone[s.status]}>{skillLabel[s.status]}</Pill>
          </>
        }
        right={<Toggle on={on} onChange={() => app.toggleSkill(s)} label={`Enable ${s.name}`} />}
      />
      <p className="vb-lead">{s.description}.</p>
      {on !== initial && (
        <Callout tone={on ? 'blue' : 'red'} icon={on ? 'download' : 'trash'} title={on ? 'Installs on next apply' : 'Removed on next apply'}>
          {on ? 'Added to the profile for every machine that follows it.' : 'Backed up first; turn it back on to keep it.'}
        </Callout>
      )}
      {s.status === 'outdated' && (
        <Callout tone="blue" icon="pin" title={`Pinned to ${s.pinned}`}>
          This Mac has v1.1.4. The pinned version installs on the next apply.
        </Callout>
      )}
      <Facts
        rows={[
          ['Source', s.source],
          ['Manifest mode', src.mode === 'all' ? 'all — every skill in the repo' : src.mode === 'exact' ? 'exact — listed skills only' : 'optional — opt in per skill'],
          ['Location', <code key="l">~/.claude/skills/{s.name}/</code>],
          ['Pinned', s.pinned ? <code key="p">{s.pinned}</code> : 'Tracks latest'],
        ]}
      />
      <Section title="skills-manifest.txt">
        <pre className="vb-code">
          {s.source}
          {src.mode !== 'all' ? ` (${src.mode})` : ''}
          {'\n'}
          {'  '}
          {s.name}
          {s.pinned ? `@${s.pinned}` : ''}
        </pre>
      </Section>
    </>
  );
}

/* ───────────────────────── Integrations ───────────────────────── */

const kindMeta: Record<Integration['kind'], { label: string; icon: IconName }> = {
  plugin: { label: 'Plugins', icon: 'pkg' },
  mcp: { label: 'MCP servers', icon: 'terminal' },
  hook: { label: 'Hooks', icon: 'hook' },
  marketplace: { label: 'Marketplaces', icon: 'store' },
};
const intTone: Record<Integration['status'], Tone> = { installed: 'green', missing: 'orange', 'allowed-extra': 'gray', drift: 'red' };
const intLabel: Record<Integration['status'], string> = { installed: 'Installed', missing: 'Missing', 'allowed-extra': 'Allowed extra', drift: 'Drift' };

function Integrations({ app, go }: ScreenProps) {
  const f = app.seg.integrations;
  const q = app.query.toLowerCase();
  const list = integrations.filter(
    (i) => (f === 0 || (f === 1 && i.target === 'claude') || (f === 2 && i.target === 'codex')) && (!q || `${i.label} ${i.detail}`.toLowerCase().includes(q)),
  );
  const [sel, setSel] = useState('');
  const current = list.find((i) => i.id === sel) ?? list[0];
  useListKeys(
    list.map((i) => i.id),
    current?.id,
    setSel,
  );
  const c8Queued = app.checked.has('c8') || app.applied.has('c8');

  return (
    <>
      <section className="vb-list">
        <div className="vb-list-scroll">
          {(['plugin', 'mcp', 'hook', 'marketplace'] as const).map((k) => {
            const rows = list.filter((i) => i.kind === k);
            if (!rows.length) return null;
            return (
              <div key={k}>
                <div className="vb-group">
                  {kindMeta[k].label}
                  <span>{rows.length}</span>
                </div>
                {rows.map((i) => (
                  <Row key={i.id} id={i.id} selected={current?.id === i.id} onSelect={setSel} className="vb-mail">
                    <Tile icon={kindMeta[k].icon} tone={i.status === 'installed' ? 'gray' : intTone[i.status]} />
                    <div className="vb-mail-t">
                      <div className="vb-mail-l1">
                        <b>{i.label}</b>
                        <TargetChip target={i.target} />
                      </div>
                      <span>{i.detail}</span>
                    </div>
                    {i.status !== 'installed' && <Pill tone={intTone[i.status]}>{intLabel[i.status]}</Pill>}
                  </Row>
                ))}
              </div>
            );
          })}
          {list.length === 0 && <Empty icon="search" title="No integrations match" text="Try another filter or search." />}
        </div>
      </section>
      <section className="vb-insp">
        {current && (
          <div className="vb-insp-in" key={current.id}>
            <InspHead
              icon={kindMeta[current.kind].icon}
              tone={current.status === 'installed' ? 'blue' : intTone[current.status]}
              title={current.label}
              meta={
                <>
                  <TargetChip target={current.target} />
                  <span>{kindMeta[current.kind].label.replace(/s$/, '')}</span>
                  <span>·</span>
                  <Pill tone={intTone[current.status]}>{intLabel[current.status]}</Pill>
                </>
              }
            />
            <div className="vb-actions">
              {current.status === 'missing' && (
                <button className="vb-btn primary" onClick={() => go('changes')}>
                  Review in Changes
                </button>
              )}
              {current.status === 'drift' && (
                <button
                  className="vb-btn danger"
                  disabled={c8Queued}
                  onClick={() => {
                    const c8 = changes.find((c) => c.id === 'c8')!;
                    app.toggleChange(c8);
                  }}
                >
                  <Icon n="trash" size={12} /> {c8Queued ? 'Removal queued' : 'Remove from this Mac…'}
                </button>
              )}
              {current.status === 'drift' && c8Queued && (
                <button className="vb-btn" onClick={() => go('changes')}>
                  Open Changes
                </button>
              )}
            </div>
            {current.status === 'installed' && (
              <Callout tone="green" icon="circleCheck" title="Installed and matching the profile" />
            )}
            {current.status === 'missing' && (
              <Callout tone="orange" icon="download" title="Declared but not installed">
                It installs on the next apply.
              </Callout>
            )}
            {current.status === 'allowed-extra' && (
              <Callout tone="gray" icon="shield" title="Present on purpose">
                Listed under <code>allow</code> in integrations.json. nortuscc never installs or removes it.
              </Callout>
            )}
            {current.status === 'drift' && (
              <Callout tone="red" icon="alert" title="On this machine but not in the profile">
                {current.detail}. Removing it is destructive and needs confirmation.
              </Callout>
            )}
            {current.env && (
              <Section title="Environment">
                {current.env.map((e) => (
                  <div className="vb-env" key={e}>
                    <code>{e}</code>
                    <Pill tone="orange" icon="alert">
                      Not set
                    </Pill>
                  </div>
                ))}
                <p className="vb-help">Only the variable's name is stored in the profile. Its value stays on this machine.</p>
              </Section>
            )}
            <Section title="integrations.json">
              <pre className="vb-code">
                {JSON.stringify(
                  { id: current.id, kind: current.kind, target: current.target, ...(current.env ? { env: current.env } : {}) },
                  null,
                  2,
                )}
              </pre>
            </Section>
          </div>
        )}
      </section>
    </>
  );
}

/* ───────────────────────── Machines ───────────────────────── */

function Machines({ app, go }: ScreenProps) {
  const list = app.fleet.filter((m) => app.seg.machines === 0 || app.machineStatus(m) !== 'in-sync');
  const current = list.find((m) => m.id === app.machineId) ?? list[0];
  useListKeys(
    list.map((m) => m.id),
    current?.id,
    app.setMachineId,
  );

  return (
    <>
      <section className="vb-list">
        <div className="vb-list-scroll">
          <div className="vb-group">
            Using {profile.name}
            <span>{list.length}</span>
          </div>
          {list.map((m) => {
            const st = app.machineStatus(m);
            return (
              <Row key={m.id} id={m.id} selected={current?.id === m.id} onSelect={app.setMachineId} className="vb-mail">
                <Tile icon={machineIcon(m)} tone={m.current ? 'blue' : 'gray'} />
                <div className="vb-mail-t">
                  <div className="vb-mail-l1">
                    <b>
                      {m.name}
                      {m.current && <small className="vb-this">This Mac</small>}
                    </b>
                    <time>{m.lastSeen}</time>
                  </div>
                  <span>
                    {m.os} · {m.arch} · <code>{m.appliedRevision}</code>
                  </span>
                </div>
                <Pill tone={machineTone[st]}>{machineLabel[st]}</Pill>
              </Row>
            );
          })}
        </div>
      </section>
      <section className="vb-insp">{current && <MachineDetail m={current} app={app} go={go} key={current.id} />}</section>
    </>
  );
}

function MachineDetail({ m, app, go }: ScreenProps & { m: Machine }) {
  const st = app.machineStatus(m);
  const log = activity.filter((a) => a.who === m.name);
  const latest = app.sync === 'done' ? profile.upstreamRevision : profile.revision;
  const explain: Record<MachineStatus, [IconName, string, string]> = {
    'in-sync': ['circleCheck', 'In sync', 'Everything the profile declares is applied.'],
    behind: ['download', 'Behind', `${app.pending.length} local changes and ${app.sync === 'done' ? 0 : upstream.length} upstream commits are waiting for review.`],
    drift: ['alert', 'Drifted from the profile', 'context-mode plugin is installed but no longer declared.'],
    offline: ['wifiOff', 'Offline', `Hasn't checked in for ${m.lastSeen.replace(' ago', '')}. It catches up next time it runs nortuscc.`],
  };
  const [icon, title, text] = explain[st];
  return (
    <div className="vb-insp-in">
      <InspHead
        icon={machineIcon(m)}
        tone={m.current ? 'blue' : 'gray'}
        title={
          <>
            {m.name}
            {m.current && <small className="vb-this">This Mac</small>}
          </>
        }
        meta={
          <>
            <span>
              {m.os} · {m.arch}
            </span>
            <span>·</span>
            <span>Last seen {m.lastSeen}</span>
          </>
        }
      />
      <Callout tone={machineTone[st]} icon={icon} title={title}>
        {text}
      </Callout>
      <div className="vb-actions">
        {m.current && st !== 'in-sync' && (
          <button className="vb-btn primary" onClick={() => go('changes')}>
            Review changes
          </button>
        )}
        {(st === 'drift' || st === 'behind') && !m.current && (
          <button className="vb-btn primary" disabled={app.requested.has(m.id)} onClick={() => app.request(m.id)}>
            {app.requested.has(m.id) ? 'Re-apply requested' : 'Request re-apply'}
          </button>
        )}
        {!m.current && (
          <button
            className="vb-btn danger"
            onClick={() =>
              app.setConfirm({
                title: `Forget ${m.name}?`,
                body: (
                  <>
                    It is removed from the fleet and its <b>{m.overrides} machine overrides</b> are deleted from the profile. Nothing on the machine
                    itself changes.
                  </>
                ),
                action: 'Forget machine',
                onConfirm: () => {
                  app.forget(m.id);
                  app.setMachineId('m1');
                },
              })
            }
          >
            Forget…
          </button>
        )}
      </div>
      {app.requested.has(m.id) && <p className="vb-hint">Queued — {m.name} re-applies the profile when it next checks in.</p>}
      <Facts
        rows={[
          ['Applied', <code key="a">{m.current && st === 'in-sync' ? latest : m.appliedRevision}</code>],
          ['Profile', <code key="p">{latest}</code>],
          ['Overrides', `${m.overrides} on this machine`],
          ['Targets', m.targets.map((t) => targetLabel[t]).join(', ')],
        ]}
      />
      <Section title="Activity">
        {log.length ? (
          <div className="vb-timeline">
            {log.map((a) => (
              <div key={a.id}>
                <i className={`k-${a.kind}`} />
                <span>{a.text}</span>
                <time>{a.when}</time>
              </div>
            ))}
          </div>
        ) : (
          <p className="vb-help">No recent activity from this machine.</p>
        )}
      </Section>
    </div>
  );
}

/* ───────────────────────── Sharing ───────────────────────── */

const avatarTones: Tone[] = ['blue', 'purple', 'teal', 'orange', 'indigo', 'green'];
const avatarTone = (s: string) => avatarTones[[...s].reduce((n, ch) => n + ch.charCodeAt(0), 0) % avatarTones.length]!;

function Sharing({ app }: ScreenProps) {
  const copiesAsProfiles: PublishedProfile[] = app.copies.map((orig) => {
    const src = community.find((p) => p.name === orig)!;
    return { ...src, name: `${account.handle}/${orig.split('/')[1]}`, owner: account.handle, description: `Copy of ${orig}`, followers: 0, updated: 'just now', relation: 'mine' };
  });
  const everything = [...community, ...copiesAsProfiles];
  const rel = (p: PublishedProfile): Relation => (p.owner === account.handle || p.relation === 'mine' ? 'mine' : app.relations[p.name] ?? 'none');
  const f = app.seg.sharing;
  const q = app.query.toLowerCase();
  const list = everything.filter(
    (p) => (f === 0 || (f === 1 && rel(p) === 'following') || (f === 2 && rel(p) === 'mine')) && (!q || `${p.name} ${p.description}`.toLowerCase().includes(q)),
  );
  const [sel, setSel] = useState('');
  const current = list.find((p) => p.name === sel) ?? list[0];
  useListKeys(
    list.map((p) => p.name),
    current?.name,
    setSel,
  );

  return (
    <>
      <section className="vb-list">
        <div className="vb-list-scroll">
          <div className="vb-group">
            Profiles<span>{list.length}</span>
          </div>
          {list.map((p) => {
            const r = rel(p);
            return (
              <Row key={p.name} id={p.name} selected={current?.name === p.name} onSelect={setSel} className="vb-mail">
                <span className={cx('vb-avatar sm', `t-${avatarTone(p.owner)}`)}>{p.owner.slice(0, 2).toUpperCase()}</span>
                <div className="vb-mail-t">
                  <div className="vb-mail-l1">
                    <b>{p.name}</b>
                    <time>{p.updated}</time>
                  </div>
                  <span>{p.description}</span>
                </div>
                {r === 'following' && <Pill tone="blue">Following</Pill>}
                {r === 'mine' && <Pill tone="gray">Yours</Pill>}
              </Row>
            );
          })}
          {list.length === 0 && <Empty icon="users" title="Nothing here yet" text="Profiles you follow or own appear here." />}
        </div>
      </section>
      <section className="vb-insp">
        {current && (
          <div className="vb-insp-in" key={current.name}>
            <div className="vb-pcard">
              <span className={cx('vb-avatar xl', `t-${avatarTone(current.owner)}`)}>{current.owner.slice(0, 2).toUpperCase()}</span>
              <h2>{current.name}</h2>
              <span className="vb-pcard-owner">@{current.owner}</span>
              <p>{current.description}</p>
              <div className="vb-pcard-stats">
                <div>
                  <b>{current.followers.toLocaleString()}</b>
                  <span>followers</span>
                </div>
                <div>
                  <b>{current.skills}</b>
                  <span>skills</span>
                </div>
                <div>
                  <b>{current.updated}</b>
                  <span>updated</span>
                </div>
              </div>
            </div>
            {rel(current) === 'mine' ? <Publish p={current} app={app} /> : <FollowOrCopy p={current} app={app} />}
          </div>
        )}
      </section>
    </>
  );
}

function FollowOrCopy({ p, app }: { p: PublishedProfile; app: App }) {
  const following = app.relations[p.name] === 'following';
  const copied = app.copies.includes(p.name);
  return (
    <div className="vb-choices">
      <div className={cx('vb-choice', following && 'active')}>
        <Tile icon="bell" tone="blue" />
        <h3>Follow</h3>
        <p>
          Stay subscribed. New revisions arrive in <b>Sync</b> as a preview, and your machine overrides are never overwritten.
        </p>
        <button className={cx('vb-btn block', !following && 'primary')} onClick={() => app.follow(p.name)}>
          {following ? (
            <>
              <Icon n="check" size={12} /> Following · Unfollow
            </>
          ) : (
            'Follow'
          )}
        </button>
      </div>
      <div className={cx('vb-choice', copied && 'active')}>
        <Tile icon="copy" tone="purple" />
        <h3>Copy</h3>
        <p>
          Start an independent profile in your own repo. You can edit everything, and you won't get {p.owner}'s future updates.
        </p>
        <button className="vb-btn block" disabled={copied} onClick={() => app.copy(p.name)}>
          {copied ? (
            <>
              <Icon n="check" size={12} /> Copied as {account.handle}/{p.name.split('/')[1]}
            </>
          ) : (
            `Copy to @${account.handle}`
          )}
        </button>
      </div>
    </div>
  );
}

function Publish({ p, app }: { p: PublishedProfile; app: App }) {
  const [copiedLink, setCopiedLink] = useState(false);
  const isMain = p.name === profile.name;
  const link = `nortuscc://follow/${p.name}`;
  return (
    <>
      {isMain && (
        <Section title="Visibility">
          <div className="vb-seg wide">
            {(['public', 'private'] as const).map((v) => (
              <button
                key={v}
                className={cx(app.visibility === v && 'on')}
                onClick={() => {
                  if (v === app.visibility) return;
                  if (v === 'private')
                    app.setConfirm({
                      title: `Make ${p.name} private?`,
                      body: (
                        <>
                          <b>{p.followers} followers</b> stop receiving updates. Their copies of the current revision keep working.
                        </>
                      ),
                      action: 'Make private',
                      onConfirm: () => app.setVisibility('private'),
                    });
                  else app.setVisibility('public');
                }}
              >
                <Icon n={v === 'public' ? 'globe' : 'lock'} size={12} /> {v === 'public' ? 'Public' : 'Private'}
              </button>
            ))}
          </div>
          <p className="vb-help">
            {app.visibility === 'public'
              ? 'Anyone can follow or copy this profile. Machine overrides and environment values are never published.'
              : 'Only your machines can use this profile.'}
          </p>
        </Section>
      )}
      {app.visibility === 'public' || !isMain ? (
        <Section title="Share link">
          <div className="vb-linkbox">
            <Icon n="link" size={13} />
            <code>{link}</code>
            <button className="vb-btn" onClick={() => setCopiedLink(true)}>
              {copiedLink ? 'Copied' : 'Copy'}
            </button>
          </div>
        </Section>
      ) : null}
      <Facts
        rows={[
          ['Repository', isMain ? profile.repo : `${account.handle}/${p.name.split('/')[1]}`],
          ['Published', isMain ? <code key="r">{profile.revision}</code> : 'Not yet published'],
          ['Followers', String(p.followers)],
        ]}
      />
    </>
  );
}
