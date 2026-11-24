import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BlockInfo,
  blockState,
  composeBlock,
  bodyLines,
  findBlockAt,
  findBlocks,
  formatMarker,
  getCommentToken,
  hashCode,
  hashRule,
  parseMarker
} from '../src/core/blocks';

function stateOf(doc: string[], token = '//', index = 0) {
  const block = findBlocks(doc, token)[index];
  return blockState(block, bodyLines(doc, block));
}

/** Builds a linked block exactly like Lugus writes it. */
function linked(rule: string[], code: string[], indent = '', token = '//'): string[] {
  return [
    ...rule.map((r) => `${indent}${token}> ${r}`),
    ...code,
    formatMarker(indent, token, code.join('\n'), rule)
  ];
}

describe('getCommentToken', () => {
  it('maps languages to comment prefixes', () => {
    assert.equal(getCommentToken('csharp'), '//');
    assert.equal(getCommentToken('python'), '#');
    assert.equal(getCommentToken('gdscript'), '#');
    assert.equal(getCommentToken('sql'), '--');
  });
});

describe('parseMarker', () => {
  it('reads the current format', () => {
    const m = parseMarker('    // </lugus> code:0123456789abcdef rule:fedcba9876543210', '//');
    assert.deepEqual(m, { codeHash: '0123456789abcdef', ruleHash: 'fedcba9876543210' });
  });
  it('reads pre-release markers', () => {
    assert.deepEqual(parseMarker('// </lugus>', '//'), {});
    assert.deepEqual(parseMarker('// </lugus> sha256:0123456789abcdef', '//'), {
      legacyCodeHash: '0123456789abcdef'
    });
  });
  it('rejects other lines and other tokens', () => {
    assert.equal(parseMarker('// lugus', '//'), null);
    assert.equal(parseMarker('# </lugus>', '//'), null);
    assert.notEqual(parseMarker('-- </lugus>', '--'), null);
  });
  it('ignores unknown fields', () => {
    assert.deepEqual(parseMarker('// </lugus> v3 code:0123456789abcdef', '//'), { codeHash: '0123456789abcdef' });
  });
});

describe('findBlocks', () => {
  it('finds unlinked and linked blocks in order', () => {
    const doc = [
      'void A() {',
      '  //> first rule',
      '  //> second line',
      '}',
      ...linked(['rule two'], ['  x();'], '  ')
    ];
    const blocks = findBlocks(doc, '//');
    assert.equal(blocks.length, 2);
    assert.deepEqual(
      blocks.map((b) => [b.promptStart, b.promptEnd, b.markerLine]),
      [
        [1, 2, null],
        [4, 4, 6]
      ]
    );
    assert.deepEqual(blocks[0].ruleLines, ['first rule', 'second line']);
    assert.equal(blocks[0].indent, '  ');
  });

  it('never steals the marker of the next block', () => {
    const doc = ['//> unlinked', 'code();', ...linked(['linked'], ['y();'])];
    const blocks = findBlocks(doc, '//');
    assert.equal(blocks[0].markerLine, null);
    assert.equal(blocks[1].markerLine, 4);
  });

  it('does not treat //> inside a longer comment as a rule', () => {
    assert.equal(findBlocks(['/// > doc', 'x //> trailing'], '//').length, 0);
  });

  it('uses the language token', () => {
    const doc = linked(['sum'], ['total = a + b'], '', '#');
    assert.equal(findBlocks(doc, '#').length, 1);
    assert.equal(findBlocks(doc, '//').length, 0);
  });
});

describe('findBlockAt', () => {
  const doc = ['before();', ...linked(['rule'], ['a();', 'b();']), 'after();'];
  it('matches rule, body and marker lines', () => {
    for (const line of [1, 2, 3, 4]) {
      assert.equal(findBlockAt(doc, '//', line)?.promptStart, 1, `line ${line}`);
    }
  });
  it('returns null outside blocks', () => {
    assert.equal(findBlockAt(doc, '//', 0), null);
    assert.equal(findBlockAt(doc, '//', 5), null);
  });
});

