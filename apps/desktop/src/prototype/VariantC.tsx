// PROTOTYPE — Variant C, "Command centre": top pill navigation, bento dashboard, wizard-style apply.
import { useEffect, useState, type ReactNode } from 'react';
import type { VariantProps } from './main.tsx';
import {
  account,
  activity,
  applySteps,
  changes,
  community,
  conflicts as initialConflicts,
  counts,
  integrations,
  machines,
  profile,
  screens,
  settings,
  show,
  skillSources,
  upstream,
  type Activity,
  type Change,
  type Conflict,
  type IntegrationKind,
  type IntegrationStatus,
  type Machine,
  type MachineStatus,
  type Screen,
  type SkillStatus,
  type Source,
} from './data.ts';
import './VariantC.css';

export const name = 'Command centre';

type Go = (screen: Screen) => void;

/* ---------- Icons (Lucide-like, 16px stroke) ---------- */

const paths = {
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  laptop: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M2 20h20" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="3" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="7" rx="2" />
      <path d="M7 6.5h.01M7 17.5h.01" />
    </>
  ),
  mini: (
    <>
      <rect x="3" y="8" width="18" height="9" rx="2.5" />
      <path d="M7 12.5h.01M6 20h12" />
    </>
  ),
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  sparkles: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 3v4M17 5h4" />
    </>
  ),
  plug: <path d="M12 22v-5M9 8V2M15 8V2M18 8v4a6 6 0 0 1-12 0V8z" />,
  refresh: <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M2.5 12h19M12 2.5a14 14 0 0 1 0 19M12 2.5a14 14 0 0 0 0 19" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
    </>
  ),
  play: <path d="M7 4.5v15l12-7.5z" />,
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  tilde: <path d="M4 14c2-4 4-4 6-2s4 2 6-2 2-2 4 0" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  pin: <path d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />,
  layers: (
    <>
      <path d="m12 2 10 5-10 5L2 7z" />
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
    </>
  ),
  commit: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  hook: (
    <>
      <path d="M18 3v8a6 6 0 0 1-12 0v-1" />
      <path d="m3 13 3-3 3 3" />
    </>
  ),
  store: <path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6" />,
  terminal: (
    <>
      <path d="m4 17 6-6-6-6M12 19h8" />
    </>
  ),
  upload: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
  undo: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />,
  star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  merge: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V21M6 9a9 9 0 0 0 9.5 9" />
    </>
  ),
};
type IconName = keyof typeof paths;

function Icon({ name: icon, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="vc-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[icon]}
    </svg>
  );
}

/* ---------- Shared bits ---------- */

const statusMeta: Record<MachineStatus, { label: string; tone: string }> = {
  'in-sync': { label: 'In sync', tone: 'good' },
  behind: { label: 'Behind', tone: 'warn' },
  drift: { label: 'Drift', tone: 'bad' },
  offline: { label: 'Offline', tone: 'mute' },
};

const deviceIcon = (m: Machine): IconName =>
  m.name.includes('mbp') ? 'laptop' : m.os.startsWith('Windows') ? 'monitor' : m.os.startsWith('Ubuntu') ? 'server' : 'mini';

const sourceMeta: Record<Source, { label: string; tone: string }> = {
  base: { label: 'Base', tone: 'base' },
  override: { label: 'Override', tone: 'override' },
  pinned: { label: 'Pinned', tone: 'pinned' },
  default: { label: 'Default', tone: 'default' },
};

const skillStatusMeta: Record<SkillStatus, { label: string; tone: string }> = {
  installed: { label: 'Installed', tone: 'good' },
  outdated: { label: 'Update', tone: 'warn' },
  missing: { label: 'Missing', tone: 'bad' },
  optional: { label: 'Optional', tone: 'mute' },
};

const integrationStatusMeta: Record<IntegrationStatus, { label: string; tone: string }> = {
  installed: { label: 'Installed', tone: 'good' },
  missing: { label: 'Missing', tone: 'warn' },
  'allowed-extra': { label: 'Allowed extra', tone: 'mute' },
  drift: { label: 'Drift', tone: 'bad' },
};

const kindMeta: Record<IntegrationKind, { label: string; icon: IconName }> = {
  plugin: { label: 'Plugin', icon: 'plug' },
  marketplace: { label: 'Marketplace', icon: 'store' },
  hook: { label: 'Hook', icon: 'hook' },
  mcp: { label: 'MCP server', icon: 'terminal' },
};

const changeMeta: Record<Change['kind'], { icon: IconName; tone: string; label: string }> = {
  add: { icon: 'plus', tone: 'good', label: 'Add' },
  modify: { icon: 'tilde', tone: 'info', label: 'Modify' },
  remove: { icon: 'minus', tone: 'bad', label: 'Remove' },
};

const activityIcon: Record<Activity['kind'], IconName> = {
  apply: 'play',
  sync: 'refresh',
  override: 'layers',
  publish: 'upload',
  drift: 'alert',
};

const me = machines.find((m) => m.current)!;

function Pill({ tone, children, dot }: { tone: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`vc-pill vc-tone-${tone}`}>
      {dot && <span className="vc-dot" />}
      {children}
    </span>
  );
}

function Target({ t }: { t: string }) {
  return <span className={`vc-target vc-target-${t}`}>{t === 'claude' ? 'Claude' : 'Codex'}</span>;
}

