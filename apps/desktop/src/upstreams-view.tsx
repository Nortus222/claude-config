import React, { useState } from 'react';
import { AuthorFeedback, AuthorIssues, DraftLine, RunStatus, READ_REASON, WRITE_REASON, type AuthorPageProps } from './publish-view.tsx';
import type { AuthorState } from './author-controller.ts';
import { plural } from './copy.ts';
import { thisMachine } from './device.ts';

type Source = NonNullable<AuthorState['upstreams']>['sources'][number];
// Discovery state in words, with its pill tone.
const DISCOVERY: Readonly<Record<string, readonly [string, string]>> = { complete: ['Skill list read', 'pill-success'], unavailable: ["Couldn't read", 'pill-danger'] };
// Why a skill list couldn't be read, in words.
const UNAVAILABLE: Readonly<Record<string, string>> = { 'cli-failed': 'The skills tool failed', unparseable: 'Its answer couldn’t be read',
  'head-moved': 'The source changed while it was read', timeout: 'It took too long', 'too-large': 'The list is too large' };
const discoveryState =(source: Source) => source.discovery ? DISCOVERY[source.discovery.kind] ?? [source.discovery.kind, ''] : ['Not read', ''] as const;

function included(state: AuthorState, profile: string, source: string, name: string) {
  const intent = state.draft ? [...state.draft.intents].reverse().find(i => (i.kind === 'includeSkill' || i.kind === 'excludeSkill') && i.profile === profile && i.source === source && i.name === name) : undefined;
  if (intent) return intent.kind === 'includeSkill';
  return state.profiles?.profiles.find(p => p.name === profile)?.skills.some(s => s.source === source && s.name === name && s.included) ?? false;
}

// One source: its profiles, pin and skill-list state, and once read, its skills with per-profile include.
function SourceRow({ state, controller, source }: Pick<AuthorPageProps, 'state' | 'controller'> & { source: Source }) {
  const discovery = source.discovery;
  const [label, tone] = discoveryState(source);
  const impact = state.profiles?.profiles.flatMap(profile => profile.skills.filter(s => s.source === source.source).map(s => `${profile.name}: ${s.name}`)) ?? [];
  return <li className="row upstream-source">
    <div className="row-main"><span className="row-title">{source.source}</span>
      <span className="chips">{source.inProfiles.length ? source.inProfiles.map(name => <span className="pill" key={name}>{name}</span>) : <span className="row-sub">Browsing only</span>}</span></div>
    <div className="row-trail">
      <span className={`pill ${source.pin ? 'pill-accent' : ''}`} title={source.pin ? `Pinned to ${source.pin}` : undefined}>{source.pin ? `Pinned ${source.pin.slice(0, 7)}` : 'Unpinned'}</span>
      <span className={`pill ${tone}`}>{label}</span>
      <button disabled={!state.canWrite} title={state.canWrite ? undefined : WRITE_REASON} onClick={() => void controller.discover(source.source)}>{discovery ? 'Refresh skill list' : 'Read skill list'}</button>
    </div>
    {discovery?.kind === 'unavailable' ? <p className="row-detail alert" role="alert">Couldn't read this source's skill list. {UNAVAILABLE[discovery.reason] ?? 'Something went wrong'}. Retry with Refresh skill list.</p> : null}
    {discovery?.kind === 'complete' ? <div className="row-detail">
      <details className="pin-impact"><summary>Pin · affects {plural(impact.length, 'profile skill')}</summary>
        <fieldset disabled={!state.canWrite}><legend className="sr-only">Pin impact</legend>
          <p className="row-sub">Source pins are shared by all profiles. Current commit <code>{discovery.commit.slice(0, 12)}</code>.</p>
          {impact.length ? <ul className="impact-list">{impact.map(item => <li key={item}>{item}</li>)}</ul> : <p className="row-sub">No included skills currently use this source.</p>}
          <div className="actions"><button onClick={() => void controller.pin(source.source, discovery.commit)}>Pin to current commit</button>
            {source.pin ? <button onClick={() => void controller.unpin(source.source)}>Unpin</button> : null}</div>
        </fieldset>
      </details>
      {discovery.skills.length ? <ul className="rows upstream-skills">{discovery.skills.map(skill => <li className="row" key={skill.name}>
        <div className="row-main"><h3 className="row-title">{skill.name}</h3><p className="row-sub">{skill.description}</p>
          <fieldset className="include-profiles" disabled={!state.canWrite}><legend className="sr-only">Include {skill.name} in profiles</legend>
            <span className="row-sub" aria-hidden="true">Include in</span>
            {state.profiles?.profiles.map(profile => <label className="choice" key={profile.name}>
              <input type="checkbox" checked={included(state, profile.name, source.source, skill.name)} onChange={e => void controller.includeSkill(profile.name, source.source, skill.name, e.target.checked)} />{profile.name}
            </label>)}</fieldset></div>
        <div className="row-trail"><button aria-label={`Read ${skill.name}`} disabled={!state.canRead} onClick={() => void controller.readSkill(source.source, discovery.commit, skill.name)}>Read</button></div>
      </li>)}</ul> : <p className="row-sub">No skills in this source.</p>}
    </div> : null}
  </li>;
}

export function UpstreamsView({ state, controller, onOpenPublish }: AuthorPageProps) {
  const [url, setUrl] = useState('');
  const sources = state.upstreams?.sources ?? [];
  return <div className="author-view"><header className="page-header"><div><h1>Upstreams</h1><p className="intro">Browse source skills and choose which profiles include them.</p></div>
    <div className="header-actions"><button disabled={!state.canRead} title={state.canRead ? undefined : READ_REASON} onClick={() => void controller.reload()}>Reload upstreams</button></div></header>
    <AuthorFeedback state={state} /><RunStatus state={state} controller={controller} page="author" /><DraftLine state={state} onOpenPublish={onOpenPublish} />
    <AuthorIssues issues={state.upstreams?.issues} />
    <section className="card" aria-labelledby="upstreams-add-h"><h2 id="upstreams-add-h">Add source</h2>
      <form className="inline-form" onSubmit={e => {e.preventDefault();if (url.trim()) void controller.discover(url.trim());}}>
        <label className="inline-field"><span className="sr-only">Source URL or owner/repo</span><input type="text" value={url} placeholder="owner/repo or URL" disabled={!state.canWrite} onChange={e => setUrl(e.target.value)} /></label>
        <button disabled={!state.canWrite || !url.trim()}>Add source</button></form>
      <p className="row-sub">Browsing a source doesn’t publish it. Including one of its skills adds it to the draft.</p></section>
    {sources.length ? <section className="card" aria-labelledby="upstreams-sources-h">
      <div className="card-head"><div><h2 id="upstreams-sources-h">Sources</h2>{state.canWrite ? null : <p>Reading skill lists is available when {thisMachine} finishes its current work.</p>}</div></div>
      <ul className="rows">{sources.map(source => <SourceRow key={source.source} state={state} controller={controller} source={source} />)}</ul></section> : null}
    {state.skill ? <section className="card"><h2>Skill contents</h2>{'unavailable' in state.skill ? <p className="alert" role="alert">{state.skill.unavailable}</p> : <>
      <p className="row-sub">{state.skill.path}</p><pre className="setup-sync-diff" tabIndex={0} aria-label="Skill text">{state.skill.text}</pre>
      <details><summary>{plural(state.skill.files.length, 'file')}</summary><ul>{state.skill.files.map(file => <li key={file}>{file}</li>)}</ul></details>
    </>}</section> : null}
  </div>;
}
