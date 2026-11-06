# blindfold: merged design (draft for final review)

Merged from `claude-ideas.md`, `pi-ideas.md`, `round-1-claude.md`, `round-1-pi.md`, `round-2-pi.md`, and the owner's answers to Q8 to Q12. Design only. UNVERIFIED marks claims the local docs in `docs/mods/` do not confirm. Each UNVERIFIED claim becomes a gate before release.

## Purpose and promise

blindfold keeps secret values out of the conversation with Claude while the developer's app and tests keep using them.

The promise, in these words: "blindfold never puts a raw secret into a tool input, a prompt, or its own store. A value you enter goes only to the env file you chose. Its shield reduces accidental exposure on the text paths listed below. Programs that read your env file can still expose the value."

blindfold does not promise:

- that a known value is hidden in every representation (encoded, split, in an image),
- that a key is never committed or sent (a program that reads `.env` can do both),
- protection from another installed mod, same-user malware, or a model that has unrestricted Bash.

## Names

- Mod: `blindfold`. The name says what the mod does: Claude works with the keys without seeing them.
- Command: `/secrets`. The user types it when they need a secret.
- Tool: `request_secret`, handled as `mcp__blindfold__request_secret`.

## Principles

- P1. Markers are inert: `[secret: NAME]` for a known value, `[secret hidden]` for a detector hit. There is no reverse map. A marker never turns back into a value.
- P2. No hook changes a tool input. This avoids the auto-mode denial "a hook changed this call's input after the model wrote it" (`test-and-troubleshoot/troubleshoot.md`). Auto mode can still refuse credential work for its own reasons.
- P3. Claude refers to a secret by name only (`process.env.NAME` in code that the app's own loader feeds). blindfold does not recommend `source .env`, because a dotenv file is not a safe shell program.
- P4. `$.store` holds numbers only (`AGENTS.md`), or nothing. No telemetry, no `$.model.*`.
- P5. Every guard hook has a `.catch` that withholds or refuses. The `.catch` does no scan (1 s limit, `reference.md`, "Limits").
- P6. A value the user enters never goes into argv, render props, `$.state`, `$.store`, a log, or a model message. It goes from the input to the env file and to the exact-match set, nowhere else.

## Slice 1: first release

Slice 1 includes entry and writing (owner decision Q8). Gates G1 to G4 in 1i are release blockers.

### 1a. The shield

Paths, each with a pure scan function and a thin hook:

| Path | Action |
|---|---|
| `prompt.submit` (text and context) | Rewrite known values and detector hits to markers. Tell the user with a toast. |
| `tool.call` arguments, every tool including MCP | Refuse a call whose arguments hold a recognised raw secret. |
| `tool.call` result, deny text, context | Scan after `await next(e)`. Rewrite to markers. Withhold if a part cannot be rewritten. |
| `prompt.context`, `prompt.section`, `prompt.attachment`, `skill.prompt` | Rewrite or withhold. |
| `prompt.mention` | Refuse env files and any readable file with a recognised secret. |
| `agent.spawn` | Refuse a prompt with a recognised secret. |
| `session.send`, `session.receive` | Refuse a message with a recognised secret. |
| `session.append` | Second scan before a row is stored. A hit here means an earlier layer missed it: show rotate advice. |

Scans are bounded by bytes, depth, and the hook's `next.budget.remainingMs`. Object keys are scanned as well as values. Media, binary, and server-side tool calls are not covered, and the README says so.

Detectors, in order of precision:

1. Exact values from enrolled env files (1b), plus base64, URL, and hex forms of each.
2. Private key blocks and a small reviewed list of vendor prefixes, written for this mod and tested.
3. Context rules: a value after `token=`, `Bearer `, `"api_key":` and similar, with an entropy floor.

### 1b. Enrollment of env files

Which files: the `userConfig` option `envFiles` (comma-separated paths relative to the session root, default `.env`, owner decision Q9). It lives in the user's own settings under `pluginConfigs`, not in the repository, so a repository cannot add files to read (`reference.md`, "Files" and "Settings and environment variables"). A path that leaves the session root, or is a symlink, is refused.

- No recursive crawl. The mod reads each listed file with one documented dotenv dialect. A line it cannot parse is reported, not guessed.
- Only names that look secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `DSN`, …) feed the exact-match set. A value the user enters through blindfold always feeds the set, whatever its name.
- Values live in module variables only. Not in `$.state`, `$.store`, render props, or logs.

No listed file exists (owner decision Q9): the first save asks which file to use. The choices are `.env`, `.env.local`, or a name the user types. A file name is not secret, so a normal `Input` is correct here. The typed name must pass the path rules above. The choice holds for the session. The pane tells the user to add it to `envFiles` to keep it (UNVERIFIED: whether a mod can change its own `pluginConfigs` entry; if it can, offer that with a confirmation).