function PageHead({ eyebrow, title, hint, actions }: { eyebrow?: string; title: string; hint: string; actions?: ReactNode }) {
  return (
    <div className="vc-head">
      <div>
        {eyebrow && <div className="vc-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{hint}</p>
      </div>
      {actions && <div className="vc-head-actions">{actions}</div>}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button className={`vc-switch${on ? ' is-on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={onChange}>
      <span />
    </button>
  );
}

/* ---------- Top bar ---------- */

function Topbar({ screen, go }: VariantProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(me.id);
  const active = machines.find((m) => m.id === selected)!;
  const badges: Partial<Record<Screen, number>> = { changes: counts.pendingChanges, sync: counts.upstreamBehind };
  return (
    <header className="vc-top">
      <button className="vc-brand" onClick={() => go('dashboard')}>
        <span className="vc-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="7" cy="7" r="2.6" />
            <circle cx="17" cy="17" r="2.6" />
            <path d="M7 9.6v3.4a4 4 0 0 0 4 4h3.4" />
          </svg>
        </span>
        <b>nortuscc</b>
      </button>

      <nav className="vc-tabs" aria-label="Sections">
        {screens.map((s) => (
          <button
            key={s.key}
            className={`vc-tab${s.key === screen ? ' is-active' : ''}`}
            onClick={() => go(s.key)}
            title={s.hint}
            aria-current={s.key === screen ? 'page' : undefined}
          >
            {s.label}
            {badges[s.key] ? <span className="vc-tab-badge">{badges[s.key]}</span> : null}
          </button>
        ))}
      </nav>

      <div className="vc-top-right">
        <div className="vc-msel">
          <button className="vc-msel-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Icon name={deviceIcon(active)} />
            <span>{active.name}</span>
            <span className={`vc-dot vc-tone-${statusMeta[active.status].tone}`} />
            <Icon name="chevronDown" size={14} />
          </button>
          {open && (
            <div className="vc-menu" role="menu">
              <div className="vc-menu-label">Machines on {profile.name}</div>
              {machines.map((m) => (
                <button
                  key={m.id}
                  role="menuitemradio"
                  aria-checked={m.id === selected}
                  className={`vc-menu-item${m.id === selected ? ' is-selected' : ''}`}
                  onClick={() => {
                    setSelected(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="vc-glyph-sm">
                    <Icon name={deviceIcon(m)} size={14} />
                  </span>
                  <span className="vc-menu-main">
                    <b>
                      {m.name}
                      {m.current && <em>this machine</em>}
                    </b>
                    <small>
                      {m.os} · {m.appliedRevision}
                    </small>
                  </span>
                  <span className={`vc-dot vc-tone-${statusMeta[m.status].tone}`} />
                </button>
              ))}
              <button
                className="vc-menu-foot"
                onClick={() => {
                  setOpen(false);
                  go('machines');
                }}
              >
                Manage machines <Icon name="arrowRight" size={14} />
              </button>
            </div>
          )}
        </div>
        <span className="vc-avatar" title={`${account.name} · @${account.handle}`}>
          {account.initials}
        </span>
      </div>
    </header>
  );
}

/* ---------- Revision graph (git-style) ---------- */

const history = [
  { sha: 'cf264eb', message: 'centralized agent setup' },
  { sha: '264dea5', message: 'plan Tauri fixture app' },
  { sha: '618c2f0', message: 'Tauri validation' },
];
const incoming = [...upstream].reverse().map((c) => ({ sha: c.sha, message: c.message }));

function RevisionGraph() {
  const x0 = 56;
  const gap = 118;
  const low = 128;
  const high = 64;
  const nodes = [
    ...history.map((c, i) => ({ ...c, x: x0 + i * gap, y: low, lane: 'history' as const })),
    ...incoming.map((c, i) => ({ ...c, x: x0 + (i + 3) * gap, y: high, lane: 'incoming' as const })),
  ];
  const fork = nodes[2]!;
  const last = nodes[nodes.length - 1]!;
  const tagWidth = (text: string) => text.length * 6.4 + 30;
  return (
    <svg className="vc-graph" viewBox="0 0 720 190" role="img" aria-label="Revision graph: which machine sits on which revision">
      <path d={`M ${x0 - 30} ${low} H ${fork.x + 70}`} className="vc-g-line" />
      <path d={`M ${fork.x + 70} ${low} H 700`} className="vc-g-line vc-g-faded" />
      <path
        d={`M ${fork.x} ${low} C ${fork.x + 60} ${low}, ${fork.x + 64} ${high}, ${fork.x + gap} ${high} H ${last.x}`}
        className="vc-g-line vc-g-incoming"
      />
      <text x={last.x + 14} y={high + 4} className="vc-g-ref">
        origin/main
      </text>
      {nodes.map((n) => {
        const sitting = machines.filter((m) => m.appliedRevision === n.sha);
        const isHead = n.sha === profile.revision;
        return (
          <g key={n.sha}>
            <circle
              cx={n.x}
              cy={n.y}
              r={isHead ? 7 : 5.5}
              className={`vc-g-node${n.lane === 'incoming' ? ' vc-g-node-in' : ''}${isHead ? ' vc-g-node-head' : ''}`}
            />
            <text x={n.x} y={n.lane === 'history' ? n.y - 16 : n.y + 24} textAnchor="middle" className="vc-g-sha">
              {n.sha}
            </text>
            {sitting.map((m, i) => {
              const w = tagWidth(m.name);
              const y = n.lane === 'history' ? n.y + 18 + i * 24 : n.y - 50 - i * 24;
              const tone = statusMeta[m.status].tone;
              return (
                <g key={m.id} transform={`translate(${n.x - w / 2} ${y})`} className={`vc-g-tag${m.current ? ' is-current' : ''}`}>
                  <line x1={w / 2} x2={w / 2} y1={n.lane === 'history' ? -11 : 21} y2={n.lane === 'history' ? 0 : 32} className="vc-g-stem" />
                  <rect width={w} height={21} rx={10.5} />
                  <circle cx={12} cy={10.5} r={3.5} className={`vc-g-status vc-tone-${tone}`} />
                  <text x={21} y={14.5}>
                    {m.name}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- Dashboard ---------- */

function HealthRing({ value }: { value: number }) {
  const r = 58;
  const c = 2 * Math.PI * r;
  return (
    <div className="vc-ring">
      <svg viewBox="0 0 140 140" width="148" height="148" aria-hidden="true">
        <defs>
          <linearGradient id="vc-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff8a3d" />
            <stop offset="1" stopColor="#ff4d1a" />
          </linearGradient>
        </defs>
        <circle cx="70" cy="70" r={r} className="vc-ring-track" />
        <circle
          cx="70"
          cy="70"
          r={r}
          className="vc-ring-value"
          strokeDasharray={`${(value / 100) * c} ${c}`}
          transform="rotate(-90 70 70)"
        />
      </svg>
      <div className="vc-ring-label">
        <b>{value}%</b>
        <span>aligned</span>
      </div>
    </div>
  );
}

function SkillComposition() {
  const max = Math.max(...skillSources.map((s) => s.skills.length));
  const order: SkillStatus[] = ['installed', 'outdated', 'missing', 'optional'];
  return (
    <div className="vc-comp">
      {skillSources.map((src) => (
        <div className="vc-comp-row" key={src.repo}>
          <div className="vc-comp-name">
            <span>{src.repo.split('/')[0]}</span>
            <small>{src.skills.length}</small>
          </div>
          <div className="vc-comp-track">
            <div className="vc-comp-bar" style={{ width: `${(src.skills.length / max) * 100}%` }}>
              {order.map((st) => {
                const n = src.skills.filter((s) => s.status === st).length;
                return n ? <span key={st} className={`vc-seg vc-seg-${st}`} style={{ flex: n }} title={`${n} ${st}`} /> : null;
              })}
            </div>
          </div>
        </div>
      ))}
      <div className="vc-legend">
        {order.map((st) => (
          <span key={st}>
            <i className={`vc-seg-${st}`} />
            {skillStatusMeta[st].label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Dashboard({ go }: { go: Go }) {
  const total = settings.length + counts.skillsTotal + integrations.length;
  const aligned = Math.round(((total - counts.pendingChanges) / total) * 100);
  const overrides = settings.filter((s) => s.source === 'override');
  const inSync = machines.filter((m) => m.status === 'in-sync').length;
  const mine = community.find((p) => p.relation === 'mine')!;
  return (
    <>
      <PageHead
        eyebrow={`${profile.name} · ${profile.repo}@${profile.branch}`}
        title="Good evening, Ihor"
        hint="Here is how this machine and the rest of the fleet line up with your profile."
      />
      <div className="vc-bento">
        <section className="vc-tile vc-hero span-8">
          <div className="vc-hero-body">
            <Pill tone="warn" dot>
              Update available
            </Pill>
            <h2>
              {me.name} is <em>{counts.upstreamBehind} commits</em> behind · <em>{counts.pendingChanges} changes</em> ready
            </h2>
            <div className="vc-hero-facts">
              <span>
                <Icon name="alert" size={14} /> {counts.conflicts} conflict to resolve
              </span>
              <span>
                <Icon name="minus" size={14} /> {counts.destructive} destructive change
              </span>
              <span>
                <Icon name="layers" size={14} /> {counts.overrides} local overrides
              </span>
            </div>
            <div className="vc-hero-cta">
              <button className="vc-btn vc-btn-primary vc-btn-lg" onClick={() => go('changes')}>
                Review & apply <Icon name="arrowRight" />
              </button>
              <button className="vc-btn vc-btn-lg" onClick={() => go('sync')}>
                <Icon name="refresh" /> Pull upstream
              </button>
            </div>
          </div>
          <div className="vc-hero-ring">
            <HealthRing value={aligned} />
            <small>
              {total - counts.pendingChanges} of {total} items match
            </small>
          </div>
        </section>

        <section className="vc-tile span-4">
          <div className="vc-tile-head">
            <h3>Fleet</h3>
            <span className="vc-muted">
              {inSync} of {machines.length} in sync
            </span>
          </div>
          <div className="vc-fleet">
            {machines.map((m) => (
              <button key={m.id} className="vc-fleet-row" onClick={() => go('machines')}>
                <span className={`vc-glyph vc-tone-${statusMeta[m.status].tone}`}>
                  <Icon name={deviceIcon(m)} />
                </span>
                <span className="vc-fleet-main">
                  <b>
                    {m.name}
                    {m.current && <em>you</em>}
                  </b>
                  <small>
                    {m.os} · {m.lastSeen}
                  </small>
                </span>
                <Pill tone={statusMeta[m.status].tone}>{statusMeta[m.status].label}</Pill>
              </button>
            ))}
          </div>
        </section>

        <section className="vc-tile span-8">
          <div className="vc-tile-head">
            <h3>Revision timeline</h3>
            <div className="vc-legend vc-legend-inline">
              <span>
                <i className="vc-key-history" />
                Applied history
              </span>
              <span>
                <i className="vc-key-incoming" />
                Incoming upstream
              </span>
            </div>
          </div>
          <RevisionGraph />
        </section>

        <section className="vc-tile span-4">
          <div className="vc-tile-head">
            <h3>Skills</h3>
            <button className="vc-link" onClick={() => go('skills')}>
              {counts.skillsInstalled}/{counts.skillsTotal} installed <Icon name="chevronRight" size={14} />
            </button>
          </div>
          <SkillComposition />
        </section>

        <section className="vc-tile span-4">
          <div className="vc-tile-head">
            <h3>Overrides on {me.name}</h3>
            <button className="vc-link" onClick={() => go('profile')}>
              Profile <Icon name="chevronRight" size={14} />
            </button>
          </div>
          <div className="vc-ovr">
            {overrides.map((s) => (
              <div key={s.key} className="vc-ovr-row">
                <div className="vc-ovr-key">
                  <code>{s.key}</code>
                  <Target t={s.target} />
                </div>
                <div className="vc-ovr-val">
                  <s>{show(s.base)}</s>
                  <Icon name="arrowRight" size={12} />
                  <code>{show(s.override)}</code>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="vc-tile span-4 vc-community-tile">
          <div className="vc-tile-head">
            <h3>Community</h3>
            <button className="vc-link" onClick={() => go('sharing')}>
              Sharing <Icon name="chevronRight" size={14} />
            </button>
          </div>
          <div className="vc-followers">
            <b>{mine.followers}</b>
            <span>
              followers of <code>{mine.name}</code>
            </span>
          </div>
          <div className="vc-facepile">
            {['MP', 'AK', 'JS', 'LR', 'TW', 'EH'].map((x, i) => (
              <span key={x} style={{ zIndex: 10 - i }}>
                {x}
              </span>
            ))}
            <span className="vc-facepile-more">+{mine.followers - 6}</span>
          </div>
          <div className="vc-mini-list">
            {community
              .filter((p) => p.relation !== 'mine')
              .slice(0, 2)
              .map((p) => (
                <div key={p.name}>
                  <code>{p.name}</code>
                  <span className="vc-muted">
                    <Icon name="users" size={12} /> {p.followers.toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        </section>

        <section className="vc-tile span-4">
          <div className="vc-tile-head">
            <h3>Activity</h3>
            <span className="vc-muted">Today</span>
          </div>
          <ol className="vc-activity">
            {activity.slice(0, 4).map((a) => (
              <li key={a.id}>
                <span className={`vc-act-icon vc-act-${a.kind}`}>
                  <Icon name={activityIcon[a.kind]} size={13} />
                </span>
                <span className="vc-act-main">
                  <b>{a.who}</b> {a.text}
                </span>
                <time>{a.when}</time>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}

/* ---------- Profile ---------- */

function Profile({ go }: { go: Go }) {
  const [target, setTarget] = useState<'all' | 'claude' | 'codex'>('all');
  const rows = settings.filter((s) => target === 'all' || s.target === target);
  const pinned = skillSources.flatMap((s) => s.skills).filter((s) => s.pinned);
  const layers = [
    { icon: 'lock' as IconName, title: 'Defaults', sub: 'Agent built-ins', count: settings.filter((s) => s.source === 'default').length },
    { icon: 'layers' as IconName, title: 'Base profile', sub: `${profile.name}@${profile.revision}`, count: settings.filter((s) => s.source === 'base').length },
    { icon: 'sliders' as IconName, title: 'Machine overrides', sub: me.name, count: counts.overrides, accent: true },
    { icon: 'pin' as IconName, title: 'Pinned skills', sub: 'Exact versions', count: pinned.length },
  ];
  return (
    <>
      <PageHead
        eyebrow={profile.repo}
        title="Profile"
        hint="Every resolved value on this machine, and the layer it comes from."
        actions={
          <div className="vc-seg-ctl">
            {(['all', 'claude', 'codex'] as const).map((t) => (
              <button key={t} className={t === target ? 'is-active' : ''} onClick={() => setTarget(t)}>
                {t === 'all' ? 'All targets' : t === 'claude' ? 'Claude Code' : 'Codex'}
              </button>
            ))}
          </div>
        }
      />
      <div className="vc-layers">
        {layers.map((l, i) => (
          <div key={l.title} className="vc-layer-wrap">
            <div className={`vc-tile vc-layer${l.accent ? ' is-accent' : ''}`}>
              <span className="vc-layer-icon">
                <Icon name={l.icon} />
              </span>
              <div>
                <b>{l.title}</b>
                <small>{l.sub}</small>
              </div>
              <span className="vc-layer-count">{l.count}</span>
            </div>
            {i < layers.length - 1 && (
              <span className="vc-layer-arrow">
                <Icon name="chevronRight" size={14} />
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="vc-split">
        <section className="vc-tile vc-tile-flush">
          <table className="vc-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Resolved value</th>
                <th>Provenance</th>
                <th>On this machine</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const pending = show(s.current) !== show(s.desired);
                return (
                  <tr key={`${s.target}-${s.key}`}>
                    <td>
                      <div className="vc-key-cell">
                        <code>{s.key}</code>
                        <Target t={s.target} />
                      </div>
                    </td>
                    <td>
                      <code className="vc-val">{show(s.desired)}</code>
                      {s.source === 'override' && (
                        <div className="vc-shadowed">
                          base <s>{show(s.base)}</s>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`vc-src vc-src-${sourceMeta[s.source].tone}`}>{sourceMeta[s.source].label}</span>
                    </td>
                    <td>
                      {pending ? (
                        <button className="vc-pending" onClick={() => go('changes')}>
                          <code>{show(s.current)}</code>
                          <Icon name="arrowRight" size={12} />
                          <span>pending</span>
                        </button>
                      ) : (
                        <span className="vc-match">
                          <Icon name="check" size={14} /> Matches
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <aside className="vc-stack">
          <section className="vc-tile">
            <div className="vc-tile-head">
              <h3>Pinned skills</h3>
              <Icon name="pin" />
            </div>
            {pinned.map((p) => (
              <div key={p.name} className="vc-kv">
                <code>{p.name}</code>
                <span className="vc-src vc-src-pinned">{p.pinned}</span>
              </div>
            ))}
          </section>
          <section className="vc-tile vc-note">
            <Icon name="layers" />
            <p>
              Overrides win over the base profile. Sync never overwrites them silently — conflicts are surfaced in{' '}
              <button className="vc-link" onClick={() => go('sync')}>
                Sync
              </button>
              .
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

/* ---------- Skills ---------- */

function Skills() {
  const all = skillSources.flatMap((s) => s.skills);
  const [enabled, setEnabled] = useState(() => new Set(all.filter((s) => s.status !== 'optional').map((s) => s.name)));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | SkillStatus>('all');
  const toggle = (n: string) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const q = query.trim().toLowerCase();
  const groups = skillSources
    .map((src) => ({
      ...src,
      skills: src.skills.filter(
        (s) => (filter === 'all' || s.status === filter) && (!q || s.name.includes(q) || s.description.toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.skills.length);
  return (
    <>
      <PageHead
        eyebrow={`${enabled.size} of ${all.length} enabled`}
        title="Skills"
        hint="Agent skills from every source repo. Toggle one to include it in this profile."
        actions={
          <label className="vc-search">
            <Icon name="search" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear search">
                <Icon name="x" size={14} />
              </button>
            )}
          </label>
        }
      />
      <div className="vc-chips">
        {(['all', 'installed', 'outdated', 'missing', 'optional'] as const).map((f) => (
          <button key={f} className={`vc-chip${filter === f ? ' is-active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : skillStatusMeta[f].label}
            <span>{f === 'all' ? all.length : all.filter((s) => s.status === f).length}</span>
          </button>
        ))}
      </div>
      {groups.length === 0 && (
        <div className="vc-tile vc-empty">
          <Icon name="search" size={20} />
          <b>No skills match “{query}”</b>
          <span>Try another name or clear the filter.</span>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.repo} className="vc-group">
          <div className="vc-group-head">
            <span className="vc-repo-mark">{g.repo[0]!.toUpperCase()}</span>
            <h3>{g.repo}</h3>
            <span className="vc-mode">{g.mode === 'all' ? 'All skills' : g.mode === 'exact' ? 'Exact list' : 'Opt-in'}</span>
            <span className="vc-muted">{g.skills.length} shown</span>
          </div>
          <div className="vc-gallery">
            {g.skills.map((s) => {
              const on = enabled.has(s.name);
              return (
                <article key={s.name} className={`vc-tile vc-skill${on ? '' : ' is-off'}`}>
                  <div className="vc-skill-top">
                    <span className="vc-skill-icon">
                      <Icon name="sparkles" />
                    </span>
                    <Switch on={on} onChange={() => toggle(s.name)} label={`Enable ${s.name}`} />
                  </div>
                  <code className="vc-skill-name">{s.name}</code>
                  <p>{s.description}</p>
                  <div className="vc-skill-foot">
                    <Pill tone={skillStatusMeta[s.status].tone} dot>
                      {skillStatusMeta[s.status].label}
                    </Pill>
                    {s.pinned && (
                      <span className="vc-src vc-src-pinned">
                        <Icon name="pin" size={11} /> {s.pinned}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

/* ---------- Integrations ---------- */

function Integrations({ go }: { go: Go }) {
  const [kind, setKind] = useState<'all' | IntegrationKind>('all');
  const list = integrations.filter((i) => kind === 'all' || i.kind === kind);
  return (
    <>
      <PageHead
        eyebrow="integrations.json"
        title="Integrations"
        hint="Plugins, marketplaces, hooks and MCP servers this profile expects."
        actions={
          <div className="vc-seg-ctl">
            {(['all', 'plugin', 'marketplace', 'hook', 'mcp'] as const).map((k) => (
              <button key={k} className={k === kind ? 'is-active' : ''} onClick={() => setKind(k)}>
                {k === 'all' ? 'All' : kindMeta[k].label}
              </button>
            ))}
          </div>
        }
      />
      <div className="vc-int-grid">
        {list.map((i) => (
          <article key={i.id} className={`vc-tile vc-int vc-int-${i.status}`}>
            <div className="vc-int-top">
              <span className="vc-int-icon">
                <Icon name={kindMeta[i.kind].icon} />
              </span>
              <div className="vc-int-title">
                <b>{i.label}</b>
                <small>
                  {kindMeta[i.kind].label} · <Target t={i.target} />
                </small>
              </div>
              <Pill tone={integrationStatusMeta[i.status].tone} dot>
                {integrationStatusMeta[i.status].label}
              </Pill>
            </div>
            <p className="vc-int-detail">{i.detail}</p>
            {i.env && (
              <div className="vc-env">
                {i.env.map((e) => (
                  <span key={e}>
                    <Icon name="key" size={12} /> <code>{e}</code> <em>not set</em>
                  </span>
                ))}
              </div>
            )}
            {(i.status === 'missing' || i.status === 'drift') && (
              <button className={`vc-int-action vc-tone-${i.status === 'drift' ? 'bad' : 'warn'}`} onClick={() => go('changes')}>
                {i.status === 'drift' ? 'Will be removed on next apply' : 'Will be installed on next apply'}
                <Icon name="arrowRight" size={14} />
              </button>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

/* ---------- Changes (wizard) ---------- */

const TICKS_PER_STEP = 12;
const wizard = ['Review', 'Back up', 'Apply', 'Verify'];
const backupPath = '~/.claude/backups/2026-10-05T18-52-07';

function Changes({ go }: { go: Go }) {
  const [phase, setPhase] = useState<'review' | 'backup' | 'run'>('review');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<'running' | 'completed' | 'cancelled'>('running');
  const [restored, setRestored] = useState(false);
  const total = applySteps.length * TICKS_PER_STEP;

  useEffect(() => {
    if (phase !== 'run' || status !== 'running') return;
    const id = setInterval(() => setTick((t) => Math.min(t + 1, total)), 90);
    return () => clearInterval(id);
  }, [phase, status, total]);
  useEffect(() => {
    if (phase === 'run' && status === 'running' && tick >= total) setStatus('completed');
  }, [tick, total, phase, status]);

  const included = changes.filter((c) => !excluded.has(c.id));
  const destructiveIncluded = included.filter((c) => c.destructive);
  const blocked = included.length === 0 || (destructiveIncluded.length > 0 && !confirmed);
  const stepIndex = Math.min(Math.floor(tick / TICKS_PER_STEP), applySteps.length - 1);
  const pct = Math.round((tick / total) * 100);
  const wizardIndex =
    phase === 'review' ? 0 : phase === 'backup' ? 1 : status === 'completed' ? 3 : stepIndex === 0 ? 1 : stepIndex === applySteps.length - 1 ? 3 : 2;

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const start = () => {
    setTick(0);
    setStatus('running');
    setRestored(false);
    setPhase('run');
  };
  const reset = () => {
    setPhase('review');
    setTick(0);
    setStatus('running');
    setRestored(false);
  };
  const byKind = (k: Change['kind']) => included.filter((c) => c.kind === k).length;
  const areas: Change['area'][] = ['setting', 'skill', 'integration'];

  return (
    <>
      <PageHead
        eyebrow={`${me.name} · ${profile.revision}`}
        title="Apply changes"
        hint="Preview what will change on this machine. A backup is always taken first."
        actions={
          <div className="vc-diffstat">
            <span className="vc-tone-good">+{byKind('add')}</span>
            <span className="vc-tone-info">~{byKind('modify')}</span>
            <span className="vc-tone-bad">−{byKind('remove')}</span>
          </div>
        }
      />

      <ol className="vc-stepper">
        {wizard.map((w, i) => {
          const state =
            phase === 'run' && status === 'cancelled' && i === wizardIndex
              ? 'cancelled'
              : i < wizardIndex || (status === 'completed' && phase === 'run')
                ? 'done'
                : i === wizardIndex
                  ? 'active'
                  : 'todo';
          return (
            <li key={w} className={`is-${state}`}>
              <span className="vc-step-num">
                {state === 'done' ? <Icon name="check" size={14} /> : state === 'cancelled' ? <Icon name="x" size={14} /> : i + 1}
              </span>
              <span className="vc-step-label">
                <small>Step {i + 1}</small>
                {w}
              </span>
            </li>
          );
        })}
      </ol>

      {phase === 'review' && (
        <section className="vc-tile vc-wizard">
          {areas.map((area) => (
            <div key={area} className="vc-cgroup">
              <h4>{area === 'setting' ? 'Settings' : area === 'skill' ? 'Skills' : 'Integrations'}</h4>
              {changes
                .filter((c) => c.area === area)
                .map((c) => {
                  const on = !excluded.has(c.id);
                  const meta = changeMeta[c.kind];
                  return (
                    <label key={c.id} className={`vc-change${on ? '' : ' is-excluded'}${c.destructive ? ' is-destructive' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
                      <span className={`vc-ckind vc-tone-${meta.tone}`} title={meta.label}>
                        <Icon name={meta.icon} size={13} />
                      </span>
                      <code className="vc-cpath">{c.path}</code>
                      <Target t={c.target} />
                      {c.destructive && (
                        <span className="vc-pill vc-tone-bad">
                          <Icon name="alert" size={12} /> Destructive
                        </span>
                      )}
                      <span className="vc-cdiff">
                        {c.before && <del>{c.before}</del>}
                        {c.before && c.after && <Icon name="arrowRight" size={12} />}
                        {c.after && <ins>{c.after}</ins>}
                        {!c.before && !c.after && <span className="vc-muted">{c.kind === 'add' ? 'install' : 'uninstall'}</span>}
                      </span>
                    </label>
                  );
                })}
            </div>
          ))}
          {destructiveIncluded.length > 0 && (
            <div className="vc-danger">
              <span className="vc-danger-icon">
                <Icon name="alert" />
              </span>
              <div>
                <b>
                  {destructiveIncluded.length} destructive change removes something from this machine
                </b>
                <p>
                  {destructiveIncluded.map((c) => c.path).join(', ')} will be uninstalled. It is captured in the backup and can be restored.
                </p>
                <label className="vc-confirm">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I understand and want to
                  remove it
                </label>
              </div>
            </div>
          )}
          <div className="vc-wizard-foot">
            <button className="vc-btn" onClick={() => go('dashboard')}>
              Cancel
            </button>
            <span className="vc-muted">
              {included.length} of {changes.length} changes selected
            </span>
            <button className="vc-btn vc-btn-primary" disabled={blocked} onClick={() => setPhase('backup')}>
              Continue to backup <Icon name="arrowRight" />
            </button>
          </div>
        </section>
      )}

      {phase === 'backup' && (
        <section className="vc-tile vc-wizard vc-backup">
          <div className="vc-backup-art">
            <Icon name="archive" size={36} />
          </div>
          <div className="vc-backup-body">
            <h3>A snapshot is taken before anything is written</h3>
            <p>If the apply is cancelled or fails, restore from this snapshot in one click.</p>
            <dl>
              <dt>Destination</dt>
              <dd>
                <code>{backupPath}</code>
              </dd>
              <dt>Includes</dt>
              <dd>
                <code>settings.json</code> <code>skills/</code> <code>plugins/</code> <code>~/.codex/config.toml</code>
              </dd>
              <dt>Applying</dt>
              <dd>
                {included.length} changes{destructiveIncluded.length ? `, ${destructiveIncluded.length} destructive (confirmed)` : ''}
              </dd>
            </dl>
          </div>
          <div className="vc-wizard-foot">
            <button className="vc-btn" onClick={() => setPhase('review')}>
              Back
            </button>
            <span />
            <button className="vc-btn vc-btn-primary" onClick={start}>
              <Icon name="shield" /> Back up & apply
            </button>
          </div>
        </section>
      )}

      {phase === 'run' && (
        <section className={`vc-tile vc-wizard vc-run vc-run-${status}`}>
          <div className="vc-run-top">
            <div className="vc-run-pct">
              <b>{pct}</b>
              <span>%</span>
            </div>
            <div className="vc-run-status">
              {status === 'running' && (
                <>
                  <Pill tone="accent" dot>
                    Running
                  </Pill>
                  <h3>{applySteps[stepIndex]}…</h3>
                </>
              )}
              {status === 'completed' && (
                <>
                  <Pill tone="good" dot>
                    Completed
                  </Pill>
                  <h3>
                    {included.length} changes applied and verified
                  </h3>
                </>
              )}
              {status === 'cancelled' && (
                <>
                  <Pill tone="bad" dot>
                    Cancelled
                  </Pill>
                  <h3>Stopped during “{applySteps[stepIndex]}”</h3>
                </>
              )}
            </div>
          </div>
          <div className="vc-bigbar">
            {applySteps.map((s, i) => {
              const fill = Math.max(0, Math.min(1, (tick - i * TICKS_PER_STEP) / TICKS_PER_STEP));
              return (
                <div key={s} className="vc-bigbar-seg">
                  <span style={{ width: `${fill * 100}%` }} />
                </div>
              );
            })}
          </div>
          <ol className="vc-run-steps">
            {applySteps.map((s, i) => {
              const done = tick >= (i + 1) * TICKS_PER_STEP;
              const current = !done && i === stepIndex;
              const st = done ? 'done' : current ? (status === 'cancelled' ? 'cancelled' : 'active') : status === 'cancelled' ? 'skipped' : 'todo';
              return (
                <li key={s} className={`is-${st}`}>
                  <span className="vc-run-icon">
                    {st === 'done' ? (
                      <Icon name="check" size={13} />
                    ) : st === 'cancelled' ? (
                      <Icon name="x" size={13} />
                    ) : st === 'active' ? (
                      <span className="vc-spinner" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span>{s}</span>
                  <em>{st === 'done' ? 'Done' : st === 'active' ? 'In progress' : st === 'cancelled' ? 'Cancelled' : st === 'skipped' ? 'Not run' : 'Queued'}</em>
                </li>
              );
            })}
          </ol>
          {status === 'completed' && (
            <div className="vc-result vc-tone-good">
              <Icon name="shield" />
              <span>
                Verified against {profile.revision}. Backup kept at <code>{backupPath}</code>.
              </span>
            </div>
          )}
          {status === 'cancelled' && (
            <div className="vc-result vc-tone-bad">
              <Icon name="alert" />
              <span>
                {stepIndex === 0
                  ? 'Cancelled before anything was written.'
                  : `Steps 1–${stepIndex} finished; nothing after them was written.`}{' '}
                {restored ? 'Backup restored — this machine is back where it started.' : <>Backup at <code>{backupPath}</code>.</>}
              </span>
            </div>
          )}
          <div className="vc-wizard-foot">
            {status === 'running' && (
              <>
                <span className="vc-muted">Applying {included.length} changes to {me.name}</span>
                <span />
                <button className="vc-btn vc-btn-danger" onClick={() => setStatus('cancelled')}>
                  <Icon name="x" /> Cancel apply
                </button>
              </>
            )}
            {status === 'completed' && (
              <>
                <button className="vc-btn" onClick={reset}>
                  Start over
                </button>
                <span />
                <button className="vc-btn vc-btn-primary" onClick={() => go('dashboard')}>
                  Back to overview <Icon name="arrowRight" />
                </button>
              </>
            )}
            {status === 'cancelled' && (
              <>
                <button className="vc-btn" disabled={restored || stepIndex === 0} onClick={() => setRestored(true)}>
                  <Icon name="undo" /> {restored ? 'Restored' : 'Restore backup'}
                </button>
                <span />
                <button className="vc-btn vc-btn-primary" onClick={reset}>
                  Start over
                </button>
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
}

/* ---------- Sync ---------- */

function Sync({ go }: { go: Go }) {
  const [conflicts, setConflicts] = useState<Conflict[]>(initialConflicts);
  const [state, setState] = useState<'idle' | 'syncing' | 'done'>('idle');
  const unresolved = conflicts.filter((c) => !c.resolution).length;
  const resolve = (key: string, resolution: Conflict['resolution']) =>
    setConflicts((cs) => cs.map((c) => (c.key === key ? { ...c, resolution } : c)));
  useEffect(() => {
    if (state !== 'syncing') return;
    const id = setTimeout(() => setState('done'), 1400);
    return () => clearTimeout(id);
  }, [state]);
  const theme = conflicts.find((c) => c.key === 'theme');
  const rows = [
    { key: 'theme', up: '"light"', mine: '"dark"', note: 'local override', conflict: true },
    { key: 'skills · wayfinder', up: 'added', mine: 'not installed' },
    { key: 'skills · triage', up: 'added', mine: 'not installed' },
    { key: 'skills · show-me', up: 'v1.2.0', mine: 'v1.1.4' },
  ];
  return (
    <>
      <PageHead
        eyebrow={`${profile.repo}@${profile.branch}`}
        title="Sync upstream"
        hint={`${counts.upstreamBehind} new commits on origin/${profile.branch}. Overrides are never overwritten without your say.`}
      />
      <div className="vc-commits">
        {upstream.map((c) => (
          <div key={c.sha} className="vc-commit">
            <span className="vc-commit-dot" />
            <code>{c.sha}</code>
            <span className="vc-commit-msg">{c.message}</span>
            <span className="vc-muted">
              {c.author} · {c.when}
            </span>
          </div>
        ))}
      </div>

      <div className="vc-compare">
        <section className="vc-tile vc-cmp vc-cmp-up">
          <div className="vc-cmp-head">
            <Icon name="globe" />
            <div>
              <b>Upstream</b>
              <small>origin/{profile.branch} · {profile.upstreamRevision}</small>
            </div>
          </div>
          {rows.map((r) => (
            <div key={r.key} className={`vc-cmp-row${r.conflict ? ' is-conflict' : ''}`}>
              <span>{r.key}</span>
              <code>{r.up}</code>
            </div>
          ))}
        </section>
        <div className="vc-cmp-mid">
          <Icon name="merge" size={18} />
        </div>
        <section className="vc-tile vc-cmp">
          <div className="vc-cmp-head">
            <Icon name="laptop" />
            <div>
              <b>Yours</b>
              <small>
                {me.name} · {profile.revision}
              </small>
            </div>
          </div>
          {rows.map((r) => (
            <div key={r.key} className={`vc-cmp-row${r.conflict ? ' is-conflict' : ''}`}>
              <span>{r.key}</span>
              <code>{r.key === 'theme' && theme?.resolution === 'take-upstream' ? <s>{r.mine}</s> : r.mine}</code>
              {r.note && <em>{r.note}</em>}
            </div>
          ))}
        </section>
      </div>

      {conflicts.map((c) => (
        <section key={c.key} className={`vc-conflict${c.resolution ? ' is-resolved' : ''}`}>
          <div className="vc-conflict-head">
            <span className="vc-conflict-icon">
              <Icon name={c.resolution ? 'check' : 'alert'} />
            </span>
            <div>
              <b>
                Conflict on <code>{c.key}</code>
              </b>
              <p>
                Upstream changed the base from <code>{c.base}</code> to <code>{c.upstream}</code>, but this machine overrides it with{' '}
                <code>{c.local}</code>.
              </p>
            </div>
          </div>
          <div className="vc-choices">
            <button className={`vc-choice${c.resolution === 'keep-local' ? ' is-chosen' : ''}`} onClick={() => resolve(c.key, 'keep-local')}>
              <span className="vc-radio" />
              <span>
                <b>Keep local override</b>
                <small>
                  Stay on <code>{c.local}</code>; the base becomes <code>{c.upstream}</code> underneath.
                </small>
              </span>
            </button>
            <button
              className={`vc-choice${c.resolution === 'take-upstream' ? ' is-chosen' : ''}`}
              onClick={() => resolve(c.key, 'take-upstream')}
            >
              <span className="vc-radio" />
              <span>
                <b>Take upstream</b>
                <small>
                  Drop the override and use <code>{c.upstream}</code>.
                </small>
              </span>
            </button>
          </div>
        </section>
      ))}

      <div className="vc-tile vc-syncbar">
        {state === 'done' ? (
          <>
            <span className="vc-result-inline vc-tone-good">
              <Icon name="check" /> Synced to {profile.upstreamRevision}.{' '}
              {theme?.resolution === 'keep-local' ? 'theme stays "dark" as an override.' : 'theme override removed.'}
            </span>
            <button className="vc-btn vc-btn-primary" onClick={() => go('changes')}>
              Review changes <Icon name="arrowRight" />
            </button>
          </>
        ) : (
          <>
            <span className="vc-muted">
              {unresolved ? `Resolve ${unresolved} conflict${unresolved > 1 ? 's' : ''} to continue` : 'All conflicts resolved — ready to sync'}
            </span>
            <button className="vc-btn vc-btn-primary" disabled={unresolved > 0 || state === 'syncing'} onClick={() => setState('syncing')}>
              {state === 'syncing' ? (
                <>
                  <span className="vc-spinner vc-spinner-light" /> Syncing…
                </>
              ) : (
                <>
                  <Icon name="refresh" /> Sync {counts.upstreamBehind} commits
                </>
              )}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/* ---------- Machines ---------- */

const revOrder = ['cf264eb', '264dea5', '618c2f0', '77c0d1a', '9be1f40', 'a41d9e2'];

function Machines({ go }: { go: Go }) {
  return (
    <>
      <PageHead
        eyebrow={profile.name}
        title="Machines"
        hint="Every machine using this profile and the revision it last applied."
        actions={
          <button className="vc-btn">
            <Icon name="plus" /> Add machine
          </button>
        }
      />
      <section className="vc-tile">
        <div className="vc-tile-head">
          <h3>Where each machine sits</h3>
          <span className="vc-muted">Head {profile.upstreamRevision}</span>
        </div>
        <RevisionGraph />
      </section>
      <div className="vc-machine-grid">
        {machines.map((m) => {
          const behind = revOrder.length - 1 - revOrder.indexOf(m.appliedRevision);
          const tone = statusMeta[m.status].tone;
          return (
            <article key={m.id} className={`vc-tile vc-machine${m.current ? ' is-current' : ''}`}>
              <div className="vc-machine-top">
                <span className={`vc-glyph vc-glyph-lg vc-tone-${tone}`}>
                  <Icon name={deviceIcon(m)} size={22} />
                </span>
                <Pill tone={tone} dot>
                  {statusMeta[m.status].label}
                </Pill>
              </div>
              <h3>
                {m.name}
                {m.current && <em>this machine</em>}
              </h3>
              <small className="vc-muted">
                {m.os} · {m.arch}
              </small>
              <dl>
                <dt>Revision</dt>
                <dd>
                  <code>{m.appliedRevision}</code> {behind > 0 ? <span className="vc-muted">−{behind}</span> : <span className="vc-tone-good">head</span>}
                </dd>
                <dt>Last seen</dt>
                <dd>{m.lastSeen}</dd>
                <dt>Overrides</dt>
                <dd>{m.overrides}</dd>
                <dt>Targets</dt>
                <dd className="vc-targets">
                  {m.targets.map((t) => (
                    <Target key={t} t={t} />
                  ))}
                </dd>
              </dl>
              {m.current ? (
                <button className="vc-btn vc-btn-primary vc-btn-block" onClick={() => go('changes')}>
                  Review {counts.pendingChanges} changes
                </button>
              ) : m.status === 'drift' ? (
                <button className="vc-btn vc-btn-block">
                  <Icon name="eye" /> Inspect drift
                </button>
              ) : (
                <button className="vc-btn vc-btn-block" disabled={m.status === 'offline'}>
                  {m.status === 'offline' ? 'Unreachable' : 'Up to date'}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

/* ---------- Sharing ---------- */

function Sharing() {
  const [visibility, setVisibility] = useState(profile.visibility);
  const [published, setPublished] = useState(false);
  const [following, setFollowing] = useState(() => new Set(community.filter((p) => p.relation === 'following').map((p) => p.name)));
  const [copied, setCopied] = useState<Set<string>>(new Set());
  const mine = community.find((p) => p.relation === 'mine')!;
  const others = community.filter((p) => p.relation !== 'mine');
  const followers = Object.fromEntries(
    others.map((p) => [p.name, p.followers + (following.has(p.name) ? 1 : 0) - (p.relation === 'following' ? 1 : 0)]),
  ) as Record<string, number>;
  const toggleFollow = (n: string) =>
    setFollowing((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  return (
    <>
      <section className="vc-tile vc-tile-flush vc-profile-hero">
        <div className="vc-banner" />
        <div className="vc-profile-body">
          <span className="vc-profile-avatar">{account.initials}</span>
          <div className="vc-profile-main">
            <div className="vc-profile-title">
              <h1>{mine.name}</h1>
              <Pill tone={visibility === 'public' ? 'good' : 'mute'}>
                <Icon name={visibility === 'public' ? 'globe' : 'lock'} size={12} /> {visibility === 'public' ? 'Public' : 'Private'}
              </Pill>
            </div>
            <p>
              {profile.description} by <b>@{account.handle}</b>
            </p>
            <div className="vc-profile-stats">
              <span>
                <b>{mine.followers}</b> followers
              </span>
              <span>
                <b>{mine.skills}</b> skills
              </span>
              <span>
                <b>{machines.length}</b> machines
              </span>
              <span>
                updated <b>{mine.updated}</b>
              </span>
            </div>
          </div>
          <div className="vc-profile-actions">
            <div className="vc-seg-ctl">
              {(['public', 'private'] as const).map((v) => (
                <button key={v} className={v === visibility ? 'is-active' : ''} onClick={() => setVisibility(v)}>
                  {v === 'public' ? 'Public' : 'Private'}
                </button>
              ))}
            </div>
            <button className="vc-btn vc-btn-primary" disabled={published || visibility === 'private'} onClick={() => setPublished(true)}>
              {published ? (
                <>
                  <Icon name="check" /> Published {profile.revision}
                </>
              ) : (
                <>
                  <Icon name="upload" /> Publish {profile.revision}
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      <div className="vc-section-head">
        <h2>Discover profiles</h2>
        <p>
          <b>Follow</b> to receive updates as they are published. <b>Copy</b> to fork an independent profile you own.
        </p>
      </div>
      <div className="vc-market">
        {others.map((p) => {
          const isFollowing = following.has(p.name);
          const isCopied = copied.has(p.name);
          return (
            <article key={p.name} className="vc-tile vc-card">
              <div className="vc-card-top">
                <span className="vc-card-avatar">{p.owner.slice(0, 2).toUpperCase()}</span>
                <div>
                  <code className="vc-card-name">{p.name}</code>
                  <small>@{p.owner}</small>
                </div>
                {isFollowing && <Pill tone="accent">Following</Pill>}
              </div>
              <p>{p.description}</p>
              <div className="vc-card-stats">
                <span>
                  <Icon name="users" size={13} /> {followers[p.name]!.toLocaleString()}
                </span>
                <span>
                  <Icon name="sparkles" size={13} /> {p.skills} skills
                </span>
                <span>
                  <Icon name="clock" size={13} /> {p.updated}
                </span>
              </div>
              <div className="vc-splitbtn">
                <button className={isFollowing ? 'is-on' : 'is-primary'} onClick={() => toggleFollow(p.name)}>
                  {isFollowing ? (
                    <>
                      <Icon name="check" size={14} /> Following
                    </>
                  ) : (
                    <>
                      <Icon name="star" size={14} /> Follow
                    </>
                  )}
                </button>
                <button disabled={isCopied} onClick={() => setCopied((prev) => new Set(prev).add(p.name))}>
                  {isCopied ? <Icon name="check" size={14} /> : <Icon name="copy" size={14} />}
                  {isCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {isCopied && (
                <small className="vc-card-note">
                  Copied as <code>{account.handle}/{p.name.split('/')[1]}</code> — independent, won’t receive updates.
                </small>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

/* ---------- Root ---------- */

export function VariantC({ screen, go }: VariantProps) {
  return (
    <div className="vc">
      <Topbar screen={screen} go={go} />
      <main className="vc-main" key={screen}>
        {screen === 'dashboard' && <Dashboard go={go} />}
        {screen === 'profile' && <Profile go={go} />}
        {screen === 'skills' && <Skills />}
        {screen === 'integrations' && <Integrations go={go} />}
        {screen === 'changes' && <Changes go={go} />}
        {screen === 'sync' && <Sync go={go} />}
        {screen === 'machines' && <Machines go={go} />}
        {screen === 'sharing' && <Sharing />}
      </main>
    </div>
  );
}
