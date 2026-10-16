import React, { useEffect, useState, type ReactNode } from 'react';
import type { WireHostedState } from '@nortuscc/agent/ipc/protocol';
import type { Policy } from '@nortuscc/hosted-protocol';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';
import type { SetupController, SetupViewState } from './setup-controller.ts';
import type { AccountController, AccountViewState } from './account-controller.ts';
import type { UpdateViewState } from './update-controller.ts';
import type { MachineController, ViewState } from './controller.ts';
import type { SetupSyncController, SetupSyncState } from './setup-sync-controller.ts';
import { draftCount, type HomeState } from './home-controller.ts';
import { errorText } from './copy.ts';

export type Screen = 'home' | 'changes' | 'skills' | 'profiles' | 'upstreams' | 'publish' | 'settings';
// Counts shown beside a screen's name: undecided incoming changes, unpublished drafts, an app update.
export type NavBadges = { readonly changes?: number; readonly publish?: number; readonly settings?: boolean };
// Badges from the Changes review (rows not on hold), Home's local drafts and the updater.
export function navBadges(changes: Pick<SetupSyncState, 'review'>, home: Pick<HomeState, 'drafts'>, update: UpdateViewState): NavBadges {
  const phase = update.update?.enabled ? update.update.phase : null;
  return {
    changes: changes.review?.rows.filter(row => !row.held).length ?? 0,
    publish: draftCount(home.drafts),
    settings: phase === 'available' || phase === 'verified',
  };
}
const groups = [
  ['THIS MAC', [['home', 'Home'], ['changes', 'Changes'], ['skills', 'Skills']]],
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
    <div><strong>This Mac couldn’t be inspected.</strong> <span>{errorText(machine.initialReadError)}</span></div>
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
      <main>{banner}{children}</main>
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
      <h1>Set up this Mac</h1>
      <p className="intro">Prepare the local setup and background agent. Review configuration changes before applying them.</p>
      <section className="form-section">
        <h2>Setup repository</h2>
        <p><code>{DEFAULT_REPO_URL}</code></p>
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
        <p className="muted">Skills and integrations are included in the later inspection and preview.</p>
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
    <div className="startup-brand"><span className="startup-mark" aria-hidden="true">N</span><p className="eyebrow">NORTUSCC / THIS MAC</p></div>
    <div className="startup-message">
      <span className={error ? 'startup-attention-mark' : 'startup-activity'} aria-hidden="true">{error ? '!' : null}</span>
      <div><h1 id="startup-heading">{title}</h1><p role={error ? 'alert' : undefined}>{detail}</p></div>
    </div>
    <ol className="startup-milestones" aria-label="Startup readiness">
      {['Local setup', 'Agent connection', 'Local inspection'].map((label, index) => <li key={label}
        aria-current={!error && index === stage ? 'step' : undefined} className={index < stage ? 'complete' : index === stage ? 'current' : ''}>
        <span className="startup-step-mark" aria-hidden="true">{index < stage ? '✓' : index + 1}</span>
        <span>{label}</span><span className="startup-step-state">{index < stage ? 'Complete' : index === stage ? error ? 'Needs attention' : 'In progress' : 'Waiting'}</span>
      </li>)}
    </ol>
    <div className="startup-next">{children ?? <p className="muted">Your configuration will be ready to review when the local inspection finishes.</p>}</div>
    </section>
  </>;
}

function MachineStartupView({ state, controller }: { state: ViewState; controller?: MachineController }) {
  return <StartupCard stage={state.connection === 'connected' ? 2 : 1}
    title={state.connection === 'connected' ? 'Loading your configuration' : 'Starting local agent'}
    detail={state.waitingForReport ? 'Reading your local setup and checking for changes.' : state.detail}>
    {state.waitingForReport ? <>
      <p className="muted">You can review the results when the inspection finishes.</p>
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
    <div className="offered-setup">
      <h3>{setup.name}</h3><p><code>{setup.repoUrl}</code> · {setup.profile}</p>
      <button disabled={disabled || !onFollowProfile} onClick={() => onFollowProfile?.(setup.setupId)}>Follow this profile</button>
    </div>
  );
  return <LegacyOfferedSetup setup={setup} controller={controller} disabled={disabled} />;
}

