// PROTOTYPE — Variant A "Console": dark Linear/Vercel-style app shell with a left sidebar,
// slim top bar, ⌘K palette, dense tables and right-side drawers. All state is in memory.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  type PublishedProfile,
  type Screen,
  type Setting,
  type Skill,
  type Source,
} from './data.ts';
import './VariantA.css';

export const name = 'Console';

/* ------------------------------------------------------------------ icons */

type IconProps = { size?: number; className?: string };
const icon = (body: ReactNode) =>
  function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {body}
      </svg>
    );
  };

const IGrid = icon(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>);
const ILayers = icon(<><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>);
const ISparkles = icon(<><path d="M11 3l1.8 4.7 4.7 1.8-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8z" /><path d="M19 14v6M16 17h6" /></>);
const IPlug = icon(<><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></>);
const IDiff = icon(<><path d="M12 3v10" /><path d="M7 8h10" /><path d="M7 19h10" /></>);
const IRefresh = icon(<><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /></>);
const IServer = icon(<><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01" /></>);
const IGlobe = icon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" /></>);
const ISearch = icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
const IChevronRight = icon(<path d="m9 6 6 6-6 6" />);
const IChevrons = icon(<><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></>);
const ICheck = icon(<path d="M20 6 9 17l-5-5" />);
const IX = icon(<path d="M18 6 6 18M6 6l12 12" />);
const IAlert = icon(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>);
const IPlay = icon(<path d="M7 4.5v15l12-7.5z" />);
const IStop = icon(<rect x="6" y="6" width="12" height="12" rx="1.5" />);
const ICommit = icon(<><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>);
const IBranch = icon(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10" /><path d="M18 9a7 7 0 0 1-7 7H8" /></>);
const IArchive = icon(<><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></>);
const IPlus = icon(<path d="M12 5v14M5 12h14" />);
const IMinus = icon(<path d="M5 12h14" />);
const IPencil = icon(<><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></>);
const ICopy = icon(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>);
const IBell = icon(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></>);
const ILock = icon(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
const IClock = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
const IDownload = icon(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>);
const IUpload = icon(<><path d="M12 21V9" /><path d="m7 14 5-5 5 5" /><path d="M5 3h14" /></>);
const IPin = icon(<><path d="M12 17v5" /><path d="M9 3h6l-1 7 4 4H6l4-4z" /></>);
const IShield = icon(<><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></>);
const IArrowRight = icon(<path d="M5 12h14M13 6l6 6-6 6" />);
const IUsers = icon(<><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-4-5.6" /></>);
const ILogo = icon(<><path d="M4 7l8-4 8 4v10l-8 4-8-4z" /><path d="M4 7l8 4 8-4" /><path d="M12 11v10" /></>);
const IMore = icon(<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>);
const ILoader = icon(<path d="M21 12a9 9 0 1 1-6.2-8.6" />);

const screenIcon: Record<Screen, (p: IconProps) => ReactNode> = {
  dashboard: IGrid,
  profile: ILayers,
  skills: ISparkles,
  integrations: IPlug,
  changes: IDiff,
  sync: IRefresh,
  machines: IServer,
  sharing: IGlobe,
};

/** `g` + key jumps to a screen. */
const gKeys: Record<string, Screen> = { o: 'dashboard', p: 'profile', s: 'skills', i: 'integrations', c: 'changes', y: 'sync', m: 'machines', h: 'sharing' };
const gKeyFor = (s: Screen) => Object.entries(gKeys).find(([, v]) => v === s)?.[0].toUpperCase() ?? '';

/* ------------------------------------------------------------------ shared state */

type RunStatus = 'idle' | 'running' | 'completed' | 'cancelled';
const TICKS_PER_STEP = 5;
const totalTicks = applySteps.length * TICKS_PER_STEP;

type Shared = ReturnType<typeof useShared>;

function useShared() {
  // Apply (Changes screen)
  const [applyStatus, setApplyStatus] = useState<RunStatus>('idle');
  const [ticks, setTicks] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const timer = useRef<number | null>(null);

  const stopTimer = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);

  const startApply = () => {
    stopTimer();
    setTicks(0);
    setApplyStatus('running');
    timer.current = window.setInterval(() => {
      setTicks((t) => {
        const next = t + 1;
        if (next >= totalTicks) {
          stopTimer();
          setApplyStatus('completed');
        }
        return Math.min(next, totalTicks);
      });
    }, 220);
  };
  const cancelApply = () => {
    stopTimer();
    setApplyStatus('cancelled');
  };
  const resetApply = () => {
    stopTimer();
    setTicks(0);
    setApplyStatus('idle');
  };

  // Sync
  const [conflicts, setConflicts] = useState<Conflict[]>(initialConflicts);
  const [syncStatus, setSyncStatus] = useState<RunStatus>('idle');
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'running' | 'done'>('idle');

  // Skills: enabled-on-this-machine; differences from the profile default are machine overrides.
  const [skillOn, setSkillOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(skillSources.flatMap((x) => x.skills).map((k) => [k.name, k.status !== 'optional'])),
  );

  // Sharing
  const [relations, setRelations] = useState<Record<string, PublishedProfile['relation']>>(() =>
    Object.fromEntries(community.map((p) => [p.name, p.relation])),
  );
  const [copies, setCopies] = useState<string[]>([]);

  // Toasts
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const applied = applyStatus === 'completed';
  const synced = syncStatus === 'completed';
  const pending = applied ? 0 : changes.length;
  const behind = synced ? 0 : upstream.length;
  const unresolved = conflicts.filter((c) => !c.resolution).length;

  return {
    applyStatus, ticks, skipped, setSkipped, confirmed, setConfirmed, startApply, cancelApply, resetApply,
    conflicts, setConflicts, syncStatus, setSyncStatus, fetchStatus, setFetchStatus,
    skillOn, setSkillOn, relations, setRelations, copies, setCopies,
    toast, setToast, applied, synced, pending, behind, unresolved,
  };
}

/* ------------------------------------------------------------------ root */

export function VariantA({ screen, go }: VariantProps) {
  const st = useShared();
  const [palette, setPalette] = useState(false);
  const gPressed = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') {
        gPressed.current = Date.now();
        return;
      }
      if (Date.now() - gPressed.current < 1000) {
        const target = gKeys[e.key];
        gPressed.current = 0;
        if (target) go(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const meta = screens.find((s) => s.key === screen)!;

  return (
    <div className="va">
      <Sidebar screen={screen} go={go} st={st} />
      <div className="va-main">
        <header className="va-topbar">
          <nav className="va-crumbs" aria-label="Breadcrumb">
            <span className="va-crumb-muted">{profile.name}</span>
            <IChevronRight size={14} className="va-crumb-sep" />
            <span>{meta.label}</span>
          </nav>
          <button className="va-search" onClick={() => setPalette(true)}>
            <ISearch size={14} />
            <span>Search or jump to…</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="va-topbar-right">
            <span className="va-machine-chip" title="This machine">
              <Dot status={st.applied && st.synced ? 'in-sync' : 'behind'} />
              ihor-mbp
              <span className="va-faint">macOS 27.0</span>
            </span>
            <button className="va-btn va-btn-primary" onClick={() => go('changes')} disabled={screen === 'changes'}>
              Review changes
              {st.pending > 0 && <span className="va-btn-count">{st.pending}</span>}
            </button>
          </div>
        </header>
        <main className="va-content">
          {screen === 'dashboard' && <Dashboard go={go} st={st} />}
          {screen === 'profile' && <ProfileScreen st={st} />}
          {screen === 'skills' && <SkillsScreen st={st} />}
          {screen === 'integrations' && <IntegrationsScreen go={go} />}
          {screen === 'changes' && <ChangesScreen st={st} />}
          {screen === 'sync' && <SyncScreen st={st} go={go} />}
          {screen === 'machines' && <MachinesScreen st={st} />}
          {screen === 'sharing' && <SharingScreen st={st} />}
        </main>
      </div>
      {palette && <Palette go={go} close={() => setPalette(false)} />}
      {st.toast && (
        <div className="va-toast" role="status">
          <ICheck size={14} /> {st.toast}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

function Sidebar({ screen, go, st }: VariantProps & { st: Shared }) {
  const groups: { label: string; items: Screen[] }[] = [
    { label: 'Workspace', items: ['dashboard', 'profile', 'skills', 'integrations'] },
    { label: 'Operations', items: ['changes', 'sync', 'machines'] },
    { label: 'Community', items: ['sharing'] },
  ];
  const badge = (s: Screen) => {
    if (s === 'changes' && st.pending) return <span className="va-badge va-badge-accent">{st.pending}</span>;
    if (s === 'sync' && st.behind) return <span className={`va-badge ${st.unresolved ? 'va-badge-amber' : ''}`}>{st.behind}</span>;
    return null;
  };
  return (
    <aside className="va-sidebar">
      <button className="va-switcher" title="Switch profile">
        <span className="va-logo"><ILogo size={14} /></span>
        <span className="va-switcher-text">
          <b>{profile.name}</b>
          <small>{profile.repo}</small>
        </span>
        <IChevrons size={14} className="va-faint" />
      </button>
      <nav className="va-nav">
        {groups.map((g) => (
          <div key={g.label} className="va-nav-group">
            <div className="va-nav-label">{g.label}</div>
            {g.items.map((key) => {
              const s = screens.find((x) => x.key === key)!;
              const Ico = screenIcon[key];
              return (
                <button
                  key={key}
                  className={`va-nav-item ${screen === key ? 'is-active' : ''}`}
                  onClick={() => go(key)}
                  title={`${s.hint} (G then ${gKeyFor(key)})`}
                >
                  <Ico size={15} />
                  <span>{s.label}</span>
                  {badge(key)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="va-sidebar-foot">
        <div className="va-rev">
          <IBranch size={13} />
          <span>{profile.branch}</span>
          <code>{st.synced ? profile.upstreamRevision : profile.revision}</code>
        </div>
        <button className="va-account">
          <span className="va-avatar">{account.initials}</span>
          <span className="va-switcher-text">
            <b>{account.name}</b>
            <small>@{account.handle}</small>
          </span>
          <IMore size={14} className="va-faint" />
        </button>
      </div>
    </aside>
  );
}

function Palette({ go, close }: { go: (s: Screen) => void; close: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const nav = screens.map((s) => ({ id: s.key, label: `Go to ${s.label}`, hint: s.hint, screen: s.key, kbd: `G ${gKeyFor(s.key)}` }));
    const actions = [
      { id: 'apply', label: 'Apply pending changes…', hint: 'Preview, back up and apply', screen: 'changes' as Screen, kbd: '' },
      { id: 'fetch', label: 'Fetch upstream', hint: `${profile.repo}@${profile.branch}`, screen: 'sync' as Screen, kbd: '' },
      { id: 'skill', label: 'Find a skill…', hint: 'Filter installed and missing skills', screen: 'skills' as Screen, kbd: '' },
      { id: 'publish', label: 'Publish profile', hint: 'Share nortus/base publicly', screen: 'sharing' as Screen, kbd: '' },
    ];
    const all = [...nav, ...actions];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((i) => `${i.label} ${i.hint}`.toLowerCase().includes(needle)) : all;
  }, [q]);

  const pick = (i: number) => {
    const item = items[i];
    if (!item) return;
    go(item.screen);
    close();
  };

  return (
    <div className="va-overlay" onMouseDown={close}>
      <div className="va-palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="va-palette-input">
          <ISearch size={15} />
          <input
            autoFocus
            value={q}
            placeholder="Type a command or search…"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') pick(sel);
              else if (e.key === 'Escape') close();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="va-palette-list">
          {items.length === 0 && <div className="va-empty">No results for “{q}”</div>}
          {items.map((item, i) => {
            const Ico = screenIcon[item.screen];
            return (
              <button
                key={item.id}
                className={`va-palette-item ${i === sel ? 'is-sel' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(i)}
              >
                <Ico size={15} />
                <span>{item.label}</span>
                <small>{item.hint}</small>
                {item.kbd && <kbd>{item.kbd}</kbd>}
              </button>
            );
          })}
        </div>
        <div className="va-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>G</kbd> then a letter jumps anywhere</span>
        </div>
      </div>
    </div>
  );
}

function Drawer({ title, sub, onClose, children, footer }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="va-drawer-wrap" onMouseDown={onClose}>
      <aside className="va-drawer" onMouseDown={(e) => e.stopPropagation()} role="dialog">
        <header className="va-drawer-head">
          <div>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          <button className="va-icon-btn" onClick={onClose} aria-label="Close">
            <IX size={15} />
          </button>
        </header>
        <div className="va-drawer-body">{children}</div>
        {footer && <footer className="va-drawer-foot">{footer}</footer>}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ primitives */

const statusLabel: Record<MachineStatus, string> = { 'in-sync': 'In sync', behind: 'Behind', drift: 'Drift', offline: 'Offline' };
function Dot({ status }: { status: MachineStatus }) {
  return <span className={`va-dot va-dot-${status}`} />;
}
function StatusPill({ status }: { status: MachineStatus }) {
  return (
    <span className={`va-status va-status-${status}`}>
      <Dot status={status} />
      {statusLabel[status]}
    </span>
  );
}
function TargetTag({ t }: { t: 'claude' | 'codex' }) {
  return <span className={`va-target va-target-${t}`}>{t}</span>;
}
function SourcePill({ s }: { s: Source }) {
  return <span className={`va-source va-source-${s}`}>{s === 'override' ? 'machine override' : s}</span>;
}
function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string; count?: number }[] }) {
  return (
    <div className="va-tabs" role="tablist">
      {items.map((i) => (
        <button key={i.key} role="tab" aria-selected={value === i.key} className={value === i.key ? 'is-active' : ''} onClick={() => onChange(i.key)}>
          {i.label}
          {i.count !== undefined && <span>{i.count}</span>}
        </button>
      ))}
    </div>
  );
}
function PageHead({ title, sub, actions }: { title: string; sub: ReactNode; actions?: ReactNode }) {
  return (
    <div className="va-pagehead">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      {actions && <div className="va-pagehead-actions">{actions}</div>}
    </div>
  );
}
function Sparkline({ points, tone = 'accent' }: { points: number[]; tone?: 'accent' | 'green' | 'amber' | 'red' }) {
  const w = 72;
  const h = 24;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 2 - ((p - min) / (max - min || 1)) * (h - 4)] as const);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1]!;
  return (
    <svg className={`va-spark va-spark-${tone}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={`${d} L${w},${h} L0,${h} Z`} className="va-spark-fill" />
      <path d={d} className="va-spark-line" />
      <circle cx={last[0]} cy={last[1]} r={2} className="va-spark-dot" />
    </svg>
  );
}

/* ------------------------------------------------------------------ dashboard */

function Dashboard({ go, st }: { go: (s: Screen) => void; st: Shared }) {
  const allSkills = skillSources.flatMap((x) => x.skills);
  const missing = allSkills.filter((k) => k.status === 'missing').length;
  const outdated = allSkills.filter((k) => k.status === 'outdated').length;
  const drifted = settings.filter((x) => show(x.current) !== show(x.desired)).length;
  const bySource = (['base', 'override', 'default'] as Source[]).map((src) => ({ src, n: settings.filter((x) => x.source === src).length }));

  const health = [
    {
      icon: ILayers,
      label: 'Settings',
      ok: st.applied,
      text: st.applied ? `${settings.length} keys match the resolved profile` : `${drifted} of ${settings.length} keys differ from the resolved profile`,
      to: 'profile' as Screen,
    },
    {
      icon: ISparkles,
      label: 'Skills',
      ok: st.applied,
      text: st.applied ? `${allSkills.length - 1} installed, 1 optional` : `${missing} missing · ${outdated} outdated`,
      to: 'skills' as Screen,
    },
    {
      icon: IPlug,
      label: 'Integrations',
      ok: st.applied,
      danger: !st.applied,
      text: st.applied ? 'All plugins, hooks and MCP servers present' : '1 missing MCP server · 1 plugin to remove',
      to: 'integrations' as Screen,
    },
    {
      icon: IRefresh,
      label: 'Upstream',
      ok: st.synced,
      text: st.synced ? `Up to date with ${profile.upstreamRevision}` : `${upstream.length} commits behind · ${st.unresolved} conflict${st.unresolved === 1 ? '' : 's'}`,
      to: 'sync' as Screen,
    },
    {
      icon: IArchive,
      label: 'Backups',
      ok: true,
      text: st.applied ? 'Backup taken just now · 8 kept' : 'Last backup 2026-10-04 22:10 · 7 kept',
      to: 'changes' as Screen,
    },
  ];

  return (
    <div className="va-page">
      <PageHead
        title="Overview"
        sub={
          <>
            <code>{profile.name}</code> at <code>{st.synced ? profile.upstreamRevision : profile.revision}</code>
            {!st.synced && (
              <>
                {' '}· upstream is at <code>{profile.upstreamRevision}</code>
              </>
            )}
          </>
        }
        actions={
          <>
            <button className="va-btn" onClick={() => go('sync')}>
              <IRefresh size={14} /> Sync
            </button>
            <button className="va-btn" onClick={() => go('machines')}>
              <IServer size={14} /> Fleet
            </button>
          </>
        }
      />

      <section className="va-kpis">
        <button className="va-kpi" onClick={() => go('changes')}>
          <div className="va-kpi-label">Pending changes</div>
          <div className="va-kpi-row">
            <div className="va-kpi-value">{st.pending}</div>
            <Sparkline points={st.applied ? [4, 6, 3, 5, 8, 2, 0] : [2, 4, 3, 5, 3, 6, 8]} />
          </div>
          <div className="va-kpi-foot">
            {st.applied ? (
              <span className="va-green">Applied just now</span>
            ) : (
              <>
                <span className="va-red"><IAlert size={12} /> {counts.destructive} destructive</span>
                <span className="va-faint">+2 since yesterday</span>
              </>
            )}
          </div>
        </button>
        <button className="va-kpi" onClick={() => go('profile')}>
          <div className="va-kpi-label">Machine overrides</div>
          <div className="va-kpi-row">
            <div className="va-kpi-value">{counts.overrides}</div>
            <Sparkline points={[1, 1, 2, 2, 2, 3, 3]} tone="amber" />
          </div>
          <div className="va-kpi-foot">
            <span className="va-amber">+1 this week</span>
            <span className="va-faint">of {settings.length} keys</span>
          </div>
        </button>
        <button className="va-kpi" onClick={() => go('skills')}>
          <div className="va-kpi-label">Skills installed</div>
          <div className="va-kpi-row">
            <div className="va-kpi-value">
              {st.applied ? counts.skillsTotal - 1 : counts.skillsInstalled}
              <span className="va-kpi-of">/{counts.skillsTotal}</span>
            </div>
          </div>
          <div className="va-meter">
            <span style={{ width: `${((st.applied ? counts.skillsTotal - 1 : counts.skillsInstalled) / counts.skillsTotal) * 100}%` }} />
          </div>
          <div className="va-kpi-foot">
            <span className="va-faint">{skillSources.length} sources · 1 optional</span>
          </div>
        </button>
        <button className="va-kpi" onClick={() => go('sync')}>
          <div className="va-kpi-label">Upstream behind</div>
          <div className="va-kpi-row">
            <div className="va-kpi-value">
              {st.behind}
              <span className="va-kpi-of"> commits</span>
            </div>
            <Sparkline points={st.synced ? [1, 2, 1, 3, 1, 0, 0] : [0, 1, 0, 1, 2, 2, 3]} tone="green" />
          </div>
          <div className="va-kpi-foot">
            {st.unresolved && !st.synced ? <span className="va-amber">{st.unresolved} conflict with an override</span> : <span className="va-green">No conflicts</span>}
          </div>
        </button>
      </section>

      <div className="va-dash-grid">
        <div className="va-col">
          <section className="va-panel">
            <header className="va-panel-head">
              <div className="va-panel-title">
                <IShield size={15} />
                This machine
                <span className="va-mono va-faint">ihor-mbp · arm64</span>
              </div>
              <StatusPill status={st.applied && st.synced ? 'in-sync' : 'behind'} />
            </header>
            <div className="va-health">
              {health.map((h) => (
                <button key={h.label} className="va-health-row" onClick={() => go(h.to)}>
                  <span className={`va-health-icon ${h.ok ? 'is-ok' : h.danger ? 'is-danger' : 'is-warn'}`}>
                    {h.ok ? <ICheck size={13} /> : <IAlert size={13} />}
                  </span>
                  <h.icon size={14} className="va-faint" />
                  <span className="va-health-label">{h.label}</span>
                  <span className="va-health-text">{h.text}</span>
                  <IChevronRight size={14} className="va-faint va-health-go" />
                </button>
              ))}
            </div>
            <div className="va-panel-sub">
              <div className="va-sourcebar-label">
                <span>Resolved settings by source</span>
                <span className="va-faint">{settings.length} keys</span>
              </div>
              <div className="va-sourcebar">
                {bySource.map((b) => (
                  <span key={b.src} className={`va-sourcebar-${b.src}`} style={{ flex: b.n }} title={`${b.src}: ${b.n}`} />
                ))}
              </div>
              <div className="va-legend">
                {bySource.map((b) => (
                  <span key={b.src}>
                    <i className={`va-sourcebar-${b.src}`} /> {b.src === 'override' ? 'Machine override' : b.src[0]!.toUpperCase() + b.src.slice(1)} <b>{b.n}</b>
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="va-panel">
            <header className="va-panel-head">
              <div className="va-panel-title">
                <IServer size={15} />
                Fleet
                <span className="va-faint">{machines.length} machines</span>
              </div>
              <button className="va-link" onClick={() => go('machines')}>
                View all <IArrowRight size={13} />
              </button>
            </header>
            <FleetTable rows={machines} st={st} onRow={() => go('machines')} compact />
          </section>
        </div>

        <div className="va-col">
          <section className="va-panel">
            <header className="va-panel-head">
              <div className="va-panel-title">
                <IClock size={15} />
                Activity
              </div>
              <span className="va-faint va-small">Today</span>
            </header>
            <ActivityFeed items={activity} st={st} />
          </section>

          <section className="va-panel">
            <header className="va-panel-head">
              <div className="va-panel-title">
                <IBranch size={15} />
                Upstream
              </div>
              <button className="va-link" onClick={() => go('sync')}>
                Review <IArrowRight size={13} />
              </button>
            </header>
            {st.synced ? (
              <div className="va-empty">
                <ICheck size={14} /> Up to date with <code>{profile.upstreamRevision}</code>
              </div>
            ) : (
              <ul className="va-commits">
                {upstream.map((c) => (
                  <li key={c.sha}>
                    <code>{c.sha.slice(0, 7)}</code>
                    <span className="va-ellipsis">{c.message}</span>
                    {c.touches.includes('theme') && <span className="va-chip va-chip-amber" title="Touches an override">conflict</span>}
                    <span className="va-faint va-small">{c.when}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const activityIcon: Record<Activity['kind'], (p: IconProps) => ReactNode> = {
  apply: IDownload,
  sync: IRefresh,
  override: IPencil,
  publish: IUpload,
  drift: IAlert,
};

function ActivityFeed({ items, st }: { items: Activity[]; st: Shared }) {
  const extra: Activity[] = [];
  if (st.synced) extra.push({ id: 'live-sync', when: 'Now', who: 'ihor-mbp', text: `Synced to ${profile.upstreamRevision}`, kind: 'sync' });
  if (st.applied) extra.push({ id: 'live-apply', when: 'Now', who: 'ihor-mbp', text: `Applied ${changes.length - st.skipped.size} changes`, kind: 'apply' });
  return (
    <ol className="va-feed">
      {[...extra, ...items].map((a) => {
        const Ico = activityIcon[a.kind];
        return (
          <li key={a.id} className={`va-feed-${a.kind}`}>
            <span className="va-feed-icon">
              <Ico size={12} />
            </span>
            <div>
              <div className="va-feed-text">
                <b>{a.who}</b> {a.text}
              </div>
              <div className="va-faint va-small">{a.when}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function liveMachine(m: Machine, st: Shared): Machine {
  if (!m.current) return m;
  if (st.applied && st.synced) return { ...m, status: 'in-sync', appliedRevision: profile.upstreamRevision };
  return m;
}

function FleetTable({ rows, st, onRow, compact }: { rows: Machine[]; st: Shared; onRow: (m: Machine) => void; compact?: boolean }) {
  return (
    <table className="va-table">
      <thead>
        <tr>
          <th>Machine</th>
          <th>Status</th>
          <th>Revision</th>
          {!compact && <th>OS</th>}
          <th className="va-num">Overrides</th>
          <th>Targets</th>
          <th className="va-right">Last seen</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((raw) => {
          const m = liveMachine(raw, st);
          return (
            <tr key={m.id} onClick={() => onRow(m)} className="is-click">
              <td>
                <span className="va-machine-name">
                  <IServer size={14} className="va-faint" />
                  {m.name}
                  {m.current && <span className="va-chip">this machine</span>}
                </span>
              </td>
              <td><StatusPill status={m.status} /></td>
              <td>
                <code className={m.appliedRevision === profile.upstreamRevision ? '' : 'va-faint'}>{m.appliedRevision}</code>
              </td>
              {!compact && <td className="va-muted">{m.os} · {m.arch}</td>}
              <td className="va-num">{m.overrides}</td>
              <td>
                <span className="va-targets">{m.targets.map((t) => <TargetTag key={t} t={t} />)}</span>
              </td>
              <td className="va-right va-muted">{m.lastSeen}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ profile */

type ProfileTab = 'all' | 'override' | 'changing' | 'claude' | 'codex';

function ProfileScreen({ st }: { st: Shared }) {
  const [tab, setTab] = useState<ProfileTab>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Setting | null>(null);
  const changing = (x: Setting) => !st.applied && show(x.current) !== show(x.desired);
  const rows = settings.filter((x) => {
    if (q && !x.key.toLowerCase().includes(q.toLowerCase())) return false;
    if (tab === 'override') return x.source === 'override';
    if (tab === 'changing') return changing(x);
    if (tab === 'claude' || tab === 'codex') return x.target === tab;
    return true;
  });

  return (
    <div className="va-page">
      <PageHead
        title="Profile"
        sub="Resolved settings for this machine, and the layer each value comes from."
        actions={
          <button className="va-btn" onClick={() => st.setToast('Opened profile repo in editor')}>
            <IPencil size={14} /> Edit in repo
          </button>
        }
      />

      <section className="va-profile-card">
        <div className="va-profile-id">
          <span className="va-logo va-logo-lg"><ILogo size={18} /></span>
          <div>
            <b>{profile.name}</b>
            <p>{profile.description}</p>
          </div>
        </div>
        <dl className="va-meta">
          <div><dt>Repository</dt><dd><code>{profile.repo}</code></dd></div>
          <div><dt>Branch</dt><dd><code>{profile.branch}</code></dd></div>
          <div><dt>Revision</dt><dd><code>{st.synced ? profile.upstreamRevision : profile.revision}</code></dd></div>
          <div><dt>Visibility</dt><dd>{profile.visibility === 'public' ? <><IGlobe size={12} /> Public</> : <><ILock size={12} /> Private</>}</dd></div>
        </dl>
        <div className="va-layers" aria-label="Resolution order">
          <span className="va-source va-source-default">default</span>
          <IChevronRight size={12} className="va-faint" />
          <span className="va-source va-source-base">base</span>
          <IChevronRight size={12} className="va-faint" />
          <span className="va-source va-source-override">machine override</span>
          <IChevronRight size={12} className="va-faint" />
          <span className="va-source va-source-resolved">resolved</span>
        </div>
      </section>

      <div className="va-toolbar">
        <Tabs<ProfileTab>
          value={tab}
          onChange={setTab}
          items={[
            { key: 'all', label: 'All', count: settings.length },
            { key: 'override', label: 'Overrides', count: settings.filter((x) => x.source === 'override').length },
            { key: 'changing', label: 'Will change', count: settings.filter(changing).length },
            { key: 'claude', label: 'Claude' },
            { key: 'codex', label: 'Codex' },
          ]}
        />
        <label className="va-filter">
          <ISearch size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter keys" />
        </label>
      </div>

      <section className="va-panel va-panel-flush">
        <table className="va-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Target</th>
              <th>Resolved</th>
              <th>On disk</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.target}.${x.key}`} className="is-click" onClick={() => setOpen(x)}>
                <td><code className="va-key">{x.key}</code></td>
                <td><TargetTag t={x.target} /></td>
                <td><code className="va-val">{show(x.desired)}</code></td>
                <td>
                  {changing(x) ? (
                    <span className="va-drift"><code className="va-val va-val-old">{show(x.current)}</code><span className="va-chip va-chip-amber">will change</span></span>
                  ) : (
                    <span className="va-faint va-small"><ICheck size={12} /> matches</span>
                  )}
                </td>
                <td><SourcePill s={x.source} /></td>
                <td className="va-right"><IChevronRight size={14} className="va-faint" /></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6}><div className="va-empty">No keys match this filter.</div></td></tr>
            )}
          </tbody>
        </table>
      </section>

      {open && (
        <Drawer
          title={<code>{open.key}</code>}
          sub={<><TargetTag t={open.target} /> resolved from <SourcePill s={open.source} /></>}
          onClose={() => setOpen(null)}
          footer={
            <>
              <button className="va-btn" onClick={() => setOpen(null)}>Close</button>
              <button className="va-btn" onClick={() => { st.setToast(open.override !== null ? `Override on ${open.key} marked for removal` : `Override drafted for ${open.key}`); setOpen(null); }}>
                {open.override !== null ? 'Remove override' : 'Override on this machine'}
              </button>
            </>
          }
        >
          <h3 className="va-drawer-h">Provenance</h3>
          <ol className="va-chain">
            <ChainStep label="Default" sub="Built-in value of the agent" value={open.source === 'default' ? show(open.desired) : null} active={open.source === 'default'} />
            <ChainStep label="Base profile" sub={`${profile.repo} · settings.keys.json`} value={open.base === null ? null : show(open.base)} active={open.source === 'base'} overridden={open.source === 'override'} />
            <ChainStep label="Machine override" sub="ihor-mbp · overrides.json" value={open.override === null ? null : show(open.override)} active={open.source === 'override'} />
            <ChainStep label="Resolved" sub="What nortuscc will write" value={show(open.desired)} resolved />
          </ol>
          <h3 className="va-drawer-h">On this machine</h3>
          <div className="va-ondisk">
            <div>
              <span className="va-faint va-small">~/.{open.target === 'claude' ? 'claude/settings.json' : 'codex/config.toml'}</span>
              <code className="va-val">{show(open.current)}</code>
            </div>
            {changing(open) ? (
              <span className="va-chip va-chip-amber">Next apply writes {show(open.desired)}</span>
            ) : (
              <span className="va-chip va-chip-green"><ICheck size={11} /> In agreement</span>
            )}
          </div>
          {open.note && <p className="va-note">{open.note}</p>}
        </Drawer>
      )}
    </div>
  );
}

function ChainStep({ label, sub, value, active, overridden, resolved }: { label: string; sub: string; value: string | null; active?: boolean; overridden?: boolean; resolved?: boolean }) {
  return (
    <li className={`va-chain-step ${active ? 'is-active' : ''} ${resolved ? 'is-resolved' : ''} ${value === null ? 'is-empty' : ''}`}>
      <span className="va-chain-node" />
      <div className="va-chain-body">
        <div className="va-chain-top">
          <b>{label}</b>
          {active && <span className="va-chip va-chip-accent">wins</span>}
          {overridden && <span className="va-chip">overridden</span>}
        </div>
        <small className="va-faint">{sub}</small>
      </div>
      <code className={`va-val ${overridden ? 'va-val-old' : ''}`}>{value ?? 'not set'}</code>
    </li>
  );
}

/* ------------------------------------------------------------------ skills */

type SkillTab = 'all' | Skill['status'];

function SkillsScreen({ st }: { st: Shared }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<SkillTab>('all');
  const all = skillSources.flatMap((x) => x.skills);
  const countOf = (s: Skill['status']) => all.filter((k) => k.status === s).length;
  const match = (k: Skill) =>
    (tab === 'all' || k.status === tab) && (!q || `${k.name} ${k.description} ${k.source}`.toLowerCase().includes(q.toLowerCase()));
  const groups = skillSources.map((g) => ({ ...g, skills: g.skills.filter(match) })).filter((g) => g.skills.length);
  const overrides = all.filter((k) => st.skillOn[k.name] !== (k.status !== 'optional')).length;

  return (
    <div className="va-page">
      <PageHead
        title="Skills"
        sub={<>{counts.skillsInstalled} of {counts.skillsTotal} installed from {skillSources.length} source repos{overrides > 0 && <> · <span className="va-amber">{overrides} toggled on this machine</span></>}</>}
        actions={
          <button className="va-btn" onClick={() => st.setToast('Checked 5 sources — 1 update available')}>
            <IRefresh size={14} /> Check for updates
          </button>
        }
      />
      <div className="va-toolbar">
        <Tabs<SkillTab>
          value={tab}
          onChange={setTab}
          items={[
            { key: 'all', label: 'All', count: all.length },
            { key: 'installed', label: 'Installed', count: countOf('installed') },
            { key: 'missing', label: 'Missing', count: countOf('missing') },
            { key: 'outdated', label: 'Outdated', count: countOf('outdated') },
            { key: 'optional', label: 'Optional', count: countOf('optional') },
          ]}
        />
        <label className="va-filter">
          <ISearch size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills" />
          {q && <button className="va-filter-clear" onClick={() => setQ('')} aria-label="Clear"><IX size={12} /></button>}
        </label>
      </div>

      {groups.length === 0 && (
        <section className="va-panel"><div className="va-empty">No skills match “{q}”.</div></section>
      )}
      {groups.map((g) => (
        <section key={g.repo} className="va-panel va-panel-flush">
          <header className="va-group-head">
            <IBranch size={14} className="va-faint" />
            <code>{g.repo}</code>
            <span className="va-chip" title="Manifest mode">{g.mode === 'all' ? 'all skills' : g.mode === 'exact' ? 'exact list' : 'opt-in'}</span>
            <span className="va-faint va-small va-push">{g.skills.length} shown</span>
          </header>
          <ul className="va-rows">
            {g.skills.map((k) => {
              const on = st.skillOn[k.name] ?? false;
              const isOverride = on !== (k.status !== 'optional');
              return (
                <li key={k.name} className={`va-row ${on ? '' : 'is-off'}`}>
                  <div className="va-row-main">
                    <div className="va-row-title">
                      <code>{k.name}</code>
                      {k.pinned && <span className="va-chip" title="Pinned"><IPin size={11} /> {k.pinned}</span>}
                      {isOverride && <span className="va-source va-source-override">machine override</span>}
                    </div>
                    <div className="va-muted va-small">{k.description}</div>
                  </div>
                  <SkillStatus status={k.status} on={on} />
                  <button
                    role="switch"
                    aria-checked={on}
                    aria-label={`${on ? 'Disable' : 'Enable'} ${k.name}`}
                    className={`va-switch ${on ? 'is-on' : ''}`}
                    onClick={() => st.setSkillOn((s) => ({ ...s, [k.name]: !on }))}
                  >
                    <span />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SkillStatus({ status, on }: { status: Skill['status']; on: boolean }) {
  if (!on) return <span className="va-skill-status va-faint">disabled</span>;
  const map: Record<Skill['status'], [string, string]> = {
    installed: ['va-green', 'installed'],
    missing: ['va-amber', 'will install'],
    outdated: ['va-amber', 'update available'],
    optional: ['va-accent', 'will install'],
  };
  const [cls, label] = map[status];
  return <span className={`va-skill-status ${cls}`}><i />{label}</span>;
}

/* ------------------------------------------------------------------ integrations */

type KindTab = 'all' | IntegrationKind;
const kindLabel: Record<IntegrationKind, string> = { plugin: 'Plugin', marketplace: 'Marketplace', hook: 'Hook', mcp: 'MCP server' };
const intStatus: Record<IntegrationStatus, [string, string]> = {
  installed: ['va-green', 'Installed'],
  missing: ['va-amber', 'Will install'],
  'allowed-extra': ['va-muted', 'Allowed extra'],
  drift: ['va-red', 'Will remove'],
};

function IntegrationsScreen({ go }: { go: (s: Screen) => void }) {
  const [tab, setTab] = useState<KindTab>('all');
  const rows = integrations.filter((i) => tab === 'all' || i.kind === tab);
  const n = (k: IntegrationKind) => integrations.filter((i) => i.kind === k).length;
  return (
    <div className="va-page">
      <PageHead
        title="Integrations"
        sub={<>Declared in <code>integrations.json</code>. Environment variables are named here; their values stay on each machine.</>}
      />
      <div className="va-toolbar">
        <Tabs<KindTab>
          value={tab}
          onChange={setTab}
          items={[
            { key: 'all', label: 'All', count: integrations.length },
            { key: 'plugin', label: 'Plugins', count: n('plugin') },
            { key: 'marketplace', label: 'Marketplaces', count: n('marketplace') },
            { key: 'hook', label: 'Hooks', count: n('hook') },
            { key: 'mcp', label: 'MCP', count: n('mcp') },
          ]}
        />
      </div>
      <section className="va-panel va-panel-flush">
        <table className="va-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Target</th>
              <th>Detail</th>
              <th>Environment</th>
              <th className="va-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const [cls, label] = intStatus[i.status];
              return (
                <tr key={i.id} className={i.status === 'drift' ? 'is-danger' : ''}>
                  <td><b className="va-strong">{i.label}</b></td>
                  <td className="va-muted">{kindLabel[i.kind]}</td>
                  <td><TargetTag t={i.target} /></td>
                  <td className="va-muted va-detail">{i.detail}</td>
                  <td>
                    {i.env ? i.env.map((e) => <span key={e} className="va-chip va-chip-mono"><ILock size={11} /> {e}</span>) : <span className="va-faint">—</span>}
                  </td>
                  <td className="va-right">
                    {i.status === 'drift' || i.status === 'missing' ? (
                      <button className={`va-status-link ${cls}`} onClick={() => go('changes')}>
                        {i.status === 'drift' && <IAlert size={12} />}
                        {label}
                        <IArrowRight size={12} />
                      </button>
                    ) : (
                      <span className={`va-skill-status ${cls}`}><i />{label}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className="va-footnote">
        <b>Allowed extras</b> are present on this machine on purpose and are never installed or removed. Anything else not in the profile is
        reported as drift and removed on apply, after confirmation.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ changes */

type AreaTab = 'all' | Change['area'];

function ChangesScreen({ st }: { st: Shared }) {
  const [tab, setTab] = useState<AreaTab>('all');
  const running = st.applyStatus === 'running';
  const locked = running || st.applyStatus === 'completed';
  const included = changes.filter((c) => !st.skipped.has(c.id));
  const needConfirm = included.filter((c) => c.destructive && !st.confirmed.has(c.id));
  const rows = changes.filter((c) => tab === 'all' || c.area === tab);
  const stepIndex = Math.min(Math.floor(st.ticks / TICKS_PER_STEP), applySteps.length);
  const pct = Math.round((st.ticks / totalTicks) * 100);
  const n = (a: Change['area']) => changes.filter((c) => c.area === a).length;

  const toggleSet = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  return (
    <div className="va-page">
      <PageHead
        title="Changes"
        sub={
          st.applyStatus === 'completed' ? (
            <>Applied {included.length} changes to <b>ihor-mbp</b>. Backup kept at <code>~/.claude/backups/2026-10-05T19-02</code>.</>
          ) : (
            <>{changes.length} changes between the resolved profile and <b>ihor-mbp</b>. Nothing is written until you apply.</>
          )
        }
      />

      <div className="va-changes-grid">
        <div className="va-col">
          <div className="va-toolbar">
            <Tabs<AreaTab>
              value={tab}
              onChange={setTab}
              items={[
                { key: 'all', label: 'All', count: changes.length },
                { key: 'setting', label: 'Settings', count: n('setting') },
                { key: 'skill', label: 'Skills', count: n('skill') },
                { key: 'integration', label: 'Integrations', count: n('integration') },
              ]}
            />
            <span className="va-legend-inline">
              <span className="va-green"><IPlus size={12} /> add</span>
              <span className="va-amber"><IPencil size={12} /> modify</span>
              <span className="va-red"><IMinus size={12} /> remove</span>
            </span>
          </div>
          <section className="va-panel va-panel-flush">
            <ul className="va-changes">
              {rows.map((c) => {
                const skip = st.skipped.has(c.id);
                const ok = st.confirmed.has(c.id);
                const done = st.applyStatus === 'completed' && !skip;
                return (
                  <li key={c.id} className={`va-change va-change-${c.kind} ${skip ? 'is-skipped' : ''} ${c.destructive ? 'is-destructive' : ''}`}>
                    <div className="va-change-row">
                      <input
                        type="checkbox"
                        className="va-check"
                        checked={!skip}
                        disabled={locked}
                        onChange={() => st.setSkipped((s) => toggleSet(s, c.id))}
                        aria-label={`Include ${c.path}`}
                      />
                      <span className="va-change-kind">{c.kind === 'add' ? <IPlus size={13} /> : c.kind === 'remove' ? <IMinus size={13} /> : <IPencil size={12} />}</span>
                      <code className="va-change-path">{c.path}</code>
                      <span className="va-faint va-small">{c.area}</span>
                      <TargetTag t={c.target} />
                      <span className="va-push" />
                      {done && <span className="va-chip va-chip-green"><ICheck size={11} /> applied</span>}
                      {skip && <span className="va-chip">skipped</span>}
                      {c.destructive && !skip && !done && <span className="va-chip va-chip-red"><IAlert size={11} /> destructive</span>}
                    </div>
                    {(c.before || c.after) && (
                      <div className="va-diff">
                        {c.before && <div className="va-diff-del"><span>-</span>{c.before}</div>}
                        {c.after && <div className="va-diff-add"><span>+</span>{c.after}</div>}
                      </div>
                    )}
                    {c.destructive && !skip && !done && (
                      <div className="va-danger-box">
                        <p>
                          <b>Removes the context-mode plugin from ~/.claude.</b> It was dropped from the profile on 2026-08-20 but is still installed here. A backup is
                          taken first, but any local plugin data is deleted.
                        </p>
                        <label className="va-confirm">
                          <input type="checkbox" className="va-check" checked={ok} disabled={locked} onChange={() => st.setConfirmed((s) => toggleSet(s, c.id))} />
                          I understand — remove <code>context-mode</code> on apply
                        </label>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <aside className="va-col">
          <section className={`va-panel va-apply va-apply-${st.applyStatus}`}>
            <header className="va-panel-head">
              <div className="va-panel-title">
                <IDownload size={15} />
                Apply to ihor-mbp
              </div>
              <span className={`va-runstate va-runstate-${st.applyStatus}`}>{st.applyStatus}</span>
            </header>
            <div className="va-apply-sum">
              <div><span className="va-faint">Included</span><b>{included.length}</b></div>
              <div><span className="va-faint">Skipped</span><b>{st.skipped.size}</b></div>
              <div><span className="va-faint">Destructive</span><b className={included.some((c) => c.destructive) ? 'va-red' : ''}>{included.filter((c) => c.destructive).length}</b></div>
            </div>
            {st.applyStatus !== 'idle' && (
              <div className="va-progress">
                <div className="va-progress-bar"><span style={{ width: `${pct}%` }} /></div>
                <span className="va-mono va-small">{pct}%</span>
              </div>
            )}
            <ol className="va-steps">
              {applySteps.map((s, i) => {
                const state =
                  st.applyStatus === 'idle' ? 'todo'
                  : i < stepIndex ? 'done'
                  : i === stepIndex && running ? 'active'
                  : i === stepIndex && st.applyStatus === 'cancelled' ? 'stopped'
                  : 'todo';
                return (
                  <li key={s} className={`va-step is-${state}`}>
                    <span className="va-step-icon">
                      {state === 'done' ? <ICheck size={12} /> : state === 'active' ? <ILoader size={12} className="va-spin" /> : state === 'stopped' ? <IX size={12} /> : <span className="va-step-n">{i + 1}</span>}
                    </span>
                    <span>{s}</span>
                  </li>
                );
              })}
            </ol>
            {st.applyStatus === 'cancelled' && (
              <p className="va-note va-note-amber">
                Cancelled during “{applySteps[stepIndex] ?? applySteps[applySteps.length - 1]}”. {stepIndex > 0 ? 'Steps already finished stay applied; the backup can restore them.' : 'Nothing was written.'}
              </p>
            )}
            {st.applyStatus === 'completed' && <p className="va-note va-note-green">All steps finished and verified.</p>}
            {needConfirm.length > 0 && st.applyStatus !== 'completed' && (
              <p className="va-note va-note-red">
                <IAlert size={13} /> Confirm or skip {needConfirm.length} destructive change before applying.
              </p>
            )}
            <div className="va-apply-actions">
              {running ? (
                <button className="va-btn va-btn-danger-ghost va-grow" onClick={st.cancelApply}>
                  <IStop size={13} /> Cancel apply
                </button>
              ) : st.applyStatus === 'completed' ? (
                <button className="va-btn va-grow" onClick={st.resetApply}>Done</button>
              ) : (
                <button className="va-btn va-btn-primary va-grow" disabled={needConfirm.length > 0 || included.length === 0} onClick={st.startApply}>
                  <IPlay size={13} /> {st.applyStatus === 'cancelled' ? 'Retry apply' : `Apply ${included.length} changes`}
                </button>
              )}
            </div>
            <p className="va-faint va-small va-apply-hint">
              <IArchive size={12} /> Backs up <code>~/.claude</code> and <code>~/.codex</code> first.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sync */

function SyncScreen({ st, go }: { st: Shared; go: (s: Screen) => void }) {
  const running = st.syncStatus === 'running';
  const done = st.syncStatus === 'completed';
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const resolve = (key: string, resolution: Conflict['resolution']) =>
    st.setConflicts((cs) => cs.map((c) => (c.key === key ? { ...c, resolution } : c)));

  const runSync = () => {
    st.setSyncStatus('running');
    timer.current = window.setTimeout(() => {
      st.setSyncStatus('completed');
      st.setToast(`Synced to ${profile.upstreamRevision}`);
    }, 1600);
  };
  const fetchNow = () => {
    st.setFetchStatus('running');
    timer.current = window.setTimeout(() => st.setFetchStatus('done'), 900);
  };

  return (
    <div className="va-page">
      <PageHead
        title="Sync"
        sub={<>Bring upstream changes from <code>{profile.repo}@{profile.branch}</code> into this machine. Local overrides are never overwritten silently.</>}
        actions={
          <button className="va-btn" onClick={fetchNow} disabled={st.fetchStatus === 'running' || running}>
            {st.fetchStatus === 'running' ? <ILoader size={14} className="va-spin" /> : <IDownload size={14} />}
            {st.fetchStatus === 'running' ? 'Fetching…' : 'Fetch'}
          </button>
        }
      />

      <section className="va-syncbar">
        <div className="va-syncbar-node">
          <span className="va-faint va-small">This machine</span>
          <code>{done ? profile.upstreamRevision : profile.revision}</code>
        </div>
        <div className="va-syncbar-line">
          <span>{done ? 'up to date' : `${upstream.length} commits behind`}</span>
        </div>
        <div className="va-syncbar-node">
          <span className="va-faint va-small">origin/{profile.branch}</span>
          <code>{profile.upstreamRevision}</code>
        </div>
        <span className="va-faint va-small va-push">
          <IClock size={12} /> {st.fetchStatus === 'done' ? 'Fetched just now' : 'Fetched 4 min ago'}
        </span>
      </section>

      <div className="va-changes-grid">
        <div className="va-col">
          <section className="va-panel va-panel-flush">
            <header className="va-panel-head va-panel-head-pad">
              <div className="va-panel-title"><ICommit size={15} /> Incoming commits</div>
              <span className="va-faint va-small">{upstream.length}</span>
            </header>
            <table className="va-table">
              <tbody>
                {upstream.map((c) => (
                  <tr key={c.sha}>
                    <td style={{ width: 80 }}><code>{c.sha}</code></td>
                    <td className="va-strong">{c.message}</td>
                    <td>{c.touches.map((t) => <span key={t} className={`va-chip ${t === 'theme' ? 'va-chip-amber' : ''}`}>{t}</span>)}</td>
                    <td className="va-muted">{c.author}</td>
                    <td className="va-right va-muted">{c.when}</td>
                    <td style={{ width: 70 }}>{done && <span className="va-chip va-chip-green"><ICheck size={11} /> merged</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <h2 className="va-section-h">
            Conflicts with local overrides
            <span className={`va-badge ${st.unresolved ? 'va-badge-amber' : 'va-badge-green'}`}>{st.unresolved ? `${st.unresolved} unresolved` : 'all resolved'}</span>
          </h2>
          {st.conflicts.map((c) => (
            <section key={c.key} className={`va-panel va-conflict ${c.resolution ? 'is-resolved' : ''}`}>
              <header className="va-conflict-head">
                {c.resolution ? <ICheck size={14} className="va-green" /> : <IAlert size={14} className="va-amber" />}
                <code className="va-key">{c.key}</code>
                <span className="va-muted va-small">Upstream changed a key you override on this machine.</span>
              </header>
              <div className="va-three">
                <div className="va-three-col">
                  <span className="va-faint va-small">Base (before)</span>
                  <code className="va-val va-val-old">{c.base}</code>
                </div>
                <button
                  className={`va-three-col va-choice ${c.resolution === 'take-upstream' ? 'is-picked' : ''}`}
                  disabled={running || done}
                  onClick={() => resolve(c.key, 'take-upstream')}
                >
                  <span className="va-faint va-small">Upstream · a41d9e2</span>
                  <code className="va-val">{c.upstream}</code>
                  <span className="va-choice-label">{c.resolution === 'take-upstream' ? <><ICheck size={12} /> Taking upstream</> : 'Take upstream'}</span>
                </button>
                <button
                  className={`va-three-col va-choice ${c.resolution === 'keep-local' ? 'is-picked' : ''}`}
                  disabled={running || done}
                  onClick={() => resolve(c.key, 'keep-local')}
                >
                  <span className="va-faint va-small">Your override · ihor-mbp</span>
                  <code className="va-val">{c.local}</code>
                  <span className="va-choice-label">{c.resolution === 'keep-local' ? <><ICheck size={12} /> Keeping local</> : 'Keep local'}</span>
                </button>
              </div>
              {c.resolution === 'take-upstream' && <p className="va-note va-note-amber">Your override for <code>{c.key}</code> will be removed and the upstream value used.</p>}
            </section>
          ))}
        </div>

        <aside className="va-col">
          <section className="va-panel">
            <header className="va-panel-head">
              <div className="va-panel-title"><IRefresh size={15} /> Sync plan</div>
              <span className={`va-runstate va-runstate-${st.syncStatus}`}>{st.syncStatus}</span>
            </header>
            <ul className="va-plan">
              <li><ICheck size={13} className="va-green" /> Fast-forward {profile.revision} → {profile.upstreamRevision}</li>
              <li>
                {st.unresolved ? <IAlert size={13} className="va-amber" /> : <ICheck size={13} className="va-green" />}
                {st.conflicts.map((c) => (c.resolution ? `${c.key}: ${c.resolution === 'keep-local' ? 'keep local' : 'take upstream'}` : `${c.key}: needs a decision`)).join(', ')}
              </li>
              <li><IDiff size={13} className="va-faint" /> Changes are previewed before apply</li>
            </ul>
            {running && <div className="va-progress"><div className="va-progress-bar is-indeterminate"><span /></div></div>}
            {done ? (
              <>
                <p className="va-note va-note-green">Now at <code>{profile.upstreamRevision}</code>. Review the resulting changes before applying.</p>
                <button className="va-btn va-btn-primary va-grow" onClick={() => go('changes')}>Review changes <IArrowRight size={13} /></button>
              </>
            ) : (
              <>
                {st.unresolved > 0 && <p className="va-note va-note-amber">Resolve every conflict to enable sync.</p>}
                <button className="va-btn va-btn-primary va-grow" disabled={st.unresolved > 0 || running} onClick={runSync}>
                  {running ? <><ILoader size={13} className="va-spin" /> Syncing…</> : <>Sync {upstream.length} commits</>}
                </button>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ machines */

type MachineTab = 'all' | MachineStatus;

function MachinesScreen({ st }: { st: Shared }) {
  const [tab, setTab] = useState<MachineTab>('all');
  const [open, setOpen] = useState<Machine | null>(null);
  const live = machines.map((m) => liveMachine(m, st));
  const rows = live.filter((m) => tab === 'all' || m.status === tab);
  const n = (s: MachineStatus) => live.filter((m) => m.status === s).length;
  return (
    <div className="va-page">
      <PageHead
        title="Machines"
        sub={<>Every machine that applies <code>{profile.name}</code>.</>}
        actions={<button className="va-btn" onClick={() => st.setToast('Enrollment command copied')}><IPlus size={14} /> Add machine</button>}
      />
      <div className="va-toolbar">
        <Tabs<MachineTab>
          value={tab}
          onChange={setTab}
          items={[
            { key: 'all', label: 'All', count: live.length },
            { key: 'in-sync', label: 'In sync', count: n('in-sync') },
            { key: 'behind', label: 'Behind', count: n('behind') },
            { key: 'drift', label: 'Drift', count: n('drift') },
            { key: 'offline', label: 'Offline', count: n('offline') },
          ]}
        />
      </div>
      <section className="va-panel va-panel-flush">
        <FleetTable rows={rows} st={st} onRow={setOpen} />
        {rows.length === 0 && <div className="va-empty">No machines with this status.</div>}
      </section>

      {open && (
        <Drawer
          title={<span className="va-machine-name"><IServer size={16} /> {open.name}</span>}
          sub={<>{open.os} · {open.arch} · last seen {open.lastSeen}</>}
          onClose={() => setOpen(null)}
          footer={
            <>
              <button className="va-btn" onClick={() => { st.setToast(`Copied ${open.id}`); }}><ICopy size={13} /> Copy ID</button>
              {!open.current && <button className="va-btn" onClick={() => st.setToast(`Asked ${open.name} to sync`)}>Request sync</button>}
            </>
          }
        >
          <dl className="va-kv">
            <div><dt>Status</dt><dd><StatusPill status={open.status} /></dd></div>
            <div><dt>Applied revision</dt><dd><code>{open.appliedRevision}</code>{open.appliedRevision !== profile.upstreamRevision && <span className="va-faint va-small"> · latest {profile.upstreamRevision}</span>}</dd></div>
            <div><dt>Targets</dt><dd className="va-targets">{open.targets.map((t) => <TargetTag key={t} t={t} />)}</dd></div>
            <div><dt>Overrides</dt><dd>{open.overrides}</dd></div>
          </dl>
          {open.current && (
            <>
              <h3 className="va-drawer-h">Overrides on this machine</h3>
              <ul className="va-mini-list">
                {settings.filter((x) => x.source === 'override').map((x) => (
                  <li key={x.key}><code>{x.key}</code><code className="va-val">{show(x.override)}</code></li>
                ))}
              </ul>
            </>
          )}
          {open.status === 'drift' && (
            <p className="va-note va-note-red"><IAlert size={13} /> context-mode plugin is installed but not in the profile.</p>
          )}
          {open.status === 'offline' && <p className="va-note">Not seen for 9 days. It will catch up on its next sync.</p>}
        </Drawer>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ sharing */

function SharingScreen({ st }: { st: Shared }) {
  const [visibility, setVisibility] = useState(profile.visibility);
  const [publishing, setPublishing] = useState<'idle' | 'running' | 'done'>('idle');
  const mine = community.find((p) => p.relation === 'mine')!;
  const others = community.filter((p) => p.relation !== 'mine');
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const publish = () => {
    setPublishing('running');
    timer.current = window.setTimeout(() => {
      setPublishing('done');
      st.setToast(`Published ${profile.name}@${profile.revision}`);
    }, 1200);
  };
  const follow = (p: PublishedProfile) => {
    const next = st.relations[p.name] === 'following' ? 'none' : 'following';
    st.setRelations((r) => ({ ...r, [p.name]: next }));
    st.setToast(next === 'following' ? `Following ${p.name} — updates arrive through Sync` : `Unfollowed ${p.name}`);
  };
  const copy = (p: PublishedProfile) => {
    const copyName = `${account.handle}/${p.name.split('/')[1]}`;
    if (st.copies.includes(copyName)) return;
    st.setCopies((c) => [...c, copyName]);
    st.setToast(`Copied as ${copyName} — independent of ${p.owner}`);
  };

  return (
    <div className="va-page">
      <PageHead title="Sharing" sub="Publish your profile, or build on someone else’s." />

      <section className="va-panel va-publish">
        <div className="va-profile-id">
          <span className="va-logo va-logo-lg"><ILogo size={18} /></span>
          <div>
            <b>{mine.name}</b>
            <p>{mine.description}</p>
            <div className="va-publish-meta">
              <span><IUsers size={12} /> {mine.followers} followers</span>
              <span><ISparkles size={12} /> {mine.skills} skills</span>
              <span><IClock size={12} /> updated {mine.updated}</span>
            </div>
          </div>
        </div>
        <div className="va-publish-actions">
          <div className="va-seg" role="radiogroup" aria-label="Visibility">
            <button role="radio" aria-checked={visibility === 'public'} className={visibility === 'public' ? 'is-active' : ''} onClick={() => setVisibility('public')}>
              <IGlobe size={13} /> Public
            </button>
            <button role="radio" aria-checked={visibility === 'private'} className={visibility === 'private' ? 'is-active' : ''} onClick={() => setVisibility('private')}>
              <ILock size={13} /> Private
            </button>
          </div>
          <button className="va-btn va-btn-primary" onClick={publish} disabled={publishing === 'running' || visibility === 'private'}>
            {publishing === 'running' ? <><ILoader size={13} className="va-spin" /> Publishing…</> : publishing === 'done' ? <><ICheck size={13} /> Published {profile.revision}</> : <><IUpload size={13} /> Publish {profile.revision}</>}
          </button>
        </div>
        <p className="va-faint va-small va-publish-note">
          Publishing shares the base profile only. Machine overrides and environment variable values never leave this machine.
        </p>
      </section>

      <div className="va-explain">
        <div><IBell size={14} className="va-accent" /><div><b>Follow</b><span>Stay linked. Their updates arrive through Sync, and conflicts with your overrides are shown for review.</span></div></div>
        <div><ICopy size={14} className="va-accent" /><div><b>Copy</b><span>Fork once into your own profile. No further updates; you own it from then on.</span></div></div>
      </div>

      <section className="va-panel va-panel-flush">
        <header className="va-panel-head va-panel-head-pad">
          <div className="va-panel-title"><IGlobe size={15} /> Community profiles</div>
        </header>
        <table className="va-table">
          <thead>
            <tr>
              <th>Profile</th>
              <th className="va-num">Followers</th>
              <th className="va-num">Skills</th>
              <th>Updated</th>
              <th className="va-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {others.map((p) => {
              const following = st.relations[p.name] === 'following';
              const copied = st.copies.includes(`${account.handle}/${p.name.split('/')[1]}`);
              return (
                <tr key={p.name}>
                  <td>
                    <div className="va-strong"><code>{p.name}</code>{following && <span className="va-chip va-chip-accent">following</span>}</div>
                    <div className="va-muted va-small">{p.description}</div>
                  </td>
                  <td className="va-num">{(p.followers + (following && p.relation !== 'following' ? 1 : 0) - (!following && p.relation === 'following' ? 1 : 0)).toLocaleString()}</td>
                  <td className="va-num">{p.skills}</td>
                  <td className="va-muted">{p.updated}</td>
                  <td className="va-right">
                    <span className="va-actions">
                      <button className={`va-btn va-btn-sm ${following ? 'va-btn-following' : ''}`} onClick={() => follow(p)}>
                        {following ? <><ICheck size={12} /><span className="va-when-idle">Following</span><span className="va-when-hover">Unfollow</span></> : <><IBell size={12} /> Follow</>}
                      </button>
                      <button className="va-btn va-btn-sm" onClick={() => copy(p)} disabled={copied}>
                        {copied ? <><ICheck size={12} /> Copied</> : <><ICopy size={12} /> Copy</>}
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {st.copies.length > 0 && (
        <section className="va-panel">
          <header className="va-panel-head">
            <div className="va-panel-title"><ICopy size={15} /> Your copies</div>
          </header>
          <ul className="va-mini-list">
            {st.copies.map((c) => (
              <li key={c}><code>{c}</code><span className="va-chip">private · independent</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

