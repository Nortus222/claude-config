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

import { emitKeypressEvents } from 'node:readline';

const CHECKED = '◉';
const UNCHECKED = '◯';
const POINTER = '❯';
const LEGEND = [
  '  ↑↓ move · space toggle · a all in group · A all · n none in group · N none',
  '  enter confirm · esc cancel',
];

// Pure: returns the lines to draw, with no cursor movement or clearing. The
// driver owns everything about where on the screen these land, which is what
// lets the whole layout be asserted in a test with no terminal.
export function render(state, { title }) {
  const lines = [`  ${title}`, ''];
  // Notes line up past the longest label across every group, so the columns do
  // not step as the eye moves down the list.
  const width = Math.max(0, ...state.items.map((i) => i.label.length));

  let group = null;
  state.items.forEach((item, n) => {
    if (item.group !== group) {
      group = item.group;
      const count = state.items.filter((i) => i.group === group).length;
      if (n > 0) lines.push('');
      lines.push(`  ${group} (${count})`);
    }
    const point = n === state.cursor ? POINTER : ' ';
    const mark = item.checked ? CHECKED : UNCHECKED;
    lines.push(`  ${point} ${mark} ${item.label.padEnd(width)}  ${item.note}`.trimEnd());
  });

  return [...lines, '', ...LEGEND];
}

// node:readline reports a shifted letter as {name: 'a', shift: true} while the
// raw string carries the actual character. Reading the string keeps `a` and `A`
// distinct without depending on which of the two the platform fills in.
export function keyName(str, key = {}) {
  if (key.ctrl && key.name === 'c') return 'ctrl-c';
  if (['up', 'down', 'space', 'return', 'escape'].includes(key.name)) return key.name;
  if (typeof str === 'string' && /^[ajknAJKNQq]$/.test(str)) return str === 'Q' ? 'q' : str;
  return null;
}

// Returns the selected keys, or null when the user cancelled or there was no
// TTY to ask on. An empty item list is answered immediately with [] — having
// nothing to choose is not the same as being unable to choose.
export async function select(items, {
  title = 'select',
  input = process.stdin,
  output = process.stdout,
  isTTY = process.stdin.isTTY,
} = {}) {
  if (items.length === 0) return [];
  if (!isTTY) return null;

  let state = initialState(items);
  let drawn = 0;

  const draw = () => {
    // Move back over what was drawn last time and clear forward, so the list
    // redraws in place instead of scrolling a new copy for every keystroke.
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = render(state, { title });
    output.write(lines.join('\n') + '\n');
    drawn = lines.length;
  };

  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  if (input.setRawMode) input.setRawMode(true);
  output.write('\x1b[?25l'); // hide the cursor; the pointer is the cursor here

  try {
    return await new Promise((resolve) => {
      const onKey = (str, key) => {
        const name = keyName(str, key);
        if (!name) return;
        const next = reduce(state, name);
        state = next.state;
        if (next.done) {
          input.off('keypress', onKey);
          resolve(next.done === 'confirm' ? selectedKeys(state) : null);
          return;
        }
        draw();
      };
      input.on('keypress', onKey);
      draw();
    });
  } finally {
    // Restore unconditionally. A terminal left in raw mode with a hidden
    // cursor outlives the process and takes the user's shell with it.
    output.write('\x1b[?25h');
    if (input.setRawMode) input.setRawMode(Boolean(wasRaw));
  }
}
