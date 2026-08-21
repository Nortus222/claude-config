// What a credential looks like, by name and by shape. Shared by every
// validator that guards a committed file, so the two cannot drift apart:
// integrations.json and claude/settings.keys.json are both public, and both
// may name an environment variable but never carry its value.

// Fields whose *name* alone means the value would be a credential.
const SECRET_FIELD = /^(token|secret|password|passphrase|credential|api_?key|access_?key)s?$/i;

// Shapes that are recognisably a credential wherever they appear, so a value
// smuggled into an innocuously named field is still caught.
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{4,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecretName(name) {
  return SECRET_FIELD.test(name);
}

export function looksLikeSecretValue(text) {
  return SECRET_VALUE.some((pattern) => pattern.test(text));
}
