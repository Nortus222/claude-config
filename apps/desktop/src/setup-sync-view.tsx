import React from 'react';
import type { InspectResult } from '@nortuscc/agent/ipc/protocol';
import type { ChangePreview, OperationOutput, RunView } from '@nortuscc/agent/operations';
import { incomingCounts, selectedLocal, type SetupChoice, type SetupSyncController, type SetupSyncState } from './setup-sync-controller.ts';
import { CopyDetails, RunPlaces, RunRecovery, runCounts } from './run-recovery.tsx';
import { causeText, changeTitle, errorText, itemLabel, repoName, runCauses, runReport, type ItemLabel } from './copy.ts';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';
import { BusyCard } from './busy-view.tsx';

type Review = OperationOutput<'setupReview'>;
type ReviewRow = Review['rows'][number];
type Observed = InspectResult['items'][number];
type Actions = Pick<SetupSyncController, 'reload' | 'refetch' | 'choose' | 'chooseAll' | 'preview' | 'apply' | 'cancel' | 'repreview' | 'askAbandon' | 'keepRun' | 'abandon' | 'page' | 'selectSource' | 'switchProfile' | 'followSharedLink'
  | 'toggleLocal' | 'previewLocal' | 'cancelPreview' | 'followRepository' | 'reveal'>;
// `repoUrl` is the setup repository, whose profiles an unfollowed Mac can follow.
type Props = { state: SetupSyncState; controller: Actions; onOpenProfiles?: () => void; repoUrl?: string };

