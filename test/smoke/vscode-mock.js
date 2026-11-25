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
  get fsPath() { return this.path; }
  static from({ scheme, path }) { return new Uri(scheme, path); }
  static file(p) { return new Uri('file', p); }
  static joinPath(u, ...parts) { return new Uri(u.scheme, require('path').posix.normalize([u.path, ...parts].join('/'))); }
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
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class Selection extends Range {}

// Diagnostics, keyed by uri string.
const diagnostics = new Map();
const docListeners = { open: [], change: [] };
const files = new Map(); // fake disk: uri string -> { uri, text, languageId }
const openDocs = [];
const fsLog = [];
const renameListeners = [];
const symbolProvider = { enabled: true };

// SymbolKind with the reverse mapping a real TS enum has.
const SymbolKind = {};
['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','EnumMember','Struct','Event','Operator','TypeParameter']
  .forEach((name, i) => { SymbolKind[name] = i; SymbolKind[i] = name; });

/** Tiny C#-like symbol provider: classes and methods, ranges by brace matching. */
function computeSymbols(doc) {
  const lines = doc.lines;
  const endOf = (start) => {
    let depth = 0, seen = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; seen = true; }
        if (ch === '}') { depth--; if (seen && depth === 0) return i; }
      }
    }
    return lines.length - 1;
  };
  const roots = [];
  const stack = [];
  lines.forEach((line, i) => {
    const cls = /^\s*(?:public |private |internal |static |sealed )*class (\w+)/.exec(line);
    const method = /^\s*(?:[\w<>\[\],]+\s+)+(\w+)\s*\([^)]*\)\s*\{?\s*$/.exec(line);
    let sym = null;
    if (cls) sym = { name: cls[1], kind: SymbolKind.Class };
    else if (method && !['if', 'for', 'while', 'switch', 'catch', 'return', 'foreach', 'using'].includes(method[1])) sym = { name: method[1], kind: SymbolKind.Method };
    if (!sym) return;
    const end = endOf(i);
    sym.range = new Range(i, 0, end, lines[end].length);
    sym.selectionRange = sym.range;
    sym.children = [];
    while (stack.length && stack[stack.length - 1].range.end.line < i) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(sym);
    stack.push(sym);
  });
  return roots;
}

const log = { info: [], warn: [], error: [], status: [], diffs: [], quickPick: [] };
const answers = { info: [], input: [], quickPick: [], warn: [] };
const settings = {};
const commands = new Map();
let codeLensProvider = null;
let codeActionProvider = null;

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
  setText(t) {
    this.text = t; this.version++;
    docListeners.change.forEach((l) => l({ document: this }));
  }
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
  showWarningMessage: async (msg, ...items) => { log.warn.push(msg); return items.some((i) => typeof i === 'string') ? answers.warn.shift() : undefined; },
  showErrorMessage: async (msg) => { log.error.push(msg); return undefined; },
  setStatusBarMessage: (msg) => { log.status.push(msg); return { dispose() {} }; },
  showInputBox: async () => answers.input.shift(),
  withProgress: async (_o, task) => task({ report() {} }, { onCancellationRequested() { return { dispose() {} }; } }),
  showTextDocument: async (docOrUri) => {
    const doc = docOrUri instanceof Document ? docOrUri : await workspace.openTextDocument(docOrUri);
    const editor = new Editor(doc);
    editor.revealRange = () => {};
    window.activeTextEditor = editor;
    return editor;
  },
  showQuickPick: async (items, options) => { log.quickPick.push({ items, options }); return answers.quickPick.shift()?.(items); },
  tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }), close: async () => true }
};

