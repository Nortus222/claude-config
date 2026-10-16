import React from 'react';
import type { OperationOutput } from '@nortuscc/agent/operations';
import type { SetupChoice, SetupSyncController, SetupSyncState } from './setup-sync-controller.ts';
import { RunRecovery } from './run-recovery.tsx';

type Review = OperationOutput<'setupReview'>;
type ReviewRow = Review['rows'][number];
type Actions = Pick<SetupSyncController, 'reload' | 'refetch' | 'choose' | 'chooseAll' | 'preview' | 'apply' | 'cancel' | 'repreview' | 'abandon' | 'page' | 'selectSource' | 'switchProfile' | 'followSharedLink'>;
const CHANGE = { added: 'Added', changed: 'Changed', removed: 'Removed', unchanged: 'Unchanged' };

function SourceSummary({ state, controller }: { state: SetupSyncState; controller: Actions }) {
  const { source, review } = state;
  const [link, setLink] = React.useState('');
  const followed = state.profiles?.followed;
  return <section className="card setup-sync-summary" aria-labelledby="setup-sync-source-h">
    <p className="eyebrow">SETUP REPOSITORY</p><h2 id="setup-sync-source-h">{followed ? `Following ${followed.profile} from ${followed.repoUrl}` : source?.repository ?? 'No setup selected'}</h2>
    {state.profileNotice ? <p className="notice">{state.profileNotice}</p> : null}
    {followed ? <label>Switch profile <select aria-label="Switch profile" value={followed.profile} disabled={!state.eligibility.read} onChange={event => void controller.switchProfile(event.target.value)}>{state.profiles?.available.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label> : null}
    <form onSubmit={event => { event.preventDefault(); void controller.followSharedLink(link); }}><label>Follow a shared link <input value={link} onChange={event => setLink(event.target.value)} disabled={!state.eligibility.read} placeholder="nortuscc://follow/… or setup ID" /></label><button disabled={!state.eligibility.read || !link.trim()}>Preview follow</button></form>
    {state.sources.length > 1 ? <label>Setup <select value={source?.setupId ?? ''} disabled={!state.eligibility.read}
      onChange={event => void controller.selectSource(event.target.value)}>{state.sources.map(source => <option key={source.setupId} value={source.setupId}>{source.repository ?? source.setupId}</option>)}</select></label> : null}
    {source ? <p>{source.accountId ? 'Hosted setup' : 'Local setup'} · {source.trusted ? 'Trusted on this Mac' : 'Not trusted on this Mac'}</p> : null}
    {review ? <dl className="setup-sync-facts"><dt>Offered revision</dt><dd><code>{review.revision.kind === 'local' ? review.revision.commit : `${review.revision.number} (${review.revision.commitSha})`}</code></dd></dl> : null}
  </section>;
}

// Accept keeps local overrides; replacing one requires a separate, explicit choice.
function pairLabel(row: ReviewRow, action: SetupChoice['action']) {
  if (action === 'hold') return 'Hold at the current Setup value';
  if (action === 'takeTheirs') return row.kind === 'file' ? "Replace this Mac's file with the setup version (backed up first)" : 'Use the setup value and remove this one override (backed up first)';
  const incoming = action === 'release' ? 'Release the hold and take the setup value' : 'Take the setup value';
  return row.conflict ? `${incoming} · keep this Mac's ${row.kind === 'file' ? 'file' : 'override'}` : incoming;
}
function Row({ row, state, controller }: { row: ReviewRow; state: SetupSyncState; controller: Actions }) {
  const staged = state.choices.find(choice => choice.itemId === row.itemId);
  // A bulk take stages accept, which also releases a held row.
  const chosen = staged?.action === 'accept' && row.held ? { ...staged, action: 'release' as const } : staged;
  const actions: SetupChoice['action'][] = ['hold', row.held ? 'release' : 'accept', ...(row.conflict ? ['takeTheirs' as const] : [])];
  return <li className="setup-sync-row">
    <div className="setup-sync-row-head"><strong>{row.itemId}</strong><span className="setup-sync-tag">{row.kind}</span><span className="setup-sync-tag">{CHANGE[row.change]}</span></div>
    {row.held ? <small>Held at the current Setup value</small> : null}
    {row.conflict ? <small>This Mac overrides this value</small> : null}
    <details className="setup-sync-values"><summary>Values and differences</summary>
      {([['Current', row.before], ['Offered', row.after], ["This Mac's", row.mine]] as const).map(([label, value]) => <div key={label}>
        <p className="setup-sync-label">{label}</p><pre className="setup-sync-diff" tabIndex={0} aria-label={`${label} value of ${row.itemId}`}><code>{value ?? 'None'}</code></pre>
      </div>)}
      {row.truncated ? <p className="setup-sync-warn">Values are truncated. Only the bounded part supplied by the agent is shown.</p> : null}
    </details>
    <fieldset className="setup-sync-choices"><legend>Choice for {row.itemId}</legend>
      {actions.map(action => <label key={action} className="setup-sync-choice"><input type="radio" name={`setup-sync-${row.itemId}`} value={action}
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
      <p>{group.itemIds.length} affected items, {group.itemIds.filter(id => !onPage.has(id)).length} not on this page</p>
      <div className="setup-sync-actions"><button disabled={!state.eligibility.choose} onClick={() => controller.chooseAll('accept', group.source)}>Take this group</button>
        <button disabled={!state.eligibility.choose} onClick={() => controller.chooseAll('hold', group.source)}>Hold this group</button></div>
      <details><summary>Affected items</summary><ul>{group.itemIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></details>
      {state.groupErrors[group.source] ? <p className="alert" role="alert">{state.groupErrors[group.source]}</p> : null}
    </fieldset>)}
  </div>;
}
function PreviewPanel({ state, controller }: { state: SetupSyncState; controller: Actions }) {
  const preview = state.preview;
  if (!preview) return null;
  return <section className="card setup-sync-preview" aria-labelledby="setup-sync-preview-h"><p className="eyebrow">PREVIEW</p><h2 id="setup-sync-preview-h">Planned changes</h2>
    {'droppedChoices' in preview ? <div><h3>Choices removed on switch</h3><ul aria-label="Dropped holds">{preview.droppedChoices.holds.map(id => <li key={id}>Hold: <code>{id}</code></li>)}</ul><ul aria-label="Dropped overrides">{preview.droppedChoices.overrides.map(id => <li key={id}>Override: <code>{id}</code></li>)}</ul></div> : null}
    {preview.change.kind === 'setupApply' ? <ul aria-label="Reviewed choices">{preview.change.choices.map(choice => <li key={choice.itemId}><code>{choice.itemId}</code> {({ accept: 'Take the setup value and keep local overrides', hold: 'Hold at the current Setup value', release: 'Release the hold and take the setup value', takeTheirs: 'Use the setup value and replace the local value (backed up first)' })[choice.action]}</li>)}</ul> : null}
    {preview.plan.steps.length ? <ol className="steps setup-sync-steps" aria-label="Planned steps">{preview.plan.steps.map((step, index) => <li key={`${index}:${step.key}`}><span>{step.summary}</span><small>{step.domain} · {step.action}</small></li>)}</ol>
      : <p>No machine steps are planned. Apply saves the reviewed choices.</p>}
    {preview.plan.skipped.length ? <ul>{preview.plan.skipped.map((step, index) => <li key={index}><code>{step.key}</code> {step.reason}</li>)}</ul> : null}
    {'actionEffects' in preview ? preview.actionEffects?.map(effect => <p key={effect}>{effect}</p>) : null}
    <p>Items you don't choose will be held. Overrides and files your choices replace are backed up before writing.</p>
    <button className="primary" disabled={!state.eligibility.apply} onClick={() => void controller.apply()}>Apply reviewed choices</button>
  </section>;
}
export function SetupSyncView({ state, controller }: { state: SetupSyncState; controller: Actions }) {
  if (!state.native) return <div className="setup-sync-view"><h1>Setup</h1><p className="notice">Open the desktop app to review Setup. Browser preview has no agent connection.</p></div>;
  const { review, run, eligibility: can } = state;
  return <div className="setup-sync-view">
    <header><div><p className="eyebrow">SHARED CONFIGURATION</p><h1>Setup</h1><p className="intro">Review incoming changes for this Mac. Preview, then Apply.</p></div>
      <div className="setup-sync-actions"><button disabled={!can.read} onClick={() => void controller.reload()}>Reload cached state</button>
        <button disabled={!can.refetch} onClick={() => void controller.refetch()}>Refetch</button><span className={`connection ${state.connection}`}>{state.connection}</span></div></header>
    {state.error && !Object.keys(state.groupErrors).length ? <p className="alert" role="alert">{state.error}</p> : null}
    <p className="setup-sync-detail" role="status">{state.pending ? 'Reading Setup operations...' : state.message}</p>
    <SourceSummary state={state} controller={controller} />
    {run ? <section className="card" aria-label="Setup run"><h2>Run {run.state}</h2>
      {run.steps.length ? <ul>{run.steps.map(step => <li key={step.key}><code>{step.key}</code> {step.outcome} {step.note}</li>)}</ul> : null}
      {run.result && 'message' in run.result ? <p>{run.result.message}</p> : null}
      {can.cancel ? <button onClick={() => void controller.cancel()} disabled={state.pending}>Cancel</button> : null}
    </section> : null}
    {run ? <RunRecovery run={run} onRepreview={() => void controller.repreview()} onAbandon={() => void controller.abandon()} disabled={!can.read} /> : null}
    {review ? <section className="card setup-sync-review" aria-labelledby="setup-sync-review-h"><p className="eyebrow">INCOMING CHANGES</p><h2 id="setup-sync-review-h">{review.rows.length ? `Review page ${state.pageIndex + 1}` : 'No incoming rows in this review'}</h2>
      {review.rows.some(row => row.change !== 'unchanged') ? <div className="setup-sync-actions" role="group" aria-label="Choose for every incoming row">
        <button disabled={!can.choose} onClick={() => controller.chooseAll('accept')}>Take all incoming</button>
        <button disabled={!can.choose} onClick={() => controller.chooseAll('hold')}>Hold all incoming</button></div> : null}
      {review.pinGroups.length ? <Pins review={review} state={state} controller={controller} /> : null}
      <ul className="setup-sync-rows">{review.rows.map(row => <Row key={row.itemId} row={row} state={state} controller={controller} />)}</ul>
      <nav className="setup-sync-actions" aria-label="Review pages"><button disabled={!can.browse || !state.pageIndex} onClick={() => void controller.page('previous')}>Previous page</button>
        <button disabled={!can.browse || !review.nextCursor} onClick={() => void controller.page('next')}>Next page</button></nav>
      <p className="notice">Items you don't choose will be held.</p><div className="setup-sync-actions"><button disabled={!can.preview} onClick={() => void controller.preview()}>Preview</button><span>{state.choices.length} explicit choices. Preview writes nothing.</span></div>
      {state.previewError && !Object.keys(state.groupErrors).length ? <p className="alert" role="alert">{state.previewError}</p> : null}
    </section> : null}
    <PreviewPanel state={state} controller={controller} />
  </div>;
}
