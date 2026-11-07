## F77. High. Previously safe request metadata becomes a secret after a save and is rendered without another scan

Locations: `blindfold/hooks/ui.ts:320–325`, `ui.ts:190–196`, `ui.ts:608–609`, `ui.ts:639–651`, `blindfold/hooks/request.ts:101–107`, `blindfold/hooks/register.ts:60–63`.

Input: request `DB_PASSWORD` with reason `Use orchard-river-value for the database`, then enter the made-up value `orchard-river-value`. Alternatively, enter `DB_PASSWORD` itself as that name's value. Both metadata fields pass their initial checks because the value is not yet known.

What happens: the save learns the value and loads the file, but request synchronization only changes `state`. The first case leaves the now-known value in `Request.reason` and the ready band's `Text`. In the second case, enrollment correctly returns `[hidden name]`, but `rowsOf` appends the raw requested name again. The value appears in the band, status line, pane text, and `enter::DB_PASSWORD` button key, and the request remains pending because synchronization compares against the redacted status. This is a remaining R7/F65/F73 failure, not the excluded unknown command-line-paste limit.

Evidence: `/Users/dave/.cache/pi-review/ui-code-pi/metadata.ts` runs the real registered request, command, entry/save wiring with fake process results, asserts both saves, and confirms the retained metadata and rendered disclosures. No native dialog runs.

Fix: Revalidate retained request/outcome metadata against the current known set after learning/loading, clear or redact unsafe metadata, and never reconstruct actionable identities from a display-redacted status.

## F78. Medium. Rewrite counters copy a hidden, secret-bearing name into module state

Location: `blindfold/hooks/shield.ts:247–251`.

Input: `.env.test` contains `API_KEY=orchard_secret42` and `orchard_secret42_TOKEN=second-madeup-value`. A tool result contains `second-madeup-value`.

What happens: enrollment hides the second name as `[hidden name]`, but `countRewrite` copies its raw known-hit name into the module-level `rewrites` map. Its key is `orchard_secret42_TOKEN`, which contains the first kept value. The numeric map values do not make its string keys safe. This introduces a value-bearing copy outside enrollment even though the pane disables the hidden row's actions.

Evidence: `/Users/dave/.cache/pi-review/ui-code-pi/counts.ts` asserts the counter exists under the raw name while enrollment's status hides it.

Fix: Exclude secret-bearing names from counter keys, or count under a value-free opaque identity resolved inside enrollment.

## F79. Medium. Cancellation and file-choice exits can restore outcomes after Dismiss or session end

Locations: `blindfold/hooks/ui.ts:470–477`, `ui.ts:489–491`, `ui.ts:514–521`.

Input: start entry, Dismiss or end the session while it waits, then have entry return `{ kind: "cancel", why: "unavailable" }`. Separately, let a pending file choice return `denied` after Dismiss/session end.

What happens: the unavailable branch calls `finish` before checking the fence and restores a manual-entry outcome. `chooseFile` has no fence and restores a denied outcome after the lifecycle handler cleared it. The catch branch also calls `finish` without the post-await fence. The busy flag does reset, but cleared outcomes and stale instructions return. This is not the excluded question of whether a toast survives reload.

Evidence: deferred-I/O assertions reproduced the late unavailable outcome. `/Users/dave/.cache/pi-review/ui-code-pi/lifecycle.ts` reproduces a late denied choice without any reload and a rejected save restoring a manual outcome after invalidation.

Fix: Apply the initiating request/session fence to every asynchronous exit, including unavailable, catch, and file-choice completion, before publishing an outcome.

## F80. Medium. Request buttons can act on a different request from the one displayed

Locations: `blindfold/hooks/ui.ts:603–605`, `ui.ts:630–644`, `ui.ts:718`, `ui.ts:770`.

Input: render a pending band for `OLD_KEY`, replace it with a request for `NEW_KEY`, and invoke the still-displayed old Enter handler before the redraw replaces it. For Continue, render `OLD_KEY` ready, replace it with a ready `NEW_KEY`, then invoke the old Continue handler. A Dismiss/replacement while the band's `next(e)` is pending also causes that render to return the old request's tree.

What happens: Enter saves `OLD_KEY`, but `startFlow` captures the current `NEW_KEY` request's fence, so the fence does not reject the stale action. Continue consumes and submits `NEW_KEY` even though the button was drawn for `OLD_KEY`. Pane handlers have the same missing displayed-request identity check. Invalidation is not a synchronous replacement of all mounted callbacks.

Evidence: `/Users/dave/.cache/pi-review/ui-code-pi/lifecycle.ts` asserts the old Enter callback writes `OLD_KEY` through the real entry/write functions after request replacement. Additional deferred-render and ready-button probes confirmed the stale returned tree and `NEW_KEY` submission respectively.

Fix: Bind request-specific handlers to the displayed request id/epoch and reject them if it changes, and recheck the request after the band's awaited `next(e)`.

## F81. Low. A new flow does not clear the previous outcome, and tests require the wrong retention

Locations: `blindfold/hooks/ui.ts:439–452`, `ui.ts:470–475`, `blindfold/tests/ui.test.ts:607–617`.

Input: retain `{ kind: "not-saved", name: "OLD_KEY", step: "git", reason: "tracked" }`, start a new flow for `DB_PASSWORD`, and cancel its dialog normally.

What happens: the old failure stays in module state throughout the new flow and after cancellation. The pane and status line can keep reporting that `OLD_KEY` was not saved instead of clearing it at the next flow, as UI R3 requires. The three ordinary-cancel tests explicitly assert that an earlier outcome survives, so they enforce this contract violation rather than catch it.

Evidence: `startFlow` never resets the outcome on an accepted native-entry start, ordinary cancellation returns without changing it, and the tests assert equality with the previous outcome. A deferred-entry probe confirmed retention both during entry and after cancellation.

Fix: Clear the prior outcome when a new flow is accepted, and make ordinary-cancel tests expect that cleared state.

## F82. Low. F76's different-length test still cannot detect a state/store length leak

Location: `blindfold/tests/ui-hooks.test.ts:976–986`.

Input: two different-length canaries, with a hypothetical `$.state.set` or `$.store.set` write containing only `value.length`.

What happens: the test compares `a.seen` with `b.seen`, but checks `a.stored` and `b.stored` only for the literal canaries. A numeric length in the recorded writes passes both assertions. Thus the F76 repair covers length-dependent visible output, but not length-dependent state/store writes. This is a confirmed test gap, not a claim that production currently writes a length there.

Evidence: precise reading of the separate `seen`/`stored` serializations and assertions at lines 971–986. The fake records state/store writes, but those recordings are never compared between canaries.

Fix: Also compare the two recorded state/store write sequences, allowing only explicitly value-independent differences.

Verdict: Request changes for F77–F80. The existing suite passes 1,094 tests and TypeScript exits 0, but confirmed disclosure and lifecycle defects remain.
