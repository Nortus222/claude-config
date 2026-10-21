import React from 'react';
import type { RunView } from '@nortuscc/agent/operations';
import { AGENT_LOG, backupFolder, changeTitle, runCauses } from './copy.ts';
import type { RevealPlace } from './setup-sync-controller.ts';
import { fileManager, thisMachine } from './device.ts';

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

// Shows a place in the file manager; resolves to why it couldn't, or null once shown.
export type Reveal = (place: RevealPlace) => Promise<string | null>;

// What a run wrote and did not: the agent's evidence when it kept some, else its step outcomes against the
// planned steps. `notWritten` is null when the plan's size is unknown.
export function runCounts(run: RunView): { written: number; notWritten: number | null; backupIds: readonly string[] } {
  const evidence = run.parity;
  if (evidence) return { written: evidence.committedKeys.length, notWritten: evidence.remainingKeys.length, backupIds: evidence.backupIds };
  const ok = run.steps.filter(step => step.outcome === 'ok').length;
  const change = run.intent.change;
  const planned = (run.intent as { parity?: { plannedKeys?: readonly string[] } }).parity?.plannedKeys?.length ?? (change.kind === 'reconcile' ? change.only.length : null);
  return { written: ok, notWritten: planned === null ? null : Math.max(planned - ok, run.steps.length - ok), backupIds: [] };
}

// Where to look after a run stops: the agent log and the backups folder, each with a reveal button when the
// host can show it.
export function RunPlaces({ backupIds, onReveal }: { backupIds: readonly string[]; onReveal?: Reveal }) {
  const [problem, setProblem] = React.useState<string | null>(null);
  const show = (place: RevealPlace, name: string) => onReveal
    ? <button className="link" aria-label={`Show ${name} in ${fileManager}`} onClick={() => { setProblem(null); void onReveal(place).then(setProblem); }}>Show in {fileManager}</button> : null;
  return <>
    <dl className="setup-sync-facts run-places">
      <dt>Agent log</dt><dd><code>{AGENT_LOG}</code> {show('agentLog', 'the agent log')}<small>What the agent did and why it stopped.</small></dd>
      {backupIds.length ? <><dt>Backups</dt><dd><ul>{backupIds.map(id => <li key={id}><code>{backupFolder(id)}</code></li>)}</ul>{show('backups', 'the backups folder')}
        <small>Copies of what the run replaced.</small></dd></> : null}
    </dl>
    {problem ? <p className="alert" role="alert">{problem}</p> : null}
  </>;
}

// Copies a plain-text account of a run, to paste into a message.
export function CopyDetails({ text }: { text: string }) {
  const [done, setDone] = React.useState<string | null>(null);
  return <><button onClick={() => void navigator.clipboard.writeText(text).then(() => setDone('Copied.'), () => setDone('Couldn’t copy. Open Details to read them instead.'))}>Copy details</button>
    {done ? <span className="reason" role="status">{done}</span> : null}</>;
}

// Recovery for an interrupted or abandoned run: why it stopped, what it wrote, in counts, and Re-preview or
// Abandon. Abandon asks once (`onAskAbandon`), naming its effect, before `onAbandon`. Keys, backup folders,
// the agent log and the run ID stay under Details.
export function RunRecovery({ run, onRepreview, onAskAbandon, onAbandon, onKeep, confirming, disabled = false, onReveal, report }: {
  run: RunView; onRepreview: () => void; onAskAbandon: () => void; onAbandon: () => void; onKeep: () => void; confirming: boolean; disabled?: boolean;
  onReveal?: Reveal; report?: string;
}) {
  if (run.state !== 'interrupted' && run.state !== 'abandoned') return null;
  const evidence = run.parity;
  const written = evidence?.committedKeys.length ?? 0, left = evidence?.remainingKeys.length ?? 0, backups = evidence?.backupIds.length ?? 0;
  const list = (label: string, values: readonly string[] | undefined) => values?.length
    ? <><dt>{label}</dt><dd><ul>{values.map(value => <li key={value}><code>{value}</code></li>)}</ul></dd></> : null;
  const causes = run.state === 'interrupted' ? runCauses(run) : [];
  return <section className="card run-recovery" aria-label="Run recovery">
    <div className="card-head"><div><h2>{changeTitle(run.intent.change.kind)} was {run.state}</h2></div>
      <span className={`pill ${run.state === 'interrupted' ? 'pill-warning' : ''}`}>{run.state === 'interrupted' ? 'Interrupted' : 'Abandoned'}</span></div>
    {causes.map(cause => <p className="run-cause" key={cause}>{cause}</p>)}
    <p className="muted">{evidence ? `${changes(written)} ${written === 1 ? 'was' : 'were'} written and ${left} ${left === 1 ? 'was' : 'were'} not.` : 'What it already wrote stays in place.'}
      {backups ? ' Backups of what it replaced are kept.' : ''} Nothing is rolled back automatically.</p>
    {run.state === 'interrupted' && confirming ? <div className="confirm" role="group" aria-label="Confirm abandon">
      <p>Abandon “{changeTitle(run.intent.change.kind)}”? Its remaining steps won’t run. Finished steps and backups are kept.</p>
      <div className="setup-sync-actions"><button className="danger" disabled={disabled} onClick={onAbandon}>Abandon</button>
        <button onClick={onKeep}>Keep</button></div>
    </div> : run.state === 'interrupted' ? <>
      <p className="muted">Re-preview checks {thisMachine} again and prepares a fresh plan. It doesn’t block other changes or app updates.</p>
      <div className="setup-sync-actions"><button disabled={disabled} onClick={onRepreview}>Re-preview</button>
        <button disabled={disabled} onClick={onAskAbandon}>Abandon</button>{report ? <CopyDetails text={report} /> : null}</div>
    </> : null}
    <details className="run-details"><summary>Details</summary>
      <RunPlaces backupIds={evidence?.backupIds ?? []} onReveal={onReveal} />
      <dl className="setup-sync-facts">
        <dt>Run</dt><dd><code>{run.runId}</code></dd>
        {list('Written', evidence?.committedKeys)}{list('Not written', evidence?.remainingKeys)}
      </dl></details>
  </section>;
}
