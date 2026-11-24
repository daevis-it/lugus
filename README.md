# Lugus

**Master of all languages. Turn inline pseudocode comments into production code.**

Lugus is a lightweight, zero-bloat VS Code extension that translates natural-language pseudocode written directly in your editor into idiomatic code for the active file's language, right at your cursor.

No autonomous multi-file agents. No chat sidebars. No "vibe coding". You stay in charge of the architecture, types, and logic; Lugus acts as a fast, deterministic translator.

---

## Philosophy

Lugus is built around three core principles:

1. **Zero Lock-in, Privacy & Real Costs (BYOK / Local)**
   Bring your own API key (Anthropic, OpenAI, OpenRouter, Groq, etc.) or run 100% locally via Ollama / LM Studio on private codebases. API keys are stored encrypted in VS Code's native `SecretStorage`, never in plain-text settings files. Zero telemetry.
2. **Zero Visual Noise ("Anti-Clippy")**
   No unsolicited ghost-text popups interrupting your thoughts while writing normal comments. Lugus stays completely silent until you explicitly write a pseudocode trigger (`//>`, `#>`, `-->`) and invoke it.
3. **Towards a Real Pseudocode Compiler**
   Rather than trying to replace the developer with an agent, Lugus focuses on making structured human pseudocode a first-class authoring layer: designed to evolve toward re-compilable blocks and project-level translation rules (`.lugusrc`).

---

## How It Works

Write a single-line or multi-line pseudocode comment in any human language using the trigger prefix for the current file:

- `//>` for C#, TypeScript, JavaScript, Rust, C++, Go, Java, PHP, etc.
- `#>` for Python, Bash, Ruby, YAML, GDScript, PowerShell, etc.
- `-->` for SQL, Lua, Haskell, Ada.

Place your cursor on any line of the block and press **`Ctrl+Alt+Enter`** (`Cmd+Alt+Enter` on macOS).

### Example (C#)

Before:

```csharp
//> iterate over Items, extract all keys where value is "user"
//> store them in a list and return it at the end
```

After pressing `Ctrl+Alt+Enter`:

```csharp
var users = new List<string>();
foreach (var item in Items)
{
    if (item.Value == "user")
    {
        users.Add(item.Key);
    }
}
return users;
```

Don't like the output? A single `Ctrl+Z` reverts the entire block cleanly.

---

## Setup & Configuration

1. Open the Command Palette (`Ctrl+Shift+P`) and run **`Lugus: Set API Key`** (skip this step if using Ollama locally).
2. Open VS Code Settings (`Ctrl+,`), search for **`Lugus`**, and select your **`lugus.provider`**.

### Available Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `lugus.provider` | `anthropic` | Provider preset: `anthropic`, `openai`, `ollama`, or `custom`. |
| `lugus.model` | *(auto)* | Optional model override. Defaults to `claude-haiku-4-5` (Anthropic), `gpt-4o-mini` (OpenAI), or `qwen2.5-coder:7b` (Ollama). |
| `lugus.baseUrl` | *(auto)* | Optional endpoint override. Required only when `provider` is set to `custom`. |
| `lugus.keepComment` | `false` | Keeps the original pseudocode as standard comments above the generated code. |
| `lugus.contextLines` | `20` | Lines above and below the cursor sent as local context (`0` to disable). |
| `lugus.languageOverride` | *(auto)* | Forces a target language instead of auto-detecting from the active file. |
| `lugus.timeoutMs` | `30000` | Request timeout in milliseconds. |

---

## Development

```bash
git clone https://github.com/daevis-it/lugus.git
cd lugus
npm install
npm run build
```

Press **`F5`** inside VS Code to launch the *Extension Development Host* and test Lugus live.

---

## License

Released under the [MIT License](LICENSE).