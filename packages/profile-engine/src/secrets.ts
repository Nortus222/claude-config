// What a credential looks like, by name and by shape. The same rules as the CLI's
// src/secrets.mjs: committed documents may name an environment variable, never carry a value.

const SECRET_FIELD = /^(token|secret|password|passphrase|credential|api_?key|access_?key)s?$/i;

const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{4,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecretName(name: string): boolean {
  return SECRET_FIELD.test(name);
}

export function looksLikeSecretValue(text: string): boolean {
  return SECRET_VALUE.some((pattern) => pattern.test(text));
}

// Complaints for every credential-shaped name or value anywhere inside a settings value.
export function nestedSecretComplaints(value: unknown, path: string): string[] {
  const errors: string[] = [];
  walk(value, path, errors);
  return errors;
}

function walk(value: unknown, path: string, errors: string[]): void {
  if (typeof value === 'string') {
    if (looksLikeSecretValue(value)) errors.push(`settings key '${path}' contains what looks like a secret value`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [name, nested] of Object.entries(value)) {
    const where = path ? `${path}.${name}` : name;
    if (looksLikeSecretName(name)) {
      errors.push(`settings key '${where}' looks like a secret; this file is committed`);
      continue;
    }
    walk(nested, where, errors);
  }
}
