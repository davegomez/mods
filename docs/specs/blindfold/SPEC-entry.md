# Spec: blindfold `entry`

Module id: `entry`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, section 1e, gates G1 and G2. Depends on nothing in blindfold. `ui` draws the terminal field. `write` gets the value.

API facts come from the Claude Code 2.1.318 declarations (`d.ts:N`) and `docs/mods/`.

## Objective

`entry` gets 1 value from the user outside the chat: a native dialog with a hidden field, or a terminal field that blindfold masks. It returns the value or a cancel to its caller and keeps no copy.

Success: on macOS the user types a value in a native dialog with hidden text, and the value reaches `write` unchanged, with no trace in argv, the transcript, render props, `$.state`, or `$.store`.

### Module shape

```ts
export type Method = "auto" | "native" | "terminal";
export type Platform = "macos" | "windows" | "linux" | "unknown";
export type Entered = { kind: "value"; value: string } | { kind: "cancel"; why: "cancelled" | "timeout" | "unavailable" | "failed" };
// Pure:
export function nativeCommand(platform: Platform, name: string, reason: string): { argv: string[]; env?: Record<string, string> } | undefined; // R2
export function readNative(platform: Platform, out: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }): Entered; // R3
export function maskStep(state: Masked, shown: string): Masked; // R5
// Thin:
export function detectPlatform($): Promise<Platform>;   // R1
export function enterNative($, platform, name, reason): Promise<Entered>; // R2, R3
```

### Requirements

R1. Method and platform. The `userConfig` field `inputMethod` is a string with `options: ["auto", "native", "terminal"]`, default `auto` (`d.ts:8034`, Q10). A change reloads the plugin (`d.ts:10004`). There is no platform API, so `detectPlatform` reads `$.env.get("OS")` (`Windows_NT` on Windows), else runs `uname -s` with `$.process.run` (`Darwin` or `Linux`). A failure is `unknown`.

| `inputMethod` | macOS | Windows, Linux | unknown |
|---|---|---|---|
| `auto` | native | native when R2 finds a dialog, else terminal (Q35) | terminal (Q35) |
| `native` | native | native, else `unavailable` | `unavailable` |
| `terminal` | terminal (Q35) | terminal (Q35) | terminal (Q35) |

`unavailable` tells the user to add the value in their editor.

R2. Native dialogs. 1 fixed script per platform. The name and the reason go in as arguments or environment variables, never in script source. `$.process.run` has no shell (`d.ts:3646`).

- macOS: `["osascript", "-e", SCRIPT, "--", name, reason]`. `SCRIPT` is a fixed `on run argv` handler that shows `display dialog … default answer "" with hidden answer` and returns `text returned`.
- Windows: `powershell -NoProfile -NonInteractive -Command SCRIPT` with a fixed WinForms dialog that has `UseSystemPasswordChar`. The name and the reason come from 2 environment variables in `ProcessRunInit.env` (`d.ts:8385`). Not tested (Q13).
- Linux: when `$.env.get("DISPLAY")` or `$.env.get("WAYLAND_DISPLAY")` is set, `zenity --entry --hide-text --title blindfold --text <reason>`, else `kdialog --password <reason>`. A program that does not start is `unavailable`. Not tested (Q13).

`timeoutMs` is 300,000. A timeout kills the dialog and the call rejects (`d.ts:8385`), which is `cancel` with `timeout`.

R3. Reading the answer. `isStdoutTruncated` is `failed`, whatever the exit code (F55). Exit code 0: the value is `stdout` with exactly 1 trailing `\n` (or `\r\n` on Windows) removed. No other trim (G1). An empty value is `cancel` with `cancelled`. On macOS, exit code 1 with `-128` in `stderr` is `cancelled`. Any other exit is `failed`. `stderr` is never shown, because it can hold text from the dialog.

R4. The value. `entry` returns the value to its caller and keeps no copy in module state. It never puts the value in argv, `env`, a render prop, `$.state`, `$.store`, a log, a toast, or an error.

R5. Terminal field (Q35). `ui` draws an `Input` whose `value` is `"•"` repeated for each character typed. `Input` has no mask prop (`d.ts:5693`). `maskStep` reads each `onInput` text:

- the dots, then more characters: those characters are added at the end,
- fewer dots and nothing else: that many characters are removed from the end,
- anything else (an edit in the middle, a changed dot): the field is cleared.

The README states the limits: a paste can show for 1 frame, only edits at the end are kept, and the field draws dots only if the host treats `value` as controlled. The terminal field is used only after G2 confirms that the host draws the dots, not the typed text (Q35).

R6. Other mods. A mod that runs earlier in the hook chain sees the `ui.input` text, the `process.run` result, and the `fs.write` text (`build/draw-in-the-interface.md`, "Which controls need a key", `build/use-the-mods-api.md`, "Reach files, processes, and the network"). Other mods are trusted code (design "Purpose and promise"). The README states this (Q34).

### Not in scope

Drawing the field and the buttons (`ui`). Saving (`write`). A `Client` surface with raw keys (`d.ts:1630`), which needs fullscreen rendering. A later slice can try it if G2 fails.

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`, with the 4 commands. Files: `blindfold/hooks/entry.ts`, `blindfold/tests/entry.test.ts`, and `blindfold/.claude-plugin/plugin.json` (the `inputMethod` field).

## Testing strategy

- Pure tests: `nativeCommand` for each platform (the script is fixed, the name and reason with quotes, `$`, backslashes, and newlines stay out of the script text), `readNative` for each exit case and line ending, every `maskStep` rule.
- Stub tests with `fakeApi`: `detectPlatform` for each case, a timeout reject, a program that does not start.
- R4: the JSON text of every call to the fake `$` holds no fake value, except the `stdout` that the fake dialog returns.

## Boundaries

- Always: pass the name and the reason as data. Remove 1 line ending only.
- Ask first: a new dialog program, a change to the timeout, turning the terminal field on before G2.
- Never: build a script from text. Use a shell. Keep a copy of the value.

## Success criteria

- The 4 commands pass. Every requirement R1 to R6 has a test that names it.
- G1 on macOS (milestone 5, with the owner's approval): fixed source, masking, cancel, a value with spaces, quotes, `$`, and non-ASCII text arrives unchanged, the dialog ends after the timeout, VoiceOver reads the prompt.
- G2 (milestone 5): the fake value is not in the transcript file or the debug log, and the terminal field draws dots.

## Decisions

- Q34. A mod earlier in the hook chain can see the value in `ui.input`, `process.run`, and `fs.write`. blindfold cannot hide a call from those hooks. Other mods are trusted, and the README states this next to the promise. Accepted (agent decision, owner delegated 2026-11-06).
- Q35. The terminal field stays off until G2 shows that the host draws the controlled `value` (the dots). Until then, `auto` uses the native dialog, and a platform without one tells the user to edit the file. If G2 passes, the field turns on as in Q10. Accepted (agent decision, owner delegated 2026-11-06).
