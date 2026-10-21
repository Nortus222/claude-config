import React, { useState } from 'react';
import { FILES } from '@nortuscc/profile-engine/author-values';
import { AuthorFeedback, AuthorIssues, DraftLine, RunStatus, READ_REASON, WRITE_REASON, type AuthorPageProps } from './publish-view.tsx';
import { itemLabel, plural, repoName } from './copy.ts';
import { thisMachine } from './device.ts';

type Skill = { readonly source: string; readonly name: string; readonly included: boolean; readonly from: string };

// Skills grouped by source, keeping the order sources first appear in.
function bySource(skills: readonly Skill[]) {
  const groups = new Map<string, Skill[]>();
  for (const skill of skills) groups.set(skill.source, [...groups.get(skill.source) ?? [], skill]);
  return [...groups];
}

export function ProfilesView({ state, controller, onOpenPublish }: AuthorPageProps) {
  const [choice, setChoice] = useState<'updateShared' | 'ownCopy' | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const [showExcluded, setShowExcluded] = useState(false);
  const profile = state.profiles?.profiles.find(p => p.name === state.selectedProfile);
  const capture = state.capture;
  const [copyMessage, setCopyMessage] = useState('');
  const shareLink = profile?.setupId ? `nortuscc://follow/${profile.setupId}` : null;
  const included = profile?.skills.filter(skill => skill.included) ?? [];
  const excluded = profile?.skills.filter(skill => !skill.included) ?? [];
  const shown = showExcluded ? profile?.skills ?? [] : included;
  return <div className="author-view">
    <header className="page-header"><div><h1>Profiles</h1><p className="intro">{state.profiles ? `Resolved skills and files for each profile in ${repoName(state.profiles.repoUrl)}.` : 'Resolved skills and files for each profile.'}</p></div>
      <div className="header-actions"><button disabled={!state.canRead} title={state.canRead ? undefined : READ_REASON} onClick={() => void controller.reload()}>Reload profiles</button></div></header>
    <AuthorFeedback state={state} /><RunStatus state={state} controller={controller} page="author" /><DraftLine state={state} onOpenPublish={onOpenPublish} /><AuthorIssues issues={state.profiles?.issues} except={profile?.name} />
    <section className="card" aria-label="Profile">
      <ul className="rows">
        <li className="row"><label className="row-main" htmlFor="profiles-select"><span className="row-title">Profile</span>
          {profile ? <span className="row-sub">{profile.extends ? `Extends ${profile.extends}` : 'No parent profile'}</span> : null}</label>
          <div className="row-trail"><select id="profiles-select" disabled={!state.canRead} value={state.selectedProfile} onChange={e => {setChoice(null); setCopyMessage(''); setShowExcluded(false); void controller.selectProfile(e.target.value);}}>
            {!state.profiles?.profiles.length ? <option value="">No profiles available</option> : null}
            {state.profiles?.profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select></div></li>
        {profile && shareLink ? <li className="row"><div className="row-main"><span className="row-title">Share this profile</span><span className="row-sub selectable">{shareLink}</span></div>
          <div className="row-trail">{copyMessage ? <span className="reason" role="status">{copyMessage}</span> : null}
            <button aria-label={`Copy follow link for ${profile.name}`} onClick={() => { void navigator.clipboard.writeText(shareLink).then(() => setCopyMessage('Link copied'), () => setCopyMessage('Could not copy the link')); }}>Copy</button></div></li> : null}
      </ul>
      {profile ? <AuthorIssues issues={state.profiles?.issues} profile={profile.name} /> : null}
    </section>
    {profile ? <section className="card" aria-labelledby="profile-skills-h">
      <div className="card-head"><div><h2 id="profile-skills-h">Skills</h2>
        <p>{profile.skills.length ? `${included.length} included${excluded.length ? ` · ${excluded.length} excluded` : ''}` : 'No skills declared.'}</p></div>
        {excluded.length ? <button className="link" aria-pressed={showExcluded} onClick={() => setShowExcluded(!showExcluded)}>{showExcluded ? 'Hide excluded' : `Show ${plural(excluded.length, 'excluded skill')}`}</button> : null}</div>
      {shown.length ? <ul className="rows" aria-label={`Skills in ${profile.name}`}>{bySource(shown).map(([source, skills]) => <React.Fragment key={source}>
        <li className="group-label">{source}</li>
        {skills.map(skill => <li className="row" key={`${skill.source}:${skill.name}`}>
          <div className="row-main"><span className="row-title">{skill.name}</span><span className="row-sub">From {skill.from}</span></div>
          <span className={`pill ${skill.included ? 'pill-success' : ''}`}>{skill.included ? 'Included' : 'Excluded'}</span>
        </li>)}
      </React.Fragment>)}</ul> : profile.skills.length ? <p className="muted">Every skill in this profile is excluded.</p> : null}
    </section> : null}
    {profile ? <section className="card" aria-labelledby="profile-files-h">
      <div className="card-head"><div><h2 id="profile-files-h">Files</h2>{state.canWrite ? null : <p>Capturing is available when {thisMachine} finishes its current work.</p>}</div></div>
      {profile.files.length ? <ul className="rows setup-sync-rows">{profile.files.map(file => <li className="row" key={file.fileId}>
        <div className="row-main"><span className="row-title">{itemLabel(`file:${file.fileId}`).text}</span><span className="row-sub">{file.path ?? 'Unmanaged'} · from {file.from}</span></div>
        <div className="row-trail"><button aria-label={`Read ${file.fileId}`} disabled={!state.canRead} onClick={() => void controller.selectFile(file.fileId)}>Read</button>
          {FILES.some(f => f.id === file.fileId && f.capture) ? <button disabled={!state.canWrite} title={state.canWrite ? undefined : WRITE_REASON} onClick={() => {setChoice(null);setRepoPath('');void controller.captureFile(file.fileId);}}>Capture from {thisMachine}</button> : null}</div>
      </li>)}</ul> : <p className="muted">No files declared.</p>}
    </section> : null}
    {state.file ? <section className="card"><div className="card-head"><div><h2>{state.fileId ? itemLabel(`file:${state.fileId}`).text : 'File'}</h2><p>{state.file.path ?? 'Unmanaged'}. Read only.</p></div></div><AuthorIssues issues={state.file.issues} />
      <pre className="setup-sync-diff" tabIndex={0} aria-label="Profile file text">{state.file.text}</pre>{state.file.truncated ? <p className="muted" role="status">File preview is truncated.</p> : null}</section> : null}
    {capture ? <section className="card"><div className="card-head"><div><h2>Capture {itemLabel(`file:${capture.fileId}`).text} from {thisMachine}</h2>
      <p>Affected profiles: {capture.affectedProfiles.join(', ')}</p></div></div>
      <pre className="setup-sync-diff" tabIndex={0} aria-label="Captured machine text">{capture.text}</pre>
      <fieldset className="capture-choices" disabled={!state.canWrite}><legend>Choose where to capture</legend>
        <label className="choice"><input type="radio" name="capture-choice" checked={choice === 'updateShared'} onChange={() => setChoice('updateShared')} />
          <span className="row-main"><span>Update shared file</span><span className="row-sub">Updates all listed profiles.</span></span></label>
        <label className="choice"><input type="radio" name="capture-choice" checked={choice === 'ownCopy'} onChange={() => setChoice('ownCopy')} />
          <span className="row-main"><span>Give this profile its own copy</span><span className="row-sub">Changes only {capture.profile}.</span></span></label>
        {choice === 'ownCopy' ? <label className="field">Copy path under claude/ or codex/<input type="text" value={repoPath} onChange={e => setRepoPath(e.target.value)} /></label> : null}
      </fieldset>
      <div className="actions"><button className="primary" disabled={!state.canWrite || !choice || choice === 'ownCopy' && !repoPath} onClick={() => {
        if (choice) void controller.saveCapture(choice === 'updateShared' ? {kind:'updateShared'} : {kind:'ownCopy',repoPath});
      }}>Add capture to draft</button></div>
    </section> : null}
  </div>;
}
