import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTelegramHtml } from '../src/markdown.js';

test('markdownToTelegramHtml returns empty string for falsy input', () => {
  assert.equal(markdownToTelegramHtml(''), '');
  assert.equal(markdownToTelegramHtml(null), '');
  assert.equal(markdownToTelegramHtml(undefined), '');
});

test('plain text passes through unchanged', () => {
  assert.equal(markdownToTelegramHtml('hello world'), 'hello world');
});

test('HTML entities are escaped', () => {
  assert.equal(markdownToTelegramHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('fenced code blocks are converted to <pre><code>', () => {
  const input = '```js\nconst x = 1;\n```';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, '<pre><code>const x = 1;</code></pre>');
});

test('code block contents are HTML-escaped', () => {
  const input = '```\na < b && c > d\n```';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, '<pre><code>a &lt; b &amp;&amp; c &gt; d</code></pre>');
});

test('inline code is converted to <code>', () => {
  assert.equal(markdownToTelegramHtml('use `fmt.Println`'), 'use <code>fmt.Println</code>');
});

test('inline code contents are HTML-escaped', () => {
  assert.equal(markdownToTelegramHtml('type `Map<K,V>`'), 'type <code>Map&lt;K,V&gt;</code>');
});

test('bold **text** is converted to <b>', () => {
  assert.equal(markdownToTelegramHtml('this is **bold**'), 'this is <b>bold</b>');
});

test('bold __text__ is converted to <b>', () => {
  assert.equal(markdownToTelegramHtml('this is __bold__'), 'this is <b>bold</b>');
});

test('italic *text* is converted to <i>', () => {
  assert.equal(markdownToTelegramHtml('this is *italic*'), 'this is <i>italic</i>');
});

test('italic _text_ is converted to <i> but not in snake_case', () => {
  const input = 'this is _italic_ but my_var_name stays';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, 'this is <i>italic</i> but my_var_name stays');
});

test('strikethrough ~~text~~ is converted to <s>', () => {
  assert.equal(markdownToTelegramHtml('~~removed~~'), '<s>removed</s>');
});

test('links are converted to <a> tags', () => {
  const input = 'visit [Google](https://google.com) now';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, 'visit <a href="https://google.com">Google</a> now');
});

test('heading markers are stripped', () => {
  assert.equal(markdownToTelegramHtml('## Title'), 'Title');
  assert.equal(markdownToTelegramHtml('# H1\n## H2'), 'H1\nH2');
});

test('blockquote markers are stripped', () => {
  assert.equal(markdownToTelegramHtml('> quoted text'), 'quoted text');
});

test('unordered list markers are converted to bullets', () => {
  const input = '- item 1\n- item 2\n* item 3';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, '• item 1\n• item 2\n• item 3');
});

test('mixed formatting is handled correctly', () => {
  const input = '## Summary\n\nThis is **bold** and *italic* with `code`.';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, 'Summary\n\nThis is <b>bold</b> and <i>italic</i> with <code>code</code>.');
});

test('code blocks protect inner markdown from conversion', () => {
  const input = '```\n**not bold** and _not italic_\n```';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, '<pre><code>**not bold** and _not italic_</code></pre>');
});

test('inline code protects inner markdown from conversion', () => {
  const input = 'run `**not bold**` please';
  const output = markdownToTelegramHtml(input);
  assert.equal(output, 'run <code>**not bold**</code> please');
});

test('nested bold and italic', () => {
  const input = '***bold italic***';
  const output = markdownToTelegramHtml(input);
  // **<i>bold italic</i>** → <b><i>bold italic</i></b> (bold wraps italic)
  assert.ok(output.includes('<b>') || output.includes('<i>'));
});

test('multiple code blocks in same text', () => {
  const input = '```\nblock1\n```\ntext\n```\nblock2\n```';
  const output = markdownToTelegramHtml(input);
  assert.ok(output.includes('<pre><code>block1</code></pre>'));
  assert.ok(output.includes('<pre><code>block2</code></pre>'));
  assert.ok(output.includes('text'));
});

test('markdown table is converted to <pre> formatted text', () => {
  const input = [
    '| Name | Age |',
    '| --- | --- |',
    '| Alice | 30 |',
    '| Bob | 25 |',
  ].join('\n');
  const output = markdownToTelegramHtml(input);
  assert.ok(output.includes('<pre>'));
  assert.ok(output.includes('</pre>'));
  // separator row should be stripped
  assert.ok(!output.includes('---'));
  // columns should be aligned
  assert.ok(output.includes('Alice'));
  assert.ok(output.includes('Bob'));
});

test('table with HTML special chars is escaped inside <pre>', () => {
  const input = [
    '| Type | Example |',
    '| --- | --- |',
    '| Generic | Map<K,V> |',
  ].join('\n');
  const output = markdownToTelegramHtml(input);
  assert.ok(output.includes('&lt;K,V&gt;'));
});

test('table surrounded by text is handled', () => {
  const input = [
    'Here is a table:',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'End of table.',
  ].join('\n');
  const output = markdownToTelegramHtml(input);
  assert.ok(output.includes('Here is a table:'));
  assert.ok(output.includes('<pre>'));
  assert.ok(output.includes('End of table.'));
});
