import React, { type ReactNode } from 'react';
import type { RunView } from '@nortuscc/agent/operations';
import type { ViewState } from './controller.ts';
import { incomingCounts, type SetupSyncState } from './setup-sync-controller.ts';
import type { UpdateViewState } from './update-controller.ts';
import { draftCount, interruptedRuns, unannouncedRun, type HomeController, type HomeState } from './home-controller.ts';
import { changeTitle } from './copy.ts';

export type HomeScreen = 'changes' | 'publish' | 'settings';
export type HomeProps = {
  machine: ViewState; changes: SetupSyncState; home: HomeState; update: UpdateViewState;
  navigate: (screen: HomeScreen) => void; controller: HomeController;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "Nortus222/claude-config" for a GitHub URL; other repositories keep their URL.
const repoName = (url: string) => url.replace(/^(?:https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');
const AUTHOR_KINDS = new Set(['editDraft', 'removeDraftIntent', 'deleteDraft', 'ghLogin', 'publishDraft', 'announcePublication']);
const POLICY = { 'auto-apply': 'applies incoming changes automatically', notify: 'tells you about incoming changes', manual: 'waits for you to check for changes' } as const;

function Line({ tone, children, action }: { tone?: 'attention'; children: ReactNode; action: ReactNode }) {
  return <li className={tone ? `home-line home-line-${tone}` : 'home-line'}><p>{children}</p><div className="home-actions">{action}</div></li>;
}

function agentLine({ machine }: HomeProps, open: (screen: HomeScreen) => ReactNode): ReactNode {
  const status = machine.status;
  if (machine.connection === 'browser') return <Line action={open('settings')}>Browser preview. Open the desktop app to see this Mac.</Line>;
  if (machine.connection === 'connecting') return <Line action={open('settings')}>Connecting to the agent…</Line>;
  if (machine.connection === 'disconnected') return <Line tone="attention" action={open('settings')}>The agent isn’t connected.</Line>;
  if (status?.error) return <Line tone="attention" action={open('settings')}>The agent couldn’t check this Mac. Details are in Settings.</Line>;
  if (status?.applying) return <Line action={open('changes')}>The agent is applying changes.</Line>;
  if (status?.paused) return <Line tone="attention" action={open('settings')}>Automatic apply is paused.</Line>;
  return <Line action={open('settings')}>The agent is running{status ? ` and ${POLICY[status.policy]}` : ''}.</Line>;
}

function interruptedLine(run: RunView, { home, controller, navigate }: HomeProps): ReactNode {
  const title = changeTitle(run.intent.change.kind);
  const busy = home.abandoning || !home.available;
  if (home.confirming === run.runId) return <Line key={run.runId} tone="attention" action={<>
    <button className="danger" disabled={busy} onClick={() => void controller.abandon()}>Abandon</button>
    <button disabled={home.abandoning} onClick={() => controller.cancelAbandon()}>Keep</button>
    {home.abandonError ? <span role="alert" className="home-error">{home.abandonError}</span> : null}
  </>}>Abandon “{title}”? Its remaining steps won’t run. Finished steps and backups are kept.</Line>;
  return <Line key={run.runId} tone="attention" action={<>
    <button onClick={() => navigate(AUTHOR_KINDS.has(run.intent.change.kind) ? 'publish' : 'changes')}>Review</button>
    <button disabled={busy || home.confirming !== null} onClick={() => controller.confirmAbandon(run.runId)}>Abandon</button>
  </>}>{title} was interrupted.</Line>;
}

// Home: what this Mac follows and what needs attention, each line with its next action.
export function HomeView(props: HomeProps) {
  const { machine, changes, home, update, navigate, controller } = props;
  const open = (screen: HomeScreen, label = screen === 'changes' ? 'Review' : screen === 'publish' ? 'Open Publish' : 'Open Settings') =>
    <button onClick={() => navigate(screen)}>{label}</button>;
  const followed = changes.profiles?.followed;
  const review = changes.review;
  const { incoming, held } = incomingCounts(review);
  const more = review?.nextCursor ? '+' : '';
  const items = machine.inspection?.items ?? [];
  const waiting = items.filter(item => item.disposition === 'apply').length;
  const changedHere = items.filter(item => item.disposition === 'capture').length;
  const drafts = draftCount(home.drafts);
  const unannounced = unannouncedRun(home.runs);
  const phase = update.update?.enabled ? update.update.phase : null;
  const version = update.update?.availableVersion;
  return <div className="home-view">
    <header><div><p className="eyebrow">THIS MAC</p><h1>Home</h1></div></header>
    <ul className="home-lines" aria-label="This Mac">
      {agentLine(props, open)}
      {changes.profiles ? followed
        ? <Line action={open('changes', 'Switch profile')}>Following <strong>{followed.profile}</strong> from <strong>{repoName(followed.repoUrl)}</strong></Line>
        : <Line action={open('changes', 'Choose a profile')}>This Mac doesn’t follow a profile yet.</Line> : null}
      {review ? incoming + held > 0
        ? <Line action={open('changes')}>{plural(incoming, 'incoming change')}{more}{held ? ` · ${held}${more} on hold` : ''}</Line>
        : <Line action={open('changes', 'Open Changes')}>No incoming changes.</Line> : null}
      {waiting ? <Line action={open('changes')}>{plural(waiting, 'change')} waiting to apply on this Mac</Line> : null}
      {changedHere ? <Line action={open('changes')}>{plural(changedHere, 'file')} changed on this Mac</Line> : null}
      {interruptedRuns(home.runs).map(run => interruptedLine(run, props))}
      {drafts ? <Line action={open('publish')}>{plural(drafts, 'draft')} not published</Line> : null}
      {unannounced ? <Line action={open('publish')}>Published, not announced</Line> : null}
      {phase === 'verified' || phase === 'available' ? <Line action={open('settings')}>
        App update{version ? ` ${version}` : ''} is {phase === 'verified' ? 'ready to install' : 'available'}</Line> : null}
      {home.error ? <Line tone="attention" action={<button disabled={home.pending || !home.available} onClick={() => void controller.refresh()}>Retry</button>}>
        <span role="alert">{home.error}</span></Line> : null}
    </ul>
  </div>;
}
