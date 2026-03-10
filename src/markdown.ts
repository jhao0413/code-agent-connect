/**
 * Convert markdown text to Telegram-safe HTML.
 *
 * Strategy: protect code spans/blocks first so their contents are not
 * transformed, convert remaining markdown to the HTML subset supported
 * by Telegram's parse_mode:"HTML", then restore code sections.
 */
/**
 * Detect consecutive lines that form a markdown table and return them as a
 * single block.  A table row is any line starting with `|`.  The separator
 * row (`| --- | --- |`) is included.
 */
const TABLE_LINE = /^\|.+\|$/;
const SEPARATOR_LINE = /^\|[\s:|-]+$/;

function extractTableBlocks(text: string): { text: string; tables: string[] } {
  const lines = text.split('\n');
  const tables: string[] = [];
  let buf: string[] = [];

  const flushTable = (): string => {
    if (buf.length >= 2) {
      tables.push(buf.join('\n'));
      return `\x00TB${tables.length - 1}\x00`;
    }
    // Not really a table — return lines as-is
    const plain = buf.join('\n');
    buf = [];
    return plain;
  };

  const out: string[] = [];
  for (const line of lines) {
    if (TABLE_LINE.test(line.trim())) {
      buf.push(line);
    } else {
      if (buf.length > 0) {
        out.push(flushTable());
        buf = [];
      }
      out.push(line);
    }
  }
  if (buf.length > 0) {
    out.push(flushTable());
    buf = [];
  }

  return { text: out.join('\n'), tables };
}

/**
 * Render a markdown table as a plain-text aligned table suitable for <pre>.
 * Strips the `|` borders and separator row, pads columns to equal width.
 */
function renderTableBlock(tableText: string): string {
  const rows = tableText
    .split('\n')
    .filter((r) => !SEPARATOR_LINE.test(r.trim()));

  const parsed = rows.map((row) =>
    row
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim()),
  );

  if (parsed.length === 0) {
    return tableText;
  }

  const colCount = Math.max(...parsed.map((r) => r.length));
  const widths = Array.from({ length: colCount }, () => 0);
  for (const row of parsed) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], (row[c] || '').length);
    }
  }

  return parsed
    .map((row) =>
      row.map((cell, c) => cell.padEnd(widths[c])).join('  '),
    )
    .join('\n');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(text: string): string {
  if (!text) {
    return '';
  }

  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const tableBlocks: string[] = [];

  // 1. Extract fenced code blocks (``` ... ```)
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `\x00CB${idx}\x00`;
  });

  // 2. Extract inline code (` ... `)
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00IC${idx}\x00`;
  });

  // 3. Extract markdown tables (must happen before HTML escaping)
  {
    const extracted = extractTableBlocks(result);
    result = extracted.text;
    tableBlocks.push(...extracted.tables);
  }

  // 4. Strip heading markers (keep text)
  result = result.replace(/^#{1,6}\s+/gm, '');

  // 5. Strip blockquote markers (keep text)
  result = result.replace(/^>\s?/gm, '');

  // 6. Escape HTML entities
  result = escapeHtml(result);

  // 7. Convert links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 8. Convert bold **text** and __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // 9. Convert italic *text* (but not inside words / not bold remnants)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  // Convert _text_ only when surrounded by whitespace or line boundaries
  // to avoid matching snake_case identifiers
  result = result.replace(/(?<=^|[\s(])\b_([^_]+?)_\b(?=$|[\s).,;:!?])/gm, '<i>$1</i>');

  // 10. Convert strikethrough ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 11. Convert unordered list markers to bullets
  result = result.replace(/^[\t ]*[-*]\s+/gm, '• ');

  // 12. Restore inline code with HTML escaping
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00IC${i}\x00`, `<code>${escapeHtml(inlineCodes[i])}</code>`);
  }

  // 13. Restore code blocks with HTML escaping
  for (let i = 0; i < codeBlocks.length; i++) {
    const raw = codeBlocks[i];
    const inner = raw.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    result = result.replace(`\x00CB${i}\x00`, `<pre><code>${escapeHtml(inner)}</code></pre>`);
  }

  // 14. Restore table blocks as <pre> formatted text
  for (let i = 0; i < tableBlocks.length; i++) {
    const rendered = renderTableBlock(tableBlocks[i]);
    result = result.replace(`\x00TB${i}\x00`, `<pre>${escapeHtml(rendered)}</pre>`);
  }

  return result;
}
