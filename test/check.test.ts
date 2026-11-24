import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { formatMarker } from '../src/core/blocks';
import { checkText, commentTokenForFile, describeState, isDrift, mayContainBlocks } from '../src/core/check';
import { run } from '../src/cli';

function linked(rule: string, code: string[], token = '//'): string[] {
  return [`${token}> ${rule}`, ...code, formatMarker('', token, code.join('\n'), [rule])];
}

describe('checkText', () => {
  it('reports every linked block with its state and skips unlinked rules', () => {
    const doc = [...linked('one', ['a();']), '//> not translated yet', 'x();', ...linked('two', ['b();'])];
    doc[doc.length - 2] = 'changed();';
    const reports = checkText(doc.join('\n'), '//');
    assert.deepEqual(
      reports.map((r) => [r.line, r.state, r.rule.join(' ')]),
      [
        [0, 'aligned', 'one'],
        [5, 'code-edited', 'two']
      ]
    );
  });

  it('works with CRLF text', () => {
    const doc = linked('one', ['a();']).join('\r\n');
    assert.equal(checkText(doc, '//')[0].state, 'aligned');
  });
});

describe('state helpers', () => {
  it('classifies drift', () => {
    assert.equal(isDrift('rule-changed'), true);
    assert.equal(isDrift('code-edited'), true);
    assert.equal(isDrift('both-changed'), true);
    assert.equal(isDrift('aligned'), false);
    assert.equal(isDrift('unverified'), false);
    assert.equal(describeState('both-changed'), 'rule and code changed');
  });
  it('pre-filters on the marker', () => {
    assert.equal(mayContainBlocks('//> rule only'), false);
    assert.equal(mayContainBlocks('x\n// </lugus>'), true);
  });
});

describe('commentTokenForFile', () => {
  it('uses the extension or file name when known', () => {
    assert.equal(commentTokenForFile('a/b/script.py', ''), '#');
    assert.equal(commentTokenForFile('query.SQL', ''), '--');
    assert.equal(commentTokenForFile('docker/Dockerfile', ''), '#');
    assert.equal(commentTokenForFile('C:\\x\\Player.gd', ''), '#');
  });
  it('reads the token from the markers for other files', () => {
    assert.equal(commentTokenForFile('Thing.weird', 'x\n  # </lugus> code:1'), '#');
    assert.equal(commentTokenForFile('Thing.cs', '// </lugus>'), '//');
    assert.equal(commentTokenForFile('noext', 'nothing'), '//');
  });
});

// ------------------------------------------------------------------ CLI

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lugus-cli-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function cli(argv: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('lugus check (CLI)', () => {
  const aligned = linked('sum a and b', ['return a + b;']).join('\n');
  const drifted = linked('sum a and b', ['return a - b;']).join('\n').replace('return a - b;', 'return a * b;');
  const python = linked('double it', ['x = x * 2'], '#').join('\n');

  it('exits 0 when everything is aligned', () => {
    const root = project({ 'src/Calc.cs': aligned, 'tools/x.py': python, 'README.md': 'no blocks' });
    const r = cli(['check'], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /2 linked blocks checked, 0 drifted/);
  });

  it('exits 1 and lists drifted blocks with file:line', () => {
    const root = project({ 'src/Calc.cs': `class C {\n${drifted}\n}`, 'ok.cs': aligned });
    const r = cli(['check'], root);
    assert.equal(r.code, 1);
    assert.match(r.out, /^src\/Calc\.cs:2 {2}code edited by hand {2}"sum a and b"$/m);
    assert.match(r.out, /2 linked blocks checked, 1 drifted/);
  });

  it('skips build and dependency folders when walking', () => {
    const root = project({ 'node_modules/pkg/a.cs': drifted, 'Intermediate/b.cs': drifted, 'src/a.cs': aligned });
    assert.equal(cli(['check'], root).code, 0);
  });

  it('accepts explicit files and folders', () => {
    const root = project({ 'a/x.cs': drifted, 'b/y.cs': aligned });
    assert.equal(cli(['check', 'b'], root).code, 0);
    assert.equal(cli(['check', 'a/x.cs'], root).code, 1);
  });

  it('reports unverified markers but fails on them only with --strict', () => {
    const root = project({ 'old.cs': '//> rule\nx();\n// </lugus>' });
    const r = cli(['check'], root);
    assert.equal(r.code, 0);
    assert.match(r.out, /old\.cs:1 {2}not verified/);
    assert.equal(cli(['check', '--strict'], root).code, 1);
  });

  it('prints JSON', () => {
    const root = project({ 'x.cs': drifted });
    const r = cli(['check', '--json'], root);
    const report = JSON.parse(r.out);
    assert.equal(report.ok, false);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.findings[0], { file: 'x.cs', line: 1, state: 'code-edited', rule: 'sum a and b' });
  });

  it('ignores binary files', () => {
    const root = project({ 'blob.bin': '\0\0\0// </lugus>' });
    assert.match(cli(['check'], root).out, /0 linked blocks checked/);
  });

  it('returns 2 on usage errors', () => {
    const root = project({});
    assert.equal(cli([], root).code, 2);
    assert.equal(cli(['lint'], root).code, 2);
    assert.equal(cli(['check', '--nope'], root).code, 2);
    assert.equal(cli(['check', 'missing'], root).code, 2);
    assert.equal(cli(['--version'], root).code, 0);
  });
});
