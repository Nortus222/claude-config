import React from 'react';
import type { UpdateController, UpdateViewState } from './update-controller.ts';

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
  return <section className="form-section updates">
    <h2>Updates</h2>
    <p>Installed version: {update?.installedVersion ?? 'Unknown'}</p>
    <p className="muted">Update checks and downloads do not require an account or completed setup.</p>
    {update?.enabled ? <p role="status">{state.deferred ? 'Update deferred. Return here when ready.' : descriptions[update.phase]}</p> : null}
    {!state.deferred && update?.enabled && update.availableVersion ? <p>Available version: {update.availableVersion}</p> : null}
    {!state.deferred && update?.enabled && update.notes ? <details><summary>Release notes</summary><p className="update-notes">{update.notes}</p></details> : null}
    {update?.phase === 'downloading' ? <div className="update-progress">
      <progress aria-label="Update download" value={update.totalBytes === null ? undefined : update.downloadedBytes} max={update.totalBytes ?? undefined} />
      <p>{update.downloadedBytes} bytes{update.totalBytes === null ? ' downloaded. Total size is unknown.' : ` of ${update.totalBytes} bytes`}</p>
    </div> : null}
    {update?.diagnostic ? <p className="feedback" role={update.phase === 'error' || update.phase === 'recovery' ? 'alert' : 'status'}>{update.diagnostic}</p> : null}
    {state.detail ? <p className="feedback" role={state.retry ? 'alert' : 'status'}>{state.detail}</p> : null}
    <label className="choice"><input type="checkbox" disabled={disabled} checked={update?.automaticChecks ?? false}
      onChange={(event) => void controller.preferences(event.target.checked)} />Check automatically at startup</label>
    <p className="muted">Automatic checks run at most once a day. Download and installation always need your action.</p>
    <div className="form-actions">
      <button disabled={checkDisabled} onClick={() => void controller.check()}>Check for updates</button>
      {state.retry ? <button disabled={state.retry === 'check' ? checkDisabled : disabled} onClick={() => void controller.retry()}>Retry {state.retry}</button> : null}
      {!state.deferred && update?.enabled && update.phase === 'available' ? <button className="primary" disabled={disabled} onClick={() => void controller.download()}>Download update</button> : null}
      {!state.deferred && update?.enabled && update.phase === 'verified' ? <button className="primary" disabled={disabled} onClick={() => void controller.install()}>Install and restart</button> : null}
      {!state.deferred && update?.enabled && ['available', 'verified'].includes(update.phase) ? <button disabled={disabled} onClick={() => controller.defer()}>Later</button> : null}
      {state.deferred ? <button disabled={disabled} onClick={() => controller.show()}>Show update</button> : null}
      {cancellable ? <button onClick={() => void controller.cancel()}>Cancel</button> : null}
    </div>
  </section>;
}
