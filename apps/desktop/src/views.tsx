import React, { useEffect, useState, type ReactNode } from 'react';
import type { WireHostedState } from '@nortuscc/agent/ipc/protocol';
import type { Policy } from '@nortuscc/hosted-protocol';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';
import type { SetupController, SetupViewState } from './setup-controller.ts';
import type { AccountController, AccountViewState } from './account-controller.ts';
import type { UpdateViewState } from './update-controller.ts';
import type { MachineController, ViewState } from './controller.ts';
import { incomingCounts, type SetupSyncController, type SetupSyncState } from './setup-sync-controller.ts';
import { draftCount, type HomeState } from './home-controller.ts';
import { errorText, repoName } from './copy.ts';
import { THIS_MACHINE, ThisMachine, thisMachine } from './device.ts';

export type Screen = 'home' | 'changes' | 'skills' | 'profiles' | 'upstreams' | 'publish' | 'settings';
// Counts shown beside a screen's name: undecided incoming changes, unpublished drafts, an app update.
export type NavBadges = { readonly changes?: number; readonly publish?: number; readonly settings?: boolean };
// Badges from the Changes review (incoming rows not on hold), Home's local drafts and the updater.
export function navBadges(changes: Pick<SetupSyncState, 'review'>, home: Pick<HomeState, 'drafts'>, update: UpdateViewState): NavBadges {
  const phase = update.update?.enabled ? update.update.phase : null;
  return {
    changes: incomingCounts(changes.review).incoming,
    publish: draftCount(home.drafts),
    settings: phase === 'available' || phase === 'verified',
  };
}
const groups = [
  [THIS_MACHINE, [['home', 'Home'], ['changes', 'Changes'], ['skills', 'Skills']]],
  ['MY PROFILES', [['profiles', 'Profiles'], ['upstreams', 'Upstreams'], ['publish', 'Publish']]],
] as const;
// A notification click names no notification. Item notifications count incoming changes, decided on Changes;
// agent failures (error or pause) are explained on Home.
export const screenForReview = (screen: Screen, previous: number, requested: number, status: ViewState['status']): Screen =>
  requested <= previous ? screen : status?.error || status?.paused ? 'home' : 'changes';

// Follows an offered profile from Settings and shows its preview on Changes.
export const followFromSettings = (sync: Pick<SetupSyncController, 'followSharedLink'>, navigate: (screen: Screen) => void) => (setupId: string) => {
  const following = sync.followSharedLink(setupId);
  navigate('changes');
  return following;
};

// A lost agent connection is reported once, above every screen, with the way back.
function DisconnectedBanner({ machine, onReconnect }: { machine: ViewState; onReconnect: () => void }) {
  return <div className="alert shell-banner" role="alert">
    <div><strong>The local agent is disconnected.</strong> <span>{machine.detail}</span></div>
    <button disabled={machine.pending} onClick={onReconnect}>Reconnect</button>
  </div>;
}
// A failed inspection on a connected agent stays visible on every screen with a read-only retry.
function InspectionBanner({ machine, onRecheck }: { machine: ViewState; onRecheck: () => void }) {
  return <div className="alert shell-banner" role="alert">
    <div><strong>{ThisMachine} couldn’t be checked.</strong> <span>{errorText(machine.initialReadError)}</span></div>
    <button disabled={machine.pending || machine.status?.applying === true} onClick={onRecheck}>Check again</button>
  </div>;
}
function badgeText(screen: Screen, badges: NavBadges): { text: string; label: string } | null {
  if (screen === 'changes' && badges.changes) return { text: String(badges.changes), label: `${badges.changes} incoming ${badges.changes === 1 ? 'change' : 'changes'}` };
  if (screen === 'publish' && badges.publish) return { text: String(badges.publish), label: `${badges.publish} ${badges.publish === 1 ? 'draft' : 'drafts'} not published` };
  if (screen === 'settings' && badges.settings) return { text: 'Update', label: 'App update available' };
  return null;
}
function NavButton({ screen, label, current, badges, navigate }: { screen: Screen; label: string; current: Screen; badges: NavBadges; navigate: (screen: Screen) => void }) {
  const badge = badgeText(screen, badges);
  return <button aria-current={current === screen ? 'page' : undefined} onClick={() => navigate(screen)}>
    {label}{badge ? <span className="nav-badge" aria-label={badge.label}>{badge.text}</span> : null}
  </button>;
}
export function ShellView({ screen, navigate, children, machine, onReconnect, onRecheck, badges = {} }: {
  screen: Screen; navigate: (screen: Screen) => void; children: ReactNode; machine?: ViewState; onReconnect?: () => void; onRecheck?: () => void; badges?: NavBadges;
}) {
  const banner = machine?.connection === 'disconnected' && onReconnect ? <DisconnectedBanner machine={machine} onReconnect={onReconnect} />
    : machine?.connection === 'connected' && machine.initialReadError && onRecheck ? <InspectionBanner machine={machine} onRecheck={onRecheck} /> : null;
  return (
    <div className="app-shell">
      <aside className="shell-nav">
        <h2>Nortuscc</h2>
        <nav aria-label="Main navigation">
          {groups.map(([group, items]) => {
            const id = `nav-${group.toLowerCase().replace(/ /g, '-')}`;
            return <div className="nav-group" role="group" aria-labelledby={id} key={group}>
              <p className="eyebrow nav-group-label" id={id}>{group}</p>
              {items.map(([key, label]) => <NavButton key={key} screen={key} label={label} current={screen} badges={badges} navigate={navigate} />)}
            </div>;
          })}
          <div className="nav-group nav-settings"><NavButton screen="settings" label="Settings" current={screen} badges={badges} navigate={navigate} /></div>
        </nav>
      </aside>
      <main><div className="page">{banner}{children}</div></main>
    </div>
  );
}

