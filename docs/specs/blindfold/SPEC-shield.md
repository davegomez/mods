# Spec: blindfold `shield`

Module id: `shield`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, sections 1a, 1g, P1, P2, P5. Depends on `detect` (`scanText`, `scanValue`, `DEFAULT_LIMITS`) and `enroll` (`knownSet`, `refreshIfNamed`, `load`).

API facts come from the Claude Code 2.1.318 declarations (`blindfold/.claude-plugin/types/claude-code/index.d.ts`, written `d.ts:N`) and `docs/mods/`. A fact marked INFERRED is not stated there and needs the live check in "Success criteria".

## Objective

`shield` hooks each text path into and out of the model. It replaces each secret with an inert marker (P1), or it refuses or withholds the whole item when it cannot replace the secret. It never changes a tool input (P2). Every guard hook fails closed (P5).

Success: in a session with a listed `.env`, a known value or a detector hit does not reach the model or the stored transcript through any path in R3 to R13. A scan that cannot finish stops the item. The user sees a toast when a prompt was changed.

### Module shape

`shield.ts` has a pure part and 1 handler per event. `register.ts` owns all `on(...)` calls, because an event can have only 1 hook without a matcher in a mod (`build/react-to-events.md`, "Filter which events a hook handles").

```ts
// Pure:
export type Verdict<T> =
	| { kind: "pass" }                                 // clean: pass the original on
	| { kind: "rewrite"; value: T; count: number }     // the copy, with markers
	| { kind: "stop"; reason: Unscannable["reason"] }; // refuse before next, withhold after
export type ArgsVerdict =
	| { kind: "pass" }                                 // no hit, or context rule hits only (Q30)
	| { kind: "refuse" }                               // a known value, a private key, or a vendor rule
	| { kind: "stop"; reason: Unscannable["reason"] };
export function guardText(text: string, set: KnownSet, clock: Clock): Verdict<string>;
export function guardValue(value: unknown, set: KnownSet, clock: Clock): Verdict<unknown>;
export function guardArgs(args: unknown, set: KnownSet, clock: Clock): ArgsVerdict; // R4, Q30
export function clockFor(remainingMs: number, now: () => number): Clock;              // R2

// 1 handler per event, each with its `.catch` handler. Plain functions, because the host refuses `$` passed to a method.
export function onToolCall($, e, next) ... // and so on for R3 to R13
```

### Requirements

R1. Plain copy (capability map notes, F17, F18, F41). `guardValue` scans a plain copy of the value (a JSON round trip). A copy that fails, for example a cycle or a `BigInt`, is `stop` with `unsupported`. The copy must hold everything the original holds, because `pass` forwards the original. So data that JSON would lose or replace is `stop` with `unsupported`: an object that is not a plain object or array (a `Map`, a `Date`, a class), a symbol key, an array property that is not an index, a key that is not enumerable, a getter, a function or symbol value, and an own `toJSON`. An object key whose value is undefined is scanned with the copy and stays out of a `rewrite` copy, so an optional field set to undefined still passes. A top-level undefined is `pass`. `rewrite` returns the scanned copy, never the original. `pass` returns nothing, so the handler passes on the object it got from the host. INFERRED: hook events reach the mod worker as message data, so they hold no getters or proxies.

R2. Time. A hook has 10 s, and the clock stops while `next` or a `$` call runs (`d.ts:5343`, reference.md "Limits"). `clockFor` sets the scan deadline to `remainingMs` minus 1,000 ms, read from `next.budget.remainingMs` (`d.ts:6947`). A scan that reaches the deadline returns `deadline`, which is `stop`. The `.catch` handler has 1 s (`d.ts:5351`), so it does no scan (P5).

R3. `prompt.submit` (`d.ts:9736`). Scan `text` and each `context` block. On a hit: `next({ ...e, text, context })` with the copies, then `$.ui.toast("blindfold hid N secrets in your prompt")`. The toast holds a count only, no name. On `stop`: return `{ drop: reason }`. When `e.command` is set, the host does not apply a `text` rewrite (`d.ts:9744`), so a hit in `text` is `{ drop }` (Q29). `.catch`: `next.called ? next(e) : { drop }`. Media in `attachments` is not scanned.

R4. `tool.call` before `next` (`d.ts:13840`). Scan the arguments (every field of `e` except `tool`, `tool_use_id`, and `agentId`) for every tool, MCP tools too. A known value, a private key block, or a vendor prefix is `{ deny }`. A context rule hit alone (`assign`, `auth-header`, `url-userinfo`) does not refuse (Q30). The deny text tells Claude to refer to the secret by its name (P3). Never call `next` with changed arguments (P2). `stop`: `{ deny }`. Before the scan, call `refreshIfNamed` with `e` (enroll R7).

