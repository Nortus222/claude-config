import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseServiceEnvironment } from '../src/config.ts';
export interface DeploymentParameters {
  location: string;
  namePrefix: string;
  githubClientId: string;
  allowlistedLogins: string[];
  openSignup: boolean;
  budgetAmount: number;
  budgetContactEmails: string[];
  budgetStartDate: string;
  image: string;
}
const invalid = (): never => { throw new Error('Invalid deployment configuration.'); };
const fields = ['location', 'namePrefix', 'githubClientId', 'allowlistedLogins', 'openSignup', 'budgetAmount', 'budgetContactEmails', 'budgetStartDate', 'image'];
/** Validate the complete flat public configuration, including the immutable image. */
export function validateDeploymentParameters(input: unknown): DeploymentParameters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) return invalid();
  const text = (key: string, pattern: RegExp) => { const field = value[key]; if (typeof field !== 'string' || /[\x00-\x20\x7f]/.test(field) || !pattern.test(field)) return invalid(); return field; };
  const location = text('location', /^[a-z][a-z0-9]{1,31}$/);
  const namePrefix = text('namePrefix', /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/);
  if (namePrefix.includes('--')) return invalid();
  const githubClientId = text('githubClientId', /^[A-Za-z0-9_]{1,100}$/);
  const image = text('image', /^ghcr\.io\/nortus222\/claude-config-service@sha256:[0-9a-f]{64}$/);
  if (image.length !== 111) return invalid();
  const allowlistedLogins = value.allowlistedLogins;
  if (!Array.isArray(allowlistedLogins) || allowlistedLogins.length > 100 || Object.keys(allowlistedLogins).length !== allowlistedLogins.length || allowlistedLogins.some(v => typeof v !== 'string' || /[\x00-\x20\x7f]/.test(v))) return invalid();
  if (typeof value.openSignup !== 'boolean') return invalid();
  const budgetAmount = value.budgetAmount;
  if (typeof budgetAmount !== 'number' || !Number.isSafeInteger(budgetAmount) || budgetAmount < 1 || budgetAmount > 1000000) return invalid();
  const budgetContactEmails = value.budgetContactEmails;
  if (!Array.isArray(budgetContactEmails) || budgetContactEmails.length < 1 || budgetContactEmails.length > 5 || Object.keys(budgetContactEmails).length !== budgetContactEmails.length || budgetContactEmails.some(v => typeof v !== 'string' || v.length > 254 || /[\x00-\x20\x7f]/.test(v) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(v)) || new Set(budgetContactEmails.map(v => v.toLowerCase())).size !== budgetContactEmails.length) return invalid();
  const budgetStartDate = text('budgetStartDate', /^20[2-9][0-9]-(?:0[1-9]|1[0-2])-01$/);
  parseServiceEnvironment({ NORTUSCC_SERVICE_GITHUB_CLIENT_ID: githubClientId, NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'https://deployment.documents.azure.com/', NORTUSCC_SERVICE_COSMOS_DATABASE: 'metadata', NORTUSCC_SERVICE_ALLOWLIST: allowlistedLogins.join(','), NORTUSCC_SERVICE_OPEN_SIGNUP: value.openSignup ? 'true' : 'false' });
  return { location, namePrefix, githubClientId, allowlistedLogins: [...allowlistedLogins], openSignup: value.openSignup, budgetAmount, budgetContactEmails: [...budgetContactEmails], budgetStartDate, image };
}
/** Parse bounded JSON and reject duplicate object keys before canonicalizing it. */
export function parseDeploymentJson(source: string): unknown {
  if (Buffer.byteLength(source) > 16384) return invalid();
  const value: unknown = JSON.parse(source);
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let cursor = 0;
  const walk = (depth: number): void => {
    if (depth > 10) return invalid();
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set<string>();
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++]!); if (keys.has(key)) return invalid(); keys.add(key); cursor++; walk(depth + 1); if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (token === '[') { while (tokens[cursor] !== ']') { walk(depth + 1); if (tokens[cursor] === ',') cursor++; } cursor++; }
  };
  walk(0); return value;
}
const isExecutable = () => {
  if (import.meta.main !== undefined) return import.meta.main;
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
};
if (isExecutable()) {
  try {
    if (process.argv.length !== 4) invalid();
    const input = parseDeploymentJson(readFileSync(process.argv[2]!, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'image')) invalid();
    const values = validateDeploymentParameters({ ...(input as Record<string, unknown>), image: process.argv[3] });
    process.stdout.write(JSON.stringify({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion: '1.0.0.0', parameters: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) }) + '\n');
  } catch { process.stderr.write('Invalid deployment configuration.\n'); process.exitCode = 1; }
}
