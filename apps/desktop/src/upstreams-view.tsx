import React, { useState } from 'react';
import { AuthorFeedback, AuthorIssues, PublishView, type AuthorProps } from './publish-view.tsx';
import type { AuthorState } from './author-controller.ts';

function included(state: AuthorState, profile: string, source: string, name: string) {
  const intent = state.draft ? [...state.draft.intents].reverse().find(i => (i.kind === 'includeSkill' || i.kind === 'excludeSkill') && i.profile === profile && i.source === source && i.name === name) : undefined;
  if (intent) return intent.kind === 'includeSkill';
  return state.profiles?.profiles.find(p => p.name === profile)?.skills.some(s => s.source === source && s.name === name && s.included) ?? false;
}
export function UpstreamsView({ state, controller }: AuthorProps) {
  const [url, setUrl] = useState('');
  return <div className="author-view"><header><div><p className="eyebrow">AUTHOR</p><h1>Upstreams</h1><p className="intro">Browse source skills and choose which profiles include them.</p></div>
    <button disabled={!state.canRead} onClick={() => void controller.reload()}>Reload upstreams</button></header>
    <AuthorFeedback state={state} /><AuthorIssues issues={state.upstreams?.issues} />
    <section className="card"><h2>Add source</h2><form onSubmit={e => {e.preventDefault();if (url.trim()) void controller.discover(url.trim());}}>
      <label className="field">Source URL or owner/repo<input type="text" value={url} disabled={!state.canWrite} onChange={e => setUrl(e.target.value)} /></label>
      <button disabled={!state.canWrite || !url.trim()}>Add source</button></form><p>Browsing a source does not publish it. Including one of its skills adds it to the draft.</p></section>
    {state.upstreams?.sources.map(source => {
      const discovery = source.discovery;
      const impact = state.profiles?.profiles.flatMap(profile => profile.skills.filter(s => s.source === source.source).map(s => `${profile.name}: ${s.name}`)) ?? [];
      return <section className="card" key={source.source}><h2>{source.source}</h2><p>Profiles: {source.inProfiles.join(', ') || 'Browsing only'}</p>
        <p>Pin: <code>{source.pin ?? 'Unpinned'}</code></p><p>Discovery: {discovery?.kind ?? 'Not read'}</p>
        <button disabled={!state.canWrite} onClick={() => void controller.discover(source.source)}>{discovery ? 'Refresh skill list' : 'Read skill list'}</button>
        {discovery?.kind === 'unavailable' ? <p className="alert" role="alert">Couldn't read this source's skill list. {discovery.reason}. Retry with Refresh skill list.</p> : null}
        {discovery?.kind === 'complete' ? <>
          <p>Current commit: <code>{discovery.commit}</code></p>
          <fieldset disabled={!state.canWrite}><legend>Pin impact</legend><p>Source pins are shared by all profiles.</p>
            <ul>{impact.map(item => <li key={item}>{item}</li>)}</ul>{!impact.length ? <p>No included skills currently use this source.</p> : null}
            <button onClick={() => void controller.pin(source.source, discovery.commit)}>Pin to current commit</button>
            {source.pin ? <button onClick={() => void controller.unpin(source.source)}>Unpin</button> : null}
          </fieldset>
          <ul className="setup-sync-rows">{discovery.skills.map(skill => <li className="setup-sync-row" key={skill.name}><h3>{skill.name}</h3><p>{skill.description}</p>
            <button disabled={!state.canRead} onClick={() => void controller.readSkill(source.source, discovery.commit, skill.name)}>Read {skill.name}</button>
            <fieldset disabled={!state.canWrite}><legend>Include {skill.name} in profiles</legend>{state.profiles?.profiles.map(profile => <label className="choice" key={profile.name}>
              <input type="checkbox" checked={included(state, profile.name, source.source, skill.name)} onChange={e => void controller.includeSkill(profile.name, source.source, skill.name, e.target.checked)} />{profile.name}
            </label>)}</fieldset>
          </li>)}</ul>{!discovery.skills.length ? <p>No skills in this source.</p> : null}
        </> : null}
      </section>;
    })}
    {state.skill ? <section className="card"><h2>Skill contents</h2>{'unavailable' in state.skill ? <p role="alert">{state.skill.unavailable}</p> : <>
      <p>{state.skill.path}</p><pre className="setup-sync-diff" tabIndex={0} aria-label="Skill text">{state.skill.text}</pre><h3>Files</h3><ul>{state.skill.files.map(file => <li key={file}>{file}</li>)}</ul>
    </>}</section> : null}
    <PublishView state={state} controller={controller} />
  </div>;
}
