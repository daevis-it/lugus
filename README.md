# Lugus

**Keep the rule next to the code that implements it.**

Write what a piece of code must do as a short rule in your own language, right above it. Lugus turns the rule into code for the active file, keeps the two linked, and tells you when they drift apart. When the rule changes, Lugus edits the existing code as little as possible to match. It never regenerates the block from scratch and never overwrites existing code without showing you the diff.

You choose when to call a model and which one to use, including one running on your own machine. Linking existing code, checking drift and accepting changes all run locally.

## How it works

Write a rule with the `//>` prefix (`#>` in Python and other `#` languages) and press **Ctrl+Alt+Enter** (**Cmd+Alt+Enter** on macOS), or click **Translate** above it:

```csharp
//> Collect the keys from Items where the value is "user".
//> Return them as a list.
```

Lugus writes the code below the rule and closes the block with a marker:

```csharp
//> Collect the keys from Items where the value is "user".
//> Return them as a list.
return Items.Where(item => item.Value == "user")
            .Select(item => item.Key)
            .ToList();
// </lugus> code:d95f43a14c2ffd18 rule:6f5b250d3e6942f2
```

The marker stores two fingerprints: one of the rule and one of the code. They let Lugus tell you, above every block, where it stands:

| Status | Meaning | Actions |
| --- | --- | --- |
| ✓ aligned | Rule and code are what Lugus last recorded. | Detach |
| ● rule changed | You edited the rule. The code needs updating. | **Update Code**, Accept As Is, Detach |
| ✎ code edited by hand | You changed the code. Does the rule still describe it? | **Accept Code**, Re-align to Rule, Detach |
| ● rule and code changed | Both were edited. | Update Code, Accept As Is, Detach |
| ? not verified | Marker from an older Lugus version. | Accept, Update Code, Detach |

Fingerprints ignore indentation, trailing spaces and blank lines, so moving or re-indenting a block doesn't count as a change.

### Updating code when the rule changes

Change the second rule line to `//> Sort them alphabetically and return them as a list.` The status becomes **rule changed**. Click **Update Code** or press the shortcut anywhere inside the block.

Lugus sends the model the rule, the **current code** and the lines around the block, and asks for the smallest edit that satisfies the rule. Signatures, names, comments and logic that the rule doesn't touch must stay as they are. The result always opens in a diff next to your file: choose **Apply** or **Keep Current**. Closing the diff keeps the current code. If the model decides the code already satisfies the rule, Lugus simply marks the block as aligned.

If you edit the file while a request is running, Lugus checks the block again before applying anything. Edits elsewhere in the file are fine. If the block itself changed, nothing is applied and you can run the command again.

### Link code you already have

Select the lines of an existing function or block, right-click and choose **Lugus: Link Selected Code to a Rule**. Describe in your own words the rule it implements. Lugus adds the rule above the code and a marker below it, leaving the code byte-for-byte unchanged. No model call happens. You can add more `//>` lines to the rule afterwards.

From then on the block works like any other: the model is only called when you change the rule and ask for an update.

### Accept and Detach

- **Accept** records the current rule and code as aligned without calling the model. Use it after a hand edit the rule still describes, or after rewording a rule without changing its meaning.
- **Detach** removes the rule and the marker and keeps the code. Undo restores them.

### See every block that needs attention

Drifted blocks appear in the **Problems** panel (as warnings by default; see `lugus.driftSeverity`) with **Update code** and **Accept** as quick fixes (**Ctrl+.**). Open files are re-checked as you type.

Run **Lugus: Show Blocks to Review** to scan the whole workspace: you get the list of drifted and not-verified blocks, and selecting one opens it. Build and dependency folders (`node_modules`, `dist`, `bin`, `obj`, Unreal's `Intermediate`/`Saved`/`Binaries`, Unity's `Library`, `.godot`…) are skipped.

### Check from the command line

`lugus check` reports drift without VS Code, for pre-commit hooks and CI:

```bash
npm install -g github:daevis-it/lugus
lugus check            # current folder; inside a git repo, ignored files are skipped
lugus check src --json # specific folders or files, JSON output
```

```text
src/Services/UserService.cs:42  rule changed  "Return the active users sorted by last login"
lugus: 12 linked blocks checked, 1 drifted.
```

It exits with `0` when everything is aligned and `1` when a block has drifted. Old markers without fingerprints are listed as *not verified*; add `--strict` to fail on them too. As a git pre-commit hook (`.git/hooks/pre-commit`):

```sh
#!/bin/sh
lugus check || { echo "Lugus: some rules and code are out of sync. Update or Accept them, or commit with --no-verify."; exit 1; }
```

