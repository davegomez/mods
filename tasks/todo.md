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

