import React from 'react';
import type { InspectResult } from '@nortuscc/agent/ipc/protocol';
import type { ChangePreview, OperationOutput, RunView } from '@nortuscc/agent/operations';
import { incomingCounts, selectedLocal, type SetupChoice, type SetupSyncController, type SetupSyncState } from './setup-sync-controller.ts';
import { RunRecovery } from './run-recovery.tsx';
import { changeTitle, errorText, itemLabel, repoName, type ItemLabel } from './copy.ts';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';

type Review = OperationOutput<'setupReview'>;
type ReviewRow = Review['rows'][number];
type Observed = InspectResult['items'][number];
type Actions = Pick<SetupSyncController, 'reload' | 'refetch' | 'choose' | 'chooseAll' | 'preview' | 'apply' | 'cancel' | 'repreview' | 'askAbandon' | 'keepRun' | 'abandon' | 'page' | 'selectSource' | 'switchProfile' | 'followSharedLink'
  | 'toggleLocal' | 'previewLocal' | 'cancelPreview' | 'followRepository'>;
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
const STAGED: Readonly<Record<SetupChoice['action'], string>> = {
  accept: "Take your profile's value and keep this Mac's overrides", hold: 'Hold at the current value',
  release: "Release the hold and take your profile's value", takeTheirs: "Use your profile's value and replace this Mac's (backed up first)",
};

