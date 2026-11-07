# Spec: blindfold `ui`

Module id: `ui`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, sections 1b ("No listed file exists"), 1c (display), 1d, 1f (the question), 1g, 1h, gates G1 to G3. Depends on `enroll`, `request`, `entry`, `write`.

API facts come from the Claude Code 2.1.318 declarations (`d.ts:N`) and `docs/mods/`. Decisions in this spec were made by the agent (owner delegated 2026-11-06).

## Objective

`ui` shows the state of the env files and the open request, and it connects the user's choice to `entry` and `write`. The band, the status line, the pane, and the `/secrets` command each lead to the same actions, so no single surface is the only way.

Success: when Claude calls `request_secret`, the user sees the request, enters the value in a native dialog, sees the name as Set, presses Continue, and Claude goes on. Every state reads in words.

### Module shape

```ts
// Pure:
export type Row = { name: string; file: string; state: "Set" | "Requested" | "Empty" | "Missing" | "Stale" | "Refused"; hidden: boolean; gitWarning?: "not-ignored" | "tracked"; rewrites: number };
export function rowsOf(status: Status, request: Request | undefined, counts: ReadonlyMap<string, number>, git: ReadonlyMap<string, GitState>): Row[]; // R4
export function parseCommand(args: string): Command;                 // R1
export function canonicalArgs(command: Command): string;             // R1, F64
export function statusLine(status: Status, request: Request | undefined, outcome: Outcome | undefined): string | undefined; // R3, F74
// Thin: the hooks for command.run, ui.render (Pane and AbovePrompt), and the flow in R5.
```

### Requirements

R1. Command. At `session.start`, `$.command.register({ name: "secrets", description, argumentHint: "[set NAME | add NAME | dismiss | refresh]" })` (`d.ts:3234`). A `command.run` hook with the matcher `{ command: "secrets" }` parses `e.args`:

- empty: open the pane (R4),
- `set NAME`: start the flow in R5 for `NAME`,
- `add NAME`: show the line to add by hand (R5, `never`),
- `dismiss`: clear the open request,
- `refresh`: `load` with the current list.

`NAME` must pass `request.validName`, and `NAME` with a known-value hit from `detect` is refused (F64). Any other argument is refused, because the command line is stored in the transcript (Q39). A refusal shows the toast "blindfold: /secrets takes a name, never a value." and the same text as the command's own `{ text }` answer, so it is not only a toast (F74).

The hook rewrites `e.args` to `canonicalArgs(command)` before anything else: the parsed form (`set NAME`) or `""` for a refusal. It passes that through `next({ ...e, args })`, then answers with its own `{ text }`. The declarations name `command.run` as the place to mask arguments (`d.ts:9741`). Whether the stored command line then holds only the canonical form is checked live in G2. A value that the shield does not know and that passes as a name cannot be told from a name. The README states this limit (F64).

R2. Band. While a request is open and `e.props.hasSurvey` is false (`d.ts:11064`, F72), a `ui.render` hook on `{ component: "AbovePrompt" }` adds 1 line to the tree that `next` returns (the band is shared with other mods): "Claude asks for NAME: <reason>." and buttons with hotkeys (`d.ts:1093`). Pending: `1` Enter it (or Save it, per R5), `2` Add it myself, `3` Dismiss. Ready: `4` Continue, `3` Dismiss. The reason is drawn as plain `Text`, after the request R2 scan (F65). While `hasSurvey` is true, the hook returns `next(e)` unchanged, and the pane and the status line still show the request. When the request opens, `$.ui.toast("blindfold: Claude asks for NAME. Run /secrets or use the band.")`.

R3. Status line. `$.ui.status(statusLine(...))` after each load, each request change, and each flow outcome (`d.ts:2506`). The order:

1. A degraded shield: "blindfold: degraded, <file> could not be read. New values may not be hidden."
2. A failed flow outcome (F74): "blindfold: NAME not saved, run /secrets".
3. An open request: "blindfold: NAME requested, run /secrets".
4. Otherwise `undefined`.

A stale file never reads as Set (design 1g). The outcome is 1 fixed, value-free text per R5 result, kept in module state until the next flow, a Dismiss, or a session end. The pane shows it too.

