import { Schema } from 'effect';

const LOCAL_PATH = /^(?:[/.~]|[a-z]:[\\/])/i;
const tidy = (text: string) => text.replace(/\/+$/, '').replace(/\.git$/i, '');

// Repository identity only: remote forms lose scheme, credentials, port and case;
// inert local Git fixtures preserve case. This does not grant repository access.
export const normalizeRepoUrl = (url: string): string | null => {
  const text = url.trim();
  try {
    if (/^file:\/\//i.test(text)) return tidy(decodeURIComponent(new URL(text).pathname));
    if (LOCAL_PATH.test(text)) return tidy(text);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const parsed = new URL(text);
      return tidy(`${parsed.hostname}${parsed.pathname}`).toLowerCase();
    }
  } catch {
    return null;
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):\/?(.+)$/.exec(text);
  return tidy(scp ? `${scp[1]}/${scp[2]}` : text).toLowerCase();
};

const validHost = (host: string): boolean => host.length <= 253 && host.split('.').every((label) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));

// Check the original path before URL parsing can erase traversal segments.
const validPath = (path: string): boolean => {
  if (path.includes('//')) return false;
  const parts = path.replace(/^\//, '').replace(/\/$/, '').split('/');
  return parts.every((part) => {
    const decoded = decodeURIComponent(part);
    return decoded !== '' && decoded !== '.' && decoded !== '..' && !/[\s\p{C}/\\?#]/u.test(decoded);
  });
};

const validRepoUrl = (value: string): boolean => {
  if (value === '' || /[\s\p{C}\\?#]/u.test(value) || LOCAL_PATH.test(value)) return false;
  try {
    const url = /^(https|ssh):\/\/([^/]+)(\/.*)$/.exec(value);
    if (url) {
      const [, scheme, authority, path] = url;
      if (!validPath(path) || (scheme === 'https' ? authority.includes('@') : authority.includes('@') && !/^git@[^@]+$/.test(authority))) return false;
      const parsed = new URL(value);
      return parsed.password === '' && (scheme === 'https' ? parsed.username === '' : parsed.username === '' || parsed.username === 'git')
        && (validHost(parsed.hostname) || /^\[[0-9a-f:]+\]$/i.test(parsed.hostname));
    }
    const scp = /^git@([^:/]+):(.+)$/.exec(value);
    if (scp) return validHost(scp[1]) && validPath(scp[2]);
    const remote = /^([^/:@]+)\/(.+)$/.exec(value);
    return remote !== null && validHost(remote[1]) && validPath(`/${remote[2]}`);
  } catch {
    return false;
  }
};
export const RepoUrlSchema = Schema.String.check(Schema.makeFilter(validRepoUrl));