// Why reading and choosing are unavailable, or null when they are available. HOOK(controller): the eligibility
// flags carry no reason; replace this guess with the controller's own busy reason and apply progress once it has them.
function unavailableReason(state: SetupSyncState): string | null {
  if (state.eligibility.read || state.pending || state.pagePending) return null;
  if (state.connection !== 'connected') return 'Connect the agent to read changes.';
  if (activeRun(state.run)) return 'Available when the current run finishes.';
  return 'This Mac is busy applying changes. Reading and choosing resume when it finishes.';
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
  return <section className="card changes-preview" aria-labelledby="changes-preview-h">
    <div className="card-head"><div><h2 id="changes-preview-h">{title}</h2>
      <p>{change.kind === 'followProfile' ? `From ${repoName(change.repoUrl)}. ` : ''}Preview only. Nothing is written until you apply.</p></div></div>
    {state.previewNotice ? <p className="notice" role="status">{state.previewNotice}</p> : null}
    {dropped?.holds.length ? <div className="preview-group"><h3>Holds that end with the switch</h3><ul className="changes-list" aria-label="Dropped holds">{dropped.holds.map(id => <li key={id}><Label label={itemLabel(id)} /></li>)}</ul></div> : null}
    {dropped?.overrides.length ? <div className="preview-group"><h3>Overrides removed</h3><ul className="changes-list" aria-label="Dropped overrides">{dropped.overrides.map(path => <li key={path}>{overrideLabel(path)}</li>)}</ul></div> : null}
    {change.kind === 'setupApply' ? <ul className="changes-list" aria-label="Reviewed choices">{change.choices.map(choice => <li key={choice.itemId}><Label label={itemLabel(choice.itemId)} /><small>{STAGED[choice.action]}</small></li>)}</ul> : null}
    {change.kind === 'reconcile' ? <ul className="changes-list" aria-label="Changes to apply">{change.only.map(key => <li key={key}><Label label={keyLabel(key, state.inspection)} /></li>)}</ul>
      : preview.plan.steps.length ? <ol className="steps setup-sync-steps" aria-label="Planned steps">{preview.plan.steps.map((step, index) => <li key={index}><span>{step.summary}</span></li>)}</ol>
      : change.kind === 'setupApply' ? <p className="muted">Nothing on this Mac changes yet. Apply saves your choices.</p> : null}
    {preview.plan.skipped.length ? <div className="preview-group"><h3>Left out</h3><ul className="changes-list" aria-label="Left out">{preview.plan.skipped.map((step, index) => <li key={index}><Label label={keyLabel(step.key, state.inspection)} /><small>{step.reason}</small></li>)}</ul></div> : null}
    {'actionEffects' in preview ? preview.actionEffects?.map(effect => <p className="muted" key={effect}>{effect}</p>) : null}
    {change.kind === 'setupApply' ? <p className="muted">Items you don't choose will be held. Overrides and files your choices replace are backed up before writing.</p> : null}
    <div className="setup-sync-actions"><button className="primary" disabled={!state.eligibility.apply} onClick={() => void controller.apply()}>{apply}</button>
      <button disabled={state.pending} onClick={() => controller.cancelPreview()}>Cancel</button></div>
  </section>;
}

// Planned steps of a run, when its acceptance records them.
const plannedSteps = (run: RunView) => (run.intent as { parity?: { plannedKeys?: readonly string[] } }).parity?.plannedKeys?.length ?? 0;

// One run: active, or started in this window. Interrupted and abandoned runs show as recovery instead.
export function RunCard({ run, state, controller }: { run: RunView; state: SetupSyncState; controller: Pick<Actions, 'cancel'> }) {
  if (run.state === 'interrupted' || run.state === 'abandoned') return null;
  const result = run.result, ok = run.steps.filter(step => step.outcome === 'ok').length, failed = run.steps.filter(step => step.outcome === 'failed').length;
  const total = Math.max(plannedSteps(run), run.steps.length), running = activeRun(run);
  const outcome = !result ? (run.steps.length ? `${ok} of ${count(total, 'step')} done${failed ? `, ${failed} failed` : ''}.` : 'Starting.')
    : result.status === 'done' ? `${count(result.ok, 'change')} applied${result.failed ? `, ${result.failed} failed` : ''}.`
    : result.status === 'cancelled' ? `Cancelled. ${count(result.remaining.length, 'change')} not started.`
    : errorText(result.message);
  return <section className="card changes-run" aria-labelledby="changes-run-h">
    <div className="card-head"><div><h2 id="changes-run-h">{changeTitle(run.intent.change.kind)}</h2></div>
      <div className="actions"><span className={`pill ${RUN_TONE[run.state]}`}>{running ? <span className="spinner" aria-hidden="true" /> : null}{RUN_STATE[run.state]}</span>
        {state.eligibility.cancel ? <button onClick={() => void controller.cancel()} disabled={state.pending}>Cancel</button> : null}</div></div>
    {running && total ? <progress aria-label={`${changeTitle(run.intent.change.kind)} progress`} value={run.steps.length} max={total} /> : null}
    <p role="status" className={result && result.status !== 'done' && result.status !== 'cancelled' ? 'alert' : 'muted'}>{outcome}</p>
    {run.installation ? <p className="muted">{run.installation.message}</p> : null}
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

function Row({ row, index, state, controller }: { row: ReviewRow; index: number; state: SetupSyncState; controller: Actions }) {
  const staged = state.choices.find(choice => choice.itemId === row.itemId);
  // A bulk take stages accept, which also releases a held row.
  const chosen = staged?.action === 'accept' && row.held ? { ...staged, action: 'release' as const } : staged;
  const actions: SetupChoice['action'][] = ['hold', row.held ? 'release' : 'accept', ...(row.conflict ? ['takeTheirs' as const] : [])];
  const label = itemLabel(row.itemId);
  return <li className="row setup-sync-row">
    <div className="row-main"><span className="row-title"><Label label={label} /></span>
      {row.held || row.conflict ? <span className="row-sub">{[row.held ? 'On hold at the current value' : '', row.conflict ? 'This Mac overrides this value' : ''].filter(Boolean).join(' · ')}</span> : null}</div>
    <div className="row-trail"><span className={`pill ${CHANGE_TONE[row.change]}`}>{CHANGE[row.change]}</span></div>
    <div className="row-detail">
      <fieldset className="setup-sync-choices"><legend className="sr-only">Choice for {label.text}</legend>
        {actions.map(action => <label key={action} className="setup-sync-choice"><input type="radio" name={`incoming-${index}`} value={action}
          checked={chosen?.action === action} disabled={!state.eligibility.choose} onChange={() => controller.choose({ itemId: row.itemId, action })} />{pairLabel(row, action)}</label>)}
      </fieldset>
      <details className="setup-sync-values"><summary>Values and differences</summary>
        {([['Current', row.before], ['Offered', row.after], ["This Mac's", row.mine]] as const).map(([name, value]) => <div key={name}>
          <p className="setup-sync-label">{name}</p><pre className="setup-sync-diff" tabIndex={0} aria-label={`${name} value of ${label.text}`}><code>{value ?? 'None'}</code></pre>
        </div>)}
        {row.truncated ? <p className="setup-sync-warn">Values are shortened. Only part of each value is shown.</p> : null}
      </details>
    </div>
  </li>;
}

// Groups with no row on this page have nothing to decide here.
function Pins({ review, state, controller }: { review: Review; state: SetupSyncState; controller: Actions }) {
  const onPage = new Set(review.rows.map(row => row.itemId));
  const groups = review.pinGroups.filter(group => group.itemIds.some(id => onPage.has(id)));
  if (!groups.length) return null;
  return <div className="rows setup-sync-pins" role="group" aria-label="Source pins">
    <p className="group-label">Source pins</p>
    <p className="row-sub pins-note">A pin moves a whole source, so choose one action for all its items, including those on other pages.</p>
    {groups.map(group => { const elsewhere = group.itemIds.filter(id => !onPage.has(id)).length; return <fieldset key={group.source} className="setup-sync-pin">
      <legend className="sr-only">{group.source}</legend>
      <div className="row">
        <div className="row-main"><span className="row-title" aria-hidden="true">{group.source}</span>
          <span className="row-sub">{count(group.itemIds.length, 'affected item')}, {elsewhere} not on this page</span></div>
        <div className="row-trail"><button disabled={!state.eligibility.choose} onClick={() => controller.chooseAll('accept', group.source)}>Take this group</button>
          <button disabled={!state.eligibility.choose} onClick={() => controller.chooseAll('hold', group.source)}>Hold this group</button></div>
        <div className="row-detail">
          <details><summary>Affected items</summary><ul className="changes-list">{group.itemIds.map(id => <li key={id}><Label label={itemLabel(id)} /></li>)}</ul></details>
          {state.groupErrors[group.source] ? <p className="alert" role="alert">{state.groupErrors[group.source]}</p> : null}
        </div>
      </div>
    </fieldset>; })}
  </div>;
}

function Incoming({ review, state, controller }: { review: Review; state: SetupSyncState; controller: Actions }) {
  const can = state.eligibility, { incoming, held } = incomingCounts(review);
  const from = state.profiles?.followed?.profile ?? 'your profile';
  const page = state.pageIndex ? ` · page ${state.pageIndex + 1}` : '';
  const rows = review.rows.length > 0;
  return <section className="card setup-sync-review" aria-labelledby="changes-incoming-h">
    <div className="card-head"><div><h2 id="changes-incoming-h">{incoming + held ? `${count(incoming, 'incoming change')} from ${from}${held ? ` · ${held} on hold` : ''}${page}` : `Nothing incoming from ${from}${page}`}</h2>
      <p>{rows ? "Choose for each item. Items you don't choose will be held." : "You're up to date."}</p></div>
      {review.rows.some(row => row.change !== 'unchanged') ? <div className="actions" role="group" aria-label="Choose for every incoming row">
        <button disabled={!can.choose} onClick={() => controller.chooseAll('accept')}>Take all incoming</button>
        <button disabled={!can.choose} onClick={() => controller.chooseAll('hold')}>Hold all incoming</button></div> : null}</div>
    {review.pinGroups.length ? <Pins review={review} state={state} controller={controller} /> : null}
    {rows ? <ul className="rows setup-sync-rows">{review.rows.map((row, index) => <Row key={row.itemId} row={row} index={index} state={state} controller={controller} />)}</ul> : null}
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
    <p className="muted">This Mac hasn't been inspected yet.</p></section>;
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
  const reason = unavailableReason(state);
  return <div className="setup-sync-view changes-view">
    <header className="page-header"><div><h1>Changes</h1><p className="intro">What your profile brings and what this Mac still needs.</p></div>
      <div className="header-actions">{state.connection !== 'connected' ? <span className={`pill connection ${state.connection}`}>{CONNECTION[state.connection]}</span> : null}
        <button disabled={!can.read} title={reason ?? undefined} onClick={() => void controller.reload()}>Reload</button>
        <button disabled={!can.refetch} title={reason ?? undefined} onClick={() => void controller.refetch()}>Check for new changes</button></div></header>
    {state.error && !Object.keys(state.groupErrors).length ? <p className="alert" role="alert">{state.error}</p> : null}
    {reason && !activeRun(run) ? <p className="notice busy-line">{state.connection === 'connected' ? <span className="spinner" aria-hidden="true" /> : null}<span>{reason}</span></p> : null}
    <p className="setup-sync-detail" role="status">{state.pending ? 'Reading…' : state.message}</p>
    <PreviewPanel state={state} controller={controller} />
    {run ? <RunCard run={run} state={state} controller={controller} /> : null}
    {run ? <RunRecovery run={run} onRepreview={() => void controller.repreview()} onAskAbandon={() => controller.askAbandon()} onAbandon={() => void controller.abandon()}
      onKeep={() => controller.keepRun()} confirming={state.confirmingAbandon} disabled={!can.read} /> : null}
    <Following state={state} controller={controller} repoUrl={repoUrl} />
    {review ? <Incoming review={review} state={state} controller={controller} /> : null}
    <OnThisMac state={state} controller={controller} onOpenProfiles={onOpenProfiles} />
    <Details state={state} />
  </div>;
}
