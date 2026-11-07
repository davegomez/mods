## F64. High. R1 and Q39: refusing arguments does not protect the command transcript

R1 refuses an extra argument only after `command.run` receives it. Q39 explicitly says the command line is stored in the transcript and a pasted value is not yet known to the shield. For example, `/secrets set API_KEY madeup-orchard-seven` receives the fixed refusal toast, but nothing in R1 removes the pasted text from the recorded command. There is also an accepted path: a value such as `OrchardSecret42` passes `request.validName`, so `/secrets set OrchardSecret42` treats it as a name and can reflect it in instructions and native-dialog arguments. Syntactic name validation cannot establish that text is not a value. The declarations explicitly direct authors to mask command arguments at `command.run`, not rely on a later `prompt.submit` text rewrite (`index.d.ts:9741–9750`).

Fix: Specify pre-storage command-argument sanitization with an end-to-end transcript test, scan accepted names for known secrets, and explicitly exclude undetectable command-line pastes from the promise if they cannot be prevented.

## F65. High. R2 and R7: a context-only secret in the request reason reaches the band unchanged

`SPEC-shield.md` R4/Q30 deliberately passes tool arguments whose only hits are context rules. `SPEC-request.md` R2 then only truncates the reason and removes control characters. A made-up reason `password=b9Xq7Lm4Rt2Pv8Nw` therefore reaches `Request.reason`, and R2 places it in plain `Text`. Plain text prevents markup interpretation, not disclosure. This exposes a detector-recognized value in request memory and render props, contrary to R7 and request R6. A read-only pure probe confirmed that this fixture produces `context:assign` while `guardArgs({ name: "API_KEY", reason }, ...)` returns `pass`.

Fix: Require a request-specific metadata check before constructing the request, refusing or redacting every detector hit in its name and reason without changing forwarded tool arguments.

## F66. High. R5.1, R5.2, and R7: the typed filename is an unchecked secret-bearing text path

R5.1 declares that a filename is not secret, but the `Input` accepts arbitrary text. `InputProps.value` is drawn text, and the input event and callbacks receive the whole untrimmed text (`index.d.ts:5707–5711`, `5743–5755`, `15313–15345`). Neither the enrollment path rules nor the write path allowlist rejects a filename merely because it contains a known value. If a kept made-up value is `orchard42`, `.env.orchard42` is a valid spelling. It can be passed to `addFile`, persisted in `blindfold.envFiles`, and interpolated as FILE in the manual-entry instructions. An implementation that echoes the draft through `Input.value` or module state also carries that value before submission. No scan or safe-display rule is specified for this path.

Fix: Treat filename input as untrusted metadata, reject secret-bearing text before retaining or persisting it, and specify a safe display policy or remove free-text entry where R7 cannot be met.

## F67. High. R5: clearing a request or ending a session does not invalidate the running flow

The one-flow lock prevents another start, but it does not bind the existing flow to a request id or session epoch. Under request R4, Dismiss, a new user prompt, session end, or a superseding request can clear or replace the request while native entry is waiting. R5 still proceeds from the returned value to `write.saveValue`. A dismissed flow can therefore save afterward. If the session ends while entry or a save is waiting, enrollment R7 drops the values, but write R7 can subsequently call `learn` and write R10 can call `load`. Enrollment R8 fences loads, not a later `learn` or a newly started load. The request tool's F62 epoch check does not cover this UI flow. Request R5 does already prevent two submissions for the same consumed request, so a duplicate Continue is not the missing safeguard here.

Fix: Define cancellation and generation checks through entry and write, bind callbacks to the initiating request/session, and prevent late save, learn, load, or readiness updates after invalidation.

## F68. Medium. R5.1: adding a new filename reloads the module in the middle of the flow

Enrollment R9 persists a new file through `$.config.set`. A changed plugin option reloads the module and runs `register` with a new options object (`index.d.ts:10001–10007`). Request R4 explicitly clears the request on module reload. Starting with a missing `.env` and choosing the not-yet-listed `.env.local` therefore crosses a reload boundary before R5.2. The spec nevertheless proceeds as one uninterrupted flow with the same pending request and lock. Even if an old callback returns before the reload, the new module does not inherit its closure state or pending request. The file-setup path cannot promise the stated entry-to-Continue sequence without a reload policy.

Fix: Make file enrollment a separate reload-aware phase with an explicit fresh request/restart, or revise the lifecycle contract to resume only safe flow intent across that reload.

## F69. Medium. R5.1: `addFile` supplies no reason to show

R5.1 requires a `refused` or `denied` result to show “its reason.” The enrollment module contract returns only `Promise<"added" | "refused" | "denied">`. Neither failure string carries a reason. The built implementation likewise reduces a configuration denial to `"denied"`. A UI test supplying the documented result cannot produce the required reason without inventing it or depending on a different contract.