Lifecycle (`build/draw-in-the-interface.md`, "Keep state" and "Load a saved value again after /clear"; `reference.md`, "Session"):

| Event | Action |
|---|---|
| `session.start` (start and module reload) | Read the listed files. Shield state: Active, or Degraded (1g). |
| `classic.SessionStart` with `source` `clear`, `resume`, `fork` | Read the files again, because `session.start` does not fire after these. |
| `session.end` (also `/clear`, `/resume`, `/branch`) | Drop references to learned values. No secure-erasure claim. |
| A tool call names a listed file | Read it again before the call runs, so new values are known. |
| blindfold writes a value (1f) | Add the value to the exact-match set before the write starts. |
| A read fails | That file is Stale. Old matches stay as best effort. The pane says new values in that file may not be hidden. |
| User picks "Forget" | Drop that file's values at once. |

### 1c. The request tool

`request_secret { name, reason }`, registered at `session.start` (`build/use-the-mods-api.md`, "Add a tool").

Validation: `name` matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. `reason` is cut to 120 characters, control characters removed, and drawn as plain `Text` only.

The tool returns the real status at once:

- Set in a listed file: "STRIPE_SECRET_KEY is set in .env. Use it by name through the app's env loader."
- Not set: "STRIPE_SECRET_KEY is not set. The user was asked to enter it. End your turn. Do not ask the user to paste it in chat."
- Shield Degraded: the status above, plus "blindfold cannot confirm the env file now."

Request lifecycle: one pending request at a time.

| From | Event | To |
|---|---|---|
| none | `request_secret` for a missing name | Pending (stores name, reason, a random request id, the turn id) |
| Pending | a new `request_secret` | the old one is Superseded, the new one is Pending |
| Pending | the user saves the value (1e, 1f), or the name shows in a listed file | Ready (shows "Continue") |
| Ready | user presses Continue | Consumed, then one `$.prompt.submit` |
| Pending or Ready | user Stop, `session.end`, module reload, Dismiss | Cleared; no Continue button |
| Pending or Ready | the user submits a new prompt (`prompt.submit` not sent by blindfold) | Cleared; Claude can call `request_secret` again to read the status |
| Consumed | submit is dropped or refused | Cleared, toast "Continue was not sent. Ask Claude again." No retry. |

The request moves to Consumed before the submit, so a second press does nothing (`build/use-the-mods-api.md`, "Start a turn from a background job" and "Calls and background work after the user interrupts a turn").

The mod shows the request in 3 places, because the band can be collapsed:

- the band: "Claude asks for STRIPE_SECRET_KEY: <reason>. 1: enter it · 2: add it myself · 3: dismiss" (the choices follow `saveToEnvFile`, 1f),
- a status line: "blindfold: STRIPE_SECRET_KEY requested, run /secrets",
- a toast.

Pressing `1` or running `/secrets set STRIPE_SECRET_KEY` starts entry (1e). Running `/secrets` opens the pane (user-started, so it opens at any width, `build/draw-in-the-interface.md`, "When a pane waits for a wider terminal"). "Continue" submits one fixed prompt ("STRIPE_SECRET_KEY is now set. Continue the task that needed it.") per the lifecycle above.

### 1d. The pane

- No key field in the inventory. Rows: name, file, state in words (Set, Requested, Missing, Stale), and whether git ignores the file (`git check-ignore`, read-only, shown as a warning, no Git command parsing).
- Per row: "Enter value" (1e), "Forget", and for a Requested row "Dismiss".
- Session counts per name (how many tool results were rewritten). Numbers only, in memory.
- Buttons with visible hotkeys and the same actions as `/secrets` subcommands, so the band and the pane are never the only way.
- Layout from `e.props.bodyColumns`; under about 60 columns, one column of rows and buttons.

### 1e. Entry

The setting `inputMethod` selects how the user enters a value. Default: `auto` (owner decision Q10).

| `inputMethod` | Behavior |
|---|---|
| `auto` | Native dialog when the platform has one, else the terminal field. |
| `native` | Native dialog only. If none exists, tell the user to edit the file in their editor. |
| `terminal` | Terminal field only. |

Native dialogs, one fixed script per platform. The name and the reason go in as arguments, never as script source:

- macOS: `osascript` with `display dialog … with hidden answer`.
- Windows: PowerShell with a fixed WinForms dialog that has `UseSystemPasswordChar` (UNVERIFIED: start time, focus, behavior under VS Code).
- Linux: `zenity --password` or `kdialog --password`. Not available without a display (SSH, containers).

