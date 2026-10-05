const BACKED_UP = '; backed up -> ';

// A config step's note: what happened to the file, then where the displaced copy went.
export const outcomeNote = (action: string, backedUp?: string): string => (backedUp ? `${action}${BACKED_UP}${backedUp}` : action);

export const splitOutcome = (note: string): { readonly action: string; readonly backedUp?: string } => {
  const at = note.indexOf(BACKED_UP);
  return at === -1 ? { action: note } : { action: note.slice(0, at), backedUp: note.slice(at + BACKED_UP.length) };
};
