// End-to-end smoke test of the bundled extension against an in-memory VS Code
// API (vscode-mock.js) and a fake model endpoint. No network, no VS Code needed.
// Usage: npm run test:smoke (builds the extension and a core helper bundle first)
const Module = require('module');
const path = require('path');
const assert = require('assert/strict');
const mock = require('./vscode-mock');
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? mock : origLoad.call(this, req, ...rest); };

const { log, answers, settings, commands, Document, Editor, getCodeLens, getCodeActions, diagnostics, files } = mock.__test;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Core helpers bundled separately by the test:smoke script (to build expected markers).
const { formatMarker } = require(path.resolve(process.argv[3]));
const ext = require(path.resolve(process.argv[2]));

// ---- fake model
let modelReplies = [];
let requests = [];
let onFetch = null;
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  if (onFetch) { const f = onFetch; onFetch = null; f(); }
  const reply = modelReplies.shift();
  if (reply === undefined) throw new Error('unexpected model call');
  const payload = typeof reply === 'string'
    ? { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }
    : reply;
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};

const workspaceState = (() => { const m = new Map(); return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } }; })();
ext.activate({ subscriptions: [], workspaceState, secrets: { get: async () => 'sk-ant-test', store: async () => {}, delete: async () => {} } });

function open(text, lang) {
  const doc = new Document(text, lang);
  const editor = new Editor(doc);
  mock.window.activeTextEditor = editor;
  return { doc, editor };
}
const run = (id, ...args) => commands.get(id)(...args);
const states = (doc) => getCodeLens().provideCodeLenses(doc).filter((l) => !l.command.command).map((l) => l.command.title);
function reset() { answers.info.length = 0; answers.input.length = 0; answers.quickPick.length = 0; files.clear(); diagnostics.clear(); delete settings['driftSeverity']; for (const k of Object.keys(log)) log[k].length = 0; requests = []; modelReplies = []; }

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------

test('generate: new rule becomes a linked, aligned block, no review', async () => {
  const { doc } = open([
    'class Calc {',
    '    int Sum(int a, int b) {',
    '        //> return the sum of a and b',
    '    }',
    '}'
  ].join('\n'));
  modelReplies = ['```csharp\nreturn a + b;\n```'];
  await run('lugus.translate', doc.uri, 2);
  assert.deepEqual(doc.lines.slice(2, 5).map((l) => l.replace(/code:\w+ rule:\w+/, 'H')), [
    '        //> return the sum of a and b',
    '        return a + b;',
    '        // </lugus> H'
  ]);
  assert.equal(log.diffs.length, 0);
  assert.equal(requests[0].system.includes('translator'), true);
  assert.deepEqual(states(doc), ['✓ Lugus: aligned']);
  const titles = getCodeLens().provideCodeLenses(doc).map((l) => l.command.title);
  assert.ok(titles[0].includes('aligned'), titles.join(','));
  global.__doc1 = doc;
});

