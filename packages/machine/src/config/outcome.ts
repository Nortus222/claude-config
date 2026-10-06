const BACKED_UP = '; backed up -> ';
const OLDER = '; older backup -> ';

// A config step's note: what happened to the file, where the displaced copy went, and an older backup
// uninstall would not restore (see TRUSTED_ORIGINALS_FROM).
export const outcomeNote = (action: string, backedUp?: string, older?: string): string =>
  `${action}${backedUp ? `${BACKED_UP}${backedUp}` : ''}${older ? `${OLDER}${older}` : ''}`;

export const splitOutcome = (note: string): { readonly action: string; readonly backedUp?: string; readonly older?: string } => {
  const o = note.indexOf(OLDER);
  const older = o === -1 ? undefined : note.slice(o + OLDER.length);
  const rest = o === -1 ? note : note.slice(0, o);
  const at = rest.indexOf(BACKED_UP);
  const action = at === -1 ? rest : rest.slice(0, at);
  return {
    action,
    ...(at === -1 ? {} : { backedUp: rest.slice(at + BACKED_UP.length) }),
    ...(older === undefined ? {} : { older }),
  };
};