The wait is inside `$.process.run`, so it does not use the hook budget and needs no busy-wait (`reference.md`, "Limits").

Terminal field: a pane `Input` that the mod masks itself. Limits, which the README states:

- `Input` has no password mode (`reference.md`, "Elements"). The mod draws dots. A paste can show for 1 frame.
- The mod cannot track an edit in the middle of the value. It accepts typing and deletion at the end only, and clears the field for any other edit.
- Other mods see `ui.input` events (`build/draw-in-the-interface.md`, "Which controls need a key"). Other mods are trusted code, so this is a small risk, but it is a risk.

Pi's position (`round-1-pi.md`, correction 4) was no terminal field, because it keeps the 1-frame exposure. The owner chose `auto` (Q10), so the terminal field ships with the limits above. A user who does not accept them sets `inputMethod` to `native`.

### 1f. Writing the env file

The setting `saveToEnvFile` (owner decisions Q8 and Q12):

| Value | Behavior |
|---|---|
| `ask` (default) | Ask before entry: "1: enter it here (blindfold saves it to .env) · 2: add it myself · 3: dismiss". The question comes before the value is typed, so blindfold never holds a value it then discards. |
| `always` | Go straight to entry (1e) and save. |
| `never` | Show the file and the line to add (`NAME=`). The user fills in the value in their editor and presses "Refresh". |

The question uses buttons in the band and the pane, with the same choices as `/secrets set NAME` and `/secrets add NAME`. A choice applies to that request only.

Write order, so that no step has the secret on disk with open permissions:

1. Refuse the target if it is a symlink (`$.fs.list`, `isLink`), outside the session root, or under a parent that is a symlink.
2. Add the file to `.gitignore` if git does not ignore it yet. Refuse a file that git tracks (`git ls-files --error-unmatch`, read-only).
3. If the file does not exist, create it empty. Set mode `600` with `chmod`. Only the path goes in argv.
4. Read the file again. Stop if it changed since the read in step 1 (concurrent change).
5. Write the new content with the value last. Keep all other lines unchanged. Replace an existing `NAME=` line with the same name.
6. Read the file again and parse it. Confirm the value round-trips. If not, show an error and do not mark the name Set.

Limits, which the README states:

- `$.fs.write` is not atomic (`reference.md`, "Mods API methods"). A crash during step 5 can damage the file.
- A check in step 1 and the write in step 5 are separate calls. A local process can swap the file in between. blindfold does not defend against a hostile local process (see the promise).
- On Windows, `chmod` does nothing. Access depends on the folder ACLs.
- UNVERIFIED: whether `$.fs.write` on an existing file keeps its mode, or replaces the file with a new mode.

### 1g. Degraded states and failure limits

| Condition | Behavior |
|---|---|
| A listed file is Stale | Pane and status line say "Degraded: .env could not be read; new values may not be hidden". Never "Set" or "Active" for that file. |
| A text result is too large, too deep, or not plain data | Withhold the whole result, even if the scanned part had no hit. Tell Claude to narrow the call. |
| Not enough budget left to scan (`next.budget.remainingMs`) | Withhold or refuse. |
| The hook throws or times out | `.catch` withholds (after `next`) or refuses (before `next`) (`build/react-to-events.md`, "Handle a hook that fails"). |
| The `.catch` itself fails, or the worker crashes and the mod is unloaded | The shield is gone and text passes (`test-and-troubleshoot/troubleshoot.md`, "A hook is skipped or a mod is unloaded"). The README states this limit next to the promise. A test covers the `.catch` path. |
| The dialog is cancelled, times out, or is missing | No write. The request stays Pending. |
| A write step in 1f fails | No partial "Set". The pane shows which step failed, without the value. |

### 1h. Accessibility

- Every state in words, never color alone. No dim text for a security fact.
- Logical focus order, stable keys, hotkeys shown only where they work. In VS Code, labels stand alone because buttons have no hotkeys.
- No timed instructions. Toasts are extra, never the only signal.
- The native dialogs use OS controls, which screen readers know. The terminal field announces "value hidden, N characters" in words.

### 1i. Release gates

- G1. Native dialog on each platform: fixed source, arguments only, masking, cancel, encoding, no `.trim()` damage to the value, subprocess end after timeout, screen reader. Run on macOS only (Q13). The README states that Linux and Windows are not tested.
- G2. Fake-secret end-to-end test for both entry paths: the value does not show in the transcript file, the debug log, tool rows, or render props. stdout of `$.process.run` is a mods API result, so this needs proof, not inference.
- G3. Safe write: the 1f order works on macOS (Q13). `chmod` runs before the value is written. The value is never in argv. Symlink, outside-root, tracked-file, and concurrent-change cases are refused in tests.
- G4. One dotenv dialect with a round-trip fixture set (quotes, `$`, `#`, backslash, newline, CR, empty value). Refuse a value the dialect cannot hold.

