# Step 4 spec correctness review

## F47. High. The new value is learned after it can already escape

Spec and requirement: `SPEC-write.md`, R7, R8, R10, and the objective.

Problem: R10 waits until verification before calling `enrollment.learn`. Between R7 and R10, another tool result can contain the newly written value without the shield knowing it. A write that takes effect but rejects, or a failed verification read, skips learning altogether. This contradicts design section 1b, which explicitly requires learning before the write starts. The existing shield refreshes files only when the tool input mentions a listed path. A Bun probe using the built modules confirmed that `guardText("madeup-orchard-seven", enrollment.knownSet(), clock)` passes before `learn` and rewrites after it. `learn` updates matches, not the file's Set status, so early learning need not falsely mark a failed save as successful.

Fix: After `setValue` succeeds, learn the value immediately before the first value-bearing write, retain that match on subsequent failure, and update Set/Ready only after successful verification.

## F48. High. Git errors can be treated as permission to write

Spec and requirement: `SPEC-write.md`, R3.

Problem: R3 handles only exit 0 from `ls-files` and exit 1 from `check-ignore`, and its second ignore check refuses only when the file is still reported not ignored. Neither rule requires refusing an error. In a scratch repository, both specified commands returned 128 for the allowed filename `:(bogus).env`, with `fatal: Invalid pathspec magic 'bogus'`. The specified branches therefore permit an implementation to proceed without establishing either that the target is untracked or that it is ignored. Missing paths returned 1 from `ls-files`, and ordinary unignored paths returned 1 from `check-ignore`. This concerns commands after a successful repository probe, not the accepted Q36 skip.

Fix: After the Q36 probe succeeds, accept only `ls-files` exit 1 as untracked and `check-ignore` exit 0 as ignored, handle exit 1 by adding/rechecking the rule, and stop on every rejection or other exit code.

## F49. High. A post-write permission repair does not establish the promised safe write

Spec and requirement: `SPEC-write.md`, R7, R9, the objective, and G3.

Problem: R9 explicitly permits a value to have been written with wider permissions and then returns success after a repair. That does not settle the objective's promise that the value stays off disk until mode 600 is established. The host declaration at `d.ts:3389–3395` supplies neither a mode option nor a mode-preservation guarantee. Observing or repairing the mode after R7 cannot establish what permissions applied while the bytes were being written. R9 also does not specify successful repair and a confirming mode check as conditions for success, and `Saved` has no warning field despite the instruction to return `ok` with a warning.

Fix: Keep mode preservation an unresolved, release-blocking G3 check, require successful mode inspection and any repair before returning success, and define an explicit warning outcome if post-write exposure is to be reported.

## F50. Medium. The chmod argument order fails on the tested platform

Spec and requirement: `SPEC-write.md`, R4 and R9.

Problem: On this Mac, the exact R4 vector `['chmod', '600', '--', path]` exits 1 with `chmod: --: No such file or directory`, even though it also changes the real target's mode. Since R4 refuses any nonzero exit, every new-file save using this vector stops before the value write. Both a filename with spaces and a leading-dash filename reproduced it. Separately, R9's unspecified operand handling matters: `stat -f %Lp -env` exits 1 because it parses the filename as options.

Fix: Specify tested vectors such as `['chmod', '--', '600', absoluteTarget]` and `['stat', '-f', '%Lp', '--', absoluteTarget]`, keeping each path one argument.

## F51. Medium. Path checks and file operations do not share an explicit base directory

Spec and requirement: `SPEC-write.md`, R2–R5, R7–R9.

Problem: Paths are session-root-relative by the imported enrollment contract, and R3 explicitly pins git's `cwd` to that root. R4 and R7 nevertheless show `$.fs.write(path, ...)`, while chmod/stat have no specified `cwd` or absolute operand. The host resolves relative filesystem paths against the working directory (`d.ts:3378`, `3392`), not a guaranteed project root. The docs also distinguish the session/subagent working directory in `build/use-the-mods-api.md`, “Reach files, processes, and the network.” A builder can validate and git-ignore a root-relative file but read, create, chmod, or write another file relative to the current working directory.

Fix: Define one validated absolute target, use it for every filesystem/chmod/stat operation and the root `.gitignore`, and keep a separate root-relative spelling for git rules and enrollment keys.

## F52. Medium. Git path operands and ignore rules are not literal filenames

Spec and requirement: `SPEC-write.md`, R3, and the imported R2 path rules.

Problem: `--` stops option parsing, not Git pathspec interpretation. A scratch `git ls-files --error-unmatch -- '*.env'` matched a tracked `.env`, although the literal filename `*.env` was not tracked. Also, appending the specified `/.env[local]` rule did not ignore a literal `.env[local]` file. Escaping the brackets as `/.env\[local\]` did. These spellings pass enrollment's path rules, so the current requirement can falsely refuse a valid target or mutate `.gitignore` and then fail. Ordinary internal spaces and leading dashes were handled correctly by the specified git argument boundaries.

Fix: Use literal pathspec handling for `ls-files`, a non-magic operand such as `./<path>` for `check-ignore`, and an escaped anchored ignore pattern, or explicitly reject unsupported filename spellings before mutation.

## F53. Medium. Ready can outlive the fact that the name is set

Spec and requirement: `SPEC-request.md`, R3–R5.

Problem: Once a request becomes Ready, the lifecycle has no transition for a later load showing the name missing, empty, or stale, or for Forget. R5 consumes it and unconditionally submits “NAME is now set.” Enrollment's documented load/Forget behavior can remove the active name while leaving the request Ready. Design section 1g explicitly says a stale file must never be presented as Set. The required `consume()` signature has no enrollment input, and `continueRequest($, requests)` cannot check current enrollment status as written.

Fix: Define Ready invalidation on each status change and require Continue to refresh/check the same request's active, nonempty name before consuming and submitting it.

## F54. Medium. Request validation and write failures disagree with the built dotenv contract

Spec and requirement: `SPEC-request.md`, R2, and `SPEC-write.md`, R6.

Problem: The request regex accepts `__proto__`, but the built `dotenv.isValidName` expressly rejects it because the parser cannot set it. A Bun probe confirmed that request validation accepts this name while `setValue` returns `{ ok: false, reason: 'bad-name' }`. R6 instead names `invalid-name` and omits the existing `duplicate-name` refusal. A second probe confirmed `duplicate-name` for two existing entries with the requested name. Builders following the spec and builders forwarding the real `SetResult` will therefore implement different validation and failure results.

Fix: Require request validation to use the existing `dotenv.isValidName`, and make R6 forward the actual `bad-name`, `unsafe-value`, `duplicate-name`, and `too-large` reasons.

## F55. Low. Native output truncation is discarded before answer validation

Spec and requirement: `SPEC-entry.md`, module shape `readNative`, R3, and R4.

Problem: `readNative` takes only `exitCode`, `stdout`, and `stderr`, and R3 treats every exit-0 stdout as the complete value. The host's `ProcessRunResult` explicitly limits each stream to its first 4 MiB and reports `isStdoutTruncated` and `isStderrTruncated` (`d.ts:8408–8442`). The specified boundary loses those flags, so it can return a truncated value as successful input and mistake a newline within that prefix for the transport newline. The current dotenv size limit would refuse such a large value later, but `entry` itself still violates its unchanged-value contract.

Fix: Include the host truncation flags in `readNative`'s input and return a fixed failure rather than a value when stdout is truncated.

Verdict: Not ready to build because the write order can leave a new value unshielded, git errors can fail open, the permission promise remains unproved, and the specified chmod vector fails on macOS.
