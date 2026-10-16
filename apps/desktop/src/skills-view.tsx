import React, { useState } from 'react';
import type { InspectResult } from '@nortuscc/agent/ipc/protocol';
import type { ViewState } from './controller.ts';
import { effectiveChoice, eligibleUpdates, mutationBlocked, type SkillChoice, type SkillRow, type SkillCheck, type SkillsController, type SkillsViewState } from './skills-controller.ts';
import type { OperationOutput } from '@nortuscc/agent/operations';
import { changeTitle } from './copy.ts';
export type SkillsFilter = 'all' | 'choices' | 'attention' | 'updates';
type Inventory = { readonly items: readonly OperationOutput<'inspectIntent'>['items'][number][] };
type Observation = Pick<InspectResult['items'][number], 'state' | 'disposition' | 'note'>;
const changed = (row: SkillCheck['items'][number]) => row.state === 'outdated' || row.state === 'off-pin';
const same = (a: { source: string; name: string }, b: { source: string; name: string }) => a.source === b.source && a.name === b.name;
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
  return <div>
    <div role="radiogroup" aria-label={`${row.name} on this Mac`} className="skills-seg" aria-busy={saving ? true : undefined}>
      {([['inherit', `Default · ${row.defaultEnabled ? 'On' : 'Off'}`], ['on', 'On'], ['off', 'Off']] as const).map(([choice, label]) => <label key={choice}>
        <input type="radio" name={`skill-${JSON.stringify([row.source, row.name])}`} value={choice} checked={value === choice} disabled={disabled}
          onChange={() => void controller.setChoice(row.source, row.name, choice)} /><span>{label}</span>
      </label>)}
    </div>
    <p className="muted">{saving ? <span role="status">Saving…</span> : row.choice === null ? 'From the profile' : 'Your choice on this Mac'}</p>
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
  return <div className="skills-view">
    <header><div><p className="eyebrow">THIS MAC</p><h1>Skills</h1><p className="intro">Choose which profile skills this Mac installs. Choices stay on this Mac. Apply on Changes makes installation changes.</p></div>
      <div>{onOpenChanges && waiting ? <button onClick={onOpenChanges}>Open Changes</button> : null}
      {state.native ? <button disabled={!!busy && !(active && state.error && !state.operation && machine.connection === 'connected')} onClick={() => void controller.reload()}>{view ? 'Reload skills' : 'Load skills'}</button> : null}</div>
    </header>
    {!state.native ? <section className="form-section"><h2>Open the desktop app to see this Mac's skills</h2><p className="muted">Browser preview has no agent connection.</p></section> : <>
      {state.error ? <p className="skills-alert" role="alert">{state.error}</p> : null}
      {state.stale ? <p className="skills-alert" role="alert">{state.stale}</p> : null}
      {blocked && view && !state.operation && !state.stale ? <p role="status">{blocked}</p> : null}
      <p className="muted" role="status" aria-live="polite">{state.detail}</p>
      {choicePreview && choicePatch ? <section className="form-section" aria-label="Choice preview"><h2>Review the changed choice</h2>
        {choicePreview.machineIntent.intentChanges.map((change, index) => <p key={index}>{change.message}</p>)}
        {choicePreview.machineIntent.installationEffects.map((effect, index) => <p className="muted" key={index}>{effect}</p>)}
        <button disabled={blocked !== null} onClick={() => void controller.setChoice(choicePatch.source, choicePatch.name, choicePatch.action === 'reset' ? 'inherit' : choicePatch.action === 'enable' ? 'on' : 'off')}>Retry saving choice</button>
      </section> : null}
      {state.run ? <section className="form-section" aria-label="Skills run"><h2>{changeTitle(state.run.intent.change.kind)} · {state.run.state}</h2>
        {state.run.steps.length ? <p>{stepCounts(state.run.steps)}</p> : null}
        {state.run.parity?.backupIds.length ? <p className="muted">{count(state.run.parity.backupIds.length, 'backup')} kept before changing files.</p> : null}
        {active ? <button onClick={() => void controller.cancel()}>Cancel</button> : null}
      </section> : null}
      {view ? <>
        {view.limitReason ? <p className="skills-alert" role="status">Skills inventory is incomplete: {view.limitReason}. Inspect the owning configuration before changing it.</p> : null}
        <section className="form-section"><div className="skills-actions"><h2>Skill updates for this Mac</h2><button disabled={blocked !== null} onClick={() => void controller.check()}>Check upstream</button></div>
          <p className="muted">Nothing installs until you preview and apply. Pins keep their existing policy.</p>
          {check?.unavailable ? <p role="status">Upstream checks are unavailable for this machine.</p> : null}
          {check?.limitReason ? <p role="status">The upstream check is incomplete: {check.limitReason}.</p> : null}
          {check && !check.unavailable && !check.items.some(changed) ? <p>No upstream changes to review.</p> : null}
          {check?.items.filter(changed).map(item => <div className="skills-change" key={item.key}>
            {eligible.has(item.key) ? <label><input type="checkbox" aria-label={`Select ${item.name} for update`} checked={state.selected.includes(item.key)} disabled={blocked !== null} onChange={() => controller.toggle(item.key)} />{item.name}</label> : <strong>{item.name}</strong>}
            <span>{item.source} · {UPSTREAM[item.state]} · {item.policy}</span>
            {!eligible.has(item.key) ? <p className="muted">{item.prerequisite ?? 'Off on this Mac or unavailable for this update route.'}</p> : null}
          </div>)}
          {eligible.size ? <button disabled={blocked !== null || !state.selected.length} onClick={() => void controller.previewUpdate()}>Preview update · {state.selected.length} selected</button> : null}
          {preview ? <div className="skills-preview"><h3>Planned update steps</h3><ol className="steps" aria-label="Planned update steps">{preview.plan.steps.map((step, index) => <li key={index}>{step.summary}<small>{step.domain} · {step.action}</small></li>)}</ol>
            {preview.plan.skipped.map((step, index) => <p key={index}>{step.key}: {step.reason}</p>)}
            {('actionEffects' in preview ? preview.actionEffects : [])?.map((effect, index) => <p className="muted" key={index}>{effect}</p>)}
            <button className="primary" disabled={blocked !== null || !preview.plan.steps.length} onClick={() => void controller.applyUpdate()}>Apply update · {preview.plan.steps.length} steps</button>
          </div> : null}
        </section>
        <div className="skills-toolbar"><input type="search" aria-label="Search skills" placeholder="Search skills or sources" value={query} onChange={event => setQuery(event.target.value)} />
          <select aria-label="Show" value={filter} onChange={event => setFilter(event.target.value as SkillsFilter)}>
            <option value="all">All skills</option><option value="choices">Your choices</option><option value="attention">Waiting to apply</option><option value="updates">Upstream changes</option>
          </select><p className="muted">Default follows the profile. On and Off are saved on this Mac.</p>
        </div>
        {!sources.length ? <p className="form-section">{view.items.length ? 'No skills match.' : 'This profile declares no skills.'}</p> : null}
        {sources.map((source, index) => {
          const open = !collapsed.has(source.source), id = `skills-source-${index}`;
          return <section className="form-section skills-source" key={source.source}><h2><button aria-expanded={open} aria-controls={id} onClick={() => setCollapsed(current => {
            const next = new Set(current); if (!next.delete(source.source)) next.add(source.source); return next;
          })}>{source.source} · {source.skills.length}</button></h2>
            {open ? <ul className="skills-rows" id={id}>{source.skills.map(row => {
              const matching = observations.filter(item => item.domain === 'skills' && item.label === row.name && (item.group === row.source || item.key === `skill:${row.name}`));
              const observed = matching.length === 1 ? matching[0] : undefined, disk = rowState(row, observed);
              return <li className="skills-row" key={row.name}><div><h3>{row.name}</h3><p>{disk.installed} · {row.targets.join(' + ')} · {row.policy}{row.revision ? ` · ${row.revision}` : ''}</p>
                {disk.detail ? <p className="muted">{disk.detail}</p> : null}<p className="muted">Declared by {row.declaredFrom.source}</p></div>
                <ChoiceControl row={row} state={state} disabled={blocked !== null} controller={controller} />
              </li>;
            })}</ul> : null}
          </section>;
        })}
      </> : null}
    </>}
  </div>;
}
