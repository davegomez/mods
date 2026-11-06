# blindfold step 1: tasks

Plan: `tasks/plan.md`. Commands, run for every task:

```bash
cd blindfold && claude plugin test
cd blindfold && claude plugin validate --strict .
bunx @biomejs/biome@2.6.2 check .   # repository root, no errors, no warnings
```

## T1. Make the empty mod

Make `blindfold/` so that the 3 commands pass with 1 placeholder test.

- Acceptance:
  - [ ] `blindfold/.claude-plugin/plugin.json` has name `blindfold`, version `0.1.0`, a description, and author, like `ember`.
  - [ ] `blindfold/hooks/hooks.json` loads `./register.ts`, and `register.ts` exports a `register` that adds no hooks.
  - [ ] `blindfold/tsconfig.json` extends `./.claude-plugin/types/tsconfig.json`, like `ember`.
- Verify: the 3 commands pass.
- Files: `blindfold/.claude-plugin/plugin.json`, `blindfold/hooks/hooks.json`, `blindfold/hooks/register.ts`, `blindfold/tsconfig.json`, `blindfold/tests/smoke.test.ts`.
- Depends on: none. Size: S.

## T2. Add `dotenv` and the expected-results script (Q16, option O3)

The first try showed that `claude plugin test` cannot import `dotenv`. Keep `package.json`, `bun.lock`, and the `.gitignore` line.

- Acceptance:
  - [ ] `smoke.test.ts` has no `dotenv` import, and the T1 test passes again.
  - [ ] `blindfold/tests/dotenv-cases.ts` exports a parse case list with 1 case, `A=1`. No imports.
  - [ ] `bun scripts/dotenv-expected.ts` writes `blindfold/tests/dotenv-expected.ts` with the real `dotenv.parse` result for each case. The file starts with a "generated, do not edit" line and passes Biome.
  - [ ] A test checks that the generated file holds `{ A: "1" }` for the `A=1` case. (T7 replaces this with our parser.)
- Verify: the 3 commands pass. `bun scripts/dotenv-expected.ts` run a second time gives no diff.
- Files: `blindfold/tests/smoke.test.ts`, `blindfold/tests/dotenv-cases.ts`, `blindfold/tests/dotenv-expected.ts`, `scripts/dotenv-expected.ts`.
- Depends on: T1. Size: S.

## Checkpoint A

- [x] The 3 commands pass.
- [x] The main session reviews the diff.

## T3. Markers and the known-value set

`SPEC-detect.md` R1, R2, R10 for `buildKnownSet` and `marker`.

- Acceptance:
  - [x] All R2 forms are built, including the 3 base64 alignments, and a value inside a longer base64 string is found.
  - [x] Values under 8 characters go to `skipped` (Q14).
  - [x] `tests/fakes.ts` builds every fake token at run time.
- Verify: the 3 commands pass. Tests name R1, R2, R10.
- Files: `blindfold/hooks/detect.ts`, `blindfold/tests/detect.test.ts`, `blindfold/tests/fakes.ts`.
- Depends on: Checkpoint A. Size: M.

## T4. Text scan, private keys, vendor prefixes

`SPEC-detect.md` R3, R4, R5, and `scanText` without limits.

- Acceptance:
  - [x] Overlaps resolve as R3 says, with tests for equal spans and nested spans.
  - [x] Each R5 vendor format is confirmed against vendor docs, with the source in the report. An unconfirmed format is left out and named in the report.
  - [x] Each rule has hide and keep fixtures. The keep fixtures include UUIDs, git SHAs, integrity hashes, and CSS colors.
- Verify: the 3 commands pass. Tests name R3, R4, R5.
- Files: `blindfold/hooks/detect.ts`, `blindfold/tests/detect.test.ts`, `blindfold/tests/fakes.ts`.
- Depends on: T3. Size: M.

## T5. Context rules

`SPEC-detect.md` R6.

- Acceptance:
  - [x] `assign`, `auth-header`, and `url-userinfo` mark the value only.
  - [x] The entropy floor and the placeholder list keep `.env.example` lines unchanged.
  - [x] A scan of a scan output is `clean` (R1).
- Verify: the 3 commands pass. Tests name R6.
- Files: `blindfold/hooks/detect.ts`, `blindfold/tests/detect.test.ts`.
- Depends on: T4. Size: S.

## T6. Value scan, limits, speed

`SPEC-detect.md` R7, R8, R9, and the property test.

