# Spec: blindfold `enroll`

Module id: `enroll`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, section 1b. Depends on `dotenv` (`parse`) and `detect` (`buildKnownSet`, `scanText`).

## Objective

`enroll` knows which env files the user listed, reads them, and keeps the known-value set that `shield` uses. It also gives `ui` and `request` the state of each file and each name. It holds secret values in module memory only.

Success: after `session.start`, every secret-like value in every listed file that exists is in the known-value set. A file that cannot be read is never shown as protected. No value leaves module memory.

### Module shape

`enroll.ts` has a pure part and a thin part that calls `$`. `register.ts` owns all hooks (an event can have only 1 hook without a matcher in a mod, `build/react-to-events.md`) and calls these functions:

```ts
export type FileState =
	| { kind: "active"; names: NameState[] }
	| { kind: "missing" }
	| { kind: "stale"; reason: "read-failed" | "too-large" | "not-a-file" }
	| { kind: "refused"; reason: "absolute" | "parent" | "outside-root" | "symlink" | "bad-path" | "too-many" };
export type NameState = { name: string; hidden: boolean; why?: "too-short" | "not-secret" };
export type Status = { files: { path: string; state: FileState }[]; shield: "active" | "degraded" };

export function createEnrollment(): Enrollment; // 1 per module instance
// Functions, because the host refuses `$` passed to a method:
load($, enrollment, list: string): Promise<Status>;       // read every listed file again
refreshIfNamed($, enrollment, input: unknown): Promise<void>; // load again if input names a listed file
addFile($, enrollment, path: string): Promise<"added" | "refused" | "denied">; // Q9 file choice
// Enrollment (no `$`):
learn(path: string, name: string, value: string): void; // a value blindfold wrote to `path` (from `write`)
forget(path: string): void;                   // drop the values of 1 file
drop(): void;                                 // drop every value (session end)
knownSet(): KnownSet;                         // for `shield`
status(): Status;                             // for `ui` and `request`
```

### Requirements

R1. The list. The `userConfig` field `envFiles` is a string, default `.env`: paths separated by commas, relative to the session root (`$.session.root()`, not the working directory). `load` trims each entry and drops empty ones and repeats. More than 10 entries: the rest are `refused` with `too-many`.

R2. Path rules, before any read. An entry is `refused` if it:

