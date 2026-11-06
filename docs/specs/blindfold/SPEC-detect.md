# Spec: blindfold `detect`

Module id: `detect`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, sections 1a and P1.

## Objective

`detect` finds secrets in text and in JSON-like values, and returns a copy with inert markers. It is pure: no `$`, no file access, no clock except an injected one. `shield` uses it to rewrite or refuse. `enroll` uses it to build the exact-match set.

Users of this module are other modules, not people. Success: every rule has fixtures that it hides and fixtures that it keeps, a scan never returns a raw secret in any field except the input copy it did not change, and a scan above its limits says "unscannable" instead of a partial result.

### Public interface

```ts
export type Known = { name: string; value: string };
export type KnownSet; // opaque, built once per enrollment change
export type RuleId = "private-key" | "vendor:<id>" | "context:<id>"; // exact ids listed below
export type Hit = { kind: "known"; name: string } | { kind: "rule"; rule: RuleId };
export type Limits = { maxChars: number; maxDepth: number; maxNodes: number };
export type Clock = { now: () => number; deadline: number };

export type Scan<T> =
	| { status: "clean" }
	| { status: "found"; value: T; hits: Hit[] }
	| { status: "unscannable"; reason: "too-large" | "too-deep" | "too-many-nodes" | "unsupported" | "cycle" | "deadline" };

export function buildKnownSet(known: Known[]): { set: KnownSet; skipped: { name: string; reason: "too-short" }[] };
export function scanText(text: string, set: KnownSet, limits: Limits, clock: Clock): Scan<string>;
export function scanValue(value: unknown, set: KnownSet, limits: Limits, clock: Clock): Scan<unknown>;
export const DEFAULT_LIMITS: Limits;
```

`found.value` is a new copy. The input is never changed. `hits` holds names and rule ids only.

### Requirements

R1. Markers. A known value becomes `[secret: NAME]`. A rule hit becomes `[secret hidden]`. A scan of an output of `scanText` or `scanValue` returns `clean` (markers do not match any rule).

R2. Known values. `buildKnownSet` precomputes these forms of each value, and drops a form equal to another:

- the raw value (case-sensitive),
- the JSON string escape of the value,
- `encodeURIComponent` of the value,
- lowercase and uppercase hex of the UTF-8 bytes,
- base64, standard and URL-safe alphabet, for each of the 3 byte alignments (0, 1, 2 prefix bytes). For each alignment, keep only the characters that do not depend on the bytes before or after the value. This finds the value inside a longer base64 string, for example `Authorization: Basic base64(user:pass)`.

A value with fewer than 8 characters is not added. `buildKnownSet` returns it in `skipped`, so the pane can say "too short to hide" (Q14). When 2 names have the same value, the marker uses the first name in sort order.

R3. Match order. Collect all spans from all forms and rules. Where spans overlap, keep the longest, then the earliest. Known values come before rules for spans of equal length. Replace from right to left.

R4. Private keys. `-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----` up to and including the matching `-----END … PRIVATE KEY-----`. With no END line, mark to the end of the text. Rule id `private-key`.

R5. Vendor prefixes. Initial list, rule id `vendor:<id>`. Each entry is written for this mod and has fixtures. The exact lengths are UNVERIFIED and the implementer confirms each one against the vendor documentation before release.

| id | Shape |
|---|---|
| `github` | `gh[pousr]_` and 36 or more of `[A-Za-z0-9]`, or `github_pat_` and 22 or more of `[A-Za-z0-9_]` |
| `stripe` | `(sk\|rk)_(live\|test)_` and 16 or more of `[A-Za-z0-9]` |
| `anthropic` | `sk-ant-` and 20 or more of `[A-Za-z0-9_-]` |
| `openai` | `sk-(proj-)?` and 20 or more of `[A-Za-z0-9_-]`, not `sk-ant-` |
| `slack` | `xox[abposr]-` and 10 or more of `[A-Za-z0-9-]` |
| `aws` | `(AKIA\|ASIA)[0-9A-Z]{16}` |
| `google` | `AIza[0-9A-Za-z_-]{35}` |
| `npm` | `npm_[A-Za-z0-9]{36}` |
| `jwt` | `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |

Each pattern has a word boundary on the left, so `task-ant-x` does not match.

R6. Context rules, rule id `context:<id>`. The rule marks the value only, not the label.

- `assign`: a name that holds `api_key`, `apikey`, `secret`, `token`, `password`, `passwd`, `pwd`, `private_key`, `client_secret`, `access_key`, `auth` (any case, `_` or `-` or none), then `:` or `=`, optional quotes, then a value of 12 to 512 characters without whitespace, quotes, or `,;`.
- `auth-header`: `Authorization:` then `Bearer`, `Basic`, or `Token`, then a value of 8 to 4096 characters without whitespace.
- `url-userinfo`: `scheme://user:password@host`. Mark the password.

