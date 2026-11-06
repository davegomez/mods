# Capability Map: blindfold (Slice 1)

Source: `docs/ideas/secret-mod/design.md`. Status: accepted 2026-11-05 (the owner answered Q13 and changed nothing in the map).

| Module id | Responsibility | Design section | Depends on |
|---|---|---|---|
| detect | Pure detectors: exact-match set with base64, URL, and hex forms, private key blocks, vendor prefixes, context rules with entropy floor. Bounded scan of strings and object keys and values. Marker rules. | 1a (detectors), P1 | none |
| dotenv | Pure dotenv dialect: parse, serialize, replace one `NAME=` line, keep other lines, round-trip check, name validation, refuse values the dialect cannot hold. | G4 | none |
| enroll | `envFiles` setting, path rules (inside root, no symlink), reads, lifecycle events, Stale state, Forget, feed of the exact-match set. | 1b | dotenv, detect |
| shield | Hooks on the 11 text paths, `.catch` that withholds or refuses, budget checks, degraded states, toasts. | 1a, 1g, P2, P5 | detect, enroll |
| request | `request_secret` tool, name and reason validation, request state machine, Continue with one `$.prompt.submit`. | 1c | enroll |
| entry | `inputMethod` setting, native dialog per platform with fixed source, terminal field with its own mask. Returns a value or a cancel. | 1e, G1, G2 | none |
| write | `saveToEnvFile` write order: path checks, `.gitignore`, create, `chmod 600`, change check, write, read back. File choice when no listed file exists. | 1f, 1b (no file), G3 | dotenv, enroll |
| ui | `/secrets` command and subcommands, pane inventory, band, status line, the `ask` question, accessibility. Connects request, entry, and write. | 1c (display), 1d, 1h | enroll, request, entry, write |

Build order:

1. detect, dotenv (in parallel)
2. enroll
3. shield. Milestone: a shield-only build that a user can load and test.
4. request, entry, write (in parallel)
5. ui. Milestone: Slice 1 complete, gates G1 to G4 run.

Each module gets its own spec, `docs/specs/blindfold/SPEC-<module-id>.md`, written in this order after the map is approved.

## Notes for later module specs

- shield: pass on only data that was scanned. A `clean` result holds no copy, so `shield` first makes a plain copy (for example a JSON round trip), scans that copy, and passes on that copy or the `found` copy. A proxy or getter can give different data on a later read (review findings F17, F18).
- shield: chains such as `"pwd=&".repeat(…)` that fill 2 MiB scan in about 800 ms, close to the 1 s budget. The deadline returns `deadline`, so `shield` withholds. Measure this again with the real hook budget.
