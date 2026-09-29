import fs from 'node:fs';
import path from 'node:path';

const rendererRoot = path.resolve('src/renderer');
const selectModule = '@/components/ui/select';
const failures = [];

// The shared Select supports a shorthand `<Select><SelectItem ... /></Select>` form by deriving
// the same `{ value, label }` model and composing the standard trigger/content automatically.
// Explicitly composed selects must provide their item model themselves so SelectValue never has
// to fall back to stringifying an internal value.

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

function location(fileName, text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  const column = index - lastNewline;
  return `${path.relative(process.cwd(), fileName)}:${line}:${column}`;
}

function startsJsxName(text, index, name) {
  if (!text.startsWith(`<${name}`, index) && !text.startsWith(`</${name}`, index)) return false;
  const offset = text[index + 1] === '/' ? index + name.length + 2 : index + name.length + 1;
  const next = text[offset];
  return next == null || /[\s/>]/.test(next);
}

function readJsxTag(text, start, name) {
  const closing = text[start + 1] === '/';
  let quote = null;
  let escaped = false;
  let braceDepth = 0;
  for (let index = start + name.length + (closing ? 2 : 1); index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === '>' && braceDepth === 0) {
      const raw = text.slice(start, index + 1);
      return {
        start,
        end: index + 1,
        raw,
        closing,
        selfClosing: !closing && /\/\s*>$/.test(raw),
      };
    }
  }
  return null;
}

function scanTags(text, names) {
  const tags = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '<') continue;
    for (const name of names) {
      if (!startsJsxName(text, index, name)) continue;
      const tag = readJsxTag(text, index, name);
      if (tag) {
        tags.push({ ...tag, name });
        index = tag.end - 1;
      }
      break;
    }
  }
  return tags;
}

function hasItemsAttribute(raw) {
  return /(?:^|\s)items\s*=/.test(raw);
}

function meaningfulValueChildren(text) {
  const withoutComments = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').trim();
  return withoutComments.length > 0;
}

for (const fileName of walk(rendererRoot)) {
  const text = fs.readFileSync(fileName, 'utf8');
  if (!text.includes(selectModule)) continue;

  const selectImport = text.match(
    /import\s*\{([\s\S]*?)\}\s*from\s*['"]@\/components\/ui\/select['"];?/,
  );
  if (selectImport?.[1] && /\b(?:Select|SelectValue)\s+as\s+/.test(selectImport[1])) {
    failures.push(
      `${location(fileName, text, selectImport.index ?? 0)} Select and SelectValue may not be aliased; the Select contract check relies on their canonical names.`,
    );
  }

  const tags = scanTags(text, ['Select', 'SelectTrigger', 'SelectValue']);
  const selectStack = [];
  const valueStack = [];

  for (const tag of tags) {
    if (tag.name === 'Select') {
      if (!tag.closing && !tag.selfClosing) {
        selectStack.push(tag);
      } else if (tag.closing) {
        const opening = selectStack.pop();
        if (!opening) continue;
        const body = text.slice(opening.end, tag.start);
        const customComposition = body.includes('<SelectTrigger') || body.includes('<SelectValue');
        if (customComposition && !hasItemsAttribute(opening.raw)) {
          failures.push(
            `${location(fileName, text, opening.start)} composed <Select> must provide items={...} using { value, label } entries.`,
          );
        }
      }
      continue;
    }

    if (tag.name === 'SelectValue') {
      if (!tag.closing && !tag.selfClosing) {
        valueStack.push(tag);
      } else if (tag.closing) {
        const opening = valueStack.pop();
        if (!opening) continue;
        if (meaningfulValueChildren(text.slice(opening.end, tag.start))) {
          failures.push(
            `${location(fileName, text, opening.start)} <SelectValue> must resolve its label from <Select items={...}>; do not provide label children.`,
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Select contract check failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Select contract check passed.');