## Slice 2 and later

- Host warnings: per-name host metadata and a `tool.check` hook that holds a command naming the secret and an unlisted host with `$.ui.ask`; after approval it returns `next(e)`'s decision, never `allow`. A reminder, not routing control.
- Fixed authenticated operations ("check this key works"), after redirect control and the provider's response are reviewed. The local docs confirm that `$.http.fetch` follows up to 5 redirects and document no setting to refuse them (`build/use-the-mods-api.md`, "Reach files, processes, and the network"). Check the installed declarations before deciding.
- A Git reminder that scans staged content for enrolled values, with size and binary limits.
- An atomic write through a bundled helper, if the 1f limits cause real problems.
- The Hatch broker: a companion with keychain storage and fixed operations, if users need a stronger boundary.

## Tests

- Pure functions first: detectors, dotenv parser and writer, path rules, scan bounds, marker rules, the request state machine, the terminal-field mask. Fixture sets of values to hide and values to keep.
- Thin-hook tests with `claude-code/testing` stubs for every path in 1a, including a hook that throws (the `.catch` must withhold).
- Write tests with a temporary root: new file, existing file, symlink, outside root, tracked file, concurrent change.
- Pane mounts for terminal, Desktop, and VS Code at 40, 60, and 120 columns.
- `claude plugin test`, `claude plugin validate --strict .`, Biome. Fake secrets only, no network, no live model.

## API source map

The installed type declarations outrank these pages (`create-a-mod.md`, "Get type definitions for your version"). Every exact field, result shape, and failure result below is UNVERIFIED until checked there and in a fake-secret test.

| Used for | API | Source |
|---|---|---|
| Shield paths in 1a | `prompt.submit`, `tool.call`, `prompt.context`, `prompt.section`, `prompt.attachment`, `skill.prompt`, `prompt.mention`, `agent.spawn`, `session.send`, `session.receive`, `session.append` | `reference.md`, "Events"; `build/react-to-events.md`, "Guard or change a tool call", "Rewrite or add to a prompt"; `build/use-the-mods-api.md`, "Send and receive messages between sessions" |
| Fail-closed | `.catch`, `next.called`, `next.budget` | `reference.md`, "The hook function"; `build/react-to-events.md`, "Handle a hook that fails" |
| Tool and command | `$.tool.register`, `$.command.register` (`immediate: true`), `command.run` | `build/use-the-mods-api.md`, "Add a command or a tool" |
| Settings | `userConfig` via `options`, `pluginConfigs` | `reference.md`, "Files", "Settings and environment variables" |
| Lifecycle | `session.start`, `session.end`, `classic.SessionStart` | `reference.md`, "Session"; `build/draw-in-the-interface.md`, "Load a saved value again after /clear" |
| Pane, band, controls | `$.ui.open`/`close`, `ui.render` (`Pane`, `AbovePrompt`), `Box`, `Text`, `Button`, `Input`, `ui.input`, `ui.close` | `build/draw-in-the-interface.md`, "Pick where to draw", "Open a pane at the right time", "Respond to presses and typing", "Which controls need a key"; `reference.md`, "Render sites", "Elements" |
| Notices | `$.ui.toast`, `$.ui.status` | `build/use-the-mods-api.md`, "Show something without starting a turn" |
| Continue | `$.prompt.submit` | `build/use-the-mods-api.md`, "Start a turn from a background job", "Calls and background work after the user interrupts a turn" |
| File reads and writes | `$.fs.read`, `$.fs.write`, `$.fs.exists`, `$.fs.stat`, `$.fs.list` (`isLink`) | `build/use-the-mods-api.md`, "Reach files, processes, and the network"; `reference.md`, "Mods API methods" |
| Dialogs, git, chmod | `$.process.run([...])` | Same section; `reference.md`, "Limits" |
| Tests | `claude-code/testing`, stubs, `$.ui.mount` | `test-and-troubleshoot/test.md` |

## Owner decisions

Decided:

- Q8. blindfold writes the env file.
- Q9. `envFiles` defaults to `.env`. If no listed file exists, the first save asks which file to use.
- Q10. Entry on macOS, Linux, and Windows with `inputMethod` default `auto`: native dialog, terminal field as fallback.
- Q11. Mod name `blindfold`, command `/secrets`.
- Q12. `saveToEnvFile` has the values `ask` (default), `always`, and `never`.
- Q13. The first release is tested on macOS only. Linux and Windows code ships, and the README states that it is not tested. Gates G1 and G3 run on macOS only.

No decision is open.
