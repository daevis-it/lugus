import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyIndentation,
  canonicalCode,
  canonicalRule,
  cleanModelOutput,
  commonIndent,
  dedent,
  trimBlankLines
} from '../src/core/text';

describe('commonIndent', () => {
  it('finds the shared prefix and ignores blank lines', () => {
    assert.equal(commonIndent(['    a', '', '      b', '    c']), '    ');
  });
  it('never mixes tabs and spaces', () => {
    assert.equal(commonIndent(['\t\ta', '\t  b']), '\t');
    assert.equal(commonIndent(['\ta', '    b']), '');
  });
  it('returns empty for no content', () => {
    assert.equal(commonIndent(['', '  ']), '');
  });
});

describe('dedent / applyIndentation', () => {
  it('round-trips a block', () => {
    const code = '    if (x) {\n        y();\n    }';
    const flat = dedent(code);
    assert.equal(flat, 'if (x) {\n    y();\n}');
    assert.equal(applyIndentation(flat, '    '), code);
  });
  it('keeps blank lines empty instead of indenting them', () => {
    assert.equal(applyIndentation('a\n\nb', '  '), '  a\n\n  b');
  });
  it('normalizes CRLF', () => {
    assert.equal(dedent('  a\r\n  b'), 'a\nb');
  });
});

describe('trimBlankLines', () => {
  it('drops only leading and trailing blank lines', () => {
    assert.equal(trimBlankLines('\n\n a\n\n b\n  \n'), ' a\n\n b');
  });
});

describe('cleanModelOutput', () => {
  it('strips a fenced block with a language tag', () => {
    assert.equal(cleanModelOutput('```python\nx = 1\n```'), 'x = 1');
  });
  it('strips a fence with an unusual tag and trailing spaces', () => {
    assert.equal(cleanModelOutput('```c# \nint x;\n```\n'), 'int x;');
  });
  it('handles a missing closing fence', () => {
    assert.equal(cleanModelOutput('```ts\nconst a = 1;'), 'const a = 1;');
  });
  it('keeps fences that are part of the code', () => {
    const code = 'const md = `\n```\n`;';
    assert.equal(cleanModelOutput(code), code);
  });
  it('dedents shared indentation from the model', () => {
    assert.equal(cleanModelOutput('    a\n      b'), 'a\n  b');
  });
});

describe('canonicalCode', () => {
  it('ignores base indentation, trailing spaces, blank lines and EOL', () => {
    const a = 'if (x) {\n  y();\n}';
    const b = '\t\tif (x) {   \r\n\r\n\t\t  y();\r\n\t\t}\n';
    assert.equal(canonicalCode(a), canonicalCode(b));
  });
  it('keeps relative indentation (meaningful in Python)', () => {
    assert.notEqual(canonicalCode('if a:\n    b()\nc()'), canonicalCode('if a:\n    b()\n    c()'));
  });
});

describe('canonicalRule', () => {
  it('collapses spacing and drops blank rule lines', () => {
    assert.equal(canonicalRule(['  Return   the  keys ', '', 'sorted']), 'Return the keys\nsorted');
  });
});
