import React from 'react';
import type { ConnectionsController, ConnectionsViewState } from './mcp-connections-controller.ts';
const labels = { configured: 'Configured', absent: 'Not configured', 'repair-needed': 'Repair needed', conflict: 'Conflict', unavailable: 'Unavailable' };
export function ConnectionsView({ state, controller }: { state: ConnectionsViewState; controller: ConnectionsController }) {
  return <section className="card" aria-label="Coding agent connections">
    <h2>Coding agent connections</h2>
    <p>Let Codex and Claude use this app through MCP. The background agent keeps working when the window is closed.</p>
    <button disabled={!state.available || state.pending} onClick={() => void controller.refresh()}>Refresh connections</button>
    {!state.available ? <p>Connect the local app agent to manage coding agent connections.</p> : null}
    {state.detail ? <p role="status">{state.detail}</p> : null}
    {(['codex', 'claude'] as const).map(target => {
      const connection = state.connections.find(c => c.target === target);
      const routing = connection?.routing;
      const cleanup = connection?.registration === 'absent' && (routing?.intent === 'active'
        && (routing.blockStatus === 'present' || routing.blockStatus === 'absent')
        || routing?.intent === 'released' && routing.blockStatus === 'present');
      const blocked = !state.available || state.pending || connection?.registration === 'conflict' || connection?.registration === 'unavailable';
      return <article key={target}>
        <h3>{target === 'codex' ? 'Codex' : 'Claude Code'}</h3>
        <p>{connection ? labels[connection.registration] : 'Not inspected'}</p>
        {connection ? <>
          <p className="muted">Observed from local registration. Host session: not observed.</p>
          {connection.reload === 'recommended' ? <p>Reload needed for existing sessions. Start a new session or reload the host. This app cannot confirm that a chat has reloaded.</p> : null}
          <p>Instruction guidance: {connection.routing.status}. Instruction block: {connection.routing.blockStatus}. App guidance intent: {connection.routing.intent}. {connection.note}</p>
          {cleanup ? <p role="status">Instruction cleanup is incomplete. Retry cleanup to {connection.routing.blockStatus === 'present' ? 'remove the retained app guidance' : 'stop maintaining app guidance'}.</p> : null}
          {connection.routing.status === 'unmanaged' ? <details><summary>Copy guidance for unmanaged instructions</summary>
            <textarea readOnly aria-label={`${target} instruction guidance`} value={connection.routing.offeredText} rows={8} />
            <button onClick={() => void navigator.clipboard.writeText(connection.routing.offeredText).catch(() => {})}>Copy guidance</button>
          </details> : null}
        </> : null}
        <button disabled={blocked} onClick={() => void controller.connect(target)}>{connection?.registration === 'configured' || connection?.registration === 'repair-needed' ? 'Repair connection' : 'Connect'}</button>
        <button disabled={!state.available || state.pending || !connection || (connection.registration === 'absent' && !cleanup) || connection.registration === 'unavailable'} onClick={() => void controller.disconnect(target)}>{cleanup ? 'Retry instruction cleanup' : 'Disconnect'}</button>
      </article>;
    })}
  </section>;
}