### Comment prefixes

The prefix follows the file's VS Code language mode:

| Prefix | Languages |
| --- | --- |
| `//>` | Default, including C#, C++, TypeScript, JavaScript, Rust, Go, Java, PHP, Kotlin and Swift |
| `#>` | Python, shell scripts, Ruby, YAML, GDScript, PowerShell, Dockerfile, TOML, Perl, R, Makefile, Julia and Elixir |
| `-->` | SQL, Lua, Haskell, Ada and Elm |

## Installation

Lugus requires VS Code 1.90 or later. Check [GitHub Releases](https://github.com/daevis-it/lugus/releases) for a packaged `.vsix`, or build one using the [development instructions](#development).

Open the Command Palette and run **Extensions: Install from VSIX...**, then select the package, or from a terminal:

```bash
code --install-extension lugus-0.2.0.vsix
```

## Choose a provider

In Settings, search for `lugus.provider` and choose where translations run.

| Provider | Setup |
| --- | --- |
| `anthropic` (default) | Run **Lugus: Set API Key** with your Anthropic key. Default model: `claude-haiku-4-5`. |
| `openai` | Set your OpenAI key with the same command. Default model: `gpt-4o-mini`. |
| `ollama` | Run Ollama locally and pull the default model with `ollama pull qwen2.5-coder:7b`. Uses `http://localhost:11434/v1`, no key needed. |
| `custom` | Any OpenAI-compatible service (OpenRouter, Groq, LM Studio, DeepSeek…). Set `lugus.baseUrl` (e.g. `http://localhost:1234/v1`) and `lugus.model`. A key is required for endpoints outside `localhost`. |

You can override the model and base URL for any preset. Lugus stores one API key in VS Code's SecretStorage; run **Lugus: Set API Key** again to replace it, or submit an empty value to remove it. If a response is cut off by the model's output limit, Lugus applies nothing and tells you to split the rule.

## Project rules and context

Create a plain-text `.lugusrc` in the workspace root to give the model your project's conventions:

```text
Target C# 12 and .NET 8.
Prefer LINQ method syntax where it improves readability.
Use only dependencies already in the project.
```

Each request sends the rule, the current code of the block (when updating), the target language, up to `lugus.contextLines` lines around the block and up to 8,000 characters of `.lugusrc` to the selected endpoint. Set `lugus.contextLines` to `0` to send no surrounding lines. For fully local processing, use a local model. Lugus itself collects no telemetry.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `lugus.blockMode` | `linked` | `linked` keeps the rule and the marker. `replace` leaves only the code; `comment` turns the rule into an ordinary comment. Only `linked` blocks can be tracked. |
| `lugus.enableCodeLens` | `true` | Shows status and actions above blocks. The shortcut works with CodeLens hidden. |
| `lugus.contextLines` | `20` | Lines of context sent from each side of the block. |
| `lugus.languageOverride` | Active file language | Overrides the target language requested from the model. |
| `lugus.timeoutMs` | `60000` | Request timeout in milliseconds. Raise it for slow local models. |
| `lugus.driftSeverity` | `warning` | How drifted blocks appear in the Problems panel: `warning`, `information`, `hint` or `off`. Not-verified blocks are always reported as information. |

## Development

```bash
git clone https://github.com/daevis-it/lugus.git
cd lugus
npm ci
npm run build        # bundle to dist/
npm test             # unit tests for the parser, fingerprints and prompts
npm run test:smoke   # end-to-end run of the bundled extension on a mocked VS Code API
npm run typecheck
node dist/cli.js check
```

CI runs all of the above on Linux and Windows for every push and pull request, then packages the `.vsix` as a build artifact.

Press **F5** in VS Code to build and start an Extension Development Host. To create an installable package, run `npx @vscode/vsce package`.

The parsing, fingerprint, drift and prompt logic lives in `src/core/` and has no VS Code dependency. The extension (`src/extension.ts` and friends) and the CLI (`src/cli.ts`) are thin layers on top of it.

## Roadmap

- [x] Re-compilable linked blocks with Detach
- [x] Project conventions through `.lugusrc`
- [x] Link existing code to a rule
- [x] Drift detection: rule and code fingerprints, block status, Accept
- [x] Updates edit the current code minimally, always behind a diff review
- [x] Drift in the Problems panel, workspace overview and `lugus check` CLI
- [ ] Sidecar mode: keep rules in `.lugus/` instead of in the source, so shared code stays clean ([design](docs/design/sidecar-mode.md))

## License

Released under the [MIT License](LICENSE).
