# Shield correctness review

Reviewed `feat/blindfold`, against R1–R15 and Q26–Q30, in the requested order. Checked the 11 guard events' input/result types and catch behavior, then text coverage, copying, deadlines, hit ranking, refresh/config ordering, diagnostics, and assertions. No additional invalid return shape was confirmed. Catch replay is supported by `blindfold/.claude-plugin/types/claude-code/index.d.ts:1214–1216`.

Verification: `claude plugin test` passed 723 tests with 0 failures. `bunx tsc -p .` exited 0. The first type-check launch lacked `bunx` on its shell PATH, so it was rerun with `/Users/dave/.bun/bin` on PATH. All assertions in `/tmp/shield-pi-review-20260716/repro.ts` passed. All values below are made up.

## F39. High. Context block names reach the model without a scan

Location: `blindfold/hooks/shield.ts:296–301`.

Input: enroll `REVIEW_FAKE_KEY=MadeUpReviewValue47xZp9`, then have `prompt.context`'s `next` return `{ blocks: [{ name: "MadeUpReviewValue47xZp9", text: "ordinary context" }] }`.

What happens: only `block.text` is scanned. The handler returns the original object, including the known value in `name`. This is model text, not private metadata: `blindfold/.claude-plugin/types/claude-code/index.d.ts:8916–8921` says a block renders under `# name`, and permits a plugin's own name. The scratch script asserts both the unchanged name and result identity. A hit in the body would not help, because the rewrite spreads the original name back into the block.

Fix: scan each block's name as well as its body, and drop a block whose routing name contains a hit or cannot be scanned.

## F40. Medium. Downstream refusal diagnostics bypass the no-leak policy

Locations: `blindfold/hooks/shield.ts:261,266–269` (`drop`), `:415` (`deny`), `:439` (`deny`), `:472` (`reason`), and `:506–508` (`consumed`).

Input: with the same enrolled value, supply clean text/task fields and let `next` return a refusal containing it. The scratch script confirms all five cases: `{ drop: "Refused MadeUpReviewValue47xZp9" }`, `{ deny: "Read refused MadeUpReviewValue47xZp9" }` for a non-env mention, `{ deny: "Refused MadeUpReviewValue47xZp9" }` for a spawn, `{ isDelivered: false, reason: "No recipient MadeUpReviewValue47xZp9" }`, and `{ consumed: "Handled MadeUpReviewValue47xZp9" }`.

What happens: each diagnostic is returned verbatim. These are host-visible diagnostic channels, not harmless unused fields. The host types say a send's reason is model-readable (`index.d.ts:12567–12573`), a mention's deny reason is debug-logged (`:9450–9451`), and a receive's consumed reason is logged (`:12387–12393`). This violates R15 even though shield-authored constants are safe. An enclosing `tool.call` can mask some tool-facing cases, but does not establish the event-wide guarantee claimed by R15. The existing tests exercise clean downstream outcomes, not these secret-bearing failures.

Fix: sanitize rewritable downstream failure diagnostics, and either obtain a host-supported final-diagnostic rewrite or explicitly narrow R15 for immutable downstream failures, without introducing a forbidden late drop/deny after a prompt entered or an agent started.

## F41. Medium. JSON copying can report clean while forwarding an original that still holds a known value

Locations: `blindfold/hooks/shield.ts:55–72,79–85`, with the unsafe pass forwarded at `:196`.

Input: `const payload = []; payload.note = "MadeUpReviewValue47xZp9";`, inside `{ payload }`. The scratch script first runs `structuredClone(payload)` and freezes it, so this case needs no getter, proxy, class, symbol, or function. A second case is `{ ["MadeUpReviewValue47xZp9"]: undefined }`.

What happens: `isPlain` accepts the array. JSON drops its enumerable non-index `note` property, so both `guardValue(payload, ...)` and `guardArgs({ payload }, ...)` return `{ kind: "pass" }`. The scratch script also calls `onToolCall` and asserts that `next` receives the original event with `payload.note` intact. JSON similarly drops the second input's secret-bearing property name. The guards therefore prove the copy clean, not the original they authorize. This confirms the guard/forwarded-object gap, not a live model leak through a particular tool mapper.

Fix: reject properties that JSON would silently discard, including non-index array properties and undefined-valued object properties, before allowing an original-object pass.

## F42. Medium. Scanning a downstream tool denial does not remove a raw enrolled env name

Location: `blindfold/hooks/shield.ts:165–169`.

Input: enroll `REVIEW_FAKE_KEY=MadeUpReviewValue47xZp9`, call with clean arguments, and let `next` return `{ deny: "Unavailable REVIEW_FAKE_KEY" }`.

What happens: `guardText` detects values and detector rules, not bare enrolled names. The scan returns clean and the original denial is returned. The scratch script asserts this exact result. Unlike an approved `[secret: REVIEW_FAKE_KEY]` marker, this name occurs in ordinary denial prose, contrary to R15. The R15 tests never supply a name-only downstream denial.

Fix: use a fixed name-free diagnostic for downstream tool denials, or explicitly remove enrolled names outside approved markers before returning them.

## F43. Low. The R14 test does not prove which config value was loaded or when

Location: `blindfold/tests/shield.test.ts:1295–1316`.

Input: the test named “loads the value next wrote, after next” sets both `e.value` and `next`'s `answer.value` to `"other.env"` (`:1299`, `:1308`). It checks enrollment only after the handler finishes.

What happens: the test cannot distinguish loading `e.value` from loading `out.value`. It also cannot distinguish loading before `next` from loading afterward. Either regression could leave its assertions green. The current implementation at `blindfold/hooks/shield.ts:615–617` is correctly ordered and uses `out.value`. A scratch case with `e.value === "requested.env"` and `out.value === "changed.env"` confirms the current code loads `"changed.env"`.

Fix: make requested and returned lists different, and inspect enrollment inside a gated `next` before returning the new list.

Not checked: a live session or the excluded surfaces. No repository source or test files were changed.

Verdict: not ready for the live check, because model-visible context names remain unscanned and the claimed no-leak diagnostic policy is not met.
