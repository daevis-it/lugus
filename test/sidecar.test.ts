import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  entryState,
  fileSymbol,
  isFileEntry,
  entryStateWithoutSymbols,
  findAlignedRegion,
  findEntryCodeIn,
  makeEntry,
  newEntryId,
  parseSidecar,
  resolveAnchor,
  serializeSidecar,
  sidecarPathFor,
  sourcePathFor,
  SymbolInfo,
  symbolAt
} from '../src/core/sidecar';

const source = [
  'class Calc {', //                          0
  '    int Sum(int a, int b) {', //           1
  '        return a + b;', //                 2
  '    }', //                                 3
  '', //                                      4
  '    int Sum(int a, int b, int c) {', //    5
  '        return a + b + c;', //             6
  '    }', //                                 7
  '}' //                                      8
];

const symbols: SymbolInfo[] = [
  { path: 'Calc', kind: 'Class', startLine: 0, endLine: 8 },
  { path: 'Calc.Sum', kind: 'Method', startLine: 1, endLine: 3 },
  { path: 'Calc.Sum', kind: 'Method', startLine: 5, endLine: 7 }
];

describe('symbolAt', () => {
  it('prefers the innermost callable over the class', () => {
    assert.equal(symbolAt(symbols, 2)?.startLine, 1);
    assert.equal(symbolAt(symbols, 6)?.startLine, 5);
  });
  it('falls back to the container', () => {
    assert.equal(symbolAt(symbols, 4)?.path, 'Calc');
  });
  it('ignores non-linkable kinds', () => {
    assert.equal(symbolAt([{ path: 'x', kind: 'Variable', startLine: 0, endLine: 3 }], 1), undefined);
  });
});

describe('makeEntry / entryState', () => {
  const entry = makeEntry('a1', [' add two numbers '], symbols[1], source);

  it('records the anchor and fingerprints', () => {
    assert.deepEqual(entry.rule, ['add two numbers']);
    assert.deepEqual(entry.anchor, {
      symbol: 'Calc.Sum',
      kind: 'Method',
      line: 1,
      firstLine: 'int Sum(int a, int b) {',
      lineCount: 3
    });
    assert.equal(entryState(entry, source, symbols[1]), 'aligned');
  });

  it('detects code and rule changes, and orphans', () => {
    const edited = [...source];
    edited[2] = '        return a - b;';
    assert.equal(entryState(entry, edited, symbols[1]), 'code-edited');
    assert.equal(entryState({ ...entry, rule: ['subtract'] }, source, symbols[1]), 'rule-changed');
    assert.equal(entryState({ ...entry, rule: ['subtract'] }, edited, symbols[1]), 'both-changed');
    assert.equal(entryState(entry, source, undefined), 'orphaned');
  });

  it('stays aligned when the symbol moves or is re-indented', () => {
    const moved = ['// new line', '// another', ...source.map((l) => '  ' + l)];
    const movedSymbol = { ...symbols[1], startLine: 3, endLine: 5 };
    assert.equal(entryState(entry, moved, movedSymbol), 'aligned');
  });
});

describe('resolveAnchor', () => {
  it('tells overloads apart by first line, then distance', () => {
    const second = makeEntry('b2', ['add three'], symbols[2], source);
    assert.equal(resolveAnchor(second, symbols, source)?.startLine, 5);
    const first = makeEntry('a1', ['add two'], symbols[1], source);
    // Shifted by 10 lines: the first-line match still wins over distance.
    assert.equal(resolveAnchor({ ...first, anchor: { ...first.anchor, line: 15 } }, symbols, source)?.startLine, 1);
  });
  it('returns undefined when the symbol is gone', () => {
    const e = makeEntry('a1', ['x'], symbols[1], source);
    assert.equal(resolveAnchor({ ...e, anchor: { ...e.anchor, symbol: 'Calc.Gone' } }, symbols, source), undefined);
  });
});

