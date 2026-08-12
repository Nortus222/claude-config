import { select as realSelect } from '../select.mjs';
import { confirm as realConfirm } from '../prompt.mjs';
import { buildInstallChoices, reviewLines } from '../install-plan.mjs';
import { categoryOf } from '../integrations/runner.mjs';
import { formatRow, section } from '../report.mjs';

// The shared installation workflow, imported by setup and by `apply --install`
// and deliberately absent from the public verb list: there is no
// `nortuscc install`, because installing is something those two commands do
// rather than a mode of its own.
//
// The three sections run in the order configuration, integrations, skills.
// Within integrations the runner already orders hook, marketplace, plugin,
// mcp, so prerequisites land before the things that need them.
const ORDER = ['config', 'integrations', 'skills'];

export async function runInstall({ target, flags, deps }) {
  if (flags.error) {
    console.error(`nortuscc: ${flags.error}`);
    return 2;
  }

  const {
    isTTY = process.stdin.isTTY,
    select = realSelect,
    confirm = realConfirm,
    sections,
  } = deps;

  // Gather first, decide second. Nothing here writes, so a refusal below
  // leaves the machine exactly as it was.
  //
  // The `--no-*` opt-outs are applied here rather than inside each section, so
  // one rule covers every source of items and a section cannot forget it.
  // Configuration is never filtered: it is what this tool exists to sync, and
  // declining an agent's configuration is what `--target` is for.
  const disabled = flags.disabled ?? new Set();
  const keep = (item, fallbackCategory) =>
    !disabled.has(item.category ?? (item.type ? categoryOf(item.type) : fallbackCategory));

  const offered = {};
  for (const name of ORDER) {
    const items = sections[name] ? sections[name].items() : [];
    offered[name] = name === 'config' ? items : items.filter((item) => keep(item, name));
  }

  const actionable = ORDER.flatMap((name) => offered[name]).filter((item) => item.state !== 'installed');
  if (actionable.length === 0) {
    process.stdout.write('\nnothing to install; everything selected is already in place\n');
    return 0;
  }

  const choices = buildInstallChoices(offered);

  let keys;
  if (flags.yes) {
    // Scripted: take exactly what the picker would have shown ticked, without
    // opening a picker nothing would answer.
    keys = choices.filter((row) => row.checked).map((row) => row.key);
  } else if (!isTTY) {
    console.error(
      '\nnortuscc: no terminal to choose on. Re-run with --yes to accept the defaults,\n' +
        '  or with --no-hooks / --no-mcp / --no-plugins / --no-skills to decline categories.',
    );
    return 2;
  } else {
    keys = await select(choices, { title: 'choose what to install', isTTY });
    // null is a cancellation, which asks for nothing to happen at all — not
    // for an empty subset to be confirmed.
    if (keys === null) {
      process.stdout.write('\ncancelled; nothing was installed\n');
      return 0;
    }
  }

  const chosen = new Set(keys);
  const planned = {};
  for (const name of ORDER) {
    planned[name] = offered[name].filter((item) => chosen.has(item.id) && item.state !== 'installed');
  }
  const flat = ORDER.flatMap((name) => planned[name]);

  if (flat.length === 0) {
    process.stdout.write('\nnothing selected\n');
    return 0;
  }

  if (!flags.yes) {
    process.stdout.write('\n' + section('about to install', reviewLines(flat)));
    const go = await confirm('Install these items?', { isTTY });
    if (!go) {
      process.stdout.write('\ndeclined; nothing was installed\n');
      return 0;
    }
  }

  // Each section reports per item, so one failure is recorded and the rest of
  // the run continues.
  const results = [];
  for (const name of ORDER) {
    if (planned[name].length === 0) continue;
    results.push(...(await sections[name].install(planned[name])));
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    '\n' +
      section(
        'install',
        results.map((r) => formatRow(r.label ?? r.id, r.ok ? (r.skipped ? 'satisfied' : 'installed') : 'failed', r.note ?? '')),
      ),
  );

  if (failed.length) {
    process.stdout.write(`\n${failed.length} item(s) failed. See the output above for details.\n`);
    return 1;
  }
  return 0;
}
