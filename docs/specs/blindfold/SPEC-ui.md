# Spec: blindfold `ui`

Module id: `ui`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, sections 1b ("No listed file exists"), 1c (display), 1d, 1f (the question), 1g, 1h, gates G1 to G3. Depends on `enroll`, `request`, `entry`, `write`.

API facts come from the Claude Code 2.1.318 declarations (`d.ts:N`) and `docs/mods/`. Decisions in this spec were made by the agent (owner delegated 2026-11-06).

## Objective

`ui` shows the state of the env files and the open request, and it connects the user's choice to `entry` and `write`. The band, the status line, the pane, and the `/secrets` command each lead to the same actions, so no single surface is the only way.

Success: when Claude calls `request_secret`, the user sees the request, enters the value in a native dialog, sees the name as Set, presses Continue, and Claude goes on. Every state reads in words.

### Module shape

```ts
// Pure:
export type Row = { name: string; file: string; state: "Set" | "Requested" | "Empty" | "Missing" | "Stale" | "Refused"; gitWarning?: "not-ignored" | "tracked"; rewrites: number };
export function rowsOf(status: Status, request: Request | undefined, counts: ReadonlyMap<string, number>, git: ReadonlyMap<string, GitState>): Row[]; // R4
export function parseCommand(args: string): Command;                 // R1
export function statusLine(status: Status, request: Request | undefined): string | undefined; // R3
// Thin: the hooks for command.run, ui.render (Pane and AbovePrompt), and the flow in R5.
```

### Requirements

R1. Command. At `session.start`, `$.command.register({ name: "secrets", description, argumentHint: "[set NAME | add NAME | dismiss | refresh]" })` (`d.ts:3234`). A `command.run` hook with the matcher `{ command: "secrets" }` parses `e.args`:

- empty: open the pane (R4),
- `set NAME`: start the flow in R5 for `NAME`,
- `add NAME`: show the line to add by hand (R5, `never`),
- `dismiss`: clear the open request,
- `refresh`: `load` with the current list.

`NAME` must pass `request.validName`. Any other argument is refused with the toast "blindfold: /secrets takes a name, never a value." and nothing else happens, because the command line is stored in the transcript (Q39).

R2. Band. While a request is open, a `ui.render` hook on `{ component: "AbovePrompt" }` adds 1 line to the tree that `next` returns (the band is shared with other mods): "Claude asks for NAME: <reason>." and buttons with hotkeys (`d.ts:1093`). Pending: `1` Enter it (or Save it, per R5), `2` Add it myself, `3` Dismiss. Ready: `4` Continue, `3` Dismiss. The reason is drawn as plain `Text` (request R2). When the request opens, `$.ui.toast("blindfold: Claude asks for NAME. Run /secrets or use the band.")`.

R3. Status line. `$.ui.status(statusLine(...))` after each load and each request change (`d.ts:2506`). A degraded shield comes first: "blindfold: degraded, <file> could not be read. New values may not be hidden." Then an open request: "blindfold: NAME requested, run /secrets". Otherwise `undefined`. A stale file never reads as Set (design 1g).

R4. Pane. `/secrets` calls `$.ui.open({ id: "blindfold", title: "blindfold" })` and a `ui.render` hook on `{ component: "Pane" }` with `e.requestId === "blindfold"` draws:

- 1 row per name in each listed file, and the requested name when it is in no file: the name, the file, the state in words, a git warning in words, and the count of results the shield rewrote for that name in this session. No value and no value length.
- Per row: Enter value (R5), and Dismiss for the requested row. Per file: Forget (`enrollment.forget`), and Refresh.
- Hotkeys only where they work (1h), the same actions as R1.
- `e.props.bodyColumns` below 60: 1 column.

The git state per file comes from the `write` R3 commands (read-only: `rev-parse`, `ls-files`, `check-ignore`), run after each load, never during a render. The shield counts rewrites per known name in memory (a number per name, design 1d). This needs 1 change in `shield`: a hit of kind `known` adds 1 to the count of its name.

R5. The flow for 1 name.

1. Target file: the first listed file that is active. When none is active, and only after the first status has loaded (F34), ask which file to use: `.env`, `.env.local`, or a typed name in an `Input` (a file name is not secret). The choice goes through `enroll.addFile`. A `refused` or `denied` result shows its reason and stops.
2. `saveToEnvFile` (write R1): `ask` shows `1` Enter it here (blindfold saves it to FILE), `2` Add it myself, `3` Dismiss. `always` goes to step 3. `never` and choice `2` show "Add NAME= to FILE in your editor, then press Refresh." and stop.
3. Entry: `entry.pickMethod` and `entry.enterNative`. A `cancel` stops, and the request stays open (design 1g). `unavailable` shows the text from `never`.
4. Save: `write.saveValue`. A failure shows "Not saved: step <step>, <reason>." and names no value. A `mode-repaired` warning shows "Saved. The file was readable by others for a moment." Then `load`, and `request` moves to ready.
5. Continue: the band or the pane calls `request.continueRequest`.

1 flow runs at a time. A 2nd start while a flow runs shows "blindfold is already asking for a value." The value exists only inside steps 3 and 4 and is never stored in module state, a render prop, `$.state`, or `$.store` (entry R4).

R6. Accessibility (design 1h). Every state in words, never color alone, no dim text for a security fact. Stable `key` on each `Button` and `Input`. No timed instruction. A toast is never the only signal: the pane and the status line hold every state.

R7. No leak. No row, prop, toast, status line, or log holds a value or its length.

### Not in scope

The terminal field (Q35, off until G2). A pane on platforms other than the terminal (VS Code buttons have no hotkeys: labels stand alone, design 1h). Removing a value from a file.

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`, with the 4 commands. Files: `blindfold/hooks/ui.ts`, `blindfold/tests/ui.test.ts`, `blindfold/hooks/register.ts`, and `blindfold/hooks/shield.ts` (the counts).

## Testing strategy

- Pure tests: `parseCommand` for each form and each refusal, `rowsOf` for each state, `statusLine` order.
- Hook tests with `fakeApi`: the band adds to the tree from `next` and keeps the other mods' children, the pane renders at 59 and 60 columns, the flow with a fake `entry` and `write` for each branch in R5, 1 flow at a time.
- R7: the JSON text of every rendered tree, toast, and status line holds no fake value.

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