const picks = [['both', 'Claude and Codex'], ['claude', 'Claude only'], ['codex', 'Codex only'], ['neither', 'Neither']] as const;
export function SetupView({ state, controller }: { state: SetupViewState; controller: SetupController }) {
  if (state.phase === 'checking' || state.phase === 'error') return <StartupCard
    stage={0} title={state.phase === 'error' ? 'Local setup needs attention' : 'Opening Nortuscc'}
    detail={state.detail} error={state.phase === 'error'}>
    {state.phase === 'error' ? <>
      <p className="muted">Your existing setup has been retained. Recheck it before continuing.</p>
      <button disabled={state.pending} onClick={() => void controller.check()}>Recheck setup</button>
    </> : null}
  </StartupCard>;
  const disabled = state.phase === 'browser' || state.pending;
  const value = state.configTargets.length === 2 ? 'both' : state.configTargets[0] ?? 'neither';
  return (
    <main className="onboarding">
      <p className="eyebrow">NORTUSCC / FIRST RUN</p>
      <h1>Set up {thisMachine}</h1>
      <p className="intro">Prepare the local setup and background agent. Review configuration changes before applying them.</p>
      <section className="form-section">
        <h2>Setup repository</h2>
        <p className="muted">{DEFAULT_REPO_URL}</p>
        <fieldset disabled={disabled}>
          <legend>Configurations to manage</legend>
          {picks.map(([key, label]) => (
            <label key={key} className="choice">
              <input type="radio" name="targets" value={key} checked={value === key}
                onChange={() => controller.choose(key === 'both' ? ['claude', 'codex'] : key === 'neither' ? [] : [key])} />
              {label}
            </label>
          ))}
        </fieldset>
        <p className="muted">Skills and integrations are checked and previewed next.</p>
        <p role="status" className="feedback">{state.detail}</p>
        {state.setup && !state.setup.gitAvailable ? (
          <div className="prerequisite">
            <h2>Git is required</h2>
            <p>{state.setup.canInstallGit ? "Install Apple's command line tools, finish the system dialog, then recheck." : 'Git is unavailable. Install Git for this platform, then recheck.'}</p>
            {state.setup.canInstallGit ? <button disabled={disabled} onClick={() => void controller.installGit()}>Install Git</button> : null}
            <button disabled={disabled} onClick={() => void controller.check()}>Recheck Git</button>
          </div>
        ) : null}
        <div className="form-actions">
          <button className="primary" disabled={disabled || !state.setup?.gitAvailable} onClick={() => void controller.bootstrap()}>Use this repository and set up</button>
          <button disabled={disabled} onClick={() => void controller.check()}>Recheck setup</button>
        </div>
      </section>
    </main>
  );
}