const CHANGE = { added: 'Added', changed: 'Changed', removed: 'Removed', unchanged: 'Unchanged' };
const CHANGE_TONE = { added: 'pill-success', changed: 'pill-accent', removed: 'pill-danger', unchanged: '' };
const CONNECTION = { connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', browser: 'Browser preview' };
const RUN_STATE: Readonly<Record<RunView['state'], string>> = { accepted: 'Starting', running: 'In progress', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', abandoned: 'Abandoned' };
const RUN_TONE: Readonly<Record<RunView['state'], string>> = { accepted: 'pill-accent', running: 'pill-accent', succeeded: 'pill-success', failed: 'pill-danger', cancelled: '', interrupted: 'pill-warning', abandoned: '' };
const AGENTS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex' };
// Why an item is waiting to apply, by its inspected state.
const WAITING: Readonly<Record<string, string>> = {
  missing: 'Not installed on this Mac yet', 'off-pin': 'Not at the version your profile pins', disabled: 'Turned off; it will be removed from this Mac',
  'repo-ahead': 'Your profile has a newer version', unmanaged: 'Not set up from your profile yet',
};
// Waiting items shown before "Show all".
const LOCAL_PREVIEW_ROWS = 8;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const short = (revision: string) => revision.slice(0, 12);
const plain = (text: string): ItemLabel => ({ lead: text, name: '', tail: '', text });
const activeRun = (run: RunView | null) => run?.state === 'accepted' || run?.state === 'running';

// Labels an inspected item. Inspection keys (`config:<file>#<key>`, `skill:<name>`, `skill-link:<agent>:<name>`,
// `integration:<id>`) map onto the setup item ids `itemLabel` knows; anything else falls back to the domain's label.
function observedLabel(item: Pick<Observed, 'key' | 'label'> & { group?: string }): ItemLabel {
  const colon = item.key.indexOf(':'), kind = item.key.slice(0, colon), rest = item.key.slice(colon + 1);
  let label: ItemLabel | undefined;
  if (kind === 'config') label = itemLabel(rest.includes('#') ? `setting:${rest}` : `file:${rest}`);
  else if (kind === 'skill') label = itemLabel(item.group?.includes('/') ? `skill:${item.group}/${rest}` : item.key);
  else if (kind === 'integration') label = itemLabel(item.key);
  else if (kind === 'skill-link') {
    const at = rest.indexOf(':'), agent = AGENTS[rest.slice(0, at)];
    if (at > 0 && agent) label = { lead: 'Skill ', name: rest.slice(at + 1), tail: ` for ${agent}`, text: `Skill ${rest.slice(at + 1)} for ${agent}` };
  }
  return label && label.text !== 'Item' ? label : plain(item.label);
}
const keyLabel = (key: string, inspection: InspectResult | null) => observedLabel(inspection?.items.find(item => item.key === key) ?? { key, label: 'Item' });
// Labels a run step's key: an inspection key, else a setup item id.
const stepLabel = (key: string, inspection: InspectResult | null) => { const observed = keyLabel(key, inspection); return observed.text !== 'Item' ? observed : itemLabel(key); };
// Override paths a switch drops: `settings.<file>.<key>`, `skills.<name>`, `integrations.<id>`.
function overrideLabel(path: string) {
  if (path.startsWith('skills.')) return `Skill ${path.slice('skills.'.length)}`;
  if (path.startsWith('integrations.')) return `Integration ${path.slice('integrations.'.length)}`;
  const setting = /^settings\.([a-z]+:[^.]+\.[a-z]+)\.(.+)$/.exec(path);
  return setting ? itemLabel(`setting:${setting[1]}#${setting[2]}`).text : 'A setting override';
}
function Label({ label }: { label: ItemLabel }) {
  return <span className="changes-label">{label.lead}{label.name ? <strong>{label.name}</strong> : null}{label.tail}</span>;
}

// Accept keeps local overrides; replacing one requires a separate, explicit choice.
function pairLabel(row: ReviewRow, action: SetupChoice['action']) {
  if (action === 'hold') return 'Hold at the current value';
  if (action === 'takeTheirs') return row.kind === 'file' ? "Replace this Mac's file with your profile's version (backed up first)" : "Use your profile's value and remove this Mac's override (backed up first)";
  const incoming = action === 'release' ? "Release the hold and take your profile's value" : "Take your profile's value";
  return row.conflict ? `${incoming} · keep this Mac's ${row.kind === 'file' ? 'file' : 'override'}` : incoming;
}
// A preview's staged choices, one line per action in this order, each headed by its action and count.
const CHOICE_GROUPS: readonly { action: SetupChoice['action']; head: (n: number) => string }[] = [
  { action: 'accept', head: n => `Take ${n}` }, { action: 'release', head: n => `End hold and take ${n}` },
  { action: 'takeTheirs', head: n => `Replace mine ${n} · backed up first` }, { action: 'hold', head: n => `Hold ${n}` },
];
// Names a preview line shows before "+N more".
const INLINE_NAMES = 12;
// The one muted line under a preview, by its kind of change.
const PREVIEW_NOTE: Partial<Readonly<Record<ChangePreview['change']['kind'], string>>> = {
  setupApply: "Items you don't choose will be held. Anything your choices replace is backed up first.",
  reconcile: 'Anything this replaces is backed up first.',
};

// Item names as one wrapping, comma-separated list; past INLINE_NAMES the rest open with "+N more".
export function NameList({ labels, label }: { labels: readonly ItemLabel[]; label: string }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? labels : labels.slice(0, INLINE_NAMES);
  return <ul className="name-list" aria-label={label}>{shown.map((item, index) => <li key={index}><Label label={item} /></li>)}
    {labels.length > INLINE_NAMES ? <li className="name-more"><button type="button" className="link" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? 'Show fewer' : `+${labels.length - INLINE_NAMES} more`}</button></li> : null}</ul>;
}
function PreviewLine({ head, labels, label }: { head?: string; labels: readonly ItemLabel[]; label: string }) {
  return <div className="preview-line">{head ? <span className="preview-line-head">{head}</span> : null}<NameList labels={labels} label={label} /></div>;
}

// Why reading and choosing are unavailable, or null when they are available. A busy Mac explains itself
// in its own card.
function unavailableReason(state: SetupSyncState): string | null {
  if (state.eligibility.read || state.pending || state.pagePending) return null;
  if (state.connection !== 'connected') return 'Connect the agent to read changes.';
  if (state.busy) return `${state.busy.description}. Available when it finishes.`;
  if (activeRun(state.run)) return 'Available when the current run finishes.';
  return 'Available when this Mac finishes its current work.';
}

// The panel's heading and its Apply button, in words for the kind of change previewed.
function previewCopy(preview: ChangePreview, state: SetupSyncState): { title: string; apply: string } {
  const change = preview.change;
  if (change.kind === 'setupApply') {
    const taken = change.choices.filter(choice => choice.action !== 'hold').length;
    const text = taken ? `Apply ${count(taken, 'incoming change')}` : `Hold ${count(change.choices.length, 'incoming change')}`;
    return { title: text, apply: text };
  }
  if (change.kind === 'reconcile') { const text = `Apply ${count(change.only.length, 'change')} to this Mac`; return { title: text, apply: text }; }
  if (change.kind === 'followProfile') return state.profiles?.followed
    ? { title: `Switch this Mac to ${change.profile}`, apply: `Switch to ${change.profile}` }
    : { title: `Follow ${change.profile}`, apply: `Follow ${change.profile}` };
  return { title: changeTitle(change.kind), apply: changeTitle(change.kind) };
}

// The page's only Apply: whatever was last previewed, from either section. The first-run profile choice
// shows its follow preview here too.
export function PreviewPanel({ state, controller }: { state: SetupSyncState; controller: Pick<Actions, 'apply' | 'cancelPreview'> }) {
  const preview = state.preview;
  if (!preview) return null;
  const change = preview.change, { title, apply } = previewCopy(preview, state);
  const dropped = 'droppedChoices' in preview ? preview.droppedChoices : null;
  const { steps, skipped } = preview.plan, effects = 'actionEffects' in preview ? preview.actionEffects ?? [] : [], note = PREVIEW_NOTE[change.kind];
  return <section className="card changes-preview" aria-labelledby="changes-preview-h">
    <div className="card-head"><div><h2 id="changes-preview-h">{title}</h2>
      <p>{change.kind === 'followProfile' ? `From ${repoName(change.repoUrl)}. ` : ''}Preview only. Nothing is written until you apply.</p></div>
      <div className="actions"><button className="primary" disabled={!state.eligibility.apply} onClick={() => void controller.apply()}>{apply}</button>
        <button disabled={state.pending} onClick={() => controller.cancelPreview()}>Cancel</button></div></div>
    {state.previewNotice ? <p className="notice" role="status">{state.previewNotice}</p> : null}
    <div className="preview-lines">
      {dropped?.holds.length ? <PreviewLine head={`Holds that end ${dropped.holds.length}`} labels={dropped.holds.map(itemLabel)} label="Dropped holds" /> : null}
      {dropped?.overrides.length ? <PreviewLine head={`Overrides removed ${dropped.overrides.length}`} labels={dropped.overrides.map(path => plain(overrideLabel(path)))} label="Dropped overrides" /> : null}
      {change.kind === 'setupApply' ? <div className="preview-lines" role="group" aria-label="Reviewed choices">{CHOICE_GROUPS.map(({ action, head }) => {
        const chosen = change.choices.filter(choice => choice.action === action);
        return chosen.length ? <PreviewLine key={action} head={head(chosen.length)} labels={chosen.map(choice => itemLabel(choice.itemId))} label={`${head(chosen.length)}: items`} /> : null;
      })}</div> : null}
      {change.kind === 'reconcile' ? <PreviewLine labels={change.only.map(key => keyLabel(key, state.inspection))} label="Changes to apply" /> : null}
    </div>
    {change.kind === 'setupApply' && !steps.length ? <p className="muted">Nothing on this Mac changes yet. Apply saves your choices.</p> : null}
    {steps.length || effects.length ? <details className="preview-more"><summary>{steps.length ? `Steps (${steps.length})` : 'What Apply does'}</summary>
      {steps.length ? <ol className="steps setup-sync-steps" aria-label="Planned steps">{steps.map((step, index) => <li key={index}><span>{step.summary}</span></li>)}</ol> : null}
      {effects.length ? <ul className="preview-effects">{effects.map(effect => <li key={effect}>{effect}</li>)}</ul> : null}</details> : null}
    {skipped.length ? <details className="preview-more"><summary>{skipped.length} left out</summary>
      <ul className="changes-list" aria-label="Left out">{skipped.map((step, index) => <li key={index}><Label label={keyLabel(step.key, state.inspection)} /><small>{step.reason}</small></li>)}</ul></details> : null}
    {note ? <p className="muted preview-note">{note}</p> : null}
  </section>;
}

// Planned steps of a run, when its acceptance records them.
const plannedSteps = (run: RunView) => (run.intent as { parity?: { plannedKeys?: readonly string[] } }).parity?.plannedKeys?.length ?? 0;

// Failed steps the card lists; the rest are under Details and in Copy details.
const SHOWN_FAILURES = 5;
// A run stopped before doing all it planned: it failed, or finished with failed steps.
const stopped = (run: RunView) => run.state === 'failed' || run.result?.status === 'done' && run.result.failed > 0;

const failedSteps = (run: RunView, inspection: InspectResult | null) =>
  run.steps.filter(step => step.outcome === 'failed').map(step => ({ ...step, label: stepLabel(step.key, inspection) }));
// The run as plain text for Copy details.
const reportOf = (run: RunView, inspection: InspectResult | null) => runReport({ title: changeTitle(run.intent.change.kind), state: RUN_STATE[run.state],
  cause: runCauses(run).join(' '), runId: run.runId, ...runCounts(run), failed: failedSteps(run, inspection).map(step => ({ label: step.label.text, key: step.key, note: step.note })) });

type RunActions = Pick<Actions, 'cancel'> & Partial<Pick<Actions, 'reload' | 'repreview' | 'reveal'>>;
// One run: active, or started in this window. Interrupted and abandoned runs show as recovery instead.
export function RunCard({ run, state, controller }: { run: RunView; state: SetupSyncState; controller: RunActions }) {
  if (run.state === 'interrupted' || run.state === 'abandoned') return null;
  const result = run.result, ok = run.steps.filter(step => step.outcome === 'ok').length, failed = run.steps.filter(step => step.outcome === 'failed').length;
  const total = Math.max(plannedSteps(run), run.steps.length), running = activeRun(run);
  const outcome = !result ? (run.steps.length ? `${ok} of ${count(total, 'step')} done${failed ? `, ${failed} failed` : ''}.` : 'Starting.')
    : result.status === 'done' ? `${count(result.ok, 'change')} applied${result.failed ? `, ${result.failed} failed` : ''}.`
    : result.status === 'cancelled' ? `Cancelled. ${count(result.remaining.length, 'change')} not started.`
    : errorText(result.message);
  const head = <div className="card-head"><div><h2 id="changes-run-h">{changeTitle(run.intent.change.kind)}</h2></div>
    <div className="actions"><span className={`pill ${RUN_TONE[run.state]}`}>{running ? <span className="spinner" aria-hidden="true" /> : null}{RUN_STATE[run.state]}</span>
      {state.eligibility.cancel ? <button onClick={() => void controller.cancel()} disabled={state.pending}>Cancel</button> : null}</div></div>;
  if (!running && stopped(run)) return <RunFailure run={run} state={state} controller={controller} head={head} outcome={outcome} />;
  return <section className="card changes-run" aria-labelledby="changes-run-h">
    {head}
    {running && total ? <progress aria-label={`${changeTitle(run.intent.change.kind)} progress`} value={run.steps.length} max={total} /> : null}
    <p role="status" className={result && result.status !== 'done' && result.status !== 'cancelled' ? 'alert' : 'muted'}>{outcome}</p>
    {running && run.current ? <p className="row-sub">{run.current.summary}</p> : null}
    {run.installation ? <p className="muted">{run.installation.message}</p> : null}
  </section>;
}

// A run that stopped short: why, which steps failed and what was written, the next steps, then where to
// look. Keys, the run ID and folders stay under Details and in Copy details.
function RunFailure({ run, state, controller, head, outcome }: { run: RunView; state: SetupSyncState; controller: RunActions; head: React.ReactNode; outcome: string }) {
  const causes = runCauses(run), counts = runCounts(run), failures = failedSteps(run, state.inspection), report = reportOf(run, state.inspection);
  const lead = causes.length ? causes : [run.result?.status === 'done' ? outcome : causeText('Operation stopped')];
  const keys = (name: string, values: readonly string[]) => values.length ? <><dt>{name}</dt><dd><ul>{values.map(value => <li key={value}><code>{value}</code></li>)}</ul></dd></> : null;
  return <section className="card changes-run run-failure" aria-labelledby="changes-run-h">
    {head}
    {lead.map(text => <p className="alert run-cause" role="status" key={text}>{text}</p>)}
    {failures.length ? <ul className="changes-list run-failed" aria-label="Failed steps">{failures.slice(0, SHOWN_FAILURES).map((step, index) => <li key={index}>
      <Label label={step.label} /><small>{causeText(step.note) || 'Failed.'}</small></li>)}
      {failures.length > SHOWN_FAILURES ? <li className="muted">{failures.length - SHOWN_FAILURES} more under Details</li> : null}</ul> : null}
    <p className="muted">{count(counts.written, 'change')} written{counts.notWritten === null ? '' : ` · ${counts.notWritten} not written`}.
      {counts.backupIds.length ? ' Backups of what it replaced are kept.' : ''} Nothing is rolled back automatically.</p>
    <div className="setup-sync-actions">
      {controller.reload ? <button disabled={!state.eligibility.read} title="Reads this Mac and your profile again" onClick={() => void controller.reload!()}>Check again</button> : null}
      {controller.repreview && run.state === 'failed' ? <button disabled={!state.eligibility.read} title="Prepares a fresh plan for what is still waiting" onClick={() => void controller.repreview!()}>Re-preview</button> : null}
      <CopyDetails text={report} /></div>
    <details className="run-details"><summary>Details</summary>
      <RunPlaces backupIds={counts.backupIds} onReveal={controller.reveal ? place => controller.reveal!(place) : undefined} />
      <dl className="setup-sync-facts">
        <dt>Run</dt><dd><code>{run.runId}</code></dd>
        {failures.length ? <><dt>Failed</dt><dd><ul>{failures.map((step, index) => <li key={index}><code>{step.key}</code>{step.note ? ` ${step.note}` : ''}</li>)}</ul></dd></> : null}
        {keys('Written', run.parity?.committedKeys ?? [])}{keys('Not written', run.parity?.remainingKeys ?? [])}
      </dl></details>
  </section>;
}

// With nothing followed, the setup repository's own profiles, each with Follow.
export function SetupProfiles({ state, controller, repoUrl }: { state: SetupSyncState; controller: Pick<SetupSyncController, 'followRepository'>; repoUrl: string }) {
  const available = state.profiles && !state.profiles.followed ? state.profiles.available : [];
  if (!available.length) return null;
  return <div className="rows changes-local-group"><p className="group-label">Profiles in {repoName(repoUrl)}</p>
    <ul className="rows profile-choice-list" aria-label="Profiles to follow">{available.map(profile => <li className="row" key={profile.name}>
      <span className="row-main"><strong>{profile.name}</strong>{profile.extends ? <small className="row-sub">Builds on {profile.extends}</small> : null}</span>
      <button disabled={!state.eligibility.read} onClick={() => void controller.followRepository(repoUrl, profile.name)}>Follow {profile.name}</button>
    </li>)}</ul></div>;
}

function Following({ state, controller, repoUrl = DEFAULT_REPO_URL }: Props) {
  const { source } = state;
  const [link, setLink] = React.useState('');
  const followed = state.profiles?.followed;
  return <section className="card setup-sync-summary" aria-labelledby="changes-following-h">
    <h2 id="changes-following-h">{followed ? `Following ${followed.profile} from ${repoName(followed.repoUrl)}` : source?.repository ? `Using ${source.repository}` : "This Mac doesn't follow a profile yet"}</h2>
    {state.profileNotice ? <p className={state.profiles ? 'notice' : 'alert'}>{state.profileNotice}</p> : null}
    <SetupProfiles state={state} controller={controller} repoUrl={repoUrl} />
    <ul className="rows">
      {followed ? <li className="row"><label className="row-main" htmlFor="changes-profile">Profile</label>
        <div className="row-trail"><select id="changes-profile" aria-label="Profile" value={state.switchTarget ?? followed.profile} disabled={!state.eligibility.read} onChange={event => void controller.switchProfile(event.target.value)}>{state.profiles?.available.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></div></li> : null}
      <li className="row"><form className="inline-form" onSubmit={event => { event.preventDefault(); void controller.followSharedLink(link); }}>
        <label className="row-main inline-field"><span>Follow a shared link</span><input value={link} onChange={event => setLink(event.target.value)} disabled={!state.eligibility.read} placeholder="nortuscc://follow/…" /></label>
        <button disabled={!state.eligibility.read || !link.trim()}>Preview follow</button></form></li>
      {state.sources.length > 1 ? <li className="row"><label className="row-main" htmlFor="changes-source">Source</label>
        <div className="row-trail"><select id="changes-source" value={source?.setupId ?? ''} disabled={!state.eligibility.read}
          onChange={event => void controller.selectSource(event.target.value)}>{state.sources.map((item, index) => <option key={item.setupId} value={item.setupId}>{item.repository ?? `Source ${index + 1}`}</option>)}</select></div></li> : null}
      {source && !source.trusted ? <li className="row"><p className="row-main">Not trusted on this Mac.</p><span className="pill pill-warning">Untrusted</span></li> : null}
    </ul>
  </section>;
}

type PinGroup = Review['pinGroups'][number];
type ChoiceActions = Pick<Actions, 'choose' | 'chooseAll'>;
// One entry of the incoming list: a row on its own, or a pin group with its rows on this page.
type Entry = { row: ReviewRow } | { group: PinGroup; rows: ReviewRow[] };

// Orders the page's rows for display: each pin group takes the place of its first row on this page, so a group
// with no row here is left out.
export function incomingEntries(review: Pick<Review, 'rows' | 'pinGroups'>): Entry[] {
  const groupOf = new Map(review.pinGroups.flatMap(group => group.itemIds.map(id => [id, group] as const)));
  const entries: Entry[] = [], placed = new Map<string, { group: PinGroup; rows: ReviewRow[] }>();
  for (const row of review.rows) {
    const group = groupOf.get(row.itemId);
    if (!group) { entries.push({ row }); continue; }
    let entry = placed.get(group.source);
    if (!entry) { entry = { group, rows: [] }; placed.set(group.source, entry); entries.push(entry); }
    entry.rows.push(row);
  }
  return entries;
}

// The pin a group's changed rows move to, when every offered skill value names the same new pin; else null.
export function pinMove(rows: readonly Pick<ReviewRow, 'change' | 'before' | 'after'>[]): string | null {
  const pinOf = (text: string | undefined) => {
    try { const pin = text === undefined ? undefined : (JSON.parse(text) as { pin?: unknown } | null)?.pin; return typeof pin === 'string' ? pin : null; } catch { return null; }
  };
  const moved = rows.filter(row => row.change !== 'unchanged' && row.after !== undefined);
  const pins = new Set(moved.map(row => pinOf(row.after))), [pin] = pins;
  return pins.size === 1 && typeof pin === 'string' && moved.some(row => pinOf(row.before) !== pin) ? pin : null;
}

type Option<T extends string> = { value: T; text: string; title?: string };
// A compact single choice: a radiogroup of buttons. With nothing chosen no segment is checked; the arrow keys
// move between segments and choose, as native radios do.
export function Segmented<T extends string>({ label, options, selected, disabled, onSelect }: {
  label: string; options: readonly Option<T>[]; selected: T | undefined; disabled: boolean; onSelect: (value: T) => void;
}) {
  const focusable = Math.max(0, options.findIndex(option => option.value === selected));
  return <div role="radiogroup" aria-label={label} className="segmented">
    {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={option.value === selected} title={option.title}
      tabIndex={index === focusable ? 0 : -1} disabled={disabled} onClick={() => onSelect(option.value)}
      onKeyDown={event => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = (index + step + options.length) % options.length;
        onSelect(options[next]!.value);
        (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
      }}>{option.text}</button>)}
  </div>;
}

// Shows and hides what opens below a row: `text` is what it shows, `label` its accessible name.
function Disclosure({ open, onToggle, controls, text, label }: { open: boolean; onToggle: () => void; controls: string; text: string; label: string }) {
  return <button type="button" className="link incoming-toggle" aria-expanded={open} aria-controls={open ? controls : undefined} aria-label={label} onClick={onToggle}>
    <span className="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>{text}</button>;
}

const SEGMENT: Readonly<Record<SetupChoice['action'], string>> = { hold: 'Hold', accept: 'Take', release: 'Take', takeTheirs: 'Replace mine' };
const domId = (prefix: string, key: string) => `${prefix}-${encodeURIComponent(key)}`;
// Values short enough to read side by side on one line; longer or multi-line values keep their own boxes.
const SHORT_VALUE = 40;
const shortValues = (values: readonly (readonly [string, string | undefined])[]) =>
  values.every(([, value]) => value === undefined || value.length <= SHORT_VALUE && !value.includes('\n'));

// One incoming row on one line: its label and change, its choices, and its values behind Details. A pin
// group's member shows no choices, since its group decides for it.
export function IncomingRow({ row, state, controller, open, onToggle, member = false }: {
  row: ReviewRow; state: SetupSyncState; controller: ChoiceActions; open: boolean; onToggle: () => void; member?: boolean;
}) {
  const staged = state.choices.find(choice => choice.itemId === row.itemId);
  // A bulk take stages accept, which also releases a held row.
  const chosen = staged?.action === 'accept' && row.held ? 'release' : staged?.action;
  const actions: SetupChoice['action'][] = ['hold', row.held ? 'release' : 'accept', ...(row.conflict ? ['takeTheirs' as const] : [])];
  const label = itemLabel(row.itemId), values = domId('values', row.itemId);
  const named = [['Current', row.before], ['Offered', row.after], ["This Mac's", row.mine]] as const;
  return <li className={`row incoming-row${member ? ' incoming-member' : ''}`}>
    <span className="incoming-name"><Label label={label} />
      <span className={`pill ${CHANGE_TONE[row.change]}`}>{CHANGE[row.change]}</span>
      {row.held ? <span className="pill" title="On hold at the current value">On hold</span> : null}
      {row.conflict ? <span className="pill pill-warning" title="This Mac overrides this value">Overridden here</span> : null}</span>
    {member ? null : <Segmented label={`Choice for ${label.text}`} disabled={!state.eligibility.choose} selected={chosen}
      options={actions.map(action => ({ value: action, text: SEGMENT[action], title: pairLabel(row, action) }))}
      onSelect={action => controller.choose({ itemId: row.itemId, action })} />}
    <Disclosure open={open} onToggle={onToggle} controls={values} text="Details" label={`Values of ${label.text}`} />
    {open ? <div className="incoming-detail" id={values}>
      {shortValues(named) ? <dl className="incoming-values">{named.map(([name, value]) => <div key={name}>
        <dt>{name}</dt><dd><code aria-label={`${name} value of ${label.text}`}>{value ?? 'None'}</code></dd></div>)}</dl>
        : named.map(([name, value]) => <div key={name}>
          <p className="setup-sync-label">{name}</p><pre className="setup-sync-diff" tabIndex={0} aria-label={`${name} value of ${label.text}`}><code>{value ?? 'None'}</code></pre>
        </div>)}
      {row.truncated ? <p className="setup-sync-warn">Values are shortened. Only part of each value is shown.</p> : null}
    </div> : null}
  </li>;
}

// A pin group as one row. Its Hold | Take decides for the whole group, members on other pages included, since a
// pin moves a whole source; its members open below, read-only, each with its values.
export function PinGroupRow({ group, rows, state, controller, open, onToggle, isOpen, toggle }: {
  group: PinGroup; rows: readonly ReviewRow[]; state: SetupSyncState; controller: ChoiceActions; open: boolean; onToggle: () => void;
  isOpen: (itemId: string) => boolean; toggle: (itemId: string) => void;
}) {
  const onPage = new Set(rows.map(row => row.itemId)), elsewhere = group.itemIds.filter(id => !onPage.has(id));
  const staged = new Map(state.choices.map(choice => [choice.itemId, choice.action]));
  const actions = new Set(rows.map(row => staged.get(row.itemId))), [only] = actions;
  const selected = actions.size !== 1 ? undefined : only === 'hold' ? 'hold' as const : only === 'accept' || only === 'release' ? 'accept' as const : undefined;
  const changes = new Set(rows.map(row => row.change)), change = changes.size === 1 ? [...changes][0]! : 'changed';
  const pin = pinMove(rows), members = domId('members', group.source), error = state.groupErrors[group.source];
  return <li className="row incoming-row incoming-group">
    <span className="incoming-name"><span className="changes-label">{[<>Skills from <strong>{group.source}</strong></>, count(group.itemIds.length, 'skill'),
      pin ? `pin moves to ${short(pin)}` : '', elsewhere.length ? `${elsewhere.length} on other pages` : ''].filter(Boolean)
        .map((part, index, parts) => <React.Fragment key={index}><span className={index ? 'incoming-part' : undefined}>{part}{index < parts.length - 1 ? ' ·' : ''}</span>{index < parts.length - 1 ? ' ' : ''}</React.Fragment>)}</span>
      <span className={`pill ${CHANGE_TONE[change]}`}>{CHANGE[change]}</span></span>
    <Segmented label={`Choice for every skill from ${group.source}`} disabled={!state.eligibility.choose} selected={selected}
      options={[{ value: 'hold', text: 'Hold', title: 'Hold every skill from this source at the current value' }, { value: 'accept', text: 'Take', title: "Take your profile's value for every skill from this source" }]}
      onSelect={action => controller.chooseAll(action, group.source)} />
    <Disclosure open={open} onToggle={onToggle} controls={members} text="Skills" label={`Skills from ${group.source}`} />
    {error ? <p className="alert incoming-detail" role="alert">{error}</p> : null}
    {open ? <ul className="rows incoming-detail incoming-members" id={members} aria-label={`Skills from ${group.source}`}>
      {rows.map(row => <IncomingRow key={row.itemId} row={row} state={state} controller={controller} member open={isOpen(row.itemId)} onToggle={() => toggle(row.itemId)} />)}
      {elsewhere.map(id => <li key={id} className="row incoming-row incoming-member"><span className="incoming-name"><Label label={itemLabel(id)} /><span className="muted">On another page</span></span></li>)}
    </ul> : null}
  </li>;
}

function Incoming({ review, state, controller }: { review: Review; state: SetupSyncState; controller: Actions }) {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpen(current => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });
  const can = state.eligibility, { incoming, held } = incomingCounts(review);
  const from = state.profiles?.followed?.profile ?? 'your profile';
  const page = state.pageIndex ? ` · page ${state.pageIndex + 1}` : '';
  const rows = review.rows.length > 0, entries = incomingEntries(review);
  const grouped = entries.some(entry => 'group' in entry);
  return <section className="card setup-sync-review" aria-labelledby="changes-incoming-h">
    <div className="card-head"><div><h2 id="changes-incoming-h">{incoming + held ? `${count(incoming, 'incoming change')} from ${from}${held ? ` · ${held} on hold` : ''}${page}` : `Nothing incoming from ${from}${page}`}</h2>
      <p>{rows ? `Choose for each item.${grouped ? ' Skills from one source share a pin, so they share one choice.' : ''} Items you don't choose will be held.` : "You're up to date."}</p></div>
      {review.rows.some(row => row.change !== 'unchanged') ? <div className="actions" role="group" aria-label="Choose for every incoming row">
        <button disabled={!can.choose} onClick={() => controller.chooseAll('accept')}>Take all incoming</button>
        <button disabled={!can.choose} onClick={() => controller.chooseAll('hold')}>Hold all incoming</button></div> : null}</div>
    {rows ? <ul className="rows setup-sync-rows incoming-rows">{entries.map(entry => 'group' in entry
      ? <PinGroupRow key={`group:${entry.group.source}`} group={entry.group} rows={entry.rows} state={state} controller={controller}
        open={open.has(`group:${entry.group.source}`)} onToggle={() => toggle(`group:${entry.group.source}`)} isOpen={id => open.has(id)} toggle={toggle} />
      : <IncomingRow key={entry.row.itemId} row={entry.row} state={state} controller={controller} open={open.has(entry.row.itemId)} onToggle={() => toggle(entry.row.itemId)} />)}</ul> : null}
    {review.nextCursor || state.pageIndex ? <nav className="setup-sync-actions" aria-label="Review pages"><button disabled={!can.browse || !state.pageIndex} onClick={() => void controller.page('previous')}>Previous page</button>
      <button disabled={!can.browse || !review.nextCursor} onClick={() => void controller.page('next')}>Next page</button></nav> : null}
    {rows ? <div className="setup-sync-actions section-foot"><button className="primary" disabled={!can.preview} title={can.preview ? undefined : state.choices.length ? undefined : 'Choose at least one item first.'} onClick={() => void controller.preview()}>Preview</button>
      <span className="reason">{count(state.choices.length, 'choice')} made. Preview writes nothing.</span></div> : null}
    {state.previewError && !Object.keys(state.groupErrors).length ? <p className="alert" role="alert">{state.previewError}</p> : null}
  </section>;
}