Fix: Specify fixed UI messages for the two failure strings, or explicitly extend the enrollment result contract with safe reason codes.

## F70. Medium. R5.3: `unavailable` is inside the cancel result, not an alternative to it

Entry's documented result has only `kind: "value"` and `kind: "cancel"`. Native unavailability is `{ kind: "cancel", why: "unavailable" }`, while `pickMethod` can separately return the route `"unavailable"`. R5.3 says a cancel stops, then says unavailable shows the manual-entry instructions. Applying the general cancel rule first swallows native unavailability, including the result when neither Linux dialog starts under entry R2/F63.

Fix: Branch on the selected route and then on `Entered.kind` plus `Entered.why`, handling `cancel/unavailable` before the ordinary cancellation stop.

## F71. Medium. R2–R5: no redraw is required when the module's data changes

The band and pane depend on enrollment, requests, counts, and flow choices held in module closures. R3 requires `$.ui.status`, but no requirement calls `$.ui.invalidate("ui.render")` or writes subscribed reactive state after these changes. The host cannot detect module-variable changes. Its drawings remain snapshots until site props change, a resize occurs, or the plugin requests a redraw (`docs/mods/build/draw-in-the-interface.md`, “Redraw a site,” lines 727–766, and `index.d.ts:2382–2399`). A successful idle save does not change Pane props, so an already-open pane can keep showing Requested without its Continue action.

Fix: Require render invalidation after each enrollment, request, flow-outcome, and rewrite-count change, or specify an equivalent safe reactive-state subscription.

## F72. Medium. R2: the band does not yield to an engine survey

R2 adds the request line whenever a request is open. The `AbovePrompt` declaration also supplies `hasSurvey` and explicitly says a hook yields while it is true (`index.d.ts:11062–11066`). Keeping the tree from `next` is correct for other mods, but it does not satisfy that separate survey rule. As specified, blindfold adds its own digit buttons while the engine's question owns the band.

Fix: When `e.props.hasSurvey` is true, return `next(e)` unchanged and leave the request available through the pane and status line.

## F73. Medium. Module shape and R4: display-redacted identities cannot drive the required row actions

Enrollment R10 replaces a name containing a kept value with `[hidden name]`, and a path with `[hidden path]`, before returning `Status`. `rowsOf` takes that display status, and `Row` contains only the displayed name and file strings, with no opaque operational identity. For example, if one value is the made-up string `ORCHARD42` and another env entry is named `ORCHARD42`, the second row's name is `[hidden name]`. It cannot be passed to the required Enter-value flow because it fails name validation and is not the real assignment name. A redacted path likewise is not a valid identity for `enrollment.forget`. Returning raw strings in Row would instead violate R7.

Fix: Separate safe display strings from opaque row/file identities resolved inside enrollment, or explicitly disable actions whose identities were hidden.

## F74. Medium. R1, R3, and R6: persistent feedback is required but cannot be represented

R6 says the pane and status line hold every state and a toast is never the only signal. R1 expressly gives an invalid command only a toast and says nothing else happens. More generally, `statusLine(status, request)` can represent only degraded enrollment, an open request, or no line. It has no flow-outcome input for an enrollment refusal, unavailable dialog, save failure, or mode warning. R4 also defines no retained outcome display. For an ordinary `/secrets set NAME` with no open request and otherwise healthy enrollment, a failed save therefore has no specified persistent status representation.

Fix: Define a retained, value-free UI outcome shared by the pane and status line, and include it in their rendering contracts.

## F75. Low. R4: counting hits is not counting rewritten results

R4 promises the count of results the shield rewrote for a name, then instructs shield to add one for each known hit. One result containing the same value twice has two hits but is only one rewritten result. A read-only pure probe confirmed two known hits for a single string containing the made-up `orchard42` twice. The instruction also does not restrict increments to successful tool-result rewrites, as opposed to argument scans or other shield paths.

Fix: Increment once per distinct known name in each tool result actually rewritten, not once per scan hit.

## F76. Low. Testing strategy and R7: literal-value assertions cannot detect a length leak

The specified R7 assertion searches serialized trees, toasts, and status lines for the fake value. A character count, a length-dependent mask, or another length-derived field contains no copy of that value and passes this test while violating R7. The same assertion says nothing about writes to `$.state` or `$.store`, which R5 separately forbids for values.

Fix: Add different-length canaries with assertions against length-dependent output, and spy on state/store writes as well as rendered and notification output.

Verdict: Request changes. The spec does not yet define a leak-safe, lifecycle-safe UI flow.