A context value is a hit only if its Shannon entropy is 3.0 bits per character or more, and it is not a placeholder: `<…>`, `${…}`, `{{…}}`, `process.env.…`, `os.environ…`, a marker, `x` or `*` repeated, or text that contains `your`, `example`, `changeme`, `placeholder`, `dummy`, `redacted` (any case).

R7. Values. `scanValue` walks plain objects, arrays, and strings. It scans object keys as well as values. A key with a hit becomes the marker text. If 2 keys become the same text, add ` #2`, ` #3`. Numbers, booleans, `null`, and `undefined` pass unchanged. Any other type (class instance, `Map`, `Set`, typed array, function, symbol, bigint) returns `unsupported`. A cycle returns `cycle`.

R8. Limits. `maxChars` counts the UTF-16 length of all strings and keys. `maxNodes` counts objects, arrays, and strings. A scan checks `clock.now() >= clock.deadline` at least every 64 KiB of text and every 1024 nodes, and returns `deadline`. `DEFAULT_LIMITS` is `{ maxChars: 2_097_152, maxDepth: 64, maxNodes: 50_000 }` (Q15).

R9. Speed. All regular expressions are linear: no nested quantifiers, and every repeat has an upper bound. Test: 2 MiB of adversarial text (long runs of `a`, `=`, `-`, `eyJ`, base64 characters) with 100 known values finishes in less than 1 s on the development machine. The test reports the time.

R10. No leak. No error message, `hits` entry, `skipped` entry, or thrown error holds a value. A thrown error inside a scan is a bug, and `shield` withholds when it happens.

### Not in scope

Unicode normalization, a value split across 2 strings, images and binary data, other encodings (for example base32, gzip), and a value with fewer than 8 characters. The README lists these.

## Tech stack

TypeScript, run by Claude Code 2.1.318 (`claude plugin test`). No npm dependencies. Types from `blindfold/.claude-plugin/types/` (generated at the first `--plugin-dir` load).

## Commands

```bash
cd blindfold && claude plugin test
cd blindfold && claude plugin validate --strict .
bunx @biomejs/biome@2.6.2 check .   # repository root
```

## Project structure

```
blindfold/
  .claude-plugin/plugin.json     name "blindfold", version 0.1.0
  hooks/hooks.json               { "modules": ["./register.ts"] }
  hooks/register.ts              empty register for now (shield adds hooks)
  hooks/detect.ts                this module
  tests/detect.test.ts
  tests/fakes.ts                 builds fake secrets at run time
```

## Code style

Same as `ember`: tabs, double quotes, `.ts` import paths, named exports, `type` aliases, small pure functions, a one-line `/** */` comment only where the intent is not clear.

```ts
export type Hit = { kind: "known"; name: string } | { kind: "rule"; rule: RuleId };

/** The text that replaces a hit. It never holds the value. */
export function marker(hit: Hit): string {
	return hit.kind === "known" ? `[secret: ${hit.name}]` : "[secret hidden]";
}
```

## Testing strategy

- Test first (`describe`, `test`, `expect` from `claude-code/testing`, as in `ember/tests/stats.test.ts`).
- For each of R2 to R7: fixtures that the rule hides and fixtures that it keeps. Keep fixtures: UUIDs, git SHAs, base64 images, `package-lock.json` integrity hashes, CSS hex colors, normal English, and placeholder lines from `.env.example` files.
- `tests/fakes.ts` builds fake tokens by string concatenation at run time. The repository text never holds a full token shape, so GitHub push protection and other scanners do not flag it.
- Property tests without a library: for 200 random values and positions, the output of a scan holds no known value in any R2 form, and a second scan is `clean`.
- `claude plugin test` does not measure coverage. Each exported function and each rule id has at least 1 test that hides and 1 that keeps.

## Boundaries

- Always: keep `detect.ts` pure. Inject the clock. Write the failing test first.
- Ask first: a new npm dependency, a change to the marker text, a change to `DEFAULT_LIMITS` or to the 8-character minimum, a new vendor rule.
- Never: put a real secret in a file, put a value in an error or a hit, copy code from the `secret-box` mod, use a regular expression with nested quantifiers.

## Success criteria

- `claude plugin test`, `claude plugin validate --strict .`, and Biome pass with no warnings.
- Every requirement R1 to R10 has a test that names it.
- The R9 test runs in less than 1 s.
- A review of `detect.ts` finds no `$`, no `Date.now`, and no I/O.

## Decisions

- Q14. A known value with fewer than 8 characters is not hidden, because it matches normal text (for example `admin` in `/admin/users`). The pane says that the value is too short to hide.
- Q15. `shield` withholds a result above 2 Mi characters in full, and tells Claude to read it in parts. The R9 test can change this number.