Redraw (F71). The host does not see module state. After each load, request change, flow outcome, and count change, call `$.ui.invalidate("ui.render")` (`d.ts:2398`). The host limits the rate.

R4. Pane. `/secrets` calls `$.ui.open({ id: "blindfold", title: "blindfold" })` and a `ui.render` hook on `{ component: "Pane" }` with `e.requestId === "blindfold"` draws:

- 1 row per name in each listed file, and the requested name when it is in no file: the name, the file, the state in words, a git warning in words, and the count of results the shield rewrote for that name in this session. No value and no value length.
- A row whose name or file `enroll` shows as `[hidden name]` or `[hidden path]` has `hidden: true`. It shows "hidden, because it holds a secret value" and has no action, because the hidden text is not an identity (F73).
- The last flow outcome (R3).
- Per row: Enter value (R5), and Dismiss for the requested row. Per file: Forget (`enrollment.forget`), and Refresh.
- Hotkeys only where they work (1h), the same actions as R1.
- `e.props.bodyColumns` below 60: 1 column.

The git state per file comes from the `write` R3 commands (read-only: `rev-parse`, `ls-files`, `check-ignore`), run after each load, never during a render. The shield counts rewrites per known name in memory (a number per name, design 1d). This needs 1 change in `shield`: when a tool result is rewritten, each distinct name with a `known` hit in it adds 1 to its count. A scan with no rewrite, and a 2nd hit of the same name in the same result, add nothing (F75).

R5. The flow for 1 name.

1. Target file: the first listed file that is active, else the first listed file that is missing (`write` creates it). Only when no listed file can take the value, and only after the first status has loaded (F34), ask which file to use: `.env` or `.env.local`. There is no typed file name, because typed text can hold a value (F66, Q41). The choice goes through `enroll.addFile`. `refused` shows "blindfold cannot use FILE: it is outside the project, a link, or not a regular file." `denied` shows "The env file setting was not saved." (F69). `added` changes a setting, which reloads the module and clears the request (request R4). The flow then stops with "FILE added. Run /secrets set NAME, or ask Claude again." (F68, Q42).
2. `saveToEnvFile` (write R1): `ask` shows `1` Enter it here (blindfold saves it to FILE), `2` Add it myself, `3` Dismiss. `always` goes to step 3. `never` and choice `2` show "Add NAME= to FILE in your editor, then press Refresh." and stop.
3. Entry: `entry.pickMethod`, then `entry.enterNative`. The route `unavailable`, and a result `{ kind: "cancel", why: "unavailable" }`, show the text from `never` and stop. Check them before the other cancels (F70). Any other cancel stops, and the request stays open (design 1g).
4. Save: `write.saveValue`. A failure shows "Not saved: step <step>, <reason>." and names no value. A `mode-repaired` warning shows "Saved. The file was readable by others for a moment." Then `load`, and `request` moves to ready.
5. Continue: the band or the pane calls `request.continueRequest`.

A new flow clears the last outcome when it starts (F81). 1 flow runs at a time. A 2nd start while a flow runs shows "blindfold is already asking for a value." The value exists only inside steps 3 and 4 and is never stored in module state, a render prop, `$.state`, or `$.store` (entry R4).

Invalidation (F67). A flow takes the request epoch (`requests.epoch()`, request R4) and the request id when it starts. After entry returns, and before `saveValue`, it stops when the epoch changed, the request id changed, or the session ended. The value is then dropped, and the outcome is "Not saved: the request was cleared." After `saveValue`, the same check decides whether the flow updates the request or the outcome. Every exit after an await checks the fence before it sets an outcome: the unavailable cancel, an error, and the file choice (F79).

Buttons for a request (F80). Each request button carries the id of the request it was drawn for. Its handler does nothing when the open request has another id, and Continue consumes only that id (request R5). The band checks the request again after its awaited `next(e)`. A session end during `saveValue` can still let `write` learn and load, which only adds masking. The README does not need to state this.

