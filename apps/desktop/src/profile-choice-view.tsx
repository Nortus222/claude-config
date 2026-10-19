import React, { type FormEvent } from 'react';
import type { ViewState } from './controller.ts';
import type { SetupViewState } from './setup-controller.ts';
import type { SetupSyncController, SetupSyncState } from './setup-sync-controller.ts';
import { PreviewPanel, RunCard } from './setup-sync-view.tsx';

type Actions = Pick<SetupSyncController, 'followRepository' | 'followSharedLink' | 'apply' | 'cancelPreview' | 'cancel'>;

// The first-run profile choice is due once: after this session's first-run bootstrap, while the agent is
// connected, until a follow is applied or the current profile is kept.
export const profileChoiceDue = (setup: Pick<SetupViewState, 'bootstrapped'>, machine: Pick<ViewState, 'connection'>, settled: boolean) =>
  setup.bootstrapped && !settled && machine.connection === 'connected';

// A follow or switch this window applied successfully, which makes the choice.
export const followApplied = (state: Pick<SetupSyncState, 'run'>) => state.run?.intent.change.kind === 'followProfile' && state.run.state === 'succeeded';

// First run: choose the profile this Mac follows from the setup repository, or a shared link. A choice is
// previewed and applied in the same panel as a switch on Changes.
export function ProfileChoiceView({ state, controller, repoUrl, onDone }: { state: SetupSyncState; controller: Actions; repoUrl: string; onDone: () => void }) {
  const current = state.profiles?.followed?.profile ?? null, can = state.eligibility;
  const followLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const link = (event.currentTarget.elements.namedItem('link') as HTMLInputElement | null)?.value ?? '';
    return link.trim() ? controller.followSharedLink(link) : undefined;
  };
  const keep = () => { controller.cancelPreview(); onDone(); };
  return <main className="onboarding setup-sync-view profile-choice-view">
    <p className="eyebrow">NORTUSCC / FIRST RUN</p>
    <h1>Choose a profile</h1>
    <p className="intro">This Mac is set up. Choose the profile it follows from {repoUrl}. Preview shows what changes; nothing is written until you apply.</p>
    {state.error ? <p className="alert" role="alert">{state.error}</p> : null}
    <p className="setup-sync-detail" role="status">{state.pending ? 'Reading…' : ''}</p>
    <PreviewPanel state={state} controller={controller} />
    {state.run ? <RunCard run={state.run} state={state} controller={controller} /> : null}
    <section className="card" aria-labelledby="profile-choice-h"><h2 id="profile-choice-h">Profiles</h2>
      {state.profileNotice ? <p className="notice">{state.profileNotice}</p> : null}
      {state.profiles ? <ul className="rows profile-choice-list">{state.profiles.available.map(profile => <li className="row" key={profile.name} aria-current={profile.name === current ? 'true' : undefined}>
        <span className="row-main"><strong>{profile.name}</strong>{profile.name === current ? <small className="pill pill-success">Current</small> : null}{profile.extends ? <small className="row-sub">Builds on {profile.extends}</small> : null}</span>
        {profile.name === current ? null : <button disabled={!can.read} onClick={() => controller.followRepository(repoUrl, profile.name)}>Follow {profile.name}</button>}
      </li>)}</ul> : <p className="muted">Reading profiles…</p>}
    </section>
    <section className="card" aria-labelledby="profile-choice-link-h"><h2 id="profile-choice-link-h">Follow a shared link instead</h2>
      <form className="inline-form" onSubmit={followLink}><label className="inline-field"><span>Shared link</span><input name="link" required disabled={!can.read} placeholder="nortuscc://follow/…" /></label>
        <button disabled={!can.read}>Preview follow</button></form>
    </section>
    <div className="setup-sync-actions"><button disabled={state.pending} onClick={keep}>{current ? `Keep ${current}` : 'Decide later'}</button></div>
  </main>;
}
