import React, { useState } from 'react';
import type { InspectResult } from '@nortuscc/agent/ipc/protocol';
import type { ViewState } from './controller.ts';
import { effectiveChoice, eligibleUpdates, mutationBlocked, type SkillChoice, type SkillRow, type SkillCheck, type SkillsController, type SkillsViewState } from './skills-controller.ts';
import type { OperationOutput } from '@nortuscc/agent/operations';
import { changeTitle } from './copy.ts';
import { BusyCard } from './busy-view.tsx';
export type SkillsFilter = 'all' | 'choices' | 'attention' | 'updates';
type Inventory = { readonly items: readonly OperationOutput<'inspectIntent'>['items'][number][] };
type Observation = Pick<InspectResult['items'][number], 'state' | 'disposition' | 'note'>;
const changed = (row: SkillCheck['items'][number]) => row.state === 'outdated' || row.state === 'off-pin';
const same = (a: { source: string; name: string }, b: { source: string; name: string }) => a.source === b.source && a.name === b.name;
type RunState = NonNullable<SkillsViewState['run']>['state'];
// Run headings in words, by kind; `active` covers accepted and running.
const RUN_HEADINGS: Readonly<Record<string, Readonly<Record<Exclude<RunState, 'accepted' | 'running'> | 'active', string>>>> = {
  update: { active: 'Updating skills…', succeeded: 'Skills updated', failed: 'Update failed', cancelled: 'Update cancelled', interrupted: 'Update interrupted', abandoned: 'Update abandoned' },
  machineIntent: { active: 'Saving skill choice…', succeeded: 'Skill choice saved', failed: 'Saving the skill choice failed', cancelled: 'Saving the skill choice was cancelled',
    interrupted: 'Saving the skill choice was interrupted', abandoned: 'Saving the skill choice was abandoned' },
};
const runHeading = (run: NonNullable<SkillsViewState['run']>) => {
  const state = run.state === 'accepted' || run.state === 'running' ? 'active' : run.state;
  return RUN_HEADINGS[run.intent.change.kind]?.[state] ?? (state === 'active' ? `${changeTitle(run.intent.change.kind)}…` : `${changeTitle(run.intent.change.kind)} ${state}`);
};
const UPSTREAM = { current: 'Up to date', outdated: 'Update available', 'off-pin': 'Differs from pin', gone: 'Removed upstream', unknown: 'Unknown', available: 'Available', local: 'Local' };

// Search keeps source order and drops groups without matching skills.
export function filterSkills(view: Inventory, check: SkillCheck | null, query: string, filter: SkillsFilter, observations: readonly InspectResult['items'][number][] = []) {
  const needle = query.trim().toLowerCase(), groups = new Map<string, SkillRow[]>();
  for (const row of view.items) {
    if (row.kind !== 'skill' || needle && !row.name.toLowerCase().includes(needle) && !row.source.toLowerCase().includes(needle)) continue;
    if (filter === 'choices' && row.choice === null) continue;
    if (filter === 'updates' && !check?.items.some(item => same(item, row) && changed(item))) continue;
    if (filter === 'attention' && !observations.some(item => item.domain === 'skills' && item.label === row.name && (item.group === row.source || item.key === `skill:${row.name}`) && (item.disposition === 'apply' || item.disposition === 'blocked'))) continue;
    const skills = groups.get(row.source) ?? []; skills.push(row); groups.set(row.source, skills);
  }
  return [...groups].map(([source, skills]) => ({ source, skills }));
}

