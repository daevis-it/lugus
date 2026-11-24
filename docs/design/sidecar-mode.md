# Sidecar mode: rules without markers in the source

Status: proposed for 0.3.0. Not implemented in 0.2.0.

## Problem

Inline blocks (`//>` rule lines plus a `// </lugus>` marker) work well for a solo developer, but in shared code they are noise for anyone who doesn't use Lugus:

- the markers show up in every diff and review;
- a teammate can edit the code without touching the rule, leaving a rule that no longer describes the code;
- people don't want tool-specific syntax in production files.

The goal is to keep what makes Lugus useful (the rule lives in the repository, under version control, next to the code it describes, and drift is detected) while leaving source files completely clean.

## Options considered

| Option | Clean source | Shared with team | Verdict |
| --- | --- | --- | --- |
| A. Committed sidecar store in `.lugus/` | Yes | Yes | **Chosen** |
| B. Local, git-ignored sidecar | Yes | No | Offered as a setting on top of A |
| C. Hide markers with folding or decorations | No (still in the file) | — | Rejected: cosmetic only |
| D. Strip markers with a git clean/smudge filter | In the repo, yes | Fragile | Rejected: hidden magic, breaks fingerprints, needs per-clone setup |

## Design (option A)

### Storage

One JSON file per source file, mirroring its path:

```
.lugus/rules/src/Services/UserService.cs.json
```

```json
{
  "version": 1,
  "blocks": [
    {
      "id": "b7f2c1",
      "rule": ["Return the active users sorted by last login"],
      "anchor": {
        "symbol": "UserService.GetActiveUsers",
        "kind": "method",
        "lineHint": 42,
        "firstLine": "public List<User> GetActiveUsers()"
      },
      "code": "5be1c0f3a8d2e917",
      "ruleHash": "0c4d9e6b1f27a835"
    }
  ]
}
```

One file per source file keeps merge conflicts local and makes `.lugus/` diffs readable in review. Teammates who don't use Lugus can ignore the folder; the code they read has no Lugus syntax.

### Anchors

Anchoring is the hard part, which is why this is not in 0.2.0.

1. **Symbol anchor (primary).** Use `vscode.executeDocumentSymbolProvider` to anchor a rule to a named symbol (function, method, class). It survives moves, insertions above it and reformatting, and covers most real uses ("this function implements this rule").
2. **Range anchor (fallback, sub-function blocks).** First line text, line hint and code fingerprint. To relocate: exact fingerprint match first, then the first line near the hint, otherwise **orphaned**.
3. Renamed or deleted symbol → **orphaned**. Lugus shows orphaned rules in a list and lets the user re-attach them to a symbol or delete them. It never guesses silently.

### Drift detection

Unchanged from inline mode. `src/core/blocks.ts` already separates the fingerprint logic (`hashCode`, `hashRule`, `blockState`) from where the rule is stored. A sidecar block resolves its anchor to a code range, and the same states apply: aligned, rule changed, code edited by hand, both changed, plus **orphaned**.

### Editing the rule

- CodeLens above the anchored symbol shows the status and the first line of the rule.
- Hover shows the full rule.
- **Edit Rule** opens the rule in a small editor (input box for single-line rules, virtual document for multi-line). Saving writes the sidecar file.
- **Update Code** / **Accept** / **Detach** behave exactly as in inline mode. Detach deletes the sidecar entry.

### Settings and migration

- `lugus.storage`: `"inline"` (default) | `"sidecar"` | `"sidecar-local"` (option B: `.lugus/` added to `.git/info/exclude`, rules never leave the machine).
- Commands **Move Rules to Sidecar** and **Move Rules Inline**, per file or per workspace, so a solo project can start inline and move to sidecar when shared.

### Team workflow

- CI check: `lugus check` (shipped in 0.3.0 for inline blocks) will read `.lugus/` too and report orphaned rules alongside drifted ones, without needing VS Code.
- A drifted rule is information, not an error: the team decides whether to accept the code or update it.

## Out of scope

- Generating rules from existing code with a model (it would invert the source of truth).
- Rules that span several files.