describe('blockState', () => {
  const rule = ['Return the keys whose value is "user"'];
  const code = ['    return items.Where(i => i.Value == "user")', '                .Select(i => i.Key).ToList();'];

  it('is unlinked without a marker', () => {
    assert.equal(stateOf(['//> do something']), 'unlinked');
  });

  it('is aligned right after Lugus writes the block', () => {
    assert.equal(stateOf(linked(rule, code, '    ')), 'aligned');
  });

  it('detects a rule change', () => {
    const doc = linked(rule, code, '    ');
    doc[0] = '    //> Return the keys whose value is "admin"';
    assert.equal(stateOf(doc), 'rule-changed');
  });

  it('detects a hand edit of the code', () => {
    const doc = linked(rule, code, '    ');
    doc[1] = doc[1].replace('"user"', '"guest"');
    assert.equal(stateOf(doc), 'code-edited');
  });

  it('detects both', () => {
    const doc = linked(rule, code, '    ');
    doc[0] = '    //> something else';
    doc[2] = '    return null;';
    assert.equal(stateOf(doc), 'both-changed');
  });

  it('stays aligned when the block is re-indented, gets blank lines or trailing spaces', () => {
    const doc = linked(rule, code, '    ');
    const moved = doc.map((line) => '\t' + line + '  ');
    moved.splice(2, 0, '');
    assert.equal(stateOf(moved), 'aligned');
  });

  it('stays aligned when only rule spacing changes', () => {
    const doc = linked(rule, code, '    ');
    doc[0] = '    //>   Return  the keys whose value is "user"   ';
    assert.equal(stateOf(doc), 'aligned');
  });

  it('treats pre-release markers as unverified', () => {
    assert.equal(stateOf(['//> rule', 'x();', '// </lugus>']), 'unverified');
    assert.equal(stateOf(['//> rule', 'x();', '// </lugus> sha256:0123456789abcdef']), 'unverified');
  });

  it('handles an empty body', () => {
    const doc = linked(['rule'], []);
    assert.equal(stateOf(doc), 'aligned');
    const block: BlockInfo = findBlocks(doc, '//')[0];
    assert.deepEqual(bodyLines(doc, block), []);
  });
});

describe('fingerprints', () => {
  it('are stable and EOL-insensitive', () => {
    assert.equal(hashCode('a();\r\nb();'), hashCode('a();\nb();'));
    assert.equal(hashCode('a();'), hashCode('a();'));
    assert.match(hashCode('a();'), /^[a-f0-9]{16}$/);
  });
  it('distinguish real changes', () => {
    assert.notEqual(hashCode('a();'), hashCode('b();'));
    assert.notEqual(hashRule(['sort ascending']), hashRule(['sort descending']));
  });
  it('round-trip through a written marker', () => {
    const marker = formatMarker('  ', '#', 'x = 1', ['set x']);
    assert.deepEqual(parseMarker(marker, '#'), { codeHash: hashCode('x = 1'), ruleHash: hashRule(['set x']) });
  });
});

describe('multiple blocks in one file', () => {
  it('reports each state independently', () => {
    const doc = [...linked(['one'], ['a();']), 'gap();', ...linked(['two'], ['b();'])];
    doc[4] = '//> two, changed';
    assert.equal(stateOf(doc, '//', 0), 'aligned');
    assert.equal(stateOf(doc, '//', 1), 'rule-changed');
  });
});

describe('composeBlock', () => {
  const input = {
    headerLines: ['    //> Return   the keys'],
    indent: '    ',
    token: '//',
    ruleLines: ['Return the keys'],
    code: '    return keys;'
  };

  it('linked mode keeps the header verbatim and produces an aligned block', () => {
    const text = composeBlock({ ...input, mode: 'linked' });
    const doc = ['class A {', ...text.split('\n'), '}'];
    assert.equal(doc[1], '    //> Return   the keys');
    const block = findBlocks(doc, '//')[0];
    assert.equal(blockState(block, bodyLines(doc, block)), 'aligned');
  });

  it('comment mode turns rules into plain comments', () => {
    assert.equal(composeBlock({ ...input, mode: 'comment' }), '    // Return the keys\n    return keys;');
  });

  it('replace mode returns only code', () => {
    assert.equal(composeBlock({ ...input, mode: 'replace' }), '    return keys;');
  });
});
