// Everything about what a selection *means* lives here, so the command module
// never branches on a skill's state: it hands a plan in and gets back the three
// lists its executors take.

import { short } from './report.mjs';

const key = (action, name) => `${action}:${name}`;

// Groups double as action names, which is what makes the picker's "select all
// in this group" mean "update all of them" or "adopt all of them".
export function choices(plan, { seeded }) {
  const rows = [];
  const row = (action, name, note, source, checked) => ({
    key: key(action, name),
    group: action,
    label: name,
    note: `${note}  ${source}`,
    checked: checked || seeded.has(key(action, name)),
  });

  // Outdated is checked by default: refreshing what you already have is what
  // the command is for. Removing and adopting are opt-in.
  for (const o of plan.outdated) rows.push(row('update', o.name, `${short(o.from)} -> ${short(o.to)}`, o.source, true));
  for (const g of plan.gone) rows.push(row('remove', g.name, 'gone upstream', g.source, false));
  for (const a of plan.available ?? []) rows.push(row('add', a.name, 'available', a.source, false));
  return rows;
}

export function actionsFrom(plan, keys) {
  const chosen = new Set(keys);
  return {
    update: plan.outdated.filter((o) => chosen.has(key('update', o.name))).map((o) => o.name),
    remove: plan.gone.filter((g) => chosen.has(key('remove', g.name))).map((g) => g.name),
    // Filtering the plan rather than parsing the keys is what keeps a stale or
    // hand-typed key from inventing work, and is why `add` keeps its source.
    add: (plan.available ?? [])
      .filter((a) => chosen.has(key('add', a.name)))
      .map((a) => ({ name: a.name, source: a.source })),
  };
}

// Flags pre-check rows rather than bypassing the picker, so the same values
// drive the interactive and the scripted paths.
export function seedKeys(plan, { add, prune }) {
  const seeded = new Set();
  if (prune) for (const g of plan.gone) seeded.add(key('remove', g.name));
  const wanted = new Set(add);
  for (const a of plan.available ?? []) if (wanted.has(a.name)) seeded.add(key('add', a.name));
  return seeded;
}
