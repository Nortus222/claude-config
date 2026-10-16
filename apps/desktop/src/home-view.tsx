import React, { type ReactNode } from 'react';
import type { RunView } from '@nortuscc/agent/operations';
import type { ViewState } from './controller.ts';
import { incomingCounts, MACHINE_KINDS, type SetupSyncState } from './setup-sync-controller.ts';
import { AUTHOR_RUN_KINDS } from './controller.ts';
import type { UpdateViewState } from './update-controller.ts';
import { draftCount, interruptedRuns, unannouncedRun, type HomeController, type HomeState } from './home-controller.ts';
import { changeTitle, plural, repoName } from './copy.ts';

export type HomeScreen = 'changes' | 'publish' | 'settings';
export type HomeProps = {
  machine: ViewState; changes: SetupSyncState; home: HomeState; update: UpdateViewState;
  navigate: (screen: HomeScreen) => void; controller: HomeController;
};

const POLICY = { 'auto-apply': 'applies incoming changes automatically', notify: 'tells you about incoming changes', manual: 'waits for you to check for changes' } as const;

// One fact about this Mac with its next action; attention lines carry a warning mark.
function Line({ tone, children, action }: { tone?: 'attention'; children: ReactNode; action: ReactNode }) {
  return <li className={tone ? `home-line row home-line-${tone}` : 'home-line row'}><p className="row-main">{children}</p><div className="row-trail home-actions">{action}</div></li>;
}

// Progress of the apply this Mac is running: the Changes run when one is active (it records its planned
// steps), else this window's own run. HOOK(controller): an apply the agent started itself (first run,
// auto-apply) reports no steps or total to the renderer; show its progress here once the machine state has it.
function applyProgress({ machine, changes }: HomeProps): { done: number; total: number } {
  const run = changes.run;
  if (run && (run.state === 'accepted' || run.state === 'running')) {
    const planned = (run.intent as { parity?: { plannedKeys?: readonly string[] } }).parity?.plannedKeys?.length ?? 0;
    return { done: run.steps.length, total: Math.max(planned, run.steps.length) };
  }
  if (machine.run?.outcome !== 'running') return { done: 0, total: 0 };
  return { done: machine.run.steps.filter(step => step.status !== 'pending' && step.status !== 'running').length, total: machine.run.steps.length };
}

function agentLine(props: HomeProps, open: (screen: HomeScreen) => ReactNode): ReactNode {
  const status = props.machine.status, machine = props.machine;
  if (machine.connection === 'browser') return <Line action={open('settings')}>Browser preview. Open the desktop app to see this Mac.</Line>;
  if (machine.connection === 'connecting') return <Line action={open('settings')}>Connecting to the agent…</Line>;
  if (machine.connection === 'disconnected') return <Line tone="attention" action={open('settings')}>The agent isn’t connected.</Line>;
  if (status?.error) return <Line tone="attention" action={open('settings')}>The agent couldn’t check this Mac. Details are in Settings.</Line>;
  if (status?.applying) {
    const { done, total } = applyProgress(props);
    return <Line action={open('changes')}><span className="busy-line"><span className="spinner" aria-hidden="true" />
      <span>The agent is applying changes{total ? ` · ${done} of ${plural(total, 'step')} done` : ''}.</span></span>
      {total ? <progress className="home-progress" aria-label="Apply progress" value={done} max={total} /> : null}</Line>;
  }
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
  // Review opens the screen that adopts this kind of run; other kinds can only be abandoned here.
  const kind = run.intent.change.kind, screen = AUTHOR_RUN_KINDS.has(kind) ? 'publish' : MACHINE_KINDS.has(kind) ? 'changes' : null;
  return <Line key={run.runId} tone="attention" action={<>
    {screen ? <button onClick={() => navigate(screen)}>Review</button> : null}
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
    <header className="page-header"><div><h1>Home</h1><p className="intro">What this Mac follows and what needs your attention.</p></div></header>
    <ul className="card home-lines" aria-label="This Mac">
      {agentLine(props, open)}
      {changes.profiles ? followed
        ? <Line action={open('changes', 'Switch profile')}>Following <strong>{followed.profile}</strong> from <strong>{repoName(followed.repoUrl)}</strong></Line>
        : <Line action={open('changes', 'Choose a profile')}>This Mac doesn’t follow a profile yet.</Line> : null}
      {review ? incoming + held > 0
        ? <Line action={open('changes')}>{plural(incoming, 'incoming change')}{more}{held ? ` · ${held}${more} on hold` : ''}</Line>
        : <Line action={open('changes', 'Open Changes')}>No incoming changes. You’re up to date.</Line> : null}
      {waiting ? <Line action={open('changes')}>{plural(waiting, 'change')} waiting to apply on this Mac</Line> : null}
      {changedHere ? <Line action={open('changes')}>{plural(changedHere, 'item')} changed on this Mac</Line> : null}
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
