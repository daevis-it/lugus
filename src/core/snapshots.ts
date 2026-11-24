import { bodyLines, findBlocks, hashCode } from './blocks';
import { dedent, splitLines } from './text';

/**
 * Last-aligned code, addressed by its fingerprint.
 *
 * The marker of a linked block records the fingerprint of the code as it was
 * when rule and code were last aligned. Keeping that code (keyed by the same
 * fingerprint) lets Lugus restore it exactly, without asking a model.
 */

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

interface Entry {
  code: string;
  /** Last time the entry was written or read (for eviction). */
  t: number;
}

const STORE_KEY = 'lugus.alignedSnapshots';

export class SnapshotStore {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now
  ) {}

  private entries(): Record<string, Entry> {
    return this.storage.get<Record<string, Entry>>(STORE_KEY) ?? {};
  }

  /** Remembers `code` as an aligned version. Cheap no-op when already stored. */
  public async remember(code: string): Promise<void> {
    if (!code.trim()) {
      return;
    }
    const key = hashCode(code);
    const entries = this.entries();
    if (entries[key]) {
      return;
    }
    entries[key] = { code: dedent(code), t: this.now() };
    const keys = Object.keys(entries);
    if (keys.length > this.maxEntries) {
      keys
        .sort((a, b) => entries[a].t - entries[b].t)
        .slice(0, keys.length - this.maxEntries)
        .forEach((k) => delete entries[k]);
    }
    await this.storage.update(STORE_KEY, entries);
  }

  /** Dedented code whose fingerprint is `codeHash`, if known. */
  public get(codeHash: string): string | undefined {
    return this.entries()[codeHash]?.code;
  }
}

/**
 * Looks for the code with fingerprint `codeHash` in another version of the file
 * (for example the committed one). Returns it dedented.
 */
export function findCodeByHash(text: string, token: string, codeHash: string): string | undefined {
  const lines = splitLines(text);
  for (const block of findBlocks(lines, token)) {
    if (block.markerLine === null) {
      continue;
    }
    const body = bodyLines(lines, block).join('\n');
    if (hashCode(body) === codeHash) {
      return dedent(body);
    }
  }
  return undefined;
}