R5. `tool.call` after `next` (`d.ts:13876`). Call `refreshIfNamed` with `e` again, then scan with the new set:

- `{ deny }` from below: scan the deny text. On a hit, return `{ deny: copy }`.
- success or error: scan `result`, `context`, and `text` together (F37). On `pass`, return the object from `next` unchanged, so core keeps `ref`. On `rewrite`, return a new object with the scanned `result` and `context`, the same `isError` and `isReadOnly`, and no `ref` and no `text`, so core maps the new `result` for the model (Q26). On `stop`, return `{ deny: "blindfold withheld this result (<reason>). Narrow the call." }`.
- `.catch`: `next.called ? { deny: "blindfold withheld this result." } : { deny: "blindfold refused this call." }`.

R6. `prompt.context` (`d.ts:8945`). Scan each block `name` and `text`. The name renders as `# name` (`d.ts:8916`), but it also routes the block, so it is never rewritten: leave out a block whose name has a hit or a `stop` (F39). Rewrite the text of a block with a hit in its text, and keep its name. Leave out a block on `stop`. There is no refuse shape. `.catch`: return `{ blocks: [] }`.

R7. `prompt.section` (`d.ts:9643`). Scan `text`. Rewrite on a hit. Return `{ text: null }` on `stop` and in `.catch`.

R8. `prompt.attachment` (`d.ts:8554`). Scan `text`. Rewrite on a hit. Return `{ text: null }` on `stop` and in `.catch`. This changes only what goes to the model. R13 covers the stored row.

R9. `skill.prompt` (`d.ts:12946`). Scan `text`. Rewrite on a hit. On `stop` and in `.catch`, return `{ text: "blindfold withheld this skill text." }`.

R10. `prompt.mention` (`d.ts:9387`). Refuse with `{ deny }` when the path is a listed env file, or when its base name is `.env` or starts with `.env.`. Other files pass, and R8 scans their text (Q27). `.catch`: `{ deny }`.

R11. `agent.spawn` (`d.ts:261`). Scan `prompt` and `description`. A hit or `stop` is `{ deny }`. `.catch`: `next.called ? next(e) : { deny }`.

R12. `session.send` (`d.ts:12491`) and `session.receive` (`d.ts:12277`).

- `session.send`: scan `text`. A hit or `stop` is `{ isDelivered: false, reason }`.
- `session.receive`: scan `text`. Rewrite on a hit (Q28). On `stop`, return `{ consumed: "blindfold withheld a message it could not scan." }`.
- `.catch`: refuse or consume.

R13. `session.append` (`d.ts:11444`). This is the 2nd scan before a row is stored. Scan the text blocks and the `content` of each `tool_result` block. On a hit, `next({ ...e, message })` with the copy, and `$.ui.toast` "blindfold hid a secret that an earlier check missed. Rotate it." On `stop`, replace each text block and each `tool_result` content with `[blindfold withheld this content]`. Media blocks are left as they are. `.catch`: replace the same way when `next.called` is false, else return the result unchanged. The screen can show a row just before its rewrite (`d.ts:4553`). The README states this.

R14. Config change (enroll R7). On `config.set` for `blindfold.envFiles`, after `next(e)` returns `{ value }`, call `load` with the new value.

R15. No leak (F40, F42, Q32).

- Texts that blindfold writes: no toast, deny, drop, reason, or consumed text that blindfold makes, no log, no `$.state`, and no `$.store` holds a value or an env name. A marker holds a name only (P1). The count in a toast is a number.
- A refusal text from below (from `next`: core or another mod) is scanned with `guardText` where the host allows a changed text after `next` and the model or a log reads it. A hit returns the masked text. A `stop` returns the fixed text `blindfold withheld a refusal text it could not scan (<reason>).` in the same field. A clean text returns the object from `next` unchanged.
- An env name in a text from below is not hidden, because a name is not a secret and every marker shows it.

Where a refusal text from below is masked:

- `tool.call` `{ deny }` (R5): a deny after `next` withholds the result (`build/react-to-events.md`, "Handle a hook that fails"). The model reads it. On `stop`, R5's own withheld text stands.
- `prompt.mention` `{ deny }`: "a read already made is forgotten. The debug log names the reason" (`d.ts:9450`).
- `session.send` `{ isDelivered: false, reason }`: "the model reads `reason` as the tool's result" (`d.ts:12568`). INFERRED: no type line says a changed reason after `next` fails the hook, and the outcome stays `isDelivered: false`.
- `session.receive` `{ consumed }`: "The reason is logged, the plugin named" (`d.ts:12391`). INFERRED: no type line says a changed consumed text after `next` fails the hook, and the delivery stays taken.