// Disk state is observed separately from saved intent; Off promises removal only with an owned plan.
export function rowState(row: SkillRow, observation?: Observation) {
  const state = observation?.state;
  const installed = state === 'ok' || state === 'disabled' || state === 'off-pin' ? 'Installed' : state === 'missing' ? 'Not installed' : state ?? 'Unknown';
  let detail: string | null = null;
  if (observation?.disposition === 'blocked') detail = row.choice === false ? `Disable blocked: ${observation.note ?? 'ownership could not be confirmed'}. Nothing will be removed.` : `Blocked: ${observation.note ?? 'review the machine plan'}.`;
  else if (row.choice === false && observation?.disposition === 'apply') detail = 'Disable pending. Apply on Changes removes owned copies after a backup.';
  else if (state === 'missing' && effectiveChoice(row) && observation?.disposition === 'apply') detail = 'Installs when you Apply on Changes.';
  else if (state === 'off-pin' && effectiveChoice(row)) detail = 'Differs from pin. Apply on Changes reinstalls the pinned version.';
  else if (state === 'ok' && row.choice === null && !row.defaultEnabled) detail = 'Previously installed optional skill. Default keeps it installed; choose Off to plan its removal.';
  else if (row.choice === false && state === 'missing') detail = 'Off on this Mac.';
  else detail = observation?.note ?? null;
  return { installed, detail, review: observation?.disposition === 'apply' };
}
export function ChoiceControl({ row, state, disabled, controller }: { row: SkillRow; state: SkillsViewState; disabled: boolean; controller: SkillsController }) {
  const saving = state.saving && same(state.saving, row);
  const value: SkillChoice = row.choice === null ? 'inherit' : row.choice ? 'on' : 'off';
  return <div className="skills-choice">
    <div role="radiogroup" aria-label={`${row.name} on this Mac`} className="skills-seg" aria-busy={saving ? true : undefined}>
      {([['inherit', `Default · ${row.defaultEnabled ? 'On' : 'Off'}`], ['on', 'On'], ['off', 'Off']] as const).map(([choice, label]) => <label key={choice}>
        <input type="radio" name={`skill-${JSON.stringify([row.source, row.name])}`} value={choice} checked={value === choice} disabled={disabled}
          onChange={() => void controller.setChoice(row.source, row.name, choice)} /><span>{label}</span>
      </label>)}
    </div>
    <p className="row-sub">{saving ? <span role="status"><span className="spinner" aria-hidden="true" /> Saving…</span> : row.choice === null ? 'From the profile' : 'Your choice on this Mac'}</p>
  </div>;
}
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
// "3 steps done, 1 failed": the run's step outcomes as counts, never their keys.
function stepCounts(steps: readonly { readonly outcome: 'ok' | 'failed' | 'cancelled' }[]) {
  const failed = steps.filter(step => step.outcome === 'failed').length, cancelled = steps.filter(step => step.outcome === 'cancelled').length;
  return [`${count(steps.length - failed - cancelled, 'step')} done`, failed ? `${failed} failed` : '', cancelled ? `${cancelled} cancelled` : ''].filter(Boolean).join(', ');
}
export function SkillsView({ state, machine, controller, maintenance = null, onOpenChanges }: {
  state: SkillsViewState; machine: ViewState; controller: SkillsController; maintenance?: string | null; onOpenChanges?: () => void;
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<SkillsFilter>('all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const blocked = mutationBlocked(machine, state, maintenance), view = state.view, check = state.check;
  const eligible = eligibleUpdates(view, check), observations = machine.inspection?.items ?? [];
  const waiting = observations.some(item => item.domain === 'skills' && item.disposition === 'apply');
  const sources = view ? filterSkills(view, check, query, filter, observations) : [];
  const active = state.run?.state === 'running' || state.run?.state === 'accepted';
  const choicePreview = state.preview && 'machineIntent' in state.preview ? state.preview : null;
  const choicePatch = choicePreview?.change.patch.kind === 'skill' ? choicePreview.change.patch : null;
  const preview = state.preview?.change.kind === 'update' && !active ? state.preview : null;
  const busy = machine.connection !== 'connected' || machine.pending || machine.initialReadPending || state.operation !== null || active || machine.run?.outcome === 'running' || machine.status?.applying;
  const reloadDisabled = !!busy && !(active && state.error && !state.operation && machine.connection === 'connected');
  // One error at a time: an error or a stale read replaces the status line instead of repeating it.
  const alert = state.error ?? state.stale;
  // A busy Mac shows what it is doing; once free, an outdated page reads again by itself.
  const busyMac = state.native && !active ? machine.busy : null;
  const reading = !busyMac && state.outdated && !alert;
  return <div className="skills-view">
    <header className="page-header"><div><h1>Skills</h1><p className="intro">Choose which profile skills this Mac installs. Apply on Changes makes installation changes.</p></div>
      <div className="header-actions">{onOpenChanges && waiting ? <button onClick={onOpenChanges}>Open Changes</button> : null}
      {state.native ? <button disabled={reloadDisabled} title={reloadDisabled ? blocked ?? (machine.connection === 'connected' ? 'Available when this Mac finishes its current work.' : 'Connect the agent first.') : undefined} onClick={() => void controller.reload()}>{view ? 'Reload skills' : 'Load skills'}</button> : null}</div>
    </header>
    {!state.native ? <section className="card"><h2>Open the desktop app to see this Mac's skills</h2><p className="muted">Browser preview has no agent connection.</p></section> : <>
      {state.error ? <p className="alert" role="alert">{state.error}</p> : null}
      {state.stale ? <p className="alert" role="alert">{state.stale}</p> : null}
      {blocked && view && !state.operation && !state.stale && !busyMac && !reading ? <p className="notice" role="status">{blocked}</p> : null}
      {busyMac ? <BusyCard busy={busyMac} note="Skill choices wait until it finishes, then Skills reads this Mac again." /> : null}
      <p className={reading ? 'muted skills-detail busy-line' : 'muted skills-detail'} role="status" aria-live="polite">{alert || busyMac ? '' : reading ? <><span className="spinner" aria-hidden="true" />Reading skills…</> : state.detail}</p>
      {choicePreview && choicePatch ? <section className="card" aria-label="Choice preview"><h2>Review the changed choice</h2>
        {choicePreview.machineIntent.intentChanges.map((change, index) => <p key={index}>{change.message}</p>)}
        {choicePreview.machineIntent.installationEffects.map((effect, index) => <p className="muted" key={index}>{effect}</p>)}
        <div className="actions"><button disabled={blocked !== null} onClick={() => void controller.setChoice(choicePatch.source, choicePatch.name, choicePatch.action === 'reset' ? 'inherit' : choicePatch.action === 'enable' ? 'on' : 'off')}>Retry saving choice</button></div>
      </section> : null}
      {state.run ? <section className="card" aria-label="Skills run"><div className="card-head"><div><h2 className="busy-line">{active ? <span className="spinner" aria-hidden="true" /> : null}{runHeading(state.run)}</h2>
        {state.run.steps.length || state.run.parity?.backupIds.length ? <p>{state.run.steps.length ? stepCounts(state.run.steps) : ''}{state.run.steps.length && state.run.parity?.backupIds.length ? '. ' : ''}
          {state.run.parity?.backupIds.length ? `${count(state.run.parity.backupIds.length, 'backup')} kept before changing files.` : ''}</p> : null}
        {active && state.run.current ? <p>{state.run.current.summary}</p> : null}</div>
        {active ? <button onClick={() => void controller.cancel()}>Cancel</button> : null}</div>
      </section> : null}
      {view ? <>
        {view.limitReason ? <p className="notice" role="status">Skills inventory is incomplete: {view.limitReason}. Inspect the owning configuration before changing it.</p> : null}
        <section className="card"><div className="card-head"><div><h2>Skill updates for this Mac</h2><p>Nothing installs until you preview and apply. Pins keep their existing policy.</p></div>
          <button disabled={blocked !== null} title={blocked ?? undefined} onClick={() => void controller.check()}>Check upstream</button></div>
          {check?.unavailable ? <p className="muted" role="status">Upstream checks are unavailable for this machine.</p> : null}
          {check?.limitReason ? <p className="muted" role="status">The upstream check is incomplete: {check.limitReason}.</p> : null}
          {check && !check.unavailable && !check.items.some(changed) ? <p className="muted">No upstream changes to review.</p> : null}
          {check?.items.some(changed) ? <ul className="rows">{check.items.filter(changed).map(item => <li className="row skills-change" key={item.key}>
            <div className="row-main">{eligible.has(item.key) ? <label className="choice"><input type="checkbox" aria-label={`Select ${item.name} for update`} checked={state.selected.includes(item.key)} disabled={blocked !== null} onChange={() => controller.toggle(item.key)} /><span className="row-title">{item.name}</span></label> : <span className="row-title">{item.name}</span>}
              <span className="row-sub">{item.source} · {item.policy}{!eligible.has(item.key) ? ` · ${item.prerequisite ?? 'Off on this Mac or unavailable for this update route.'}` : ''}</span></div>
            <span className={`pill ${item.state === 'outdated' ? 'pill-accent' : 'pill-warning'}`}>{UPSTREAM[item.state]}</span>
          </li>)}</ul> : null}
          {eligible.size ? <div className="actions"><button className={preview ? undefined : 'primary'} disabled={blocked !== null || !state.selected.length} title={!state.selected.length ? 'Select at least one skill first.' : undefined} onClick={() => void controller.previewUpdate()}>Preview update · {state.selected.length} selected</button></div> : null}
          {preview ? <div className="skills-preview"><h3>Planned update steps</h3><ol className="steps" aria-label="Planned update steps">{preview.plan.steps.map((step, index) => <li key={index}>{step.summary}<small>{step.domain} · {step.action}</small></li>)}</ol>
            {preview.plan.skipped.map((step, index) => <p className="muted" key={index}>{step.key}: {step.reason}</p>)}
            {('actionEffects' in preview ? preview.actionEffects : [])?.map((effect, index) => <p className="muted" key={index}>{effect}</p>)}
            <div className="actions"><button className="primary" disabled={blocked !== null || !preview.plan.steps.length} onClick={() => void controller.applyUpdate()}>Apply update · {preview.plan.steps.length} steps</button></div>
          </div> : null}
        </section>
        <div className="skills-toolbar"><input type="search" aria-label="Search skills" placeholder="Search skills or sources" value={query} onChange={event => setQuery(event.target.value)} />
          <select aria-label="Show" value={filter} onChange={event => setFilter(event.target.value as SkillsFilter)}>
            <option value="all">All skills</option><option value="choices">Your choices</option><option value="attention">Waiting to apply</option><option value="updates">Upstream changes</option>
          </select><p className="row-sub">Default follows the profile. On and Off are saved on this Mac.</p>
        </div>
        {!sources.length ? <p className="card muted">{view.items.length ? 'No skills match.' : 'This profile declares no skills.'}</p> : null}
        {sources.map((source, index) => {
          const open = !collapsed.has(source.source), id = `skills-source-${index}`;
          return <section className="card skills-source" key={source.source}><h2><button className="source-toggle" aria-expanded={open} aria-controls={id} onClick={() => setCollapsed(current => {
            const next = new Set(current); if (!next.delete(source.source)) next.add(source.source); return next;
          })}><span className="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>{source.source} <span className="pill">{source.skills.length}</span></button></h2>
            {open ? <ul className="rows skills-rows" id={id}>{source.skills.map(row => {
              const matching = observations.filter(item => item.domain === 'skills' && item.label === row.name && (item.group === row.source || item.key === `skill:${row.name}`));
              const observed = matching.length === 1 ? matching[0] : undefined, disk = rowState(row, observed);
              return <li className="row skills-row" key={row.name}><div className="row-main"><h3 className="row-title">{row.name}</h3>
                <p className="row-sub">{disk.installed} · {row.targets.join(' + ')} · {row.policy}{row.revision ? ` · ${row.revision.slice(0, 7)}` : ''} · declared by {row.declaredFrom.source}</p>
                {disk.detail ? <p className="row-sub">{disk.detail}</p> : null}</div>
                <ChoiceControl row={row} state={state} disabled={blocked !== null} controller={controller} />
              </li>;
            })}</ul> : null}
          </section>;
        })}
      </> : null}
    </>}
  </div>;
}