function StartupCard({ stage, title, detail, error = false, children }: {
  stage: number; title: string; detail: string; error?: boolean; children?: ReactNode;
}) {
  return <>
    {!error ? <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{`${title}. ${detail}`}</p> : null}
    <section className={`startup-card${error ? ' startup-attention' : ''}`} aria-busy={!error} aria-labelledby="startup-heading">
    <div className="startup-brand"><span className="startup-mark" aria-hidden="true">N</span><p className="eyebrow">NORTUSCC / {THIS_MACHINE}</p></div>
    <div className="startup-message">
      <span className={error ? 'startup-attention-mark' : 'startup-activity'} aria-hidden="true">{error ? '!' : null}</span>
      <div><h1 id="startup-heading">{title}</h1><p role={error ? 'alert' : undefined}>{detail}</p></div>
    </div>
    <ol className="startup-milestones" aria-label="Startup readiness">
      {['Local setup', 'Agent connection', `Checking ${thisMachine}`].map((label, index) => <li key={label}
        aria-current={!error && index === stage ? 'step' : undefined} className={index < stage ? 'complete' : index === stage ? 'current' : ''}>
        <span className="startup-step-mark" aria-hidden="true">{index < stage ? '✓' : index + 1}</span>
        <span>{label}</span><span className="startup-step-state">{index < stage ? 'Complete' : index === stage ? error ? 'Needs attention' : 'In progress' : 'Waiting'}</span>
      </li>)}
    </ol>
    <div className="startup-next">{children ?? <p className="muted">Your configuration will be ready to review when the agent finishes checking {thisMachine}.</p>}</div>
    </section>
  </>;
}

function MachineStartupView({ state, controller }: { state: ViewState; controller?: MachineController }) {
  return <StartupCard stage={state.connection === 'connected' ? 2 : 1}
    title={state.connection === 'connected' ? 'Loading your configuration' : 'Starting local agent'}
    detail={state.waitingForReport ? 'Reading your local setup and checking for changes.' : state.detail}>
    {state.waitingForReport ? <>
      <p className="muted">You can review the results when the check finishes.</p>
      {controller ? <button disabled={state.pending} onClick={() => void controller.inspect()}>Recheck agent status</button> : null}
    </> : null}
  </StartupCard>;
}

// A new phase opens update activity; byte progress alone preserves the user's disclosure choice.
export function updateAttention(state: UpdateViewState): string | null {
  if (state.retry) return `retry:${state.retry}`;
  const update = state.update;
  if (update?.diagnostic) return `${update.phase}:diagnostic`;
  if (update && update.phase !== 'idle' && update.phase !== 'current'
    && !(state.deferred && (update.phase === 'available' || update.phase === 'verified'))) return update.phase;
  return state.pending && update ? 'pending' : null;
}

export function StartupBoundary({ setup, setupController, machine, machineController, updates, updatesAttention = null, children }: {
  setup: SetupViewState; setupController: SetupController; machine: ViewState; machineController: MachineController;
  updates: ReactNode; updatesAttention?: string | null; children: ReactNode;
}) {
  const [updatesOpen, setUpdatesOpen] = useState(Boolean(updatesAttention));
  useEffect(() => { if (updatesAttention) setUpdatesOpen(true); }, [updatesAttention]);
  let startup: ReactNode;
  if (setup.phase !== 'ready' && setup.phase !== 'browser') startup = <SetupView state={setup} controller={setupController} />;
  else if (machine.initialReadPending || machine.waitingForReport) startup = <MachineStartupView state={machine} controller={machineController} />;
  else return <>{children}</>;
  const focused = setup.phase === 'checking' || setup.phase === 'error' || setup.phase === 'ready';
  return <div className={focused ? 'startup-layout' : undefined}>
    {focused ? <main className="startup-main">{startup}</main> : startup}
    <div className={focused ? 'startup-updates' : 'onboarding first-run-updates'}>
      <details className="startup-update-panel" open={updatesOpen} onToggle={(event) => setUpdatesOpen(event.currentTarget.open)}>
        <summary><span>App updates</span><span className="muted">{updatesAttention ? 'Update activity' : 'Available while the local agent starts'}</span></summary>
        {updates}
      </details>
    </div>
  </div>;
}

