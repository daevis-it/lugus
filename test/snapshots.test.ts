import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatMarker, hashCode } from '../src/core/blocks';
import { findCodeByHash, SnapshotStore } from '../src/core/snapshots';

function memoryStorage() {
  const data = new Map<string, unknown>();
  let writes = 0;
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      writes++;
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    writes: () => writes
  };
}

describe('SnapshotStore', () => {
  it('stores code by fingerprint, dedented', async () => {
    const store = new SnapshotStore(memoryStorage());
    const code = '    if (x) {\n        y();\n    }';
    await store.remember(code);
    assert.equal(store.get(hashCode(code)), 'if (x) {\n    y();\n}');
    assert.equal(store.get('0000000000000000'), undefined);
  });

  it('does not rewrite storage for code it already has', async () => {
    const storage = memoryStorage();
    const store = new SnapshotStore(storage);
    await store.remember('a();');
    await store.remember('  a();  ');
    assert.equal(storage.writes(), 1);
  });

  it('ignores empty code', async () => {
    const storage = memoryStorage();
    await new SnapshotStore(storage).remember('   \n');
    assert.equal(storage.writes(), 0);
  });

  it('evicts the oldest entries beyond the limit', async () => {
    let clock = 0;
    const store = new SnapshotStore(memoryStorage(), 2, () => ++clock);
    await store.remember('one();');
    await store.remember('two();');
    await store.remember('three();');
    assert.equal(store.get(hashCode('one();')), undefined);
    assert.equal(store.get(hashCode('two();')), 'two();');
    assert.equal(store.get(hashCode('three();')), 'three();');
  });
});

describe('findCodeByHash', () => {
  const committed = [
    'class A {',
    '    //> rule',
    '    return a + b;',
    formatMarker('    ', '//', '    return a + b;', ['rule']),
    '}'
  ].join('\n');

  it('finds the committed body with the recorded fingerprint', () => {
    assert.equal(findCodeByHash(committed, '//', hashCode('return a + b;')), 'return a + b;');
  });

  it('returns undefined when no body matches', () => {
    assert.equal(findCodeByHash(committed, '//', hashCode('return 0;')), undefined);
  });
});