- Acceptance:
  - [x] `scanValue` scans keys and values, and returns `unsupported`, `cycle`, `too-deep`, `too-many-nodes`, `too-large`, and `deadline` where R7 and R8 say.
  - [x] The R9 test passes in less than 1 s and prints the time. If it fails, stop and report the time. Do not change `DEFAULT_LIMITS`.
  - [x] The property test (200 random values and positions) passes.
- Verify: the 3 commands pass. Tests name R7, R8, R9.
- Files: `blindfold/hooks/detect.ts`, `blindfold/tests/detect.test.ts`.
- Depends on: T5. Size: M.

## Checkpoint B

- [x] The 3 commands pass.
- [x] `detect.ts` has no `$`, no `Date.now`, and no I/O.
- [x] The main session reviews the diff, with a security review of R2, R3, R9, and R10.

## T7. Parser

`SPEC-dotenv.md` R1, R2, R3, R8 for `parse`.

- Acceptance:
  - [x] Each R1 rule has a fixture.
  - [x] `badLines` holds line numbers only. Duplicates are listed.
  - [x] Every R1 fixture is in `dotenv-cases.ts`, the script has run, and `parse` gives the saved `dotenv` result for each one.
- Verify: the 3 commands pass. Tests name R1, R2, R3, R8.
- Files: `blindfold/hooks/dotenv.ts`, `blindfold/tests/dotenv.test.ts`, `blindfold/tests/dotenv-cases.ts`, `blindfold/tests/dotenv-expected.ts`, `scripts/dotenv-expected.ts` (output path from `import.meta.dir`).
- Depends on: Checkpoint B. Size: M.

## T8. Writer

`SPEC-dotenv.md` R4 to R8 for `setValue` and `isValidName`.

- Acceptance:
  - [x] Every round-trip pair is in `dotenv-cases.ts`. The script runs the real `dotenv.parse` on each `setValue` output, and each saved result holds the new value and all other values unchanged.
  - [x] Every refusal case returns its `reason`, and no `reason` holds the value.
  - [x] Comments, blank lines, the byte order mark, `export`, and CRLF stay unchanged.
- Verify: the 3 commands pass. Tests name R4 to R8.
- Files: `blindfold/hooks/dotenv.ts`, `blindfold/tests/dotenv.test.ts`, `blindfold/tests/dotenv-cases.ts`, `blindfold/tests/dotenv-expected.ts`.
- Depends on: T7. Size: M.

## Checkpoint C

- [x] The 3 commands pass.
- [x] The main session reviews the diff.
- [x] The owner approves step 1. Next: `SPEC-enroll.md`.

## T9. `enroll` pure part

`SPEC-enroll.md` R1, R2 (spelling checks only), R4, R5, R6, R10, and the `refreshIfNamed` name check.

- Acceptance:
  - [x] The list rules (trim, empty, repeats, more than 10) and each spelling refusal (`absolute`, `bad-path`, `parent`) have tests.
  - [x] Feed rules: each name word, a detector hit under a plain name (Q22), the 8-character minimum, `not-secret`.
  - [x] Learned values stay after a load that no longer has them (Q23), and go after `forget` and `drop`.
- Verify: the 3 commands pass. Tests name R1, R2, R4, R5, R6, R10.
- Files: `blindfold/hooks/enroll.ts`, `blindfold/tests/enroll.test.ts`.
- Depends on: Checkpoint C. Size: M.

## T10. `enroll` reads and wiring

`SPEC-enroll.md` R2 (symlink and root checks through `$.fs.stat`), R3, R7 (`session.start`, `classic.SessionStart`, `session.end` only), R8, R9.

- Acceptance:
  - [x] Stub tests for each `stale` and `refused` reason that needs `$`, and for a load that ends after `drop`.
  - [x] `plugin.json` has the `envFiles` field, and `register.ts` wires the 3 lifecycle events to 1 module-level `Enrollment`.
  - [x] `addFile` returns `added`, `refused`, and `denied` in stub tests.
- Verify: the 3 commands pass. Tests name R2, R3, R7, R8, R9.
- Files: `blindfold/hooks/enroll.ts`, `blindfold/tests/enroll.test.ts`, `blindfold/hooks/register.ts`, `blindfold/tests/smoke.test.ts`, `blindfold/.claude-plugin/plugin.json`.
- Depends on: T9. Size: M.

## Checkpoint D

- [x] The 3 commands pass.
- [ ] Pi reviews `enroll.ts` in a herdr pane, and the findings are fixed.
- [ ] The owner approves step 2. Next: `SPEC-shield.md`.
