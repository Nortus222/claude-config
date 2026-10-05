type Context = { readonly multiline: string | null; readonly depth: number };

// Separates Codex's machine-local project tables from the rest of a config.toml without
// reserialising its TOML. `managed` is trimmed and ends with one newline.
export const splitProjectTrust = (text: string): { managed: string; projects: string } => {
  const managed: string[] = [];
  const projects: string[] = [];
  let inProjects = false;
  let context: Context = { multiline: null, depth: 0 };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (!context.multiline && context.depth === 0 && /^\s*\[/.test(line)) {
      const next = /^\s*\[\[?\s*(?:projects|"projects"|'projects')\s*[.\]]/.test(line);
      if (next !== inProjects) {
        while (managed.length && !managed.at(-1)!.trim()) managed.pop();
        if (!next && managed.length) managed.push('\n');
      }
      inProjects = next;
    }
    (inProjects ? projects : managed).push(line);
    context = contextAfter(line, context);
  }
  return { managed: managed.join('').trimEnd() + '\n', projects: projects.join('') };
};

// Brackets inside strings and arrays cannot open a table.
const contextAfter = (line: string, { multiline, depth }: Context): Context => {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    if (multiline) {
      if (multiline === '"""' && line[i] === '\\') {
        i += 1;
        continue;
      }
      if (line.startsWith(multiline, i)) {
        const char = multiline[0];
        i += 2;
        while (line[i + 1] === char) i += 1;
        multiline = null;
      }
    } else if (quote) {
      if (quote === '"' && line[i] === '\\') i += 1;
      else if (line[i] === quote) quote = null;
    } else if (line[i] === '#') {
      break;
    } else if (line[i] === '"' || line[i] === "'") {
      const delimiter = line[i]!.repeat(3);
      if (line.startsWith(delimiter, i)) {
        multiline = delimiter;
        i += 2;
      } else {
        quote = line[i]!;
      }
    } else if (line[i] === '[' || line[i] === '{') {
      depth += 1;
    } else if (line[i] === ']' || line[i] === '}') {
      depth -= 1;
    }
  }
  return { multiline, depth };
};
