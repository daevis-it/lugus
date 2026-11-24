// Minimal in-memory stand-in for the parts of the VS Code API Lugus uses.
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; }
    else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}
class Uri {
  constructor(scheme, path) { this.scheme = scheme; this.path = path; }
  toString() { return `${this.scheme}:${this.path}`; }
  static from({ scheme, path }) { return new Uri(scheme, path); }
  static file(p) { return new Uri('file', p); }
  static joinPath(u, ...parts) { return new Uri(u.scheme, [u.path, ...parts].join('/')); }
  with({ path }) { return new Uri(this.scheme, path ?? this.path); }
}
class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { this.listeners.forEach((l) => l(v)); }
  dispose() {}
}
class ThemeColor { constructor(id) { this.id = id; } }
class TabInputTextDiff {}
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }

const log = { info: [], warn: [], error: [], status: [], diffs: [] };
const answers = { info: [], input: [] };
const settings = {};
const commands = new Map();
let codeLensProvider = null;

class Document {
  constructor(text, languageId = 'csharp', path = '/w/Test.cs') {
    this.text = text; this.languageId = languageId; this.version = 1; this.isClosed = false;
    this.uri = Uri.file(path); this.eol = 1;
  }
  get lines() { return this.text.split('\n'); }
  get lineCount() { return this.lines.length; }
  lineAt(i) {
    const text = this.lines[i];
    if (text === undefined) throw new Error(`lineAt(${i}) out of range`);
    return { text, lineNumber: i, range: new Range(i, 0, i, text.length) };
  }
  offsetAt(pos) {
    const lines = this.lines;
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
    return off + Math.min(pos.character, (lines[pos.line] ?? '').length);
  }
  getText(range) {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  setText(t) { this.text = t; this.version++; }
}

class Editor {
  constructor(document) { this.document = document; this.selection = { active: new Position(0, 0) }; this.selections = [this.selection]; }
  setDecorations() {}
  async edit(cb) {
    const ops = [];
    cb({
      replace: (range, text) => ops.push({ range, text }),
      insert: (pos, text) => ops.push({ range: new Range(pos, pos), text }),
      delete: (range) => ops.push({ range, text: '' })
    });
    const doc = this.document;
    const resolved = ops.map((o) => ({ s: doc.offsetAt(o.range.start), e: doc.offsetAt(o.range.end), t: o.text.replace(/\r\n/g, '\n') }));
    resolved.sort((a, b) => b.s - a.s);
    let text = doc.text;
    for (const o of resolved) text = text.slice(0, o.s) + o.t + text.slice(o.e);
    doc.setText(text);
    return true;
  }
  select(startLine, startChar, endLine, endChar) {
    const sel = new Range(startLine, startChar, endLine, endChar);
    sel.active = sel.end;
    this.selection = sel; this.selections = [sel];
  }
}

const window = {
  activeTextEditor: undefined,
  get visibleTextEditors() { return this.activeTextEditor ? [this.activeTextEditor] : []; },
  createTextEditorDecorationType: () => ({ dispose() {} }),
  showInformationMessage: async (msg, ...items) => { log.info.push(msg); return items.length ? answers.info.shift() : undefined; },
  showWarningMessage: async (msg) => { log.warn.push(msg); return undefined; },
  showErrorMessage: async (msg) => { log.error.push(msg); return undefined; },
  setStatusBarMessage: (msg) => { log.status.push(msg); return { dispose() {} }; },
  showInputBox: async () => answers.input.shift(),
  withProgress: async (_o, task) => task({ report() {} }, { onCancellationRequested() { return { dispose() {} }; } }),
  showTextDocument: async () => window.activeTextEditor,
  tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }), close: async () => true }
};

const workspace = {
  getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  getWorkspaceFolder: () => undefined,
  workspaceFolders: undefined,
  fs: { readFile: async () => { throw new Error('nope'); } }
};

module.exports = {
  Position, Range, Uri, EventEmitter, ThemeColor, TabInputTextDiff, CodeLens,
  EndOfLine: { LF: 1, CRLF: 2 },
  ProgressLocation: { Window: 10 },
  ViewColumn: { Beside: -2 },
  window, workspace,
  languages: { registerCodeLensProvider: (_s, p) => { codeLensProvider = p; return { dispose() {} }; } },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async (id, ...args) => {
      if (id === 'vscode.diff') { log.diffs.push(args); return; }
      return commands.get(id)(...args);
    }
  },
  __test: { log, answers, settings, commands, Document, Editor, getCodeLens: () => codeLensProvider }
};
