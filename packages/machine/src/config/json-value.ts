// Replace one existing top-level JSON value, retaining every other byte of the owner's document.
export const replaceOwnedJsonValue = (text: string, key: string, value: unknown): string => {
  JSON.parse(text);
  let i = text.indexOf('{') + 1;
  let selected: { start: number; end: number } | undefined;
  const whitespace = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const stringEnd = () => { i++; while (i < text.length) { if (text[i++] === '\\') i++; else if (text[i - 1] === '"') return; } };
  while (i < text.length) {
    whitespace(); if (text[i] === '}') break;
    const keyStart = i; stringEnd(); const name = JSON.parse(text.slice(keyStart, i));
    whitespace(); i++; whitespace(); const start = i;
    let depth = 0;
    while (i < text.length) {
      const char = text[i]!;
      if (char === '"') { stringEnd(); continue; }
      if (depth === 0 && (char === ',' || char === '}')) break;
      if (char === '[' || char === '{') depth++;
      if (char === ']' || char === '}') depth--;
      i++;
    }
    let end = i; while (/\s/.test(text[end - 1] ?? '') && end > start) end--;
    if (name === key) {
      if (selected) throw new Error('Selected setting has duplicate author keys');
      selected = { start, end };
    }
    if (text[i] === ',') i++; else break;
  }
  if (!selected) throw new Error('Selected setting is no longer owned by the author document');
  return text.slice(0, selected.start) + JSON.stringify(value) + text.slice(selected.end);
};
