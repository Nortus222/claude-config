// A grouped multi-select that knows nothing about what it is selecting. The
// state machine and the renderer are pure and hold no terminal state, so every
// key behaviour is tested without raw mode; only `select` below touches a TTY.

// Group headers are derived at render time from each item's `group`, never
// stored as items. That way the cursor indexes real rows only and no movement
// code has to know headers exist.
export function initialState(items) {
  return {
    // Copied, because reduce returns new items and a caller that reused its
    // input array would see toggles it never asked for.
    items: items.map((i) => ({ ...i })),
    cursor: items.length ? 0 : -1,
  };
}

export function selectedKeys(state) {
  return state.items.filter((i) => i.checked).map((i) => i.key);
}

export function groupOf(state) {
  return state.cursor < 0 ? '' : state.items[state.cursor].group;
}

function move(state, delta) {
  if (state.cursor < 0) return state;
  const n = state.items.length;
  // Wrapping in both directions: the lists are short and a cursor that sticks
  // at an end makes "jump to the other end" a long hold.
  return { ...state, cursor: (state.cursor + delta + n) % n };
}

function setAll(state, checked, group) {
  return {
    ...state,
    items: state.items.map((i) => (group === null || i.group === group ? { ...i, checked } : i)),
  };
}

function toggle(state) {
  if (state.cursor < 0) return state;
  return {
    ...state,
    items: state.items.map((i, n) => (n === state.cursor ? { ...i, checked: !i.checked } : i)),
  };
}

// Returns {state, done}. `done` stays null while the picker runs; the driver
// stops on 'confirm' or 'cancel'. Returning rather than throwing keeps the
// machine pure and lets a test drive a whole session synchronously.
export function reduce(state, key) {
  switch (key) {
    case 'up':
    case 'k':
      return { state: move(state, -1), done: null };
    case 'down':
    case 'j':
      return { state: move(state, 1), done: null };
    case 'space':
      return { state: toggle(state), done: null };
    case 'a':
      return { state: setAll(state, true, groupOf(state)), done: null };
    case 'n':
      return { state: setAll(state, false, groupOf(state)), done: null };
    case 'A':
      return { state: setAll(state, true, null), done: null };
    case 'N':
      return { state: setAll(state, false, null), done: null };
    case 'return':
      return { state, done: 'confirm' };
    case 'escape':
    case 'ctrl-c':
    case 'q':
      return { state, done: 'cancel' };
    default:
      return { state, done: null };
  }
}