R6. Accessibility (design 1h). Every state in words, never color alone, no dim text for a security fact. Stable `key` on each `Button` and `Input`. No timed instruction. A toast is never the only signal: the pane and the status line hold every state.

R7. No leak. No row, prop, button key, toast, status line, command answer, outcome, rewrite count key, or log holds a value or its length. The request reason and name are scanned first (request R2, F65). A file name is never typed (F66).

A value learned later can turn safe text into a secret (F77). After each load, scan the open request and the outcome again with the current known values: a hit in the reason replaces it with the request R2 text, a hit in the name clears the request, and a hit in the outcome name clears the outcome. A row is never built again from a name that the status hides. The shield counts no name that holds a known value (F78).

### Not in scope

The terminal field (Q35, off until G2). A pane on platforms other than the terminal (VS Code buttons have no hotkeys: labels stand alone, design 1h). Removing a value from a file.

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`, with the 4 commands. Files: `blindfold/hooks/ui.ts`, `blindfold/tests/ui.test.ts`, `blindfold/hooks/register.ts`, and `blindfold/hooks/shield.ts` (the counts).

## Testing strategy

- Pure tests: `parseCommand` for each form and each refusal, `rowsOf` for each state, `statusLine` order.
- Hook tests with `fakeApi`: the band adds to the tree from `next` and keeps the other mods' children, the pane renders at 59 and 60 columns, the flow with a fake `entry` and `write` for each branch in R5, 1 flow at a time.
- R7 (F76): 2 fake values of different lengths. The JSON text of every rendered tree, toast, status line, and command answer holds neither value, and is the same for both values. `$.state` and `$.store` writes are recorded and hold neither value.
- F67: a Dismiss, a user prompt, and a session end during entry each stop the flow before `saveValue`.

## Boundaries

- Always: the same action on every surface. Words for every state.
- Ask first: nothing; the owner delegated decisions. Record each in Decisions.
- Never: a value in the command line, a render prop, or module state. A git command during a render.

## Success criteria

- The 4 commands pass. Every requirement R1 to R7 has a test that names it.
- Milestone 5 live run on macOS (the owner types in the dialog once):
  - G1: the dialog, masking, cancel, a value with spaces, quotes, `$`, and non-ASCII text.
  - G2: the fake value is not in the transcript file or the debug log. The tool `mcp__blindfold__request_secret` is there, also after `/clear` (F58).
  - G3: a save into a scratch git repository: `.gitignore`, mode `600`, and whether `$.fs.write` keeps the mode (F49).

## Decisions

- Q39. `/secrets` takes a name or nothing. Any other argument is refused with a toast, because the command line is stored in the transcript and a value there is not yet known to the shield. Accepted (agent decision).
- Q40. The status line shows a degraded shield before an open request, because a degraded shield is the larger risk. Accepted (agent decision).
- Q41. The file choice offers only `.env` and `.env.local`. Another file goes in the `envFiles` setting. Typed text can hold a value, and a file name goes into the setting and into instructions (F66). This replaces the typed name in write R11 and Q9. Accepted (agent decision).
- Q42. A missing listed file is a valid target, so the file choice is needed only when no listed file can take a value. Adding a file reloads the module, so the flow stops there and does not try to carry the request across the reload (F68). Accepted (agent decision).
- Q43. With `saveToEnvFile` set to `ask`, the band's buttons are the question: `1` reads "Enter it here (blindfold saves it to FILE)", with `2` Add it myself and `3` Dismiss. An explicit `/secrets set NAME`, or the pane's Enter value, is the answer "Enter it", so the flow asks nothing more and goes to entry. A 2nd question after the user already chose to enter the value would only add a step. Accepted (agent decision).
- Pi review F64 to F76 (`reviews/ui-spec-pi.md`) are applied in R1 to R7 and the testing strategy. Accepted (agent decision).
- Q44. When no listed file can take a value, the flow keeps the outcome `choose` with the name, and the pane and the band show `.env` and `.env.local` for that name. Without it, `/secrets set NAME` with no open request has no place to keep the name. Accepted (agent decision).
- Pi review F77 to F82 (`reviews/ui-code-pi.md`) are applied in R5 and R7. Accepted (agent decision).
