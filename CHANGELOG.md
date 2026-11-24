# Changelog

## 0.2.0

### Added
- **Link Selected Code to a Rule**: attach a rule to existing code without changing it and without calling a model.
- **Drift detection**: the end marker now stores fingerprints of both the rule and the code (`// </lugus> code:… rule:…`). Every block shows its status: aligned, rule changed, code edited by hand, both changed, or not verified.
- **Accept**: record the current rule and code as aligned without calling the model.
- Requests can be cancelled from the status bar.
- Unit tests (`npm test`) and an end-to-end smoke test on a mocked VS Code API (`npm run test:smoke`).

### Changed
- **Updates edit, they don't regenerate.** When a linked block already has code, Lugus sends the current code to the model and asks for the smallest change that satisfies the rule, keeping signatures, names and unrelated logic.
- Changes to existing code always go through a diff review (Apply / Keep Current). Closing the diff keeps the current code.
- If the file changes during a request, Lugus re-locates the block and applies the result only if the block itself is unchanged.
- Rule lines are kept exactly as written when the block is updated.
- The extension activates at startup, so CodeLens appears as soon as a file is open.
- Default timeout raised to 60 seconds; output limit raised to 8,192 tokens.

### Fixed
- Truncated model output (token limit) was inserted silently. It is now rejected and nothing is changed.
- The first line of model output lost its indentation when the response was cleaned up.
- F5 ran a stale build: the launch configuration now builds first.

### Compatibility
- Markers from 0.1.0 (`// </lugus>`) are still recognized and shown as **not verified**. Click **Accept** once to add fingerprints.
