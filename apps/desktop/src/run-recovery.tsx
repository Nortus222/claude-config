import React from 'react';
import type { RunView } from '@nortuscc/agent/operations';

export function RunRecovery({ run, onRepreview, onAbandon, disabled = false }: {
  run: RunView; onRepreview: () => void; onAbandon: () => void; disabled?: boolean;
}) {
  if (run.state !== 'interrupted' && run.state !== 'abandoned') return null;
  const evidence = run.parity;
  const list = (label: string, values: readonly string[] | undefined) => <div><h3>{label}</h3>
    {values?.length ? <ul>{values.map(value => <li key={value}><code>{value}</code></li>)}</ul> : <p className="muted">None recorded</p>}</div>;
  return <section className="card run-recovery" aria-label="Run recovery">
    <h2>{run.state === 'interrupted' ? 'Interrupted run' : 'Abandoned run'}</h2>
    <p>Run <code>{run.runId}</code>. Changes and backups already written remain. Nothing is rolled back automatically.</p>
    {list('Committed keys', evidence?.committedKeys)}{list('Remaining keys', evidence?.remainingKeys)}{list('Backup IDs', evidence?.backupIds)}
    {run.state === 'interrupted' ? <>
      <p>Re-preview checks the machine again and prepares a fresh plan. An interrupted run does not prevent other changes or app updates.</p>
      <div className="setup-sync-actions"><button disabled={disabled} onClick={onRepreview}>Re-preview</button>
        <button disabled={disabled} onClick={onAbandon}>Abandon</button></div>
    </> : null}
  </section>;
}