function LegacyOfferedSetup({ setup, controller, disabled }: { setup: WireHostedState['setups'][number]; controller: AccountController; disabled: boolean }) {
  const [consent, setConsent] = useState(false);
  return (
    <div className="offered-setup">
      <h3>{setup.name}</h3><p><code>{setup.repoUrl}</code></p>
      <label className="choice">
        <input type="checkbox" disabled={disabled} checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        I trust this repository to supply setup changes on this Mac.
      </label>
      <button disabled={disabled || !consent} onClick={() => void controller.trustSetup(setup.setupId, consent)}>Trust on this Mac</button>
    </div>
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
  return (
    <>
      <header><div><p className="eyebrow">THIS MAC</p><h1>Settings</h1><p className="intro">Account access is optional. Review and apply work locally.</p></div></header>
      <section className="form-section">
        <h2>Account</h2>
        {!native ? <p>{machine.detail}</p> : null}
        {hosted ? (
          <>
            <p>{authenticated ? `Signed in as ${hosted.login ?? 'GitHub account'}` : hosted.auth === 'unauthenticated' ? 'Authorization expired' : pending ? 'Authorization pending' : 'Signed out'}</p>
            {authenticated ? <button disabled={disabled} onClick={() => void controller.signOut()}>Sign out</button> : pending ? (
              <>
                <p>Complete GitHub authorization to sign in.</p>
                {state.code ? (
                  <>
                    <p className="device-code" aria-label="GitHub device code">{state.code.userCode}</p>
                    <p className="muted">This code expires. A code alone does not complete sign-in.</p>
                    <button disabled={disabled} onClick={() => void controller.openGitHub()}>Open GitHub</button>
                  </>
                ) : <p className="muted">The code is unavailable in this window. Cancel to start again.</p>}
                <button disabled={!native} onClick={() => void controller.signOut()}>Cancel sign-in</button>
              </>
            ) : (
              <>
                <label className="choice">
                  <input type="checkbox" disabled={disabled || !hosted.enabled} checked={state.reportStatus} onChange={(event) => controller.chooseReporting(event.target.checked)} />
                  Share this machine's status summary
                </label>
                <p className="muted">Includes policy, agent types, setup adoption and drift counts. No configuration values or file contents.</p>
                <button disabled={disabled || !hosted.enabled} onClick={() => void controller.signIn()}>Sign in with GitHub</button>
              </>
            )}
            {!hosted.enabled ? <p>Hosted accounts are disabled for this agent.</p> : null}
            <div className="sync-state">
              <p>Last successful sync: {hosted.lastSyncAt ?? 'Never'}</p>
              {hosted.retryAt ? <p role="status">Retry after: {hosted.retryAt}</p> : null}
              {hosted.error ? <p role="alert">Account service: {hosted.error}</p> : null}
              {authenticated ? <button disabled={disabled} onClick={() => void controller.syncNow()}>Sync now / retry</button> : null}
            </div>
          </>
        ) : <p className="muted">Account state has not been loaded.</p>}
        <button disabled={disabled} onClick={() => void controller.refresh()}>Refresh account</button>
        <p className="feedback" role={state.flow === 'error' ? 'alert' : 'status'}>{state.detail}</p>
      </section>
      <section className="form-section">
        <h2>Machine</h2>
        <label className="field">Apply policy
          <select disabled={disabled} value={machine.status?.policy ?? machine.hello?.policy ?? 'notify'} onChange={(event) => void controller.setPolicy(event.target.value as Policy)}>
            <option value="notify">Notify</option><option value="manual">Manual</option><option value="auto-apply">Auto apply</option>
          </select>
        </label>
        {machine.status?.paused ? (
          <div className="prerequisite"><p>Automatic apply paused: {machine.status.paused.reason}</p><button disabled={disabled} onClick={() => void controller.resume()}>Resume automatic apply</button></div>
        ) : null}
        {authenticated ? (
          <>
            <form onSubmit={(event) => { event.preventDefault(); if (name) void controller.machineSettings({ name }); }}>
              <label className="field">New machine name
                <input type="text" value={name} maxLength={200} disabled={disabled} onChange={(event) => setName(event.target.value)} />
              </label>
              <button disabled={disabled || !name}>Queue name change</button>
              <p className="muted">The service does not return the saved name here. Acknowledgement confirms a queued update.</p>
            </form>
            <label className="choice">
              <input type="checkbox" disabled={disabled || !hosted.machine} checked={hosted.machine?.reportStatus ?? false} onChange={(event) => void controller.machineSettings({ reportStatus: event.target.checked })} />
              Share this machine's status summary
            </label>
            <p className="muted">Displayed reporting settings include local queued changes.</p>
          </>
        ) : null}
        <button disabled={machine.connection === 'browser' || machine.pending || (native && (machine.status?.applying === true || machine.run?.outcome === 'running'))} onClick={() => void machineController.restart()}>Reconnect agent</button>
        {machine.hello ? <details className="settings-details"><summary>Details</summary>
          <p className="agent-version">Agent version {machine.hello.agentVersion}</p>
        </details> : null}
      </section>
      {authenticated && hosted.setups.length ? (
        <section className="form-section">
          <h2>Offered setups</h2>
          <p>Account membership does not grant trust. Review each repository before consenting.</p>
          {hosted.setups.map((setup) => <OfferedSetup key={`${machine.session}:${hosted.accountId}:${setup.setupId}:${setup.repoUrl}`} setup={setup} controller={controller} disabled={disabled} onFollowProfile={onFollowProfile} />)}
        </section>
      ) : null}
    </>
  );
}