// This Mac's own items: those waiting to apply are checked into one reconcile; the rest name their next step.
function OnThisMac({ state, controller, onOpenProfiles }: Props) {
  const [all, setAll] = React.useState(false);
  const { inspection, eligibility: can } = state;
  if (!inspection) return <section className="card changes-local" aria-labelledby="changes-local-h"><h2 id="changes-local-h">On this Mac</h2>
    <p className="muted">This Mac hasn't been checked yet.</p></section>;
  const excluded = new Set(state.excluded), selected = selectedLocal(state).length;
  const waiting = inspection.items.filter(item => item.disposition === 'apply');
  const captured = inspection.items.filter(item => item.disposition === 'capture');
  const blocked = inspection.items.filter(item => item.disposition === 'blocked');
  const issues = inspection.profile.issues.length, unread = inspection.probeErrors.length;
  const shown = all ? waiting : waiting.slice(0, LOCAL_PREVIEW_ROWS);
  return <section className="card changes-local" aria-labelledby="changes-local-h">
    <div className="card-head"><div><h2 id="changes-local-h">{waiting.length ? `${count(waiting.length, 'change')} waiting to apply on this Mac` : 'Nothing waiting to apply on this Mac'}</h2>
      {waiting.length ? <p>Uncheck anything you want to leave for now.</p> : null}</div></div>
    {issues ? <p className="alert">Your profile has {count(issues, 'problem')}, so changes can’t be applied to this Mac. Open Details below to see {issues === 1 ? 'it' : 'them'}.</p> : null}
    {unread ? <p className="notice">{count(unread, 'part')} of this Mac couldn’t be read. Open Details below to see why.</p> : null}
    {waiting.length ? <>
      <ul className="rows setup-sync-rows">{shown.map(item => { const label = observedLabel(item); return <li key={item.key} className="row setup-sync-row">
        <label className="setup-sync-choice row-main"><input type="checkbox" aria-label={`Include ${label.text}`} checked={!excluded.has(item.key)} disabled={!can.local} onChange={() => controller.toggleLocal(item.key)} />
          <span className="local-text"><Label label={label} /><small>{WAITING[item.state] ?? item.note ?? 'Waiting to apply'}</small></span></label></li>; })}
        {waiting.length > LOCAL_PREVIEW_ROWS ? <li className="row"><button className="link" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${waiting.length}`}</button></li> : null}</ul>
      <div className="setup-sync-actions section-foot"><button className="primary" disabled={!can.previewLocal} onClick={() => void controller.previewLocal()}>Preview</button><span className="reason">{selected} of {waiting.length} included. Preview writes nothing.</span></div>
    </> : null}
    {state.localError ? <p className="alert" role="alert">{state.localError}</p> : null}
    {captured.length ? <div className="rows changes-local-group"><p className="group-label">Changed on this Mac</p>
      <div className="row"><p className="row-sub row-main">These differ from your profile. Save them to a profile draft to keep them.</p>
        {onOpenProfiles ? <div className="row-trail"><button onClick={onOpenProfiles}>Open Profiles</button></div> : null}</div>
      <ul className="rows">{captured.map(item => <li className="row" key={item.key}><Label label={observedLabel(item)} /></li>)}</ul></div> : null}
    {blocked.length ? <div className="rows changes-local-group"><p className="group-label">Can’t be applied</p>
      <ul className="rows">{blocked.map(item => <li className="row" key={item.key}><span className="row-main"><Label label={observedLabel(item)} /><small className="row-sub">{item.note ?? 'This Mac’s copy needs fixing by hand.'}</small></span></li>)}</ul>
      <p className="row-sub group-foot">Fix these on this Mac, then reload.</p></div> : null}
  </section>;
}

// Provenance and raw facts for support: the only place keys, revisions and probe text appear.
function Details({ state }: { state: SetupSyncState }) {
  const { inspection, review } = state;
  if (!inspection && !review) return null;
  return <details className="details-card changes-details"><summary>Details</summary>
    <dl className="setup-sync-facts">
      {inspection ? <><dt>Repository</dt><dd><code>{inspection.profile.repo}</code></dd>
        <dt>Revision</dt><dd><code>{inspection.profile.revision ? short(inspection.profile.revision) : 'Unknown'}</code></dd></> : null}
      {review ? <><dt>Offered revision</dt><dd><code>{review.revision.kind === 'local' ? short(review.revision.commit) : `${review.revision.number} (${short(review.revision.commitSha)})`}</code></dd></> : null}
    </dl>
    {inspection ? <div className="table-wrap"><table>
      <thead><tr><th>Item</th><th>Domain</th><th>State</th><th>Disposition</th><th>Layer / source</th></tr></thead>
      <tbody>{inspection.items.map(item => <tr key={item.key}>
        <td><strong>{observedLabel(item).text}</strong><small><code>{item.key}</code></small><small>{item.group}{item.target ? ` · ${item.target}` : ''}</small>{item.note ? <small>{item.note}</small> : null}</td>
        <td>{item.domain}</td><td>{item.state}</td><td>{item.disposition}</td>
        <td>{item.from ? `${item.from.layer} · ${item.from.source}` : 'No provenance reported'}</td>
      </tr>)}</tbody>
    </table></div> : null}
    {inspection && !inspection.items.length ? <p>No items reported.</p> : null}
    {inspection?.profile.issues.length ? <div><h3>Profile problems</h3><ul>{inspection.profile.issues.map((issue, index) => <li key={index}>{issue.source}: {issue.path}, {issue.message}</li>)}</ul></div> : null}
    {inspection?.probeErrors.length ? <div><h3>Could not be read</h3><ul>{inspection.probeErrors.map((error, index) => <li key={index}>{error}</li>)}</ul></div> : null}
  </details>;
}

// Changes: one preview panel holding the page's only Apply, the current run, the followed profile, incoming
// changes and this Mac's own items, then Details.
export function SetupSyncView({ state, controller, onOpenProfiles, repoUrl }: Props) {
  if (!state.native) return <div className="setup-sync-view changes-view"><header className="page-header"><div><h1>Changes</h1></div></header>
    <p className="notice">Open the desktop app to review changes. Browser preview has no agent connection.</p></div>;
  const { review, run, eligibility: can } = state;
  const reason = unavailableReason(state), busy = state.busy;
  // A busy Mac's card stands in for the run card of the same run, and for the review and "On this Mac".
  const busyRun = busy && run && activeRun(run) && (busy.runId === null || busy.runId === run.runId);
  return <div className="setup-sync-view changes-view">
    <header className="page-header"><div><h1>Changes</h1><p className="intro">What your profile brings and what this Mac still needs.</p></div>
      <div className="header-actions">{state.connection !== 'connected' ? <span className={`pill connection ${state.connection}`}>{CONNECTION[state.connection]}</span> : null}
        <button disabled={!can.read} title={reason ?? undefined} onClick={() => void controller.reload()}>Reload</button>
        <button disabled={!can.refetch} title={reason ?? undefined} onClick={() => void controller.refetch()}>Check for new changes</button></div></header>
    {state.error && !Object.keys(state.groupErrors).length ? <p className="alert" role="alert">{state.error}</p> : null}
    {reason && !busy && !activeRun(run) ? <p className="notice">{reason}</p> : null}
    <p className="setup-sync-detail" role="status">{state.pending ? 'Reading…' : state.message}</p>
    <PreviewPanel state={state} controller={controller} />
    {busy ? <BusyCard busy={busy} note="Incoming changes and this Mac’s items are read again when it finishes."
      action={busyRun && can.cancel ? <button onClick={() => void controller.cancel()} disabled={state.pending}>Cancel</button> : undefined} /> : null}
    {run && !busyRun ? <RunCard run={run} state={state} controller={controller} /> : null}
    {run ? <RunRecovery run={run} onRepreview={() => void controller.repreview()} onAskAbandon={() => controller.askAbandon()} onAbandon={() => void controller.abandon()}
      onKeep={() => controller.keepRun()} confirming={state.confirmingAbandon} disabled={!can.read} onReveal={place => controller.reveal(place)} report={reportOf(run, state.inspection)} /> : null}
    <Following state={state} controller={controller} repoUrl={repoUrl} />
    {review && !busy ? <Incoming review={review} state={state} controller={controller} /> : null}
    {busy ? null : <OnThisMac state={state} controller={controller} onOpenProfiles={onOpenProfiles} />}
    <Details state={state} />
  </div>;
}
