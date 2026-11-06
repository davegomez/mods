# Spec: blindfold `dotenv`

Module id: `dotenv`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, gate G4 and section 1f.

## Objective

`dotenv` reads and changes the text of an env file in 1 documented dialect. It is pure: text in, data or text out. `enroll` uses `parse` to learn values. `write` uses `setValue` to make the new file text.

The dialect is the one of the `dotenv` npm package (motdotla/dotenv, version 16), because most Node apps load env files with it or with a loader that follows it. Other loaders (Bun, Vite, Next.js, python-dotenv, Docker Compose) are UNVERIFIED. The README lists them as not tested.

Success: `parse(setValue(text, name, value).text)` gives `value` for `name` and the same values as before for all other names, for every fixture.

### Public interface

```ts
export type Entry = { name: string; value: string; start: number; end: number }; // character span of the full entry
export type Parsed = { entries: Entry[]; badLines: number[]; duplicates: string[] };
export type SetResult =
	| { ok: true; text: string }
	| { ok: false; reason: "bad-name" | "unsafe-value" | "duplicate-name" | "too-large" };

export function parse(text: string): Parsed | { tooLarge: true };
export function setValue(text: string, name: string, value: string): SetResult;
export function isValidName(name: string): boolean;
export const MAX_FILE_CHARS: number; // 1_048_576
```

### Requirements

R1. Parse. Follow the dotenv 16 rules:

- optional leading `export `,
- name `[\w.-]+`, then `=` or `: ` with optional spaces around it,
- a value in single quotes is literal,
- a value in double quotes turns `\n` into a newline and `\r` into a carriage return,
- a value in backticks is literal,
- a value in quotes can span lines,
- an unquoted value ends at `#` that follows whitespace, and is trimmed,
- an empty value is `""`,
- a line that starts with `#`, or holds only whitespace, is skipped.

A line that matches none of these goes into `badLines` as a 1-based line number. `badLines` never holds line text, because the text can hold a secret.

R2. Duplicates. When a name shows more than once, `entries` holds every occurrence and `duplicates` holds the name. `enroll` adds every value to the exact-match set.

R3. Size. Text longer than `MAX_FILE_CHARS` returns `{ tooLarge: true }`. `enroll` then marks the file Stale.

R4. Names for writing. `isValidName` accepts `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, the same rule as `request_secret`.

R5. Serialize. `setValue` writes 1 of 2 forms, and refuses all other values with `unsafe-value`:

| Value | Form |
|---|---|
| no `'`, no newline, no carriage return | `NAME='value'` |
| holds `'` or a newline, and no `"`, `\`, `$`, backtick, or carriage return (for example a PEM key, or `it'sMyPass9`) | `NAME="value"`, each newline written as `\n` (Q21) |

A value with a control character other than tab and newline, or an empty value, also returns `unsafe-value`. The pane tells the user to add such a value in their editor.

R6. Replace and append.

- `bad-name` if `isValidName(name)` is false.
- `duplicate-name` if the name shows more than once. blindfold does not guess which line the app uses.
- If the name shows once, replace the full span of that entry (all lines of a quoted value). Keep the `export ` prefix if it was there.
- If the name is not there, append the entry. Add a line break before it if the text does not end with one.
- Keep all other characters unchanged: comments, blank lines, other entries, a byte order mark, and the line endings. If the text uses CRLF, the new entry ends with CRLF.

R7. Round trip. `setValue` parses its own output before it returns. If the new value or any other value differs, it returns `unsafe-value`. This is the pure part of step 6 in design section 1f.

R8. No leak. No error, `reason`, or `badLines` entry holds a value or line text.

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`. Files: `blindfold/hooks/dotenv.ts` and `blindfold/tests/dotenv.test.ts`.

## Testing strategy

- Test first.
- A fixture table for R1: each dialect rule with its input text and the expected entries.
- A round-trip table for R5 to R7: for each value below, set it in each base file, then parse and compare all entries.
  - Values: plain, with `$`, with `#`, with `"`, with a backslash, with `=`, with spaces at both ends, with a tab, unicode, a PEM-like multiline value, 4096 characters.
  - Base files: empty, no final line break, CRLF, a byte order mark, comments, `export` entries, a multiline entry with the same name, the name present once.
- Refusal tests: a `'` together with `"`, `\`, `$`, or a backtick, a carriage return, a NUL, an empty value, a duplicate name, a bad name, text above `MAX_FILE_CHARS`.
- A test that no `reason` and no `badLines` entry holds the fake value.

## Boundaries

- Always: keep `dotenv.ts` pure. Write the failing test first.
- Ask first: a second dialect, a new value form, any dev dependency other than `dotenv` (Q16).
- Never: write variable expansion, guess at a line in `badLines`, put line text in a result.

## Success criteria

- `claude plugin test`, `claude plugin validate --strict .`, and Biome pass with no warnings.
- Every requirement R1 to R8 has a test that names it.
- Every round-trip pair passes, and every refusal case returns the expected `reason`.

## Decisions

- Q16. Compare our parser with the real `dotenv` package through saved expected results (option O3). `claude plugin test` cannot import a package: test files import only relative paths and `claude-code` (checked in T2).
  - `dotenv` is a dev dependency in a private root `package.json`, pinned at 16.6.1, with `bun.lock`. It never ships with the mod.
  - The cases (inputs only) live in `blindfold/tests/dotenv-cases.ts`, with no imports.
  - The script `scripts/dotenv-expected.ts` imports the cases and `blindfold/hooks/dotenv.ts` by relative path. It runs the real `dotenv.parse` on each parse input and on each `setValue` output. It writes `blindfold/tests/dotenv-expected.ts`, a generated file that passes Biome and starts with a "do not edit" line.
  - `blindfold/tests/dotenv.test.ts` checks that our `parse` and `setValue` give the saved results.
  - Run `bun install` and `bun scripts/dotenv-expected.ts` after any change to the cases or to `setValue`, and commit the new file.
- Q21. A value with `'` and no newline uses the double-quoted form when it has no `"`, `\`, `$`, or backtick.
