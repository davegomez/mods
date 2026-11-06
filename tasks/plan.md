# Implementation Plan: blindfold, step 1 (`detect` and `dotenv`)

## Overview

Build the 2 pure modules that every other blindfold module needs: `detect` (find and mark secrets) and `dotenv` (read and change env file text). Specs: `docs/specs/blindfold/SPEC-detect.md` and `SPEC-dotenv.md`. Map: `docs/specs/blindfold/capability-map.md`. The mod does nothing visible after this step. It has no hooks yet, so it is not added to `.claude-plugin/marketplace.json`.

## Architecture decisions

- The mod lives in `blindfold/` with the same layout as `ember` (S1). Version `0.1.0`.
- No runtime dependencies. 1 dev dependency, `dotenv`, pinned, in a private root `package.json` (Q16).
- Both modules are pure. `detect` gets its clock as an argument, so tests do not wait.
- Fake secrets are built at test run time (`tests/fakes.ts`), so the repository never holds a full token shape.
- Tasks run in sequence with 1 `worker-high` per task group. The 2 modules are in separate files, but `claude plugin test` runs all tests, so parallel work makes failures hard to read.

## Task list

Tasks with full criteria: `tasks/todo.md`.

### Phase 1: foundation

- [x] T1. Make the empty mod and confirm the tools run.
- [x] T2. Add the `dotenv` dev dependency and the script that saves its results (Q16, O3). A test cannot import `dotenv` (found in the first try).

### Checkpoint A: foundation

### Phase 2: `detect`

- [ ] T3. Markers and the known-value set.
- [ ] T4. Text scan with overlap rules, private keys, and vendor prefixes.
- [ ] T5. Context rules.
- [ ] T6. Value scan, limits, and the speed test.

### Checkpoint B: `detect` done

### Phase 3: `dotenv`

- [ ] T7. Parser.
- [ ] T8. Writer and the cross-check against `dotenv`.

### Checkpoint C: step 1 done

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `claude plugin test` cannot import from the root `node_modules` | Confirmed in T2 | Option O3: a script saves the real `dotenv` results to a generated test file. |
| The R9 speed test fails at 2 Mi characters and 100 values | Medium: Q15 limit changes | T6 reports the time. A lower limit is a spec change that the owner approves. |
| The vendor formats in `SPEC-detect.md` R5 are wrong | Medium: missed keys or false hits | The worker checks each one against vendor docs and lists the source in the report. Unconfirmed formats stay out. |
| The generated types in `blindfold/.claude-plugin/types/` exist only after an interactive `--plugin-dir` load | Low: no editor type check | T1 copies the `ember` tsconfig pattern. The owner runs `claude --plugin-dir ./blindfold` once if the types are missing. |
| The `secret-box` code is open in the earlier temp folder | Low: copied code | The worker prompt forbids reading it. |

## Open questions

None.