- is absolute, starts with `~`, has a drive letter, starts with `\\` or `//`, or holds a NUL (`absolute` or `bad-path`),
- has a `..` segment (`parent`),
- is a symbolic link itself (`$.fs.stat(path, { resolve: true }).isLink`, `symlink`),
- has a `realPath` outside the real session root (`outside-root`). The root is resolved the same way, and the check is `realPath.startsWith(realRoot + SEP)`. Only `SEP` is trimmed from the end of the real root, so a POSIX folder name that ends in `\` stays intact.

A missing file is `missing`, not an error. A path that is not a regular file is `stale` with `not-a-file`.

After the read, `load` runs the same checks on the path again. If the path is now a link, its `realPath` changed, it is not a regular file, or it left the root, the text is dropped and the file is `stale` with `read-failed`. Known limit (Q25): a swap between that second `stat` and the read it guards can still go unseen, because `$.fs` has no read that refuses to follow a link.

R3. Reads. Read each accepted file with `$.fs.read` after a `stat` shows it is 1 MiB or smaller. Larger: `stale` with `too-large`. A read that rejects: `stale` with `read-failed`. Parse with `dotenv.parse`. A `tooLarge` result is `stale` with `too-large`.

R4. Which values feed the known-value set. An entry feeds the set if:

- its name holds `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PWD`, `DSN`, `AUTH`, `CREDENTIAL`, or `PRIVATE` (any case), or
- `detect.scanText` finds a hit in its value (for example a `DATABASE_URL` with a password, or a vendor key under any name).

Every value from `learn` feeds the set, under the file it was written to, so `forget` on that file drops it too. A fed value under 8 characters is `hidden: false` with `why: "too-short"` (Q14). An entry that does not feed the set is `hidden: false` with `why: "not-secret"`.

R5. Values learned stay learned. The known-value set is the union of every value learned in this session, minus the values of files the user forgot. A value removed from a file stays in the set until `drop` or `forget`, because it can still show in later tool output.

R6. Shield state. `degraded` if any listed file is `stale` or `refused`. Otherwise `active`. A `stale` file never shows its names as hidden: its `names` are not shown, and its last values stay in the set as best effort.

R7. Lifecycle (wired in `register.ts`):

| Event | Call |
|---|---|
| `session.start` | `load` |
| `classic.SessionStart` with `source` `clear`, `resume`, or `fork` | `drop`, then `load` with the list in use before the drop (the one `session.end` dropped), not the list from `options` |
| `session.end` | `drop` |
| `tool.call` (via `shield`), before and after `next(e)` | `refreshIfNamed` with the tool input |
| `config.set` for `blindfold.envFiles`, after `next(e)` returns `{ value }` | `load` with the new value |
| the user presses Refresh (`ui`) | `load` |

`refreshIfNamed` loads again when the JSON text of the input holds a listed path or its base name. A load after the call matters most: it learns a value that the tool call itself wrote, before `shield` scans the result.

R8. Overlap. Each `load` takes a new generation number. It builds a new set and replaces the old one in 1 step, only if its generation is still the newest. `drop` and `forget` also take a new generation, so a load that is still running cannot add values after the session ended, or bring back a file the user forgot. `drop` also clears the list, so a `refreshIfNamed` after it reads nothing.

R9. Persist a file choice (Q9). `addFile` applies R2 to the path. A missing file is accepted, because `write` creates it, only when the nearest folder above it that exists is a folder whose `realPath` is the real root or under it. `addFile` calls run 1 at a time, and each reads the current list after its checks, so a concurrent add or load is not lost. It adds the path to `envFiles` with `$.config.set({ key: "blindfold.envFiles", value })`, and returns `denied` if the set call returns `{ deny }`. The key format `<plugin>.<field>` is confirmed by the type declarations of `ConfigSetInput.key`.

R10. No leak. Values live only in the `Enrollment` closure. No `Status`, error, log, `$.state`, `$.store`, or render prop holds a value. An error from `$.fs` is reduced to the reasons in `FileState`. A `Status` path or name in which the known-value set finds a value (for example a name that reuses a kept value) is shown as `[hidden path]` or `[hidden name]`; the name keeps its `hidden` flag.

### Not in scope

Writing files (`write`), drawing the state (`ui`), the hooks themselves (`shield`, `register.ts`), a recursive search for env files, other file formats, and a guard against other mods that change `blindfold.envFiles` (other mods are trusted code, design "Purpose and promise").

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`. Files: `blindfold/hooks/enroll.ts` and `blindfold/tests/enroll.test.ts`. `plugin.json` gets the `envFiles` field (type string, default `.env`, a title and a description in the style of `ember/.claude-plugin/plugin.json`).

## Testing strategy

- Test first, with `claude-code/testing` stubs for `$.fs.stat`, `$.fs.read`, `$.session.root`, and `$.config.set` (`test-and-troubleshoot/test.md`).
- Pure tests for R1, R2 (each refusal reason), R4, R5, R6, and the `refreshIfNamed` name check.
- Stub tests for R3 (each `stale` reason), R7 order, R8 (a slow load that ends after `drop` adds nothing), R9.
- R10: build a status after each test and check that no fake value is in its JSON text.

## Boundaries

- Always: resolve paths against the session root. Apply R2 before every read. Write the failing test first.
- Ask first: a new name word in R4, a change to the 10-file or 1 MiB limits, any persistence of values.
- Never: put a value in `$.state`, `$.store`, a status, an error, or a log. Read a file that R2 refuses. Follow a symbolic link.

## Success criteria

- `claude plugin test`, `claude plugin validate --strict .`, and Biome pass with no warnings.
- Every requirement R1 to R10 has a test that names it.
- `plugin.json` has the `envFiles` field, and `register.ts` wires the R7 events for `session.start`, `classic.SessionStart`, and `session.end`. `tool.call` and `config.set` wait for `shield` and `ui`.

## Decisions

- Q22. R4 also feeds a value that a detector flags, whatever its name. Some config values with high entropy can be hidden by mistake. Accepted.
- Q23. R5 keeps a value hidden after it is deleted from the file, until the session ends or the user forgets the file. Accepted.
- Q25. stat, read, stat again narrows the swap race but cannot close it, because $.fs has no no-follow read. Accepted.
- F46. A `userConfig` change reloads the plugin (`d.ts:10004`), and `session.start` does not fire again. If the reload makes a new module instance, the known-value set is empty until the next load. Fix: each guard hook in `shield` and the `request` tool call `load` first when this enrollment has never loaded (generation 0). Accepted (agent decision, owner delegated 2026-11-06).
- F56. A guard hook that runs while a `session.start` or restart load is still reading scans with the old set. Fix: the enrollment keeps the promise of its latest load, and `ensureLoaded` awaits it. Accepted (agent decision).
