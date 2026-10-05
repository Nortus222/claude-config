import { createHash } from 'node:crypto';

// Line endings are normalised so a CRLF checkout does not read as drift against an LF repo.
export const hashText = (text: string): string =>
  'sha256:' + createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
