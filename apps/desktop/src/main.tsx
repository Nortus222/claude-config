import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { WireObserved } from '@nortuscc/agent/ipc/protocol';
import { MachineController, canCancel, type StepStatus } from './controller.ts';
import { nativeAvailable, nativeBridge } from './bridge.ts';
import './style.css';

const DOMAINS = [['config', 'Configuration'], ['integrations', 'Integrations'], ['skills', 'Skills']] as const;
const MARK: Record<StepStatus, string> = { pending: '·', running: '…', ok: '✓', failed: '✕', cancelled: '–' };
const provenance = (item: WireObserved) => (item.from ? `${item.from.layer} · ${item.from.source}` : '—');

function App() {
  const [controller] = useState(() => new MachineController(nativeAvailable() ? nativeBridge : null));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.connect();
    return () => controller.dispose();
  }, [controller]);
  const running = state.run?.outcome === 'running';
  const applying = running || state.status?.applying === true;
  const ready = state.connection === 'connected' && !state.pending && !applying;
  const inspection = state.inspection;
  const excluded = new Set(state.excluded);
  const groups = DOMAINS.map(([domain, title]) => ({ domain, title, items: inspection?.items.filter((i) => i.domain === domain) ?? [] }))
    .filter((group) => group.items.length > 0);
  const steps = state.preview?.plan.steps ?? [];
  const skipped = state.preview?.plan.skipped ?? [];
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">NORTUSCC / THIS MACHINE</p>
          <h1>Machine</h1>
          <p className="intro">Inspect this machine, preview the changes, then apply them with backups.</p>
        </div>
        <span className={`connection ${state.connection}`}>
          <i />
          {state.connection === 'browser' ? 'Browser preview' : state.connection}
        </span>
      </header>
      <div className="layout">
        <aside>
          <p className="eyebrow">PROFILE</p>
          {inspection ? (
            <dl className="profile">
              <dt>Repository</dt>
              <dd><code>{inspection.profile.repo}</code></dd>
              <dt>Revision</dt>
              <dd><code>{inspection.profile.revision?.slice(0, 12) ?? 'unknown'}</code></dd>
              <dt>Overrides</dt>
              <dd><code>{inspection.profile.overrides}</code></dd>
            </dl>
          ) : (
            <p className="muted">Not inspected</p>
          )}
          {inspection?.profile.issues.length ? (
            <div className="problems">
              <strong>Profile issues</strong>
              <ul>{inspection.profile.issues.map((issue, n) => <li key={n}>{issue.source}: {issue.path} — {issue.message}</li>)}</ul>
            </div>
          ) : null}
          {inspection?.probeErrors.length ? (
            <div className="problems">
              <strong>Probe failures</strong>
              <ul>{inspection.probeErrors.map((error, n) => <li key={n}>{error}</li>)}</ul>
            </div>
          ) : null}
          {state.hello ? <p className="muted">Agent {state.hello.agentVersion} · protocol {state.hello.protocol}</p> : null}
          {state.status ? (
            <div className="agent-status">
              <p>Policy: {state.status.policy}</p>
              <p>{state.status.trusted ? 'Trusted machine' : 'Machine not trusted'}</p>
              <p>{state.status.counts.pending} pending · {state.status.counts.held} held · {state.status.counts.ready} ready · {state.status.counts.drift} drift</p>
              {state.status.applying ? <p role="status">The agent is applying changes</p> : null}
              {state.status.paused ? <p role="status">Automatic apply paused: {state.status.paused.reason}. You can still review and apply changes here.</p> : null}
              {state.status.error ? <p role="alert">{state.status.error}: {state.status.detail}</p> : null}
              {state.status.probeErrors.length ? <ul>{state.status.probeErrors.map((error, n) => <li key={n}>{error}</li>)}</ul> : null}
            </div>
          ) : null}
          <button className="restart" disabled={state.connection === 'browser' || state.pending || (state.connection === 'connected' && applying)} onClick={() => void controller.restart()}>
            Restart / reinstall agent
          </button>
        </aside>
        <div className="content">
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">INSPECT</p>
                <h2>What this machine has</h2>
              </div>
              <button disabled={state.connection !== 'connected' || state.pending || running} onClick={() => void controller.inspect()}>Inspect again</button>
            </div>
            {inspection === null ? (
              <p className="muted pad">{state.detail}</p>
            ) : groups.length === 0 ? (
              <p className="muted pad">No domain reported any items.</p>
            ) : (
              groups.map((group) => (
                <div className="table-wrap" key={group.domain}>
                  <table>
                    <caption>{group.title}</caption>
                    <thead>
                      <tr><th aria-label="Include" /><th>Item</th><th>State</th><th>Disposition</th><th>From</th></tr>
                    </thead>
                    <tbody>
                      {group.items.map((item) => (
                        <tr key={item.key}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Include ${item.label}`}
                              disabled={!ready || item.disposition !== 'apply'}
                              checked={item.disposition === 'apply' && !excluded.has(item.key)}
                              onChange={() => controller.toggle(item.key)}
                            />
                          </td>
                          <td>
                            <strong>{item.label}</strong>
                            <small>{item.group}{item.target === undefined ? '' : ` · ${item.target}`}</small>
                            {item.note ? <small>{item.note}</small> : null}
                          </td>
                          <td>{item.state}</td>
                          <td><span className={`disposition ${item.disposition}`}>{item.disposition}</span></td>
                          <td className="muted">{provenance(item)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </section>
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">PREVIEW</p>
                <h2>{state.preview ? `${steps.length} steps` : 'Not previewed'}</h2>
              </div>
              <button disabled={!ready || !inspection} onClick={() => void controller.previewPlan()}>Preview changes</button>
            </div>
            {state.preview ? (
              <>
                {steps.length ? (
                  <ol className="steps">
                    {steps.map((step, n) => (
                      <li key={`${n}:${step.key}`}>
                        <span>{step.summary}</span>
                        <small>{step.domain} · {step.action}</small>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted pad">Nothing to apply.</p>
                )}
                {skipped.length ? (
                  <details>
                    <summary>{skipped.length} skipped</summary>
                    <ul className="skipped">{skipped.map((s, n) => <li key={`${n}:${s.key}`}><code>{s.key}</code> — {s.reason}</li>)}</ul>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="muted pad">Preview to see exactly what Apply will change.</p>
            )}
          </section>
          <section className="operation">
            <div className="section-head">
              <div>
                <p className="eyebrow">APPLY</p>
                <h2 className="status">{state.connection === 'disconnected' ? 'Disconnected' : state.run?.outcome ?? 'Ready'}</h2>
              </div>
            </div>
            {state.run ? (
              <ol className="progress-steps">
                {state.run.steps.map((step, n) => (
                  <li key={`${n}:${step.key}`} className={step.status}>
                    <span aria-hidden="true">{MARK[step.status]}</span>
                    <span>{step.summary}</span>
                    {step.note ? <small>{step.note}</small> : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {state.run?.backups ? <p className="pad">Backups: <code>{state.run.backups}</code></p> : null}
            <p className="detail" role="status" aria-live="polite">{state.detail}</p>
            <div className="actions">
              <button className="primary" disabled={!ready || steps.length === 0} onClick={() => void controller.apply()}>
                Apply {steps.length} steps
              </button>
              <button disabled={!canCancel(state)} onClick={() => void controller.cancel()}>Cancel</button>
            </div>
          </section>
        </div>
      </div>
      <footer>Every replaced file is backed up to this run's backup folder first.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
