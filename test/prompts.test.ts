import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildPrompt } from '../src/core/prompts';

const base = {
  language: 'csharp',
  rule: 'Return the keys sorted alphabetically',
  contextBefore: 'var items = Load();',
  contextAfter: ''
};

describe('buildPrompt', () => {
  it('generate mode asks for new code and sends no current code', () => {
    const p = buildPrompt({ ...base, mode: 'generate' });
    assert.match(p.system, /translator/);
    assert.doesNotMatch(p.user, /CURRENT CODE/);
    assert.match(p.user, /--- RULE ---\nReturn the keys sorted alphabetically/);
    assert.match(p.user, /CONTEXT BEFORE/);
    assert.doesNotMatch(p.user, /CONTEXT AFTER/);
  });

  it('update mode sends the current code and forbids rewriting from scratch', () => {
    const currentCode = 'public List<string> Keys() {\n    return items.Keys.ToList();\n}';
    const p = buildPrompt({ ...base, mode: 'update', currentCode });
    assert.match(p.user, /--- CURRENT CODE \(csharp\) ---\npublic List<string> Keys\(\)/);
    assert.match(p.system, /smallest change/);
    assert.match(p.system, /Never rewrite the block from scratch/);
    assert.match(p.system, /return it exactly as it is/);
    // The generate-only ban on wrappers must not apply: it would strip signatures.
    assert.doesNotMatch(p.system, /Do NOT add imports\/using statements or outer class/);
  });

  it('update mode requires the current code', () => {
    assert.throws(() => buildPrompt({ ...base, mode: 'update' }));
  });

  it('includes project rules when present', () => {
    const p = buildPrompt({ ...base, mode: 'generate', projectRules: 'Target .NET 8.' });
    assert.match(p.system, /\.lugusrc[\s\S]*Target \.NET 8\./);
  });
});
