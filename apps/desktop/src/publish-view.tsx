import React from 'react';
import type { OperationOutput, RunView } from '@nortuscc/agent/operations';
import type { AuthorAction, AuthorController, AuthorIntent, AuthorState } from './author-controller.ts';
import { changeTitle, errorText, itemLabel, plural, relativeTime, repoName } from './copy.ts';
import { lineDiff } from './line-diff.ts';
import { RunRecovery } from './run-recovery.tsx';

export type AuthorProps = { state: AuthorState; controller: AuthorController };
// Profiles and Upstreams link to the Publish screen from their draft line when the shell offers it.
export type AuthorPageProps = AuthorProps & { onOpenPublish?: () => void };
type ProfileIssues = NonNullable<OperationOutput<'authorProfiles'>['issues']>;
type Draft = NonNullable<AuthorState['draft']>;
type DraftPreview = OperationOutput<'draftPreview'>;

// Why read and write actions are unavailable, shown as their buttons' titles. HOOK(controller): canRead and
// canWrite carry no reason; replace these with the controller's own once it has them.
export const READ_REASON = 'Reconnect the agent and finish any app update first.';
export const WRITE_REASON = 'Available when this Mac finishes its current work.';

const list = (names: readonly string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const short = (revision: string) => revision.slice(0, 7);
const active = (run: RunView | null | undefined) => run?.state === 'accepted' || run?.state === 'running';
const PUBLICATION_KINDS: readonly string[] = ['publishDraft', 'announcePublication'];

// Lists profile issues as "<profile>: <message> (<path>)". `profile` keeps only that profile's issues
// and drops the name; `except` leaves one profile to its own section.
export function AuthorIssues({ issues, profile, except }: { issues: ProfileIssues | undefined; profile?: string; except?: string }) {
  const groups = (issues ?? []).filter(group => (profile === undefined || group.profile === profile) && group.profile !== except && group.issues.length);
  if (!groups.length) return null;
  return <div className="alert" role="alert"><h3>{profile === undefined ? 'Profile issues' : `Issues in ${profile}`}</h3><ul>{groups.flatMap(group => group.issues.map((issue, index) =>
    <li key={`${group.profile}:${index}`}>{profile === undefined ? <><strong>{group.profile}</strong>: </> : null}{issue.message} (<code>{issue.path}</code>)</li>))}</ul></div>;
}

// One sentence for the controller's last error, chosen by its code.
function authorErrorText(state: AuthorState): string {
  const raw = state.error ?? '';
  const plain = raw.replace(/^[A-Z][A-Z0-9_]*: /, '');
  switch (state.errorCode) {
    case 'UNAUTHORIZED': return `${state.profiles ? `No access to ${state.profiles.repoUrl}` : plain}. Check repository permission, then retry.`;
    case 'NOT_SIGNED_IN': return 'Not signed in to GitHub, or GitHub is unreachable. Sign in or retry below.';
    case 'APP_UNAVAILABLE': return `${plain}${plain.includes('Follow your setup repository first') ? '. Open Changes to follow a profile.'
      : plain.includes('gh is not installed') ? '. Install GitHub CLI, then retry.' : ''}`;
    default: return errorText(raw);
  }
}
// Page-level status: connection, pending reads, and errors not owned by a Publish control.
export function AuthorFeedback({ state }: Pick<AuthorProps, 'state'>) {
  return <>
    {!state.canRead && !state.pending ? <p className="notice">Reconnect the local agent and finish any app maintenance to read author settings.</p> : null}
    {state.pending ? <p className="muted busy-line" role="status"><span className="spinner" aria-hidden="true" /> Reading or saving author settings…</p> : null}
    {state.message ? <p className="muted" role="status">{state.message}</p> : null}
    {state.error && !state.failedAction ? <p className="alert" role="alert">{authorErrorText(state)}</p> : null}
  </>;
}
// The error of one Publish control, rendered beside it.
function ActionError({ state, action }: { state: AuthorState; action: AuthorAction }) {
  return state.error && state.failedAction === action ? <p className="alert action-error" role="alert">{authorErrorText(state)}</p> : null;
}

// "Saved to draft · N changes", linking to Publish when the shell provides it.
export function DraftLine({ state, onOpenPublish }: Pick<AuthorPageProps, 'state' | 'onOpenPublish'>) {
  const count = state.draft?.intents.length ?? 0;
  if (!count) return null;
  return <p className="draft-line">{`Saved to draft · ${plural(count, 'change')}${onOpenPublish ? ' · ' : ''}`}
    {onOpenPublish ? <button className="link" onClick={onOpenPublish}>Review and publish →</button> : null}</p>;
}
// Shows the latest author run while it runs or after it fails. On Publish, sign-in and publication runs have
// their own cards; Profiles and Upstreams (`page="author"`) show any running author action and failed draft saves.
export function RunStatus({ state, controller, page }: AuthorProps & { page: 'publish' | 'author' }) {
  const run = state.run;
  if (!run) return null;
  const kind = run.intent.change.kind;
  const failed = run.state === 'failed' || run.state === 'cancelled';
  const shown = page === 'author' ? active(run) || failed && kind === 'editDraft'
    : !PUBLICATION_KINDS.includes(kind) && (active(run) ? kind !== 'ghLogin' : failed);
  if (!shown) return null;
  const message = run.result && 'message' in run.result ? ` ${run.result.message}` : '';
  return <>
    {active(run) ? <p className="notice busy-line" role="status"><span className="spinner" aria-hidden="true" />{`${changeTitle(kind)}… `}<button disabled={!state.canRead} onClick={() => void controller.cancel()}>Cancel</button></p>
      : <p className="alert" role="alert">{`${changeTitle(kind)} ${run.state === 'failed' ? 'failed' : 'was cancelled'}.${message}`}</p>}
    <ActionError state={state} action="cancel" />
  </>;
}

// A draft intent in words.
export function intentText(intent: AuthorIntent): string {
  const file = (fileId: string) => itemLabel(`file:${fileId}`).text;
  switch (intent.kind) {
    case 'includeSkill': case 'excludeSkill': return `${intent.kind === 'includeSkill' ? 'Include' : 'Exclude'} skill ${intent.name} from ${intent.source} in ${intent.profile}`;
    case 'pin': return `Pin ${intent.source} to ${short(intent.commit)}`;
    case 'unpin': return `Unpin ${intent.source}`;
    case 'captureFile': return `Capture ${file(intent.fileId)} from this Mac into ${intent.profile}, ${intent.choice.kind === 'updateShared' ? 'updating the shared file' : `as its own copy at ${intent.choice.repoPath}`}`;
    case 'createProfile': return `Create ${intent.profile}${intent.extends ? ` extending ${intent.extends}` : ''}`;
    case 'setFile': return `Set ${file(intent.fileId)} in ${intent.profile} to ${intent.path ?? 'unmanaged'}`;
    case 'setIntegration': return `${intent.include ? 'Include' : 'Exclude'} integration ${intent.id} in ${intent.profile}`;
    case 'ignore': case 'unignore': return `${intent.kind === 'ignore' ? 'Ignore' : 'Stop ignoring'} ${intent.source} at ${short(intent.revision)}`;
  }
}
const VERBS = { added: 'adds', removed: 'removes', changed: 'changes' } as const;
// "team: adds skill tdd from mattpocock/skills".
function itemSentence(item: DraftPreview['items'][number]) {
  const label = itemLabel(item.itemId).text;
  const named = /^(?:Skill|Setting|Integration|File|Item)\b/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
  return `${item.profile}: ${VERBS[item.change]} ${named}`;
}
const draftAge = (draft: Draft) => relativeTime(draft.createdAt) || 'an unknown date';
const draftLabel = (draft: Draft) => `Draft from ${draftAge(draft)} · ${plural(draft.intents.length, 'change')}`;

const GH = { missing: ['Not installed', 'pill-warning'], 'signed-out': ['Signed out', 'pill-warning'], ready: ['Ready', 'pill-success'], error: ['Unavailable', 'pill-danger'] } as const;
function GitHubCard({ state, controller }: AuthorProps) {
  const signingIn = state.run?.intent.change.kind === 'ghLogin' && active(state.run);
  const code = signingIn ? state.run?.ghCode : null;
  const ready = state.gh?.state === 'ready';
  const [label, tone] = state.gh ? GH[state.gh.state] ?? ['Unknown', ''] : ['Unknown', ''];
  return <section className="card" aria-label="GitHub publishing access">
    <div className="card-head"><div><h2>{ready ? 'GitHub' : 'Connect GitHub CLI for publishing'}</h2>
      <p>{state.gh?.state === 'missing' ? 'GitHub CLI is not installed.' : state.gh?.state === 'signed-out' ? 'Not signed in to GitHub, or GitHub is unreachable.'
        : ready ? 'Publishing uses your GitHub CLI sign-in.' : 'GitHub state is unavailable.'}</p></div>
      <span className={`pill ${tone}`}>{label}</span></div>
    {signingIn ? <>
      <p className="muted busy-line" role="status"><span className="spinner" aria-hidden="true" /> GitHub sign-in is pending. Complete authorization in your browser.</p>
      {code ? <p className="device-code" aria-label="GitHub one-time code">{code.code}</p> : <p className="muted">Waiting for GitHub's one-time code. Retry to read the current run.</p>}
    </> : null}
    {!ready || signingIn ? <div className="actions">
      {state.gh?.state === 'missing' ? <button className="primary" onClick={() => void controller.openGitHub('installCli')}>Install GitHub CLI</button> : null}
      {code ? <button className="primary" onClick={() => void controller.openGitHub('deviceLogin')}>Open GitHub</button> : null}
      {!signingIn && !ready && state.gh?.state !== 'missing' ? <button className="primary" disabled={!state.canWrite} title={state.canWrite ? undefined : WRITE_REASON} onClick={() => void controller.signIn()}>Sign in with GitHub</button> : null}
      {signingIn ? <button disabled={!state.canRead} onClick={() => void controller.cancel()}>Cancel sign-in</button> : null}
      <button disabled={!state.canRead} title={state.canRead ? undefined : READ_REASON} onClick={() => void controller.reload()}>Retry</button>
    </div> : null}
    <ActionError state={state} action="signIn" /><ActionError state={state} action="openGitHub" />
    {signingIn ? <ActionError state={state} action="cancel" /> : null}
  </section>;
}

function DraftCard({ state, controller, drafts }: AuthorProps & { drafts: readonly Draft[] }) {
  const confirming = state.confirming?.action === 'deleteDraft' ? state.confirming.draftId : null;
  const confirmedDraft = drafts.find(d => d.id === confirming);
  const unreadable = state.drafts.filter((d): d is Extract<typeof d, { error: string }> => 'error' in d);
  const invalid = state.draftPreview?.draftId === state.draft?.id ? state.draftPreview?.invalid ?? [] : [];
  const writeTitle = state.canWrite ? undefined : WRITE_REASON;
  return <section className="card" aria-label="Draft">
    <div className="card-head"><div><h2>Draft</h2><p>Drafts stay on this Mac until you publish them.</p></div>
      {!confirming && (drafts.length || state.draft) ? <div className="actions">
        {drafts.length ? <button disabled={!state.canWrite} title={writeTitle} onClick={() => controller.newDraft()}>New draft</button> : null}
        {state.draft ? <button disabled={!state.canWrite} title={writeTitle} onClick={() => controller.askDelete()}>Delete draft</button> : null}</div> : null}</div>
    {drafts.length ? <label className="field">Draft<select value={state.draft?.id ?? ''} disabled={!state.canWrite} onChange={e => controller.selectDraft(e.target.value)}>
      <option value="">New draft</option>{drafts.map(d => <option key={d.id} value={d.id}>{draftLabel(d)}</option>)}
    </select></label> : null}
    {confirming ? <div className="confirm" role="group" aria-label="Confirm delete">
      <p>{confirmedDraft ? `Delete the draft from ${draftAge(confirmedDraft)} with ${plural(confirmedDraft.intents.length, 'change')}? This can't be undone.` : 'Delete this unreadable draft? This can\'t be undone.'}</p>
      <div className="form-actions"><button className="danger" disabled={!state.canWrite} onClick={() => void controller.deleteDraft(confirming)}>Delete draft</button>
        <button onClick={() => controller.dismiss()}>Keep draft</button></div>
    </div> : null}
    <ActionError state={state} action="deleteDraft" />
    {unreadable.map(d => <div className="unreadable-draft" key={d.id}><p className="alert">{`A saved draft can't be read: ${d.error}`}</p>
      <button disabled={!state.canWrite} onClick={() => controller.askDelete(d.id)}>Delete unreadable draft</button></div>)}
    {state.draft ? <ol className="rows draft-intents" aria-label="Draft changes">{state.draft.intents.map((intent, index) => <li className="row" key={index}>
      <span className="row-main">{intentText(intent)}</span> <button disabled={!state.canWrite} aria-label={`Remove change ${index + 1}`} onClick={() => void controller.removeIntent(index)}>Remove</button>
      {invalid.filter(i => i.index === index).map(i => <p className="row-detail alert" role="alert" key={i.reason}>{i.reason}</p>)}
    </li>)}</ol> : <p className="muted">No draft yet. Include a skill, pin a source or capture a file to start one.</p>}
    <ActionError state={state} action="removeIntent" />
  </section>;
}

function FileDiff({ file }: { file: DraftPreview['diff'][number] }) {
  const hunks = lineDiff(file.before, file.after);
  const status = file.before === null ? ' (new file)' : file.after === null ? ' (removed)' : '';
  return <div className="file-diff"><h3>{`${file.path}${status}`}</h3>
    {hunks.length ? <pre className="line-diff" tabIndex={0} aria-label={`Changes in ${file.path}`}>{hunks.map((hunk, index) => <React.Fragment key={index}>
      <span className="hunk">{`Line ${hunk.afterCount ? hunk.afterStart : hunk.beforeStart}`}</span>
      {hunk.lines.map((line, row) => <span key={row} className={line.kind}>{`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`}</span>)}
    </React.Fragment>)}</pre> : <p className="muted">{file.truncated ? 'The change is beyond the shortened preview.' : 'Only the final newline changes.'}</p>}
    {file.truncated ? <p className="muted">Shortened preview. Publishing includes the whole file.</p> : null}
  </div>;
}

// Why Publish is unavailable, or null when it is available.
function publishReason(state: AuthorState): string | null {
  if (state.canPublish) return null;
  if (!state.canWrite) return WRITE_REASON;
  if (state.gh?.state !== 'ready') return 'Connect GitHub CLI first.';
  if (!state.draftPreview || state.preview?.change.kind !== 'publishDraft') return 'Preview the draft first.';
  if (state.draftPreview.invalid.length) return 'Correct the invalid changes first.';
  return 'Preview the draft again.';
}

function ReviewCard({ state, controller }: AuthorProps) {
  const preview = state.draftPreview;
  // Items grouped by profile, in the order the agent first lists each profile.
  const items = preview ? [...new Set(preview.items.map(item => item.profile))].flatMap(profile => preview.items.filter(item => item.profile === profile)) : [];
  const repo = state.profiles ? repoName(state.profiles.repoUrl) : 'the profile repository';
  const reason = publishReason(state);
  return <section className="card" aria-label="Review and publish">
    <div className="card-head"><div><h2>Review</h2><p>{preview ? preview.affectedProfiles.length ? `Updates ${list(preview.affectedProfiles)}.` : 'Updates no profiles.' : 'Preview the draft to see what changes in each profile.'}</p></div>
      <button className={preview ? undefined : 'primary'} disabled={!state.canWrite || !state.draft} title={state.canWrite ? undefined : WRITE_REASON} onClick={() => void controller.previewDraft()}>Preview draft</button></div>
    <ActionError state={state} action="preview" />
    {preview ? <>
      {items.length ? <ul className="publish-items" aria-label="Changed items">{items.map((item, index) => <li key={index}>{itemSentence(item)}</li>)}</ul> : null}
      {preview.itemsTruncated ? <p className="muted" role="status">{`Showing the first ${plural(items.length, 'changed item')}. Publishing includes every change.`}</p> : null}
      {preview.invalid.filter(issue => issue.index === null).map((issue, index) => <p className="alert" role="alert" key={index}>{issue.reason}</p>)}
      {preview.invalid.length ? <p className="alert" role="alert">Publish is disabled until every invalid change or profile is corrected.</p> : null}
      {preview.diff.length ? <details className="publish-files"><summary>{`Files (${preview.diff.length})`}</summary>
        {preview.truncated ? <p className="muted" role="status">Diff preview is truncated. Publication includes the full files.</p> : null}
        {preview.diff.map(file => <FileDiff key={file.path} file={file} />)}
      </details> : <p className="muted">No file changes.</p>}
    </> : null}
    {state.confirming?.action === 'publish' && state.canPublish ? <div className="confirm" role="group" aria-label="Confirm publish">
      <p>{`Publish ${plural(state.draft?.intents.length ?? 0, 'change')} to ${repo}? This pushes to main and updates ${preview?.affectedProfiles.length ? list(preview.affectedProfiles) : 'no profiles'}.`}</p>
      <div className="form-actions"><button className="primary" disabled={!state.canPublish} onClick={() => void controller.publish()}>Confirm publish</button>
        <button onClick={() => controller.dismiss()}>Cancel</button></div>
    </div> : <div className="form-actions"><button className="primary" disabled={!state.canPublish} title={reason ?? undefined} onClick={() => controller.askPublish()}>Publish</button>
      {reason && preview ? <span className="reason">{reason}</span> : null}</div>}
    <ActionError state={state} action="publish" />
  </section>;
}

const ENDED: Readonly<Record<RunView['state'], string>> = { accepted: 'Publishing…', running: 'Publishing…', succeeded: 'Publishing finished.', failed: 'Publishing failed.',
  cancelled: 'Publishing was cancelled.', interrupted: 'Publishing was interrupted.', abandoned: 'Publishing was abandoned.' };
// The latest publication: Published, Not announced → Announce, Unknown → Re-check, or Needs preview.
function OutcomeCard({ state, controller, run }: AuthorProps & { run: RunView }) {
  const evidence = run.publication;
  const recovery = run.publicationRecovery;
  const pushed = recovery?.published === true || evidence?.pushed === true;
  const unknown = recovery?.action === 're-check' || recovery?.published === 'unknown';
  const needsPreview = !pushed && (run.result?.status === 'needs-preview' || recovery?.action === 're-preview');
  const pending = pushed && (recovery?.action === 'announce' || !!evidence?.pending.length || evidence?.tagged === false);
  const status = unknown ? 'Push outcome unknown. Re-check reads the run again without pushing.' : pending ? 'Published, not yet announced' : pushed ? 'Published'
    : needsPreview ? 'Needs preview. Main changed; review a new preview before publishing.' : active(run) ? ENDED[run.state] : `${ENDED[run.state]} Push is not confirmed.`;
  const [pill, tone] = unknown ? ['Unknown', 'pill-warning'] : pending ? ['Not announced', 'pill-warning'] : pushed ? ['Published', 'pill-success']
    : needsPreview ? ['Needs preview', 'pill-warning'] : active(run) ? ['Publishing', 'pill-accent'] : ['Not confirmed', 'pill-danger'];
  const facts = [pushed && evidence?.commit ? `Commit ${short(evidence.commit)}.` : '', evidence?.announced.length ? `Announced to ${list(evidence.announced)}.` : '',
    pushed && evidence?.pending.length ? `Not yet announced to ${list(evidence.pending)}.` : '', pushed && evidence?.tagged === false ? 'The release tag is not confirmed.' : ''].filter(Boolean);
  return <section className="card" aria-label="Publication outcome">
    <div className="card-head"><div><h2>Last publication</h2><p role="status">{status}</p></div>
      <div className="actions"><span className={`pill ${tone}`} aria-hidden="true">{active(run) ? <span className="spinner" /> : null}{pill}</span>
        {active(run) && state.run?.runId === run.runId ? <button disabled={!state.canRead} onClick={() => void controller.cancel()}>Cancel</button> : null}
        {unknown ? <button className="primary" disabled={!state.canRead} onClick={() => void controller.recheck()}>Re-check</button>
          : pending ? <button className="primary" disabled={!state.canWrite} title={state.canWrite ? undefined : WRITE_REASON} onClick={() => void controller.announce()}>Announce</button> : null}</div></div>
    {state.run?.runId === run.runId ? <ActionError state={state} action="cancel" /> : null}
    {facts.length ? <p className="muted">{facts.join(' ')}</p> : null}
    {evidence?.unannounceable?.map(issue => <p className="alert" role="alert" key={issue.profile}>{issue.profile}: Can't announce: {issue.reason}</p>)}
    {run.result && 'message' in run.result ? <p className="muted">{run.result.message}</p> : null}
    <ActionError state={state} action="recheck" /><ActionError state={state} action="announce" />
  </section>;
}

// The Publish screen: GitHub access, the draft, its review and the latest publication.
export function PublishView({ state, controller }: AuthorProps) {
  const drafts = state.drafts.filter((d): d is Draft => 'intents' in d && d.repoUrl === state.profiles?.repoUrl);
  const reviewed = state.preview && 'actionEffects' in state.preview && !PUBLICATION_KINDS.includes(state.preview.change.kind) ? state.preview : null;
  return <div className="author-view publish-view">
    <header className="page-header"><div><h1>Publish</h1>
      <p className="intro">{state.profiles ? `Review your draft, then publish it to ${repoName(state.profiles.repoUrl)}.` : 'Review your draft, then publish it to your profile repository.'}</p></div>
      <div className="header-actions"><button disabled={!state.canRead} title={state.canRead ? undefined : READ_REASON} onClick={() => void controller.reload()}>Reload</button></div></header>
    <AuthorFeedback state={state} />
    <RunStatus state={state} controller={controller} page="publish" />
    <GitHubCard state={state} controller={controller} />
    {state.publicationRun ? <OutcomeCard state={state} controller={controller} run={state.publicationRun} /> : null}
    <DraftCard state={state} controller={controller} drafts={drafts} />
    {state.draft ? <ReviewCard state={state} controller={controller} /> : null}
    {reviewed ? <section className="card" aria-label="Reviewed action"><h2>{changeTitle(reviewed.change.kind)}</h2>
      <ul>{(reviewed.actionEffects ?? []).map(effect => <li key={effect}>{effect}</li>)}</ul>
      <div className="actions"><button className="primary" disabled={!state.canWrite} onClick={() => void controller.applyReviewed()}>Apply reviewed action</button></div>
    </section> : null}
    <ActionError state={state} action="applyReviewed" />
    {state.run ? <RunRecovery run={state.run} disabled={!state.canWrite} onRepreview={() => void controller.repreview()} onAskAbandon={() => controller.askAbandon()}
      onAbandon={() => void controller.abandon()} onKeep={() => controller.dismiss()} confirming={state.confirming?.action === 'abandon' && state.confirming.runId === state.run.runId} /> : null}
    <ActionError state={state} action="recovery" />
  </div>;
}
