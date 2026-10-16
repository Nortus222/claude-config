import React from 'react';
import type { RunView } from '@nortuscc/agent/operations';
import { changeTitle } from './copy.ts';

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

// Recovery for an interrupted or abandoned run: what it wrote, in counts, and Re-preview or Abandon.
// Abandon asks once (`onAskAbandon`), naming its effect, before `onAbandon`. Keys, backup folders and the
// run ID stay under Details.
export function RunRecovery({ run, onRepreview, onAskAbandon, onAbandon, onKeep, confirming, disabled = false }: {
  run: RunView; onRepreview: () => void; onAskAbandon: () => void; onAbandon: () => void; onKeep: () => void; confirming: boolean; disabled?: boolean;
}) {
  if (run.state !== 'interrupted' && run.state !== 'abandoned') return null;
  const evidence = run.parity;
  const written = evidence?.committedKeys.length ?? 0, left = evidence?.remainingKeys.length ?? 0, backups = evidence?.backupIds.length ?? 0;
  const list = (label: string, values: readonly string[] | undefined) => values?.length
    ? <><dt>{label}</dt><dd><ul>{values.map(value => <li key={value}><code>{value}</code></li>)}</ul></dd></> : null;
  return <section className="card run-recovery" aria-label="Run recovery">
    <div className="card-head"><div><h2>{changeTitle(run.intent.change.kind)} was {run.state}</h2></div>
      <span className={`pill ${run.state === 'interrupted' ? 'pill-warning' : ''}`}>{run.state === 'interrupted' ? 'Interrupted' : 'Abandoned'}</span></div>
    <p className="muted">{evidence ? `${changes(written)} ${written === 1 ? 'was' : 'were'} written and ${left} ${left === 1 ? 'was' : 'were'} not.` : 'What it already wrote stays in place.'}
      {backups ? ' Backups of what it replaced are kept.' : ''} Nothing is rolled back automatically.</p>
    {run.state === 'interrupted' && confirming ? <div className="confirm" role="group" aria-label="Confirm abandon">
      <p>Abandon “{changeTitle(run.intent.change.kind)}”? Its remaining steps won’t run. Finished steps and backups are kept.</p>
      <div className="setup-sync-actions"><button className="danger" disabled={disabled} onClick={onAbandon}>Abandon</button>
        <button onClick={onKeep}>Keep</button></div>
    </div> : run.state === 'interrupted' ? <>
      <p className="muted">Re-preview checks this Mac again and prepares a fresh plan. It doesn’t block other changes or app updates.</p>
      <div className="setup-sync-actions"><button disabled={disabled} onClick={onRepreview}>Re-preview</button>
        <button disabled={disabled} onClick={onAskAbandon}>Abandon</button></div>
    </> : null}
    <details className="run-details"><summary>Details</summary><dl className="setup-sync-facts">
      <dt>Run</dt><dd><code>{run.runId}</code></dd>
      {list('Written', evidence?.committedKeys)}{list('Not written', evidence?.remainingKeys)}{list('Backups', evidence?.backupIds)}
    </dl></details>
  </section>;
}
