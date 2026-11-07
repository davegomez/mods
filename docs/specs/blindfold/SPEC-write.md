# Spec: blindfold `write`

Module id: `write`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, sections 1b ("No listed file exists") and 1f, gate G3. Depends on `dotenv` (`parse`, `setValue`, `isValidName`) and `enroll` (the path rules, `learn`, `load`, `addFile`).

API facts come from the Claude Code 2.1.318 declarations (`d.ts:N`) and `docs/mods/`.

## Objective

`write` saves 1 value under 1 name in 1 env file inside the session root. The order of steps keeps the value off disk until the file is ignored by git and has mode `600`. A failed step stops the write and names the step, never the value.

Success: after a save, the env file holds `NAME=value` in the dotenv dialect, all other lines are unchanged, git ignores the file, a new file has mode `600`, and the value is in the known-value set before the next tool result.

### Module shape

```ts
export type Step = "path" | "git" | "create" | "changed" | "value" | "write" | "verify" | "mode";
export type Saved = { ok: true; created: boolean; ignoredNow: boolean } | { ok: false; step: Step; reason: string };
export function saveValue($, enrollment, path: string, name: string, value: string): Promise<Saved>;
export type SaveMode = "ask" | "always" | "never";
```

### Requirements

R1. Setting. The `userConfig` field `saveToEnvFile` is a string with `options: ["ask", "always", "never"]`, default `ask` (Q8, Q12). `ui` reads it and asks before entry. `write` does not read it.

R2. Path, step `path`. Apply the `enroll` R2 rules to `path` right before the write: the spelling rules, then `stat` with `resolve`. Refuse a symbolic link, a real path outside the root, and a path that is not a regular file. A missing file is accepted only when its nearest existing folder is a folder at or under the real root (F33: run this check here again, not only in `addFile`). Read the current text (empty for a missing file) and keep it as `before`.

R3. Git, step `git`. Run git with `$.process.run`, with `cwd` the session root (git runs with repository hooks off, `d.ts:3649`):

- `git rev-parse --is-inside-work-tree`. A failure, or git that does not start, skips the git step (Q36).
- `git ls-files --error-unmatch -- <path>`. Exit code 0 means git tracks the file: refuse.
- `git check-ignore -q -- <path>`. Exit code 1 means not ignored: add the line `/<path>` to the root `.gitignore`. Apply the R2 rules to `.gitignore` first. Keep its other lines. Add a line ending before the new line when the file does not end with one. Run `check-ignore` again, and refuse if it still says not ignored.

R4. Create, step `create`. For a missing file: `$.fs.write(path, "")`, then `$.process.run(["chmod", "600", "--", <path>])`. Only the path goes in argv. A non-zero exit refuses. On Windows `chmod` does not run, and the README states that folder access rules apply.

R5. Change check, step `changed`. Read the file again. Stop when the text is not `before`.

R6. Value, step `value`. `dotenv.setValue(before, name, value)`. A refusal (`invalid-name`, `unsafe-value`, `too-large`, CRLF rules) stops with that reason.

R7. Write, step `write`. `$.fs.write(path, text)` with the new text. `$.fs.write` has no mode option and is not documented as atomic (`d.ts:3389`). The README states that a crash during this step can damage the file.

R8. Verify, step `verify`. Read the file again and parse it. The last entry for `name` must hold exactly `value`. Otherwise stop, and the name is not marked set.

R9. Mode, step `mode`. For a file that R4 created, read its mode with `stat -f %Lp` on macOS or `stat -c %a` on Linux. When it is not `600`, run `chmod` again, and return `ok` with a warning, because the value was on disk with a wider mode for a moment. This settles the design's UNVERIFIED question about `$.fs.write` and the mode (G3).

R10. Learn. After `verify`: `enrollment.learn(path, name, value)`, then `load` with the current list, so the status shows the name as set and `request` can move to ready.

R11. No file listed (Q9). When no listed file exists, `ui` asks which file to use: `.env`, `.env.local`, or a typed name. The choice goes through `addFile` (enroll R9). `ui` offers this only after the first status has loaded (F34).

R12. No leak. The value goes only to `setValue`, `$.fs.write`, and `learn`. A `Saved` result, an error, a toast, and a log hold the step and a fixed reason, never the value. A mod earlier in the hook chain sees the `fs.write` text (Q34).

### Not in scope

The question before entry, the file choice screen, and the result screen (`ui`). Entry (`entry`). Removing a value. A file outside the session root.

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`, with the 4 commands. Files: `blindfold/hooks/write.ts`, `blindfold/tests/write.test.ts`, and `blindfold/.claude-plugin/plugin.json` (the `saveToEnvFile` field).

## Testing strategy

- Stub tests with `fakeApi` and a fake `$.process.run` that records argv. Each step has a test for its refusal: a symbolic link, outside the root, a missing file under a linked folder (F33), a tracked file, an `.gitignore` that is a link, a changed file, an unsafe value, a failed verify, a wrong mode.
- The order: the fake records every call, and the test checks that `chmod` runs before the write that holds the value, and that git runs before any write.
- R12: no recorded argv, `env`, or `stdin` holds the fake value. No result holds it.

## Boundaries

- Always: run the steps in order. Stop at the first failure. Check the path again right before the write.
- Ask first: `chmod` on a file that already exists, a write outside the root, a change to the `.gitignore` line format.
- Never: put the value in argv. Write the value before `chmod` on a new file. Mark a name set before `verify`.

## Success criteria

- The 4 commands pass. Every requirement R1 to R12 has a test that names it.
- G3 on macOS (milestone 5, with the owner's approval): a real save into a scratch git repository, with the mode and `.gitignore` checked after it.

## Decisions

- Q36. Outside a git work tree, or when git does not start, the git step is skipped, because no commit can take the file. Proposed: accept.
