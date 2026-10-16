import React from 'react';
import type { InspectResult } from '@nortuscc/agent/ipc/protocol';
import type { ChangePreview, OperationOutput, RunView } from '@nortuscc/agent/operations';
import { selectedLocal, type SetupChoice, type SetupSyncController, type SetupSyncState } from './setup-sync-controller.ts';
import { RunRecovery } from './run-recovery.tsx';
import { changeTitle, errorText, itemLabel, type ItemLabel } from './copy.ts';

// Vite defines `import.meta.env`; plain Node test runs have no CSS loader and skip the stylesheet.
if (import.meta.env) void import('./changes.css');

type Review = OperationOutput<'setupReview'>;
type ReviewRow = Review['rows'][number];
type Observed = InspectResult['items'][number];
type Actions = Pick<SetupSyncController, 'reload' | 'refetch' | 'choose' | 'chooseAll' | 'preview' | 'apply' | 'cancel' | 'repreview' | 'abandon' | 'page' | 'selectSource' | 'switchProfile' | 'followSharedLink'
  | 'toggleLocal' | 'previewLocal' | 'cancelPreview'>;
type Props = { state: SetupSyncState; controller: Actions; onOpenProfiles?: () => void };

const CHANGE = { added: 'Added', changed: 'Changed', removed: 'Removed', unchanged: 'Unchanged' };
const CONNECTION = { connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', browser: 'Browser preview' };
const RUN_STATE: Readonly<Record<RunView['state'], string>> = { accepted: 'Starting', running: 'In progress', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', abandoned: 'Abandoned' };
const AGENTS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex' };
// Why an item is waiting to apply, by its inspected state.
const WAITING: Readonly<Record<string, string>> = {
  missing: 'Not installed on this Mac yet', 'off-pin': 'Not at the version your profile pins', disabled: 'Turned off; it will be removed from this Mac',
  'repo-ahead': 'Your profile has a newer version', unmanaged: 'Not set up from your profile yet',
};
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const short = (revision: string) => revision.slice(0, 12);
const plain = (text: string): ItemLabel => ({ lead: text, name: '', tail: '', text });

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

// The page's only Apply: whatever was last previewed, from either section.
function PreviewPanel({ state, controller }: Props) {
  const preview = state.preview;
  if (!preview) return null;
  const change = preview.change, { title, apply } = previewCopy(preview, state);
  const dropped = 'droppedChoices' in preview ? preview.droppedChoices : null;
  return <section className="card changes-preview" aria-labelledby="changes-preview-h"><p className="eyebrow">PREVIEW</p><h2 id="changes-preview-h">{title}</h2>
    {state.previewNotice ? <p className="notice" role="status">{state.previewNotice}</p> : null}
    {change.kind === 'followProfile' ? <p>From {change.repoUrl}</p> : null}
    {dropped?.holds.length ? <div><h3>Holds that end with the switch</h3><ul aria-label="Dropped holds">{dropped.holds.map(id => <li key={id}><Label label={itemLabel(id)} /></li>)}</ul></div> : null}
    {dropped?.overrides.length ? <div><h3>Overrides removed</h3><ul aria-label="Dropped overrides">{dropped.overrides.map(path => <li key={path}>{overrideLabel(path)}</li>)}</ul></div> : null}
    {change.kind === 'setupApply' ? <ul className="changes-list" aria-label="Reviewed choices">{change.choices.map(choice => <li key={choice.itemId}><Label label={itemLabel(choice.itemId)} /><small>{STAGED[choice.action]}</small></li>)}</ul> : null}
    {change.kind === 'reconcile' ? <ul className="changes-list" aria-label="Changes to apply">{change.only.map(key => <li key={key}><Label label={keyLabel(key, state.inspection)} /></li>)}</ul>
      : preview.plan.steps.length ? <ol className="steps setup-sync-steps" aria-label="Planned steps">{preview.plan.steps.map((step, index) => <li key={index}><span>{step.summary}</span></li>)}</ol>
      : change.kind === 'setupApply' ? <p>Nothing on this Mac changes yet. Apply saves your choices.</p> : null}
    {preview.plan.skipped.length ? <div><h3>Left out</h3><ul className="changes-list" aria-label="Left out">{preview.plan.skipped.map((step, index) => <li key={index}><Label label={keyLabel(step.key, state.inspection)} /><small>{step.reason}</small></li>)}</ul></div> : null}
    {'actionEffects' in preview ? preview.actionEffects?.map(effect => <p key={effect}>{effect}</p>) : null}
    {change.kind === 'setupApply' ? <p>Items you don't choose will be held. Overrides and files your choices replace are backed up before writing.</p> : null}
    <div className="setup-sync-actions"><button className="primary" disabled={!state.eligibility.apply} onClick={() => void controller.apply()}>{apply}</button>
      <button disabled={state.pending} onClick={() => controller.cancelPreview()}>Cancel</button></div>
  </section>;
}

// One run: active, or started in this window. Interrupted and abandoned runs show as recovery instead.
function RunCard({ run, state, controller }: { run: RunView; state: SetupSyncState; controller: Actions }) {
  if (run.state === 'interrupted' || run.state === 'abandoned') return null;
  const result = run.result, ok = run.steps.filter(step => step.outcome === 'ok').length;
  const outcome = !result ? (run.steps.length ? `${ok} of ${count(run.steps.length, 'step')} done.` : 'Starting.')
    : result.status === 'done' ? `${count(result.ok, 'change')} applied${result.failed ? `, ${result.failed} failed` : ''}.`
    : result.status === 'cancelled' ? `Cancelled. ${count(result.remaining.length, 'change')} not started.`
    : errorText(result.message);
  return <section className="card changes-run" aria-labelledby="changes-run-h">
    <h2 id="changes-run-h">{changeTitle(run.intent.change.kind)} · {RUN_STATE[run.state]}</h2>
    <p role="status">{outcome}</p>
    {run.installation ? <p>{run.installation.message}</p> : null}
    {state.eligibility.cancel ? <button onClick={() => void controller.cancel()} disabled={state.pending}>Cancel</button> : null}
  </section>;
}

function Following({ state, controller }: Props) {
  const { source } = state;
  const [link, setLink] = React.useState('');
  const followed = state.profiles?.followed;
  return <section className="card setup-sync-summary" aria-labelledby="changes-following-h">
    <p className="eyebrow">FOLLOWING</p><h2 id="changes-following-h">{followed ? `Following ${followed.profile} from ${followed.repoUrl}` : source?.repository ? `Using ${source.repository}` : "This Mac doesn't follow a profile yet"}</h2>
    {state.profileNotice ? <p className="notice">{state.profileNotice}</p> : null}
    {followed ? <label>Profile <select aria-label="Profile" value={state.switchTarget ?? followed.profile} disabled={!state.eligibility.read} onChange={event => void controller.switchProfile(event.target.value)}>{state.profiles?.available.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label> : null}
    <form onSubmit={event => { event.preventDefault(); void controller.followSharedLink(link); }}><label>Follow a shared link <input value={link} onChange={event => setLink(event.target.value)} disabled={!state.eligibility.read} placeholder="nortuscc://follow/…" /></label><button disabled={!state.eligibility.read || !link.trim()}>Preview follow</button></form>
    {state.sources.length > 1 ? <label>Source <select value={source?.setupId ?? ''} disabled={!state.eligibility.read}
      onChange={event => void controller.selectSource(event.target.value)}>{state.sources.map((item, index) => <option key={item.setupId} value={item.setupId}>{item.repository ?? `Source ${index + 1}`}</option>)}</select></label> : null}
    {source && !source.trusted ? <p className="notice">Not trusted on this Mac.</p> : null}
  </section>;
}

function Row({ row, index, state, controller }: { row: ReviewRow; index: number; state: SetupSyncState; controller: Actions }) {
  const staged = state.choices.find(choice => choice.itemId === row.itemId);
  // A bulk take stages accept, which also releases a held row.
  const chosen = staged?.action === 'accept' && row.held ? { ...staged, action: 'release' as const } : staged;
  const actions: SetupChoice['action'][] = ['hold', row.held ? 'release' : 'accept', ...(row.conflict ? ['takeTheirs' as const] : [])];
  const label = itemLabel(row.itemId);
  return <li className="setup-sync-row">
    <div className="setup-sync-row-head"><Label label={label} /><span className="setup-sync-tag">{CHANGE[row.change]}</span></div>
    {row.held ? <small>On hold at the current value</small> : null}
    {row.conflict ? <small>This Mac overrides this value</small> : null}
    <details className="setup-sync-values"><summary>Values and differences</summary>
      {([['Current', row.before], ['Offered', row.after], ["This Mac's", row.mine]] as const).map(([name, value]) => <div key={name}>
        <p className="setup-sync-label">{name}</p><pre className="setup-sync-diff" tabIndex={0} aria-label={`${name} value of ${label.text}`}><code>{value ?? 'None'}</code></pre>
      </div>)}
      {row.truncated ? <p className="setup-sync-warn">Values are shortened. Only part of each value is shown.</p> : null}
    </details>
    <fieldset className="setup-sync-choices"><legend>Choice for {label.text}</legend>
      {actions.map(action => <label key={action} className="setup-sync-choice"><input type="radio" name={`incoming-${index}`} value={action}
        checked={chosen?.action === action} disabled={!state.eligibility.choose} onChange={() => controller.choose({ itemId: row.itemId, action })} />{pairLabel(row, action)}</label>)}
      {!chosen ? <p className="setup-sync-note">No choice selected.</p> : null}
    </fieldset>
  </li>;
}

// Groups with no row on this page have nothing to decide here.
function Pins({ review, state, controller }: { review: Review; state: SetupSyncState; controller: Actions }) {
  const onPage = new Set(review.rows.map(row => row.itemId));
  const groups = review.pinGroups.filter(group => group.itemIds.some(id => onPage.has(id)));
  if (!groups.length) return null;
  return <div className="setup-sync-pins" role="group" aria-label="Source pins"><h3>Source pins</h3>
    <p className="setup-sync-note">A pin moves for a whole source. Choose the same action for every affected item, including rows on other pages.</p>
    {groups.map(group => <fieldset key={group.source} className="setup-sync-pin"><legend>{group.source}</legend>
      <p>{count(group.itemIds.length, 'affected item')}, {group.itemIds.filter(id => !onPage.has(id)).length} not on this page</p>
      <div className="setup-sync-actions"><button disabled={!state.eligibility.choose} onClick={() => controller.chooseAll('accept', group.source)}>Take this group</button>
        <button disabled={!state.eligibility.choose} onClick={() => controller.chooseAll('hold', group.source)}>Hold this group</button></div>
      <details><summary>Affected items</summary><ul>{group.itemIds.map(id => <li key={id}><Label label={itemLabel(id)} /></li>)}</ul></details>
      {state.groupErrors[group.source] ? <p className="alert" role="alert">{state.groupErrors[group.source]}</p> : null}
    </fieldset>)}
  </div>;
}

function Incoming({ review, state, controller }: { review: Review; state: SetupSyncState; controller: Actions }) {
  const can = state.eligibility, incoming = review.rows.filter(row => row.change !== 'unchanged').length;
  const from = state.profiles?.followed?.profile ?? 'your profile';
  return <section className="card setup-sync-review" aria-labelledby="changes-incoming-h"><p className="eyebrow">INCOMING</p>
    <h2 id="changes-incoming-h">{review.rows.length ? `${count(incoming, 'incoming change')} from ${from}${state.pageIndex ? ` · page ${state.pageIndex + 1}` : ''}` : `No incoming changes from ${from}`}</h2>
    {incoming ? <div className="setup-sync-actions" role="group" aria-label="Choose for every incoming row">
      <button disabled={!can.choose} onClick={() => controller.chooseAll('accept')}>Take all incoming</button>
      <button disabled={!can.choose} onClick={() => controller.chooseAll('hold')}>Hold all incoming</button></div> : null}
    {review.pinGroups.length ? <Pins review={review} state={state} controller={controller} /> : null}
    <ul className="setup-sync-rows">{review.rows.map((row, index) => <Row key={row.itemId} row={row} index={index} state={state} controller={controller} />)}</ul>
    {review.nextCursor || state.pageIndex ? <nav className="setup-sync-actions" aria-label="Review pages"><button disabled={!can.browse || !state.pageIndex} onClick={() => void controller.page('previous')}>Previous page</button>
      <button disabled={!can.browse || !review.nextCursor} onClick={() => void controller.page('next')}>Next page</button></nav> : null}
    <p className="notice">Items you don't choose will be held.</p><div className="setup-sync-actions"><button disabled={!can.preview} onClick={() => void controller.preview()}>Preview</button><span>{count(state.choices.length, 'choice')} made. Preview writes nothing.</span></div>
    {state.previewError && !Object.keys(state.groupErrors).length ? <p className="alert" role="alert">{state.previewError}</p> : null}
  </section>;
}

// This Mac's own items: those waiting to apply are checked into one reconcile; the rest name their next step.
function OnThisMac({ state, controller, onOpenProfiles }: Props) {
  const { inspection, eligibility: can } = state;
  if (!inspection) return <section className="card changes-local" aria-labelledby="changes-local-h"><p className="eyebrow">ON THIS MAC</p><h2 id="changes-local-h">This Mac</h2>
    <p className="setup-sync-note">This Mac hasn't been inspected yet.</p></section>;
  const excluded = new Set(state.excluded), selected = selectedLocal(state).length;
  const waiting = inspection.items.filter(item => item.disposition === 'apply');
  const captured = inspection.items.filter(item => item.disposition === 'capture');
  const blocked = inspection.items.filter(item => item.disposition === 'blocked');
  const issues = inspection.profile.issues.length, unread = inspection.probeErrors.length;
  return <section className="card changes-local" aria-labelledby="changes-local-h"><p className="eyebrow">ON THIS MAC</p>
    <h2 id="changes-local-h">{waiting.length ? `${count(waiting.length, 'change')} waiting to apply on this Mac` : 'Nothing waiting to apply on this Mac'}</h2>
    {issues ? <p className="notice">Your profile has {count(issues, 'problem')}, so changes can’t be applied to this Mac. Open Details below to see {issues === 1 ? 'it' : 'them'}.</p> : null}
    {unread ? <p className="notice">{count(unread, 'part')} of this Mac couldn’t be read. Open Details below to see why.</p> : null}
    {waiting.length ? <>
      <ul className="setup-sync-rows">{waiting.map(item => { const label = observedLabel(item); return <li key={item.key} className="setup-sync-row">
        <label className="setup-sync-choice"><input type="checkbox" aria-label={`Include ${label.text}`} checked={!excluded.has(item.key)} disabled={!can.local} onChange={() => controller.toggleLocal(item.key)} />
          <span><Label label={label} /><small>{WAITING[item.state] ?? item.note ?? 'Waiting to apply'}</small></span></label></li>; })}</ul>
      <div className="setup-sync-actions"><button disabled={!can.previewLocal} onClick={() => void controller.previewLocal()}>Preview</button><span>{selected} of {waiting.length} included. Preview writes nothing.</span></div>
    </> : null}
    {state.localError ? <p className="alert" role="alert">{state.localError}</p> : null}
    {captured.length ? <div className="changes-local-group"><h3>Changed on this Mac</h3>
      <p className="setup-sync-note">These differ from your profile. Save them to a profile draft to keep them.</p>
      <ul className="changes-list">{captured.map(item => <li key={item.key}><Label label={observedLabel(item)} /></li>)}</ul>
      {onOpenProfiles ? <button onClick={onOpenProfiles}>Open Profiles</button> : null}</div> : null}
    {blocked.length ? <div className="changes-local-group"><h3>Can’t be applied</h3>
      <ul className="changes-list">{blocked.map(item => <li key={item.key}><Label label={observedLabel(item)} /><small>{item.note ?? 'This Mac’s copy needs fixing by hand.'}</small></li>)}</ul>
      <p className="setup-sync-note">Fix these on this Mac, then reload.</p></div> : null}
  </section>;
}

// Provenance and raw facts for support: the only place keys, revisions and probe text appear.
function Details({ state }: { state: SetupSyncState }) {
  const { inspection, review } = state;
  if (!inspection && !review) return null;
  return <details className="changes-details"><summary>Details</summary>
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
export function SetupSyncView({ state, controller, onOpenProfiles }: Props) {
  if (!state.native) return <div className="setup-sync-view changes-view"><h1>Changes</h1><p className="notice">Open the desktop app to review changes. Browser preview has no agent connection.</p></div>;
  const { review, run, eligibility: can } = state;
  return <div className="setup-sync-view changes-view">
    <header><div><p className="eyebrow">THIS MAC</p><h1>Changes</h1><p className="intro">What your profile brings and what this Mac still needs. Preview, then apply.</p></div>
      <div className="setup-sync-actions"><button disabled={!can.read} onClick={() => void controller.reload()}>Reload</button>
        <button disabled={!can.refetch} onClick={() => void controller.refetch()}>Check for new changes</button><span className={`connection ${state.connection}`}>{CONNECTION[state.connection]}</span></div></header>
    {state.error && !Object.keys(state.groupErrors).length ? <p className="alert" role="alert">{state.error}</p> : null}
    <p className="setup-sync-detail" role="status">{state.pending ? 'Reading…' : state.message}</p>
    <PreviewPanel state={state} controller={controller} />
    {run ? <RunCard run={run} state={state} controller={controller} /> : null}
    {run ? <RunRecovery run={run} onRepreview={() => void controller.repreview()} onAbandon={() => void controller.abandon()} disabled={!can.read} /> : null}
    <Following state={state} controller={controller} />
    {review ? <Incoming review={review} state={state} controller={controller} /> : null}
    <OnThisMac state={state} controller={controller} onOpenProfiles={onOpenProfiles} />
    <Details state={state} />
  </div>;
}
