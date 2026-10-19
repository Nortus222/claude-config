import React from 'react';
import type { MachineBusy } from './controller.ts';

// "12 of 30", when the run reports its planned steps.
export const busyCount = (busy: MachineBusy) => busy.total !== null && busy.done !== null ? `${busy.done} of ${busy.total}` : null;

// What this Mac is busy with: a spinner and its description, "12 of 30" with a bar when the total is known,
// and the step in flight.
export function BusyProgress({ busy }: { busy: MachineBusy }) {
  const count = busyCount(busy);
  return <div className="busy-progress" role="status">
    <p className="busy-line"><span className="spinner" aria-hidden="true" /><span className="row-title">{busy.description}</span>{count ? <span className="busy-count">{count}</span> : null}</p>
    {busy.total !== null && busy.done !== null ? <progress aria-label={`${busy.description}: ${count}`} value={busy.done} max={busy.total} /> : null}
    {busy.step ? <p className="row-sub">{busy.step}</p> : null}
  </div>;
}

// A page section for a busy Mac: what it is doing, an optional action, and that the page reads again
// when it finishes.
export function BusyCard({ busy, action, note = 'This page updates by itself when it finishes.' }: { busy: MachineBusy; action?: React.ReactNode; note?: string }) {
  return <section className="card busy-card" aria-label="This Mac is busy">
    <BusyProgress busy={busy} />
    <div className="card-head"><p>{note}</p>{action ?? null}</div>
  </section>;
}