export function OfferedSetup({ setup, controller, disabled, onFollowProfile }: { setup: WireHostedState['setups'][number]; controller: AccountController; disabled: boolean; onFollowProfile?: (setupId: string) => void | Promise<void> }) {
  if (setup.profile) return (
    <li className="row offered-setup">
      <div className="row-main"><h3 className="row-title">{setup.name}</h3><p className="row-sub">{repoName(setup.repoUrl)} · {setup.profile}</p></div>
      <div className="row-trail"><button disabled={disabled || !onFollowProfile} onClick={() => onFollowProfile?.(setup.setupId)}>Follow this profile</button></div>
    </li>
  );
  return <LegacyOfferedSetup setup={setup} controller={controller} disabled={disabled} />;
}

function LegacyOfferedSetup({ setup, controller, disabled }: { setup: WireHostedState['setups'][number]; controller: AccountController; disabled: boolean }) {
  const [consent, setConsent] = useState(false);
  return (
    <li className="row offered-setup">
      <div className="row-main"><h3 className="row-title">{setup.name}</h3><p className="row-sub">{repoName(setup.repoUrl)}</p>
        <label className="choice">
          <input type="checkbox" disabled={disabled} checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          I trust this repository to supply setup changes on {thisMachine}.
        </label></div>
      <div className="row-trail"><button disabled={disabled || !consent} onClick={() => void controller.trustSetup(setup.setupId, consent)}>Trust on {thisMachine}</button></div>
    </li>
  );
}

