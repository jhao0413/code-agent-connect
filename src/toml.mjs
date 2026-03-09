function stripComments(line) {
  let inString = false;
  let quoteChar = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === '\'') && line[index - 1] !== '\\') {
      if (!inString) {
        inString = true;
        quoteChar = char;
      } else if (quoteChar === char) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }
    if (char === '#' && !inString) {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitArrayItems(input) {
  const items = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let quoteChar = '';

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if ((char === '"' || char === '\'') && input[index - 1] !== '\\') {
      if (!inString) {
        inString = true;
        quoteChar = char;
      } else if (quoteChar === char) {
        inString = false;
        quoteChar = '';
      }
      current += char;
      continue;
    }
    if (!inString) {
      if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
      } else if (char === ',' && depth === 0) {
        items.push(current.trim());
        current = '';
        continue;
      }
    }
    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function parseString(input) {
  const quote = input[0];
  let result = '';
  for (let index = 1; index < input.length - 1; index += 1) {
    const char = input[index];
    if (char === '\\' && quote === '"') {
      const next = input[index + 1];
      if (next === 'n') {
        result += '\n';
      } else if (next === 't') {
        result += '\t';
      } else {
        result += next;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function parseValue(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty TOML value');
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return parseString(trimmed);
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return splitArrayItems(inner).map((item) => parseValue(item));
  }
  throw new Error(`Unsupported TOML value: ${trimmed}`);
}

function ensureObjectPath(root, keys) {
  let cursor = root;
  for (const key of keys) {
    if (!Object.hasOwn(cursor, key)) {
      cursor[key] = {};
    }
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) {
      throw new Error(`TOML section conflict at ${keys.join('.')}`);
    }
    cursor = cursor[key];
  }
  return cursor;
}

export function parseToml(input) {
  const root = {};
  let cursor = root;

  for (const rawLine of input.split(/\r?\n/u)) {
    const line = stripComments(rawLine).trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      const section = line.slice(1, -1).trim();
      if (!section) {
        throw new Error('Empty TOML section name');
      }
      cursor = ensureObjectPath(root, section.split('.'));
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      throw new Error(`Invalid TOML line: ${line}`);
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) {
      throw new Error(`Invalid TOML key in line: ${line}`);
    }
    cursor[key] = parseValue(value);
  }

  return root;
}