test('rule change -> update mode sends current code, diff shown, apply', async () => {
  const doc = global.__doc1; open(doc.text); mock.window.activeTextEditor.document = doc;
  mock.window.activeTextEditor = new Editor(doc);
  doc.setText(doc.text.replace('return the sum of a and b', 'return the sum of a and b, doubled'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('rule changed'));
  modelReplies = ['return (a + b) * 2;'];
  answers.info.push('Apply');
  await run('lugus.translate', doc.uri, 2);
  assert.ok(requests[0].messages[0].content.includes('--- CURRENT CODE (csharp) ---\nreturn a + b;'));
  assert.ok(requests[0].system.includes('smallest change'));
  assert.equal(log.diffs.length, 1);
  assert.ok(doc.text.includes('        return (a + b) * 2;'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
  assert.equal(doc.lines[0], 'class Calc {');
  assert.equal(doc.lines[1], '    int Sum(int a, int b) {');
});

test('review rejected leaves the file untouched', async () => {
  const doc = global.__doc1; mock.window.activeTextEditor = new Editor(doc);
  doc.setText(doc.text.replace('doubled', 'tripled'));
  const before = doc.text;
  modelReplies = ['return (a + b) * 3;'];
  answers.info.push('Keep Current');
  await run('lugus.translate', doc.uri, 2);
  assert.equal(doc.text, before);
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('rule changed'));
});

test('model returns the same code -> marker restamped, no diff', async () => {
  const doc = global.__doc1; mock.window.activeTextEditor = new Editor(doc);
  modelReplies = ['  return (a + b) * 2;  \n'];
  await run('lugus.translate', doc.uri, 3);
  assert.equal(log.diffs.length, 0);
  assert.ok(log.info.some((m) => m.includes('already implements')));
  assert.ok(doc.text.includes('return (a + b) * 2;'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
});

test('aligned block: translate asks first, no model call if dismissed', async () => {
  const doc = global.__doc1; mock.window.activeTextEditor = new Editor(doc);
  answers.info.push(undefined);
  await run('lugus.translate', doc.uri, 2);
  assert.equal(requests.length, 0);
});

test('hand edit -> code-edited; Accept re-signs without calling the model', async () => {
  const doc = global.__doc1; mock.window.activeTextEditor = new Editor(doc);
  doc.setText(doc.text.replace('return (a + b) * 2;', 'return checked((a + b) * 2);'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('code edited'));
  await run('lugus.accept', doc.uri, 2);
  assert.equal(requests.length, 0);
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
  assert.ok(doc.text.includes('return checked((a + b) * 2);'));
});

test('link selection keeps the code byte-for-byte and is aligned', async () => {
  const code = [
    'def is_adult(person):',
    '    if person.age is None:',
    '        return False',
    '    return person.age >= 18'
  ];
  const { doc, editor } = open(['import x', '', ...code, '', 'print(1)'].join('\n'), 'python');
  editor.select(2, 0, 6, 0); // ends at column 0 of the blank line -> excluded
  answers.input.push('  maggiorenne se età nota e almeno 18  ');
  await run('lugus.linkSelection');
  assert.deepEqual(doc.lines.slice(2, 8).map((l) => l.replace(/code:\w+ rule:\w+/, 'H')), [
    '#> maggiorenne se età nota e almeno 18',
    ...code,
    '# </lugus> H'
  ]);
  assert.equal(requests.length, 0);
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
  global.__py = doc;
});

test('changing the rule of linked code updates it, signature kept in CURRENT CODE', async () => {
  const doc = global.__py; mock.window.activeTextEditor = new Editor(doc);
  doc.setText(doc.text.replace('almeno 18', 'almeno 21'));
  modelReplies = [
    'def is_adult(person):\n    if person.age is None:\n        return False\n    return person.age >= 21'
  ];
  answers.info.push('Apply');
  await run('lugus.translate', doc.uri, 4);
  assert.ok(requests[0].messages[0].content.includes('def is_adult(person):'));
  assert.ok(doc.text.includes('    return person.age >= 21'), doc.text + '\n' + log.info.join('|'));
  assert.ok(doc.text.startsWith('import x\n\n#> maggiorenne'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
});

test('edits above the block during the request are tolerated', async () => {
  const doc = global.__py; mock.window.activeTextEditor = new Editor(doc);
  doc.setText(doc.text.replace('almeno 21', 'almeno 16'));
  onFetch = () => doc.setText('import y\n' + doc.text);
  modelReplies = ['def is_adult(person):\n    if person.age is None:\n        return False\n    return person.age >= 16'];
  answers.info.push('Apply');
  await run('lugus.translate', doc.uri, 4);
  assert.equal(log.error.length, 0, log.error.join());
  assert.ok(doc.text.startsWith('import y\nimport x\n'));
  assert.ok(doc.text.includes('>= 16'));
});

test('edits inside the block during the request abort safely', async () => {
  const doc = global.__py; mock.window.activeTextEditor = new Editor(doc);
  doc.setText(doc.text.replace('almeno 16', 'almeno 30'));
  onFetch = () => doc.setText(doc.text.replace('return False', 'return None'));
  modelReplies = ['def is_adult(person):\n    return True'];
  const before = () => doc.text;
  await run('lugus.translate', doc.uri, 5);
  assert.ok(log.error.some((m) => m.includes('changed while Lugus was working')));
  assert.ok(before().includes('return None'));
  assert.ok(!before().includes('return True'));
});

test('truncated output is rejected and nothing changes', async () => {
  const { doc } = open('//> do a big thing\n');
  const before = doc.text;
  modelReplies = [{ content: [{ type: 'text', text: 'partial(' }], stop_reason: 'max_tokens' }];
  await run('lugus.translate', doc.uri, 0);
  assert.equal(doc.text, before);
  assert.ok(log.error.some((m) => m.includes('cut off')));
});

test('detach keeps only the code; works with empty body and at end of file', async () => {
  const { doc } = open(['a();', '//> rule', 'x();', 'y();', '// </lugus> code:0123456789abcdef rule:0123456789abcdef', 'b();'].join('\n'));
  await run('lugus.detach', doc.uri, 1);
  assert.equal(doc.text, 'a();\nx();\ny();\nb();');
  const second = open(['a();', '//> rule', '// </lugus>'].join('\n'));
  await run('lugus.detach', second.doc.uri, 2);
  assert.equal(second.doc.text, 'a();');
});

test('legacy marker shows unverified, Accept fixes it', async () => {
  const { doc } = open(['//> rule', 'x();', '// </lugus> sha256:0123456789abcdef'].join('\n'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('not verified'));
  await run('lugus.accept', doc.uri, 1);
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
});

test('keybinding path (no args) uses the cursor', async () => {
  const { doc, editor } = open(['//> say hi'].join('\n'));
  editor.selection = { active: new mock.Position(0, 3) };
  modelReplies = ['hi();'];
  await run('lugus.translate');
  assert.ok(doc.text.startsWith('//> say hi\nhi();\n// </lugus> code:'));
});


// ------------------------------------------------------------ drift overview

function addFile(name, lines, languageId = 'csharp') {
  const uri = mock.Uri.file('/w/' + name);
  files.set(uri.toString(), { uri, text: lines.join('\n'), languageId });
  return uri;
}
const linkedBlock = (rule, code, token = '//') => [`${token}> ${rule}`, ...code, formatMarker('', token, code.join('\n'), [rule])];

test('drift diagnostics follow edits and offer quick fixes', async () => {
  const uri = addFile('Drift.cs', ['class A {', ...linkedBlock('sum a and b', ['return a + b;']), '}']);
  const doc = await mock.workspace.openTextDocument(uri);
  assert.deepEqual(diagnostics.get(uri.toString()), []);
  doc.setText(doc.text.replace('sum a and b', 'sum a and b twice'));
  await sleep(350);
  const [d] = diagnostics.get(uri.toString());
  assert.equal(d.code, 'rule-changed');
  assert.equal(d.severity, mock.DiagnosticSeverity.Warning);
  assert.equal(d.range.start.line, 1);
  assert.match(d.message, /^Lugus: rule changed\./);
  const actions = getCodeActions().provideCodeActions(doc, d.range, { diagnostics: [d] });
  assert.deepEqual(actions.map((a) => a.command.command), ['lugus.translate', 'lugus.accept']);
  assert.deepEqual(actions[0].command.arguments, [uri, 1]);

  doc.setText(doc.text.replace('return a + b;', 'return a + b + 0;'));
  await sleep(350);
  const [both] = diagnostics.get(uri.toString());
  assert.equal(both.code, 'both-changed');

  settings['driftSeverity'] = 'off';
  doc.setText(doc.text + '\n');
  await sleep(350);
  assert.equal(diagnostics.has(uri.toString()), false);
});

test('code edited by hand offers Accept first', async () => {
  const uri = addFile('Hand.cs', linkedBlock('rule', ['a();']));
  const doc = await mock.workspace.openTextDocument(uri);
  doc.setText(doc.text.replace('a();', 'b();'));
  await sleep(350);
  const [d] = diagnostics.get(uri.toString());
  const actions = getCodeActions().provideCodeActions(doc, d.range, { diagnostics: [d] });
  assert.equal(actions[0].command.command, 'lugus.accept');
});

test('show blocks to review: scans the workspace and opens the pick', async () => {
  addFile('ok.cs', linkedBlock('fine', ['ok();']));
  const bad = linkedBlock('return the max', ['return Math.Max(a, b);']);
  bad[1] = 'return Math.Min(a, b);';
  const badUri = addFile('src/bad.cs', ['// header', ...bad]);
  addFile('old.py', ['#> legacy', 'x = 1', '# </lugus>'], 'python');
  addFile('notes.txt', ['nothing here']);
  answers.quickPick.push((items) => items[0]);
  await run('lugus.showDrifted');
  const { items, options } = log.quickPick[0];
  assert.equal(items.length, 2);
  assert.match(options.title, /2 blocks to review \(of 3\)/);
  assert.match(items[0].label, /\$\(warning\) return the max/);
  assert.match(items[0].description, /code edited by hand · src\/bad\.cs:2/);
  assert.match(items[1].label, /\$\(question\) legacy/);
  assert.equal(mock.window.activeTextEditor.document.uri.toString(), badUri.toString());
  assert.equal(mock.window.activeTextEditor.selection.start.line, 1);
  assert.equal(diagnostics.get(badUri.toString())[0].code, 'code-edited');
});

test('show blocks to review: all aligned', async () => {
  addFile('ok.cs', linkedBlock('fine', ['ok();']));
  await run('lugus.showDrifted');
  assert.equal(log.quickPick.length, 0);
  assert.ok(log.info.some((m) => m.includes('all 1 linked blocks are aligned')));
});

// ------------------------------------------------------------ restore

test('restore: a hand edit goes back to the last aligned code, no model call', async () => {
  const { doc } = open(['class A {', '    int F() {', '        //> return forty-two', '    }', '}'].join('\n'));
  modelReplies = ['return 42;'];
  await run('lugus.translate', doc.uri, 2);
  const aligned = doc.text;
  doc.setText(doc.text.replace('        return 42;', '        var junk = 1;\n        return 42;'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('code edited'));
  assert.ok(getCodeLens().provideCodeLenses(doc).some((l) => l.command.command === 'lugus.restore'));
  requests = [];
  answers.info.push('Apply');
  await run('lugus.restore', doc.uri, 2);
  assert.equal(requests.length, 0);
  assert.equal(log.diffs.length, 1);
  assert.equal(doc.text, aligned);
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
});

test('restore: works after reopening, from blocks seen aligned by the monitor', async () => {
  const uri = addFile('Seen.cs', linkedBlock('rule', ['keep();']));
  const doc = await mock.workspace.openTextDocument(uri);
  mock.window.activeTextEditor = new Editor(doc);
  doc.setText(doc.text.replace('keep();', 'keep();\njunk();'));
  answers.info.push('Apply');
  await run('lugus.restore', doc.uri, 1);
  assert.ok(!doc.text.includes('junk'));
});

test('restore: both changed keeps the new rule and restores only the code', async () => {
  const { doc } = open('//> say hi');
  modelReplies = ['hi();'];
  await run('lugus.translate', doc.uri, 0);
  doc.setText(doc.text.replace('//> say hi', '//> say hello').replace('hi();', 'hi(); junk();'));
  answers.info.push('Apply');
  await run('lugus.restore', doc.uri, 0);
  assert.ok(doc.text.startsWith('//> say hello\nhi();\n'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('rule changed'));
});

test('restore: nothing saved -> clear warning, file untouched', async () => {
  const { doc } = open(['//> rule', 'x();', '// </lugus> code:0123456789abcdef rule:' + 'f'.repeat(16)].join('\n'));
  const before = doc.text;
  await run('lugus.restore', doc.uri, 0);
  assert.equal(doc.text, before);
  assert.ok(log.warn.some((m) => m.includes('no copy of the last aligned code')));
});

test('re-align on hand-edited code: model changes nothing -> user decides, no silent accept', async () => {
  const { doc } = open('//> compute total');
  modelReplies = ['total = a + b;'];
  await run('lugus.translate', doc.uri, 0);
  const aligned = doc.text;
  doc.setText(doc.text.replace('total = a + b;', 'total = a + b;\nlog(total);'));
  const edited = doc.text;

  // Dismissed: nothing changes, still flagged.
  modelReplies = ['total = a + b;\nlog(total);'];
  answers.info.push(undefined);
  await run('lugus.translate', doc.uri, 0);
  assert.equal(doc.text, edited);
  assert.ok(log.info.some((m) => m.includes('hand edits included')));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('code edited'));

  // Restore chosen: back to the aligned code.
  modelReplies = ['total = a + b;\nlog(total);'];
  answers.info.push('Restore Last Aligned', 'Apply');
  await run('lugus.translate', doc.uri, 0);
  assert.equal(doc.text, aligned);
});

test('re-align on hand-edited code: Accept keeps the edits as aligned', async () => {
  const { doc } = open('//> compute total');
  modelReplies = ['total = a + b;'];
  await run('lugus.translate', doc.uri, 0);
  doc.setText(doc.text.replace('total = a + b;', 'total = a + b; // checked'));
  modelReplies = ['total = a + b; // checked'];
  answers.info.push('Accept Current Code');
  await run('lugus.translate', doc.uri, 0);
  assert.ok(doc.text.includes('// checked'));
  assert.ok(getCodeLens().provideCodeLenses(doc)[0].command.title.includes('aligned'));
});

test('restore: falls back to the committed version in git', async () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lugus-git-'));
  const file = path.join(dir, 'Calc.cs');
  const committed = ['class C {', ...linkedBlock('add', ['return a + b;']), '}'].join('\n');
  fs.writeFileSync(file, committed);
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'init');

  // Never seen aligned by this session: only git knows the aligned code.
  const doc = new Document(committed.replace('return a + b;', 'return a + b + junk;'), 'csharp', file);
  mock.window.activeTextEditor = new Editor(doc);
  answers.info.push('Apply');
  await run('lugus.restore', doc.uri, 1);
  assert.equal(log.warn.length, 0, log.warn.join());
  assert.equal(doc.text, committed);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    reset();
    try { await t.fn(); console.log('ok   ', t.name); }
    catch (e) { failed++; console.log('FAIL ', t.name, '\n      ', e.message, '\n', 'errors:', log.error); }
  }
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0); // timers from the drift monitor would keep the process alive
})();