export function SettingsView({ machine, state, controller, machineController, onFollowProfile }: {
  machine: ViewState; state: AccountViewState; controller: AccountController; machineController: MachineController; onFollowProfile?: (setupId: string) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const hosted = state.hosted;
  const native = machine.connection === 'connected';
  const disabled = !native || state.pending;
  const authenticated = hosted?.auth === 'signed-in';
  const pending = state.flow === 'pending' && !authenticated;
  const reconnect = reconnectReason(machine);
  return (
    <>
      <header className="page-header"><div><h1>Settings</h1><p className="intro">Account access is optional. Review and apply work locally.</p></div></header>
      <section className="card" aria-labelledby="settings-account-h">
        <h2 id="settings-account-h">Account</h2>
        <ul className="rows">
          {!native ? <li className="row"><p className="row-sub">{machine.detail}</p></li> : null}
          {hosted ? <>
            <li className="row">
              <div className="row-main"><p className="row-title">{authenticated ? `Signed in as ${hosted.login ?? 'GitHub account'}` : hosted.auth === 'unauthenticated' ? 'Authorization expired' : pending ? 'Authorization pending' : 'Signed out'}</p>
                {pending ? <p className="row-sub">Complete GitHub authorization to sign in.</p> : !hosted.enabled ? <p className="row-sub">Hosted accounts are disabled for this agent.</p> : null}</div>
              <div className="row-trail">
                {authenticated ? <button disabled={disabled} onClick={() => void controller.signOut()}>Sign out</button>
                  : pending ? <button disabled={!native} onClick={() => void controller.signOut()}>Cancel sign-in</button>
                  : <button disabled={disabled || !hosted.enabled} onClick={() => void controller.signIn()}>Sign in with GitHub</button>}
              </div>
            </li>
            {pending ? <li className="row">{state.code ? <>
              <div className="row-main"><p className="device-code" aria-label="GitHub device code">{state.code.userCode}</p>
                <p className="row-sub">This code expires. A code alone does not complete sign-in.</p></div>
              <div className="row-trail"><button disabled={disabled} onClick={() => void controller.openGitHub()}>Open GitHub</button></div>
            </> : <p className="row-sub">The code is unavailable in this window. Cancel to start again.</p>}</li> : null}
            {!authenticated && !pending ? <li className="row"><label className="choice">
              <input type="checkbox" disabled={disabled || !hosted.enabled} checked={state.reportStatus} onChange={(event) => controller.chooseReporting(event.target.checked)} />
              <span className="row-main"><span>Share this machine's status summary</span>
                <span className="row-sub">Includes policy, agent types, setup adoption and drift counts. No configuration values or file contents.</span></span>
            </label></li> : null}
            <li className="row sync-state">
              <div className="row-main"><p>Last successful sync: {hosted.lastSyncAt ?? 'Never'}</p>
                {hosted.retryAt ? <p className="row-sub" role="status">Retry after: {hosted.retryAt}</p> : null}
                {hosted.error ? <p className="alert" role="alert">Account service: {hosted.error}</p> : null}</div>
              <div className="row-trail">{authenticated ? <button disabled={disabled} onClick={() => void controller.syncNow()}>Sync now / retry</button> : null}
                <button disabled={disabled} onClick={() => void controller.refresh()}>Refresh account</button></div>
            </li>
          </> : <li className="row"><p className="row-sub">Account state has not been loaded.</p>
            <div className="row-trail"><button disabled={disabled} onClick={() => void controller.refresh()}>Refresh account</button></div></li>}
        </ul>
        <p className="feedback" role={state.flow === 'error' ? 'alert' : 'status'}>{state.detail}</p>
      </section>
      <section className="card" aria-labelledby="settings-machine-h">
        <h2 id="settings-machine-h">Machine</h2>
        <ul className="rows">
          <li className="row"><label className="row-main" htmlFor="settings-policy"><span className="row-title">Apply policy</span>
            <span className="row-sub">How the agent handles incoming changes.</span></label>
            <div className="row-trail"><select id="settings-policy" disabled={disabled} value={machine.status?.policy ?? machine.hello?.policy ?? 'notify'} onChange={(event) => void controller.setPolicy(event.target.value as Policy)}>
              <option value="notify">Notify</option><option value="manual">Manual</option><option value="auto-apply">Auto apply</option>
            </select></div></li>
          {machine.status?.paused ? <li className="row"><div className="row-main"><p className="row-title">Automatic apply paused</p><p className="row-sub">{machine.status.paused.reason}</p></div>
            <div className="row-trail"><button disabled={disabled} onClick={() => void controller.resume()}>Resume automatic apply</button></div></li> : null}
          {authenticated ? <>
            <li className="row"><form className="row-main" onSubmit={(event) => { event.preventDefault(); if (name) void controller.machineSettings({ name }); }}>
              <label className="field">New machine name
                <span className="actions"><input type="text" value={name} maxLength={200} disabled={disabled} onChange={(event) => setName(event.target.value)} />
                  <button disabled={disabled || !name}>Queue name change</button></span>
              </label>
              <p className="row-sub">The service does not return the saved name here. Acknowledgement confirms a queued update.</p>
            </form></li>
            <li className="row"><label className="choice">
              <input type="checkbox" disabled={disabled || !hosted.machine} checked={hosted.machine?.reportStatus ?? false} onChange={(event) => void controller.machineSettings({ reportStatus: event.target.checked })} />
              <span className="row-main"><span>Share this machine's status summary</span><span className="row-sub">Displayed reporting settings include local queued changes.</span></span>
            </label></li>
          </> : null}
          <li className="row"><div className="row-main"><p className="row-title">Local agent</p><p className="row-sub">{reconnect ?? `Restarts the background agent on ${thisMachine}.`}</p></div>
            <div className="row-trail"><button disabled={reconnect !== null} title={reconnect ?? undefined} onClick={() => void machineController.restart()}>Reconnect agent</button></div>
            {machine.hello ? <details className="settings-details"><summary>Details</summary><p className="agent-version">Agent version {machine.hello.agentVersion}</p></details> : null}</li>
        </ul>
      </section>
      {authenticated && hosted.setups.length ? (
        <section className="card" aria-labelledby="settings-offered-h">
          <div className="card-head"><div><h2 id="settings-offered-h">Offered setups</h2><p>Account membership does not grant trust. Review each repository before consenting.</p></div></div>
          <ul className="rows">{hosted.setups.map((setup) => <OfferedSetup key={`${machine.session}:${hosted.accountId}:${setup.setupId}:${setup.repoUrl}`} setup={setup} controller={controller} disabled={disabled} onFollowProfile={onFollowProfile} />)}</ul>
        </section>
      ) : null}
    </>
  );
}

// Why Reconnect agent is unavailable, or null when it is available.
function reconnectReason(machine: ViewState): string | null {
  if (machine.connection === 'browser') return 'Open the desktop app to reconnect the agent.';
  if (machine.pending) return 'Waiting for the agent to answer.';
  if (machine.busy) return `${machine.busy.description}. Reconnect is available when it finishes.`;
  return null;
}