const workspace = {
  getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  onDidOpenTextDocument: (fn) => { docListeners.open.push(fn); return { dispose() {} }; },
  onDidChangeTextDocument: (fn) => { docListeners.change.push(fn); return { dispose() {} }; },
  onDidRenameFiles: (fn) => { renameListeners.push(fn); return { dispose() {} }; },
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose() {} }),
    onDidCreate: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    dispose() {}
  }),
  get textDocuments() { return openDocs; },
  asRelativePath: (uri) => uri.path.replace(/^\/w\//, ''),
  findFiles: async (include) => {
    const all = [...files.values()].map((f) => f.uri);
    return include.includes('.lugus') ? all.filter((u) => u.path.includes('/.lugus/rules/')) : all;
  },
  openTextDocument: async (uri) => {
    const existing = openDocs.find((d) => d.uri.toString() === uri.toString());
    if (existing) return existing;
    const f = files.get(uri.toString());
    if (!f) throw new Error('not found ' + uri);
    const doc = new Document(f.text, f.languageId, uri.path);
    openDocs.push(doc);
    docListeners.open.forEach((l) => l(doc));
    return doc;
  },
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  getWorkspaceFolder: (uri) => (uri.path.startsWith('/w/') ? { uri: Uri.file('/w'), name: 'w', index: 0 } : undefined),
  workspaceFolders: undefined,
  fs: {
    readFile: async (uri) => {
      const f = files.get(uri.toString());
      if (!f) throw new Error('nope');
      const open = openDocs.find((d) => d.uri.toString() === uri.toString());
      return Buffer.from(open ? open.text : f.text);
    },
    stat: async (uri) => {
      const f = files.get(uri.toString());
      if (f) return { size: Buffer.byteLength(f.text), type: 1 };
      const prefix = uri.toString() + '/';
      if ([...files.keys()].some((k) => k.startsWith(prefix))) return { size: 0, type: 2 };
      throw new Error('not found');
    },
    writeFile: async (uri, bytes) => {
      fsLog.push(['write', uri.path]);
      files.set(uri.toString(), { uri, text: Buffer.from(bytes).toString('utf8'), languageId: 'json' });
    },
    delete: async (uri) => {
      fsLog.push(['delete', uri.path]);
      if (!files.delete(uri.toString())) throw new Error('not found');
    },
    createDirectory: async () => {},
    rename: async (from, to) => {
      fsLog.push(['rename', from.path, to.path]);
      for (const [k, f] of [...files.entries()]) {
        if (k === from.toString() || k.startsWith(from.toString() + '/')) {
          const nu = Uri.file(to.path + f.uri.path.slice(from.path.length));
          files.delete(k);
          files.set(nu.toString(), { ...f, uri: nu });
        }
      }
    }
  }
};

module.exports = {
  Position, Range, Uri, EventEmitter, ThemeColor, TabInputTextDiff, CodeLens,
  Diagnostic, CodeAction, Selection, SymbolKind,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeActionKind: { QuickFix: 'quickfix' },
  TextEditorRevealType: { InCenter: 2 },
  EndOfLine: { LF: 1, CRLF: 2 },
  ProgressLocation: { Window: 10, Notification: 15 },
  ViewColumn: { Beside: -2 },
  window, workspace,
  languages: {
    registerCodeLensProvider: (_s, p) => { codeLensProvider = p; return { dispose() {} }; },
    registerCodeActionsProvider: (_s, p) => { codeActionProvider = p; return { dispose() {} }; },
    createDiagnosticCollection: () => ({
      set: (uri, d) => diagnostics.set(uri.toString(), d),
      delete: (uri) => diagnostics.delete(uri.toString()),
      has: (uri) => diagnostics.has(uri.toString()),
      dispose() {}
    })
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async (id, ...args) => {
      if (id === 'vscode.diff') { log.diffs.push(args); return; }
      if (id === 'vscode.executeDocumentSymbolProvider') {
        if (!symbolProvider.enabled) return undefined;
        const doc = openDocs.find((d) => d.uri.toString() === args[0].toString()) || (window.activeTextEditor && window.activeTextEditor.document.uri.toString() === args[0].toString() ? window.activeTextEditor.document : null);
        return doc ? computeSymbols(doc) : [];
      }
      return commands.get(id)(...args);
    }
  },
  __test: {
    log, answers, settings, commands, Document, Editor, diagnostics, files, openDocs, fsLog, renameListeners, symbolProvider,
    getCodeLens: () => codeLensProvider,
    getCodeActions: () => codeActionProvider
  }
};
