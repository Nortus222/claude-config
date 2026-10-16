import React from 'react';
import type { OperationOutput } from '@nortuscc/agent/operations';
import type { AuthorController, AuthorIntent, AuthorState } from './author-controller.ts';
import { RunRecovery } from './run-recovery.tsx';

export type AuthorProps = { state: AuthorState; controller: AuthorController };
type ProfileIssues = NonNullable<OperationOutput<'authorProfiles'>['issues']>;
// Lists profile issues as "<profile>: <message> (<path>)". `profile` keeps only that profile's issues
// and drops the name; `except` leaves one profile to its own section.
export function AuthorIssues({ issues, profile, except }: { issues: ProfileIssues | undefined; profile?: string; except?: string }) {
  const groups = (issues ?? []).filter(group => (profile === undefined || group.profile === profile) && group.profile !== except && group.issues.length);
  if (!groups.length) return null;
  return <div className="alert" role="alert"><h3>{profile === undefined ? 'Profile issues' : `Issues in ${profile}`}</h3><ul>{groups.flatMap(group => group.issues.map((issue, index) =>
    <li key={`${group.profile}:${index}`}>{profile === undefined ? <><strong>{group.profile}</strong>: </> : null}{issue.message} (<code>{issue.path}</code>)</li>))}</ul></div>;
}
export function AuthorFeedback({ state }: Pick<AuthorProps, 'state'>) {
  return <>
    {!state.canRead && !state.pending ? <p className="notice">Reconnect the local agent and finish any app maintenance to read author settings.</p> : null}
    {state.pending ? <p role="status">Reading or saving author settings…</p> : null}
    {state.message ? <p role="status">{state.message}</p> : null}
    {state.error ? <p className="alert" role="alert">{state.errorCode === 'UNAUTHORIZED' ? `${state.profiles ? `No access to ${state.profiles.repoUrl}` : state.error}. Check repository permission, then retry.`
      : state.errorCode === 'NOT_SIGNED_IN' ? 'Not signed in to GitHub, or GitHub is unreachable. Sign in or retry below.'
      : state.errorCode === 'APP_UNAVAILABLE' ? `${state.error}${state.error.includes('Follow your setup repository first')
        ? '. Open the Setup page and use its Follow controls.' : state.error.includes('gh is not installed') ? '. Install GitHub CLI using the link below.' : ''}` : state.error}</p> : null}
  </>;
}
export function intentText(intent: AuthorIntent): string {
  switch (intent.kind) {
    case 'includeSkill': case 'excludeSkill': return `${intent.kind === 'includeSkill' ? 'Include' : 'Exclude'} ${intent.source}:${intent.name} in ${intent.profile}`;
    case 'pin': return `Pin ${intent.source} to ${intent.commit}`;
    case 'unpin': return `Unpin ${intent.source}`;
    case 'captureFile': return `Capture ${intent.fileId} in ${intent.profile}, ${intent.choice.kind === 'updateShared' ? 'update shared file' : `own copy at ${intent.choice.repoPath}`}`;
    case 'createProfile': return `Create ${intent.profile}${intent.extends ? ` extending ${intent.extends}` : ''}`;
    case 'setFile': return `Set ${intent.fileId} in ${intent.profile} to ${intent.path ?? 'unmanaged'}`;
    case 'setIntegration': return `${intent.include ? 'Include' : 'Exclude'} integration ${intent.id} in ${intent.profile}`;
    case 'ignore': case 'unignore': return `${intent.kind === 'ignore' ? 'Ignore' : 'Unignore'} ${intent.source} at ${intent.revision}`;
  }
}
function GitHubCard({ state, controller }: AuthorProps) {
  const signingIn = state.run?.intent.change.kind === 'ghLogin' && (state.run.state === 'running' || state.run.state === 'accepted');
  const code = signingIn ? state.run?.ghCode : null;
  return <section className="card" aria-label="GitHub publishing access"><h2>GitHub</h2>
    <p>{state.gh?.state === 'missing' ? 'GitHub CLI is not installed' : state.gh?.state === 'signed-out' ? 'Not signed in to GitHub, or GitHub is unreachable'
      : state.gh?.state === 'ready' ? 'GitHub is ready' : 'GitHub state is unavailable'}</p>
    {state.gh?.state === 'missing' ? <a href="https://cli.github.com/" target="_blank" rel="noreferrer">Install GitHub CLI</a> : null}
    {signingIn ? <>
      <p role="status">GitHub sign-in is pending. Complete authorization in your browser.</p>
      {code ? <><p className="device-code" aria-label="GitHub one-time code">{code.code}</p><a href={code.url} target="_blank" rel="noreferrer">Open GitHub</a></>
        : <p>Waiting for GitHub's one-time code. Retry to read the current run.</p>}
    </> : state.gh?.state !== 'ready' && state.gh?.state !== 'missing' ? <button disabled={!state.canWrite} onClick={() => void controller.signIn()}>Sign in with GitHub</button> : null}
    <button disabled={!state.canRead} onClick={() => void controller.reload()}>Retry</button>
  </section>;
}
export function PublishView({ state, controller }: AuthorProps) {
  const run = state.publicationRun;
  const evidence = run?.publication;
  const recovery = run?.publicationRecovery;
  const preview = state.draftPreview;
  const busy = state.run?.state === 'running' || state.run?.state === 'accepted';
  const pushed = recovery?.published === true || evidence?.pushed === true;
  const unknown = recovery?.action === 're-check' || recovery?.published === 'unknown';
  const needsPreview = !pushed && (run?.result?.status === 'needs-preview' || recovery?.action === 're-preview');
  const pending = pushed && (recovery?.action === 'announce' || !!evidence?.pending.length || evidence?.tagged === false);
  return <div className="author-view" aria-label="Publish panel">
    <GitHubCard state={state} controller={controller} />
    <section className="card"><h2>Publish</h2>
      <p>Drafts stay on this Mac until you review the diff and publish to main.</p>
      <label className="field">Draft<select value={state.draft?.id ?? ''} disabled={!state.canWrite} onChange={e => controller.selectDraft(e.target.value)}>
        <option value="">New draft</option>{state.drafts.filter(d => 'intents' in d && d.repoUrl === state.profiles?.repoUrl).map(d => <option key={d.id} value={d.id}>{d.id}</option>)}
      </select></label>
      <div className="form-actions"><button disabled={!state.canWrite} onClick={() => controller.newDraft()}>New draft</button>
        <button disabled={!state.canWrite || !state.draft} onClick={() => void controller.deleteDraft()}>Delete draft</button></div>
      {state.drafts.filter(d => 'error' in d).map(d => 'error' in d ? <div className="alert" key={d.id}><p>Unreadable draft {d.id}: {d.error}</p>
        <button disabled={!state.canWrite} onClick={() => void controller.deleteDraft(d.id)}>Delete unreadable draft</button></div> : null)}
      {state.draft ? <ol aria-label="Draft intents">{state.draft.intents.map((intent, index) => <li key={index}>
        <span>{intentText(intent)}</span> <button disabled={!state.canWrite} aria-label={`Remove intent ${index + 1}`} onClick={() => void controller.removeIntent(index)}>Remove</button>
        {preview?.invalid.filter(i => i.index === index).map(i => <p className="alert" role="alert" key={i.reason}>{i.reason}</p>)}
      </li>)}</ol> : <p>No draft selected. Include a skill, pin a source or capture a file to start one.</p>}
      {preview ? <>
        <p>Affected profiles: {preview.affectedProfiles.join(', ') || 'None'}</p>
        {preview.invalid.filter(issue => issue.index === null).map((issue, index) => <p className="alert" role="alert" key={index}>{issue.reason}</p>)}
        {preview.invalid.length ? <p role="alert">Publish is disabled until every invalid intent or profile is corrected.</p> : null}
        {preview.truncated ? <p role="status">Diff preview is truncated. Publication includes the full files.</p> : null}
        {preview.diff.map(file => <div key={file.path}><h3>{file.path}</h3>
          <p>Before</p><pre className="setup-sync-diff" tabIndex={0} aria-label={`Before ${file.path}`}>{file.before ?? '(absent)'}</pre>
          <p>After</p><pre className="setup-sync-diff" tabIndex={0} aria-label={`After ${file.path}`}>{file.after ?? '(removed)'}</pre></div>)}
        {!preview.diff.length ? <p>No file changes.</p> : null}
      </> : <p>Preview the draft to see the diff and affected profiles.</p>}
      <div className="form-actions"><button disabled={!state.canWrite || !state.draft} onClick={() => void controller.previewDraft()}>Preview draft</button>
        <button className="primary" disabled={!state.canPublish} onClick={() => void controller.publish()}>Publish</button></div>
    </section>
    {run ? <section className="card" aria-label="Publication outcome"><h2>Publication outcome</h2>
      <p role="status">{unknown ? 'Push outcome unknown' : pending ? 'Published, not yet announced' : pushed ? 'Published' : needsPreview ? 'Needs preview. Main changed; review a new preview before publishing.' : `Publication ${run.state}. Push is not confirmed.`}</p>
      {evidence?.commit ? <p>Commit: <code>{evidence.commit}</code></p> : null}
      {evidence ? <><p>Tag: {evidence.tagged ? 'pushed' : 'not confirmed'}</p><p>Announced profiles: {evidence.announced.join(', ') || 'None'}</p><p>Pending profiles: {evidence.pending.join(', ') || 'None'}</p></> : null}
      {evidence?.unannounceable?.map(issue => <p role="alert" key={issue.profile}>{issue.profile}: Can't announce: {issue.reason}</p>)}
      {unknown ? <button disabled={!state.canRead} onClick={() => void controller.recheck()}>Re-check</button> : pending ? <button disabled={!state.canWrite} onClick={() => void controller.announce()}>Announce</button> : null}
      {run.result && 'message' in run.result ? <p>{run.result.message}</p> : null}
    </section> : null}
    {state.preview && 'actionEffects' in state.preview && !['publishDraft', 'announcePublication'].includes(state.preview.change.kind) ? <section className="card"><h2>Reviewed action</h2>
      <ul>{(state.preview.actionEffects ?? []).map(effect => <li key={effect}>{effect}</li>)}</ul>
      <button disabled={!state.canWrite} onClick={() => void controller.applyReviewed()}>Apply reviewed action</button>
    </section> : null}
    {state.run ? <><p role="status">Run {state.run.runId}: {state.run.state}</p>
      {state.run.result && 'message' in state.run.result && !publicationRunIsSame(state) ? <p role="alert">{state.run.result.message}</p> : null}
      {busy ? <button disabled={!state.canRead} onClick={() => void controller.cancel()}>Cancel action</button> : null}
      <RunRecovery run={state.run} disabled={!state.canWrite} onRepreview={() => void controller.repreview()} onAbandon={() => void controller.abandon()} />
    </> : null}
  </div>;
}
const publicationRunIsSame = (state: AuthorState) => state.run?.runId === state.publicationRun?.runId;
