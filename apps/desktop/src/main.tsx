import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { FixtureController } from './controller.ts';
import { nativeAvailable, nativeBridge } from './bridge.ts';
import './style.css';
const value = (item: string | boolean | null) => (item === null ? 'Inherited' : String(item));
function App() {
  const [controller] = useState(
    () => new FixtureController(nativeAvailable() ? nativeBridge : null),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.connect();
    return () => controller.dispose();
  }, [controller]);
  const running = state.operation?.state === 'running' && state.connection === 'connected';
  const available = state.connection === 'connected' && !state.pending;
  const status =
    state.connection === 'disconnected' ? 'Disconnected' : state.operation?.state || 'Ready';
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">NORTUSCC / DESKTOP VALIDATION</p>
          <h1>Fixture Lab</h1>
          <p className="intro">A small, safe test of the desktop runtime.</p>
        </div>
        <span className={`connection ${state.connection}`}>
          <i />
          {state.connection === 'browser' ? 'Browser preview' : state.connection}
        </span>
      </header>
      <div className="notice">
        <strong>Fixture only</strong>
        <span>Changes run in a fresh temporary directory. Your agent settings stay untouched.</span>
      </div>
      <div className="layout">
        <aside>
          <p className="eyebrow">ACTIVE PROFILE</p>
          <h2>{state.fixture.profile}</h2>
          <p className="muted">Fixed sample data</p>
          <div className="profile-step">
            <span>01</span>
            <div>
              <strong>Base profile</strong>
              <p>Shared agent preferences</p>
            </div>
          </div>
          <div className="profile-step">
            <span>02</span>
            <div>
              <strong>{state.fixture.machine}</strong>
              <p>Machine overrides</p>
            </div>
          </div>
          <div className="aside-note">
            The table shows where each desired value comes from. The preview compares it with the
            current fixture.
          </div>
          <div className="runtime">
            <span className="eyebrow">RUNTIME</span>
            <p>Tauri 2 + bundled Node</p>
            <p className="muted">TypeScript / Effect 4</p>
          </div>
        </aside>
        <div className="content">
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">INSPECT</p>
                <h2>Resolved settings</h2>
              </div>
              <span className="count">{state.fixture.rows.length} settings</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Base</th>
                    <th>Override</th>
                    <th>Desired</th>
                    <th>Current</th>
                  </tr>
                </thead>
                <tbody>
                  {state.fixture.rows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <strong>{row.key}</strong>
                        <small>{row.source}</small>
                      </td>
                      <td>{value(row.base)}</td>
                      <td className={row.override === null ? 'muted' : ''}>
                        {value(row.override)}
                      </td>
                      <td>
                        <code>{value(row.desired)}</code>
                      </td>
                      <td className={row.changed ? 'changed' : ''}>{value(row.current)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">PREVIEW</p>
                <h2>{state.fixture.diff.length ? 'Proposed changes' : 'Fixture is up to date'}</h2>
              </div>
              <span className="count">{state.fixture.diff.length} changes</span>
            </div>
            <div className="diff">
              {state.fixture.diff.length ? (
                state.fixture.diff.map((row) => (
                  <div key={row.key}>
                    <span>{row.key}</span>
                    <code className="before">− {value(row.before)}</code>
                    <code className="after">+ {value(row.after)}</code>
                  </div>
                ))
              ) : (
                <p className="muted">The current fixture matches the resolved profile.</p>
              )}
            </div>
          </section>
          <section className="operation">
            <div className="section-head">
              <div>
                <p className="eyebrow">APPLY TO TEMPORARY FIXTURE</p>
                <h2 className="status">{status}</h2>
              </div>
              <span className="percent">{state.operation?.percent || 0}%</span>
            </div>
            <progress
              aria-label="Fixture progress"
              max={100}
              value={state.operation?.percent || 0}
            />
            <p className="detail" role="status" aria-live="polite">
              {state.detail}
            </p>
            <div className="actions">
              <button
                className="primary"
                disabled={!available || running || state.fixture.diff.length === 0}
                onClick={() => void controller.start()}
              >
                Apply fixture
              </button>
              <button disabled={!available || !running} onClick={() => void controller.cancel()}>
                Cancel
              </button>
              <button
                className="restart"
                disabled={state.connection === 'browser' || state.pending || running}
                onClick={() => void controller.restart()}
              >
                Restart backend
              </button>
            </div>
            <details>
              <summary>Failure test</summary>
              <p className="muted">
                Stop the backend deliberately, then use Restart backend. Pending work ends and the
                new process starts with fresh fixture data.
              </p>
              <button disabled={!available} onClick={() => void controller.crash()}>
                Crash probe
              </button>
            </details>
          </section>
        </div>
      </div>
      <footer>Experimental feasibility app · Local fixture data · macOS validation</footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