describe('without a symbol provider', () => {
  const entry = makeEntry('a1', ['add two numbers'], symbols[1], source);

  it('finds the aligned code anywhere, even moved', () => {
    const moved = ['using X;', '', ...source];
    assert.deepEqual(findAlignedRegion(moved, entry.anchor, entry.code), { start: 3, end: 5 });
    assert.deepEqual(entryStateWithoutSymbols(entry, moved), { state: 'aligned', line: 3 });
  });

  it('tolerates added blank lines inside the region', () => {
    const spaced = [...source.slice(0, 3), '', ...source.slice(3)];
    assert.equal(entryStateWithoutSymbols(entry, spaced).state, 'aligned');
  });

  it('reports edits and rule changes', () => {
    const edited = [...source];
    edited[2] = '        return 0;';
    assert.deepEqual(entryStateWithoutSymbols(entry, edited), { state: 'code-edited', line: 1 });
    assert.equal(entryStateWithoutSymbols({ ...entry, rule: ['other'] }, source).state, 'rule-changed');
    assert.equal(entryStateWithoutSymbols(entry, null).state, 'orphaned');
  });

  it('recovers aligned code from another version of the file', () => {
    assert.equal(findEntryCodeIn(source.join('\n'), entry), 'int Sum(int a, int b) {\n    return a + b;\n}');
    const edited = [...source];
    edited[2] = '        return 0;';
    assert.equal(findEntryCodeIn(edited.join('\n'), entry), undefined);
  });
});

describe('serialization', () => {
  const a = makeEntry('aaaa0001', ['two'], symbols[2], source);
  const b = makeEntry('bbbb0002', ['one'], symbols[1], source);

  it('round-trips and sorts by position with a stable key order', () => {
    const text = serializeSidecar({ version: 1, blocks: [a, b] });
    const parsed = parseSidecar(text);
    assert.deepEqual(
      parsed.blocks.map((x) => x.id),
      ['bbbb0002', 'aaaa0001']
    );
    assert.equal(serializeSidecar(parsed), text);
    assert.ok(text.endsWith('\n'));
    assert.match(text, /^\{\n {2}"version": 1,\n {2}"blocks": \[/);
  });

  it('rejects broken files with a readable message', () => {
    assert.throws(() => parseSidecar('{'), /not valid JSON/);
    assert.throws(() => parseSidecar('{"version":2,"blocks":[]}'), /version/);
    assert.throws(() => parseSidecar('{"version":1,"blocks":[{"id":"x"}]}'), /block 1 is malformed/);
  });
});

describe('paths and ids', () => {
  it('maps source paths to sidecar paths and back', () => {
    assert.equal(sidecarPathFor('src/Calc.cs'), '.lugus/rules/src/Calc.cs.json');
    assert.equal(sidecarPathFor('src\\Calc.cs'), '.lugus/rules/src/Calc.cs.json');
    assert.equal(sourcePathFor('.lugus/rules/src/Calc.cs.json'), 'src/Calc.cs');
    assert.equal(sourcePathFor('src/Calc.cs.json'), undefined);
  });
  it('generates unique ids', () => {
    const values = [0.5, 0.5, 0.25];
    const id = newEntryId([makeEntry('7fffffff', ['x'], symbols[1], source)], () => values.shift()!);
    assert.equal(id, '3fffffff');
  });
});

describe('whole-file rules', () => {
  const json = ['{', '  "port": 8080,', '  "debug": false', '}', '', ''];
  const entry = makeEntry('f1', ['production config: debug always off'], fileSymbol(json), json);

  it('covers the file up to the last non-blank line', () => {
    assert.deepEqual(fileSymbol(json), { path: '', kind: 'File', startLine: 0, endLine: 3 });
    assert.deepEqual(fileSymbol(['']), { path: '', kind: 'File', startLine: 0, endLine: 0 });
    assert.equal(isFileEntry(entry), true);
    assert.equal(entry.anchor.kind, 'File');
  });

  it('tracks any change in the file, with or without symbols', () => {
    assert.equal(entryState(entry, json, fileSymbol(json)), 'aligned');
    assert.deepEqual(entryStateWithoutSymbols(entry, json), { state: 'aligned', line: 0 });
    const edited = json.map((l) => l.replace('false', 'true'));
    assert.deepEqual(entryStateWithoutSymbols(entry, edited), { state: 'code-edited', line: 0 });
    assert.equal(entryStateWithoutSymbols(entry, [...json, '', '']).state, 'aligned');
  });

  it('recovers the aligned file from another version', () => {
    assert.equal(findEntryCodeIn(json.join('\n'), entry), json.slice(0, 4).join('\n'));
    assert.equal(findEntryCodeIn(json.join('\n').replace('8080', '9090'), entry), undefined);
  });
});
