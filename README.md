# Lugus

**Master of all languages.**

Write a block's logic as a comment in your own language. Lugus translates it into code for the active VS Code file. When a requirement changes, edit the comment and recompile that block in place. You choose when to translate and which model to use, including one running on your own machine.

## How it works

Suppose `Items` is a C# dictionary. Inside a method, write two consecutive lines describing what it should return:

```csharp
//> Collect the keys from Items where the value is "user".
//> Return the keys as a list.
```

Place the cursor on either line and press **Ctrl+Alt+Enter** (**Cmd+Alt+Enter** on macOS), or click **Lugus: Translate** above the comment. In the default `linked` mode, the result might look like this:

```csharp
//> Collect the keys from Items where the value is "user".
//> Return the keys as a list.
return Items.Where(item => item.Value == "user")
            .Select(item => item.Key)
            .ToList();
// </lugus>
```

Change the second instruction to `//> Sort the keys alphabetically and return them as a list.` Click **Lugus: Recompile** or use the same shortcut anywhere in the linked block. Lugus replaces the implementation between the instructions and the closing marker, including any edits you made there by hand.

Choose **Detach** to remove the pseudocode and the marker while keeping the current code. A single Undo restores the previous edit.

The comment prefix follows the file's VS Code language mode:

| Prefix | Languages |
| --- | --- |
| `//>` | Default for most languages, including C#, TypeScript, JavaScript, Rust, C++, Go, Java and PHP |
| `#>` | Python, shell scripts, Ruby, YAML, GDScript, PowerShell, Dockerfile, TOML, Perl and R |
| `-->` | SQL, Lua, Haskell and Ada |

## Installation

Lugus requires VS Code 1.90 or later. Check [GitHub Releases](https://github.com/daevis-it/lugus/releases) for a packaged `.vsix`, or build one using the [development instructions](#development).

Open the Command Palette and run **Extensions: Install from VSIX...**, then select the package. To install from a terminal, run the following from the package directory, using the filename you downloaded or built:

```bash
code --install-extension lugus-0.1.0.vsix
```

## Choose a provider

In VS Code Settings, search for `lugus.provider` and choose where to run translations.

| Provider | Setup |
| --- | --- |
| `anthropic` (default) | Run **Lugus: Set API Key** from the Command Palette with your Anthropic key. The default model is `claude-haiku-4-5`. |
| `openai` | Set your OpenAI key with the same command. The default model is `gpt-4o-mini`. |
| `ollama` | Run Ollama locally and download the default model with `ollama pull qwen2.5-coder:7b`. The preset uses `http://localhost:11434/v1` and works without a key. |
| `custom` | For an OpenAI-compatible service such as OpenRouter, Groq or LM Studio, set both `lugus.baseUrl` and `lugus.model`. Use the API base URL (e.g. `http://localhost:1234/v1`) and the server's model ID. Set an API key for endpoints outside `localhost` and `127.0.0.1`. |

You can override the model and base URL for any preset. Lugus stores one API key in VS Code's SecretStorage and uses it with the selected endpoint. Run **Lugus: Set API Key** to replace it when switching services, or submit an empty value to clear it.

## Project rules and context

Create a plain-text `.lugusrc` in the root of the workspace folder to give the model repository-specific conventions. For the C# example above, you might use:

```text
Target C# 12 and .NET 8.
Prefer LINQ method syntax where it improves readability.
Use only dependencies already in the project.
```

Each translation sends the instruction, target language, surrounding lines and up to 8,000 characters of project rules to the selected endpoint. Surrounding context comes from outside the block being replaced. Set `lugus.contextLines` to `0` to omit those lines. For local processing, select a locally hosted model. Lugus itself collects no telemetry.

## Editor settings

| Setting | Default | Effect |
| --- | --- | --- |
| `lugus.blockMode` | `linked` | Keeps the editable instruction and closing marker. Choose `replace` for code only or `comment` for an ordinary comment above the code. |
| `lugus.enableCodeLens` | `true` | Shows Translate, Recompile or Detach above applicable blocks. The keyboard shortcut also works with CodeLens hidden. |
| `lugus.contextLines` | `20` | Maximum number of surrounding lines to include on each side of the block. |
| `lugus.languageOverride` | Active file language | Overrides the target language requested from the model. |
| `lugus.timeoutMs` | `30000` | Sets the request timeout in milliseconds. |

## Development

With Node.js and npm installed, clone and build the extension:

```bash
git clone https://github.com/daevis-it/lugus.git
cd lugus
npm ci
npm run build
```

Open the cloned folder in VS Code and press **F5** to try Lugus in the Extension Development Host. To create an installable VSIX, run:

```bash
npx @vscode/vsce package
```

## Roadmap

- [x] Re-compilable linked blocks with Detach support
- [x] Project conventions through `.lugusrc`
- [x] Optional CodeLens actions on pseudocode blocks
- [ ] On-demand logic check for edge cases and null risks, with findings shown separately from the code

## License

Released under the [MIT License](LICENSE).
