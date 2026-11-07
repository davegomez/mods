# Step 4 code correctness review

Reviewed `request.ts`, `entry.ts`, `write.ts`, their tests and fakes, and `register.ts` against the three specs, including their Decisions and the previous spec review. Findings below were confirmed with Bun scratch scripts under `/tmp/blindfold-step4-code-review/`. All values were made up.

## F59. High. A nested repository bypasses the tracked-file refusal

Location: `blindfold/hooks/write.ts:100–126`.

Input: The session root is a git work tree. `child/` is a separate, ordinary git repository, not a registered submodule. Its index already tracks `child/.env`. Save `API_KEY=madeup-orchard-seven` to `child/.env`.

What happens: Every git command runs in the session root, so `ls-files` checks only the outer index and misses the tracked file. Adding `/child/.env` to the outer `.gitignore` satisfies the outer `check-ignore`, but does not protect the file in the child repository. The save returns `ok: true` and changes the tracked child file. A subsequent commit in the child can include the secret. This violates the tracked-file refusal and the objective that git ignores the saved file, even though the implementation uses the commands specified in R3.

Evidence: `probes.ts` used real git and filesystem operations in a scratch outer/child repository pair. `saveValue` returned success. The child's `git ls-files --error-unmatch -- .env` returned 0 and its `git check-ignore -q -- ./.env` returned 1 afterward.

Fix: Before mutation, resolve the target's owning work tree and refuse a nested repository, or perform the tracked/ignored checks in that owning repository.

## F60. High. Creating a missing target can erase a file created during the git checks

Location: `blindfold/hooks/write.ts:184–196`, with the ineffective later check at `200–204`.

Input: `.env` is missing at the first path check. While the git step is running, another save or an editor creates it with `OTHER=keep-me\n`.

What happens: The cached `created` flag remains true. The create step unconditionally writes an empty string over the new file. The changed step then compares that emptied file with the original empty `before`, accepts it, and saves only the new assignment. The result is `ok: true`, but `OTHER` is lost. The changed-file safeguard never sees the text that the create step destroyed. This also applies chmod to a file another writer created, contrary to the existing-file boundary.

Evidence: In `probes.ts`, the fake `ls-files` response created `.env` with `OTHER=keep-me\n`. The real `saveValue` returned `{ "ok": true, "created": true, "ignoredNow": false }`, and the final file contained no `OTHER` line.

Fix: Use an exclusive empty-file create that refuses an existing target instead of the truncating `$.fs.write(target, "")`.

## F61. Medium. A failed verification leaves an existing name falsely Set and its request Ready

Location: `blindfold/hooks/write.ts:215–219` and `229`, with the failure return at `165–168`. The misleading regression test is `blindfold/tests/write.test.ts:397–405`.

Input: Load an existing `.env` containing `API_KEY=madeup-old-orchard`, with a Ready request for `API_KEY`. Save a replacement, but let the value write leave the file empty, so verification fails.

What happens: The function returns `verify/mismatch` without refreshing or invalidating the old enrollment status. It still reports an active `API_KEY`, and the request remains Ready. Continue consumes that stale status and submits “API_KEY is now set” despite the empty file. R8 requires that a failed verification not leave the name marked Set. The test named “a failed verify refuses, the name is not marked set” starts with an enrollment that was only relisted, never loaded. Its assertion that `status().files` is empty passes even if failure handling never invalidates an existing Set state.

Evidence: `status-probe.ts` loaded the old file, used `onWrite` to simulate an empty persisted file, and observed `verify/mismatch`, an empty file, an active `API_KEY` status, and a successful Continue submission. The newly learned value remained shielded, so this finding concerns false status, not a value leak.

Fix: On a potentially mutating save failure, invalidate or refresh the affected file's status while retaining learned values, and seed the regression test with an already-loaded Set name.

## F62. Medium. An in-flight tool call can recreate a request after a user prompt or session end clears it

Location: `blindfold/hooks/register.ts:71–85` and `90–92`, together with `blindfold/hooks/request.ts:138–143`.

Input: A `request_secret` tool call waits for an enrollment load. Before that load finishes, dispatch a user `prompt.submit` or `session.end`.

What happens: The lifecycle hook clears the request immediately, but does not invalidate the older asynchronous tool call. When its wait ends, the tool handler calls `requests.ask` and opens a new pending request from the previous task or ended session. Enrollment's generation check protects its file-load results, not request creation. This breaks the R4 clear transition when events overlap.

Evidence: `probes.ts` composed the registered outer `tool.call` guard and matched request handler, blocked a file read with a gate, and dispatched each clearing event separately. Both probes ended with the old `API_KEY` request pending again after the clearing event completed.

Fix: Fence request creation with a prompt/session generation captured before the first await in the outer tool-call chain, and discard creation when that generation changes.

## F63. Medium. Linux never tries kdialog when zenity cannot start

Location: `blindfold/hooks/entry.ts:135–151` and `227–237`.

Input: Linux has `DISPLAY=:0`, zenity is absent, and kdialog is available.

What happens: `nativeCommand` selects zenity solely because a display exists. Its spawn rejection immediately becomes `cancel/unavailable`, with no kdialog attempt. The user cannot enter a value through the available native dialog. R2 specifies zenity with kdialog as the alternative when a display exists. This is separate from the excluded no-display behavior in F57.

Evidence: The `probes.ts` fake rejected zenity with ENOENT and was prepared to return a made-up answer for kdialog. The only attempted program was zenity, and the result was `{ "kind": "cancel", "why": "unavailable" }`. No real Linux dialog was run.

Fix: With a display present, try the fixed kdialog command if zenity cannot start, without retrying a cancellation or timeout.

## Verification and limits

`cd blindfold && claude plugin test`: 914 passed, 0 failed, across 8 files. `cd blindfold && /Users/dave/.bun/bin/bunx tsc -p .`: exit 0. The first TypeScript launch could not find `bunx` in the hc shell, so it was rerun using its absolute path.

Both scratch scripts passed their assertions. A harmless osascript handler substituted for the dialog script confirmed that the production argv layout supplies exactly two arguments, `API_KEY` and the made-up reason. Reading the fixed dialog script and `readNative` confirmed that the value is not inserted into argv and that truncation and newline handling follow the macOS contract. No native dialog or live model call was run. Real Windows/Linux behavior and the excluded live gates were not checked.

Verdict: Request changes for F59–F63 before treating these modules as correct.
