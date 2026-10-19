import React from 'react';
import type { UpdateController, UpdateViewState } from './update-controller.ts';
import { byteSize } from './copy.ts';

const descriptions = {
  idle: 'Check for a newer stable release.', checking: 'Checking for updates.', current: 'This app is up to date.',
  available: 'An update is available.', downloading: 'Downloading update.', verified: 'Ready to install.',
  waiting: 'Waiting for configuration apply to finish.', installing: 'Installing update.', restarting: 'Restarting app.',
  error: 'The update could not finish.', recovery: 'Update recovery needs attention.',
} as const;

export function UpdateView({ controller, state }: { controller: UpdateController; state: UpdateViewState }) {
  const update = state.update;
  const active = update !== null && ['checking', 'downloading', 'waiting', 'installing', 'restarting'].includes(update.phase);
  const disabled = !state.native || !update?.enabled || state.pending || active;
  const checkDisabled = !state.native || update?.enabled === false || state.pending || active;
  const cancellable = state.native && update?.enabled && ['downloading', 'waiting'].includes(update.phase);
  return <section className="card updates" aria-labelledby="updates-h">
    <div className="card-head"><div><h2 id="updates-h">Updates</h2><p>Installed version: {update?.installedVersion ?? 'Unknown'}</p></div>
      <div className="actions">
        {!state.deferred && update?.enabled && update.phase === 'available' ? <button className="primary" disabled={disabled} onClick={() => void controller.download()}>Download update</button> : null}
        {!state.deferred && update?.enabled && update.phase === 'verified' ? <button className="primary" disabled={disabled} onClick={() => void controller.install()}>Install and restart</button> : null}
        {!state.deferred && update?.enabled && ['available', 'verified'].includes(update.phase) ? <button disabled={disabled} onClick={() => controller.defer()}>Later</button> : null}
        {state.deferred ? <button disabled={disabled} onClick={() => controller.show()}>Show update</button> : null}
        {cancellable ? <button onClick={() => void controller.cancel()}>Cancel</button> : null}
        {state.retry ? <button disabled={state.retry === 'check' ? checkDisabled : disabled} onClick={() => void controller.retry()}>Retry {state.retry}</button> : null}
        <button disabled={checkDisabled} onClick={() => void controller.check()}>Check for updates</button>
      </div></div>
    {update?.enabled ? <p role="status">{active ? <span className="spinner" aria-hidden="true" /> : null}{active ? ' ' : ''}{state.deferred ? 'Update deferred. Return here when ready.' : descriptions[update.phase]}
      {!state.deferred && update.availableVersion ? ` Version ${update.availableVersion}.` : ''}</p> : null}
    {!state.deferred && update?.enabled && update.notes ? <details><summary>Release notes</summary><p className="update-notes">{update.notes}</p></details> : null}
    {update?.phase === 'downloading' ? <div className="update-progress">
      <progress aria-label="Update download" value={update.totalBytes === null ? undefined : update.downloadedBytes} max={update.totalBytes ?? undefined} />
      <p>{byteSize(update.downloadedBytes)}{update.totalBytes === null ? ' downloaded. Total size is unknown.' : ` of ${byteSize(update.totalBytes)}`}</p>
    </div> : null}
    {update?.diagnostic ? <p className="feedback" role={update.phase === 'error' || update.phase === 'recovery' ? 'alert' : 'status'}>{update.diagnostic}</p> : null}
    {state.detail ? <p className="feedback" role={state.retry ? 'alert' : 'status'}>{state.detail}</p> : null}
    <label className="choice"><input type="checkbox" disabled={disabled} checked={update?.automaticChecks ?? false}
      onChange={(event) => void controller.preferences(event.target.checked)} />
      <span className="row-main"><span>Check automatically at startup</span>
        <span className="row-sub">At most once a day. Updates don’t need an account or a finished setup; download and install always wait for you.</span></span></label>
  </section>;
}
