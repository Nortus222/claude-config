import React, { useState } from 'react';
import { FILES } from '@nortuscc/profile-engine/author-values';
import { AuthorFeedback, AuthorIssues, PublishView, type AuthorProps } from './publish-view.tsx';

export function ProfilesView({ state, controller }: AuthorProps) {
  const [choice, setChoice] = useState<'updateShared' | 'ownCopy' | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const profile = state.profiles?.profiles.find(p => p.name === state.selectedProfile);
  const capture = state.capture;
  return <div className="author-view">
    <header><div><p className="eyebrow">AUTHOR</p><h1>Profiles</h1><p className="intro">Resolved profile skills and files, with their origins.</p></div>
      <button disabled={!state.canRead} onClick={() => void controller.reload()}>Reload profiles</button></header>
    <AuthorFeedback state={state} /><AuthorIssues value={state.profiles} />
    <section className="card"><h2>Profiles</h2>
      {state.profiles ? <p><code>{state.profiles.repoUrl}</code></p> : null}
      <label className="field">Selected profile<select disabled={!state.canRead} value={state.selectedProfile} onChange={e => {setChoice(null); void controller.selectProfile(e.target.value);}}>
        {!state.profiles?.profiles.length ? <option value="">No profiles available</option> : null}
        {state.profiles?.profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select></label>
      {profile ? <><h3>{profile.name}</h3><p>{profile.extends ? `Extends ${profile.extends}` : 'No parent profile'}</p><AuthorIssues value={profile} />
        <h3>Resolved skills</h3><ul>{profile.skills.map(skill => <li key={`${skill.source}:${skill.name}`}>
          <code>{skill.source}:{skill.name}</code>. {skill.included ? 'Included' : 'Excluded'}. From {skill.from}
        </li>)}</ul>{!profile.skills.length ? <p>No skills declared.</p> : null}
        <h3>Resolved files</h3><ul className="setup-sync-rows">{profile.files.map(file => <li className="setup-sync-row" key={file.fileId}>
          <strong>{file.fileId}</strong><p>{file.path ?? 'Unmanaged'}. From {file.from}</p>
          <div className="form-actions"><button disabled={!state.canRead} onClick={() => void controller.selectFile(file.fileId)}>Read {file.fileId}</button>
            {FILES.some(f => f.id === file.fileId && f.capture) ? <button disabled={!state.canWrite} onClick={() => {setChoice(null);setRepoPath('');void controller.captureFile(file.fileId);}}>Capture from this Mac</button> : null}</div>
        </li>)}</ul></> : null}
    </section>
    {state.file ? <section className="card"><h2>{state.fileId}</h2><p>{state.file.path ?? 'Unmanaged'}. Read only.</p><AuthorIssues value={state.file} />
      <pre className="setup-sync-diff" tabIndex={0} aria-label="Profile file text">{state.file.text}</pre>{state.file.truncated ? <p role="status">File preview is truncated.</p> : null}</section> : null}
    {capture ? <section className="card"><h2>Capture {capture.fileId} from this Mac</h2>
      <p>Affected profiles: {capture.affectedProfiles.join(', ')}</p>
      <pre className="setup-sync-diff" tabIndex={0} aria-label="Captured machine text">{capture.text}</pre>
      <fieldset disabled={!state.canWrite}><legend>Choose where to capture</legend>
        <label className="choice"><input type="radio" name="capture-choice" checked={choice === 'updateShared'} onChange={() => setChoice('updateShared')} />Update shared file</label>
        <p>Updates all listed profiles.</p>
        <label className="choice"><input type="radio" name="capture-choice" checked={choice === 'ownCopy'} onChange={() => setChoice('ownCopy')} />Give this profile its own copy</label>
        <p>Changes only {capture.profile}.</p>
        {choice === 'ownCopy' ? <label className="field">Copy path under claude/ or codex/<input type="text" value={repoPath} onChange={e => setRepoPath(e.target.value)} /></label> : null}
      </fieldset>
      <button disabled={!state.canWrite || !choice || choice === 'ownCopy' && !repoPath} onClick={() => {
        if (choice) void controller.saveCapture(choice === 'updateShared' ? {kind:'updateShared'} : {kind:'ownCopy',repoPath});
      }}>Add capture to draft</button>
    </section> : null}
    <PublishView state={state} controller={controller} />
  </div>;
}