If the host fails the hook on either INFERRED case, the `.catch` returns `next(e)`, which is the unmasked text from below, as before Q32.

Where a refusal text from below cannot be masked, so it passes as `next` gave it:

- `prompt.submit` `{ drop }`: "After a `next(e)` of the hook's was answered, a drop fails it" (`d.ts:9843`). The drop is shown to the user or logged, not read by the model.
- `agent.spawn` `{ deny }`: "Returned after a `next(e)` was answered it fails the hook" (`d.ts:450`). When the Agent tool spawns, the deny is that tool's error, and R5 masks it at `tool.call`. A workflow script's `agent()` error is not masked.

### Not in scope

Media, binary content, and audio. Server-side tools, which raise no `tool.call` (`d.ts:14772`). `command.run` arguments (Q29 drops them at `prompt.submit` instead). `turn.step` model output before it is stored (R13 covers the stored row). A failed `.catch` or a crashed worker: the shield is gone, and the README states this (design 1g). The pane and the status line (`ui`).

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`, plus `cd blindfold && bunx tsc -p .` (Q24). Files: `blindfold/hooks/shield.ts`, `blindfold/hooks/register.ts`, `blindfold/tests/shield.test.ts`, and `blindfold/tests/smoke.test.ts`.

## Testing strategy

- Pure tests for R1 and R2: a cycle, a `BigInt`, a deadline, and the copy that `rewrite` returns.
- 1 handler test per event (R3 to R14), with `claude-code/testing` and the `fakeApi` fake. Each event gets 4 cases: a hit, a clean item, a `stop`, and the `.catch` (before and after `next` where both exist).
- R4: a fake key in each argument shape (a flat field, a nested object, an MCP argument), and a context rule hit that passes.
- R5: the returned object has no `ref` and no `text` after a rewrite, and is the same object after `pass`.
- R15: after each test, the JSON text of every toast, deny, drop, reason, and consumed text holds no fake value and no env name outside a marker. Each event that masks a refusal text from below has a hit and a `stop` test. Each event that cannot has a test that the text passes unchanged.
- A speed test: `"pwd=&".repeat(…)` at 2 Mi characters finishes or stops inside the deadline (capability map note).

## Boundaries

- Always: scan before the item passes. Fail closed. Pass on only scanned data.
- Ask first: a new event, a change to the deadline reserve, any refusal of a context rule hit in tool arguments.
- Never: change a tool input (P2). Scan inside a `.catch`. Put a value or an env name in a toast, a deny, a log, `$.state`, or `$.store`.

## Success criteria

- The 4 commands pass with no warnings. Every guard hook in R3 to R13 has a `.catch`, checked by the smoke wiring test, and validate lists it for each event that can refuse. Validate lists a `.catch` only for events that can refuse, so it does not list `prompt.context`, `prompt.section`, `prompt.attachment`, or `skill.prompt`.
- Every requirement R1 to R15 has a test that names it.
- Live check (milestone 3, a shield-only build): with the owner's approval, load `claude --plugin-dir ./blindfold` with a fake `.env`, and confirm the INFERRED facts:
  - the model sees the marker, not the value, after `Bash` runs `cat` on a file that holds the value (R5, Q26),
  - the stored transcript row holds the marker (R13).

## Decisions

- Q26. A `tool.call` result is rewritten by returning a new object with the scanned `result` and no `ref` or `text`, so core maps it again. The types say core uses `ref` when the hook returns the object it got, but they do not say that core maps `result` when `text` is missing. Accepted. Confirm in the live check. Fallback: put the masked text in `{ deny }`.
- Q27. `prompt.mention` refuses env files by path only. Other files are not read in the hook, because R8 scans their text. The design said "refuse any readable file with a recognised secret". Accepted.
- Q28. `session.receive` rewrites a message from another session instead of refusing it, because `{ consumed }` drops the whole message without a word to the model. The design said "refuse". Accepted.
- Q29. A prompt with a pinned slash command and a hit in its text is dropped, because the host does not apply a text rewrite then. Accepted.
- Q30. A context rule hit alone in tool arguments does not refuse the call. Code such as `password = "…"` in an `Edit` call is common, and the context rules are the least precise detectors (design 1a). Known values, private keys, and vendor prefixes still refuse. Accepted.
- Q32. R15 covers the texts that blindfold writes. A refusal text from below is masked where the host allows a changed text after next and the model or a log reads it. Env names in text from below are not hidden, because markers show names (F40, F42). Accepted.
