# Spec: blindfold `request`

Module id: `request`. Capability map: `capability-map.md`. Design: `docs/ideas/secret-mod/design.md`, section 1c. Depends on `enroll` (`status`). `ui` draws the request and its buttons. `entry` and `write` fill it.

API facts come from the Claude Code 2.1.318 declarations (`blindfold/.claude-plugin/types/claude-code/index.d.ts`, written `d.ts:N`) and `docs/mods/`.

## Objective

Claude asks for a secret by name with the tool `request_secret`. The tool returns the real state of that name at once and never a value. When the name is missing, the mod keeps 1 pending request, which `ui` shows. When the value is saved, the user presses Continue, and the mod starts 1 turn that tells Claude the name is set.

Success: Claude can ask for a missing secret, the user can provide it outside the chat, and Claude continues without ever seeing the value.

### Module shape

```ts
// Pure:
export const TOOL_NAME = "request_secret";
export function validName(name: unknown): name is string;          // R2
export function cleanReason(reason: unknown): string;              // R2
export function statusText(name: string, status: Status): string;  // R3
export type Request = { id: string; name: string; reason: string; state: "pending" | "ready" };
export function createRequests(): {
	ask(name: string, reason: string): Request;     // R4: supersedes any open request
	sync(status: Status): void;                     // R4: pending <-> ready from the status
	consume(status: Status): Request | undefined;   // R4, R5: ready and still set -> cleared, returns it once
	clear(): void;                                  // R4
	current(): Request | undefined;
};
// Thin, wired in register.ts:
export function onRequestSecret($, enrollment, requests, e, next); // R1, R3
export function continueRequest($, enrollment, requests): Promise<void>; // R5, called by `ui`
```

### Requirements

R1. The tool. At `session.start`, call `$.tool.register({ name: "request_secret", description, inputSchema, isDeferred: false })` (`d.ts:3193`, `d.ts:14343`). The model sees it as `mcp__blindfold__request_secret`. The input schema has `name` (string) and `reason` (string), both required. A `tool.call` hook with the matcher `{ tool: "mcp__blindfold__request_secret" }` answers the call without `next`, because a call that no hook answers fails (`d.ts:3182`). `register.ts` wires this hook after the `shield` hook, so `shield` scans the arguments and the result (R4 and R5 of `SPEC-shield.md`).

R2. Validation. `name` matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, and `dotenv.isValidName` accepts it, which refuses `__proto__` (F54). A name that does not match returns `{ deny }` with the rule, and no request is made. `reason` is cut to 120 characters, and control characters are removed. Then `detect` scans the name and the reason with every rule (known, vendor, private key, and context). A hit in the name returns `{ deny }`, and no request is made. A hit in the reason replaces the reason with "(reason hidden: it held a secret)" in the request. The arguments that go on to the shield and the transcript do not change (F65). `ui` draws the reason as plain `Text` only.

R3. The answer. `{ result: statusText(name, enrollment.status()) }`, which is 1 of these:

- The name is set in an active listed file with a value that is not empty: "NAME is set in .env. Use it by name through the app's env loader."
- The name is not set: "NAME is not set. The user was asked to enter it. End your turn. Do not ask the user to paste it in chat." A request is made (R4).
- The shield is degraded: the text above, plus "blindfold cannot confirm the env file now."

This needs 1 change in `enroll`: `NameState.why` gets the value `"empty"` for a name whose value is empty. A status still holds no value.

R4. Lifecycle. At most 1 open request. The id comes from `crypto.randomUUID()` (`d.ts:16277`).

| From | Event | To |
|---|---|---|
| none | `request_secret` for a missing name | pending |
| pending or ready | a new `request_secret` for a missing name | the old one is cleared, the new one is pending |
| pending | a status shows the name set in an active file | ready |
| ready | a status shows the name missing, empty, or its file stale or gone | pending (F53) |
| ready | the user presses Continue | cleared, then 1 `$.prompt.submit` (R5) |
| pending or ready | Dismiss, `session.end`, a module reload, or a user prompt | cleared |

Each clear starts a new epoch. A `request_secret` call that started in an older epoch answers from the status but makes no request, so a call that waited during a clear cannot open a request again (F62).

A user prompt is a `prompt.submit` whose `origin` is not `{ kind: "plugin", name: $.plugin.name }` (`d.ts:9470`, `d.ts:2355`). A `prompt.submit` that runs `/secrets` does not clear, because that command answers the request (ui R1). `register.ts` already has the `shield` hook for `prompt.submit` without a matcher, so the same hook clears the request first (1 hook without a matcher per event).

R5. Continue. `continueRequest` reads `enrollment.status()` and calls `consume(status, id)` with the id of the request the button was drawn for, and consumes nothing when the open request has another id (F80). It returns the request only when it is ready and the name is still set in an active file, and it clears the request before the submit, so a 2nd press does nothing (F53). `request` calls `sync` after each `load`. Then `$.prompt.submit({ text: "NAME is now set. Continue the task that needed it." })` (`d.ts:4955`). It is called from a button handler, never from a hook, because the submit waits until the session is idle (`build/use-the-mods-api.md`, "Start a turn from a background job"). A result with `drop` shows the toast "Continue was not sent. Ask Claude again." There is no retry (Q38).

R6. No leak. No request, tool answer, toast, `$.state`, or `$.store` holds a value. The tool answer holds a name and a file path only.

### Not in scope

Drawing the band, the status line, the pane, and the buttons (`ui`). Entry (`entry`). Writing (`write`). More than 1 open request.

## Tech stack, commands, project structure, code style

Same as `SPEC-detect.md`, with the 4 commands (Q24). Files: `blindfold/hooks/request.ts`, `blindfold/tests/request.test.ts`, `blindfold/hooks/register.ts`, `blindfold/hooks/enroll.ts` (the `"empty"` reason).

## Testing strategy

- Pure tests for R2, R3 (each text), and every row of the R4 table.
- Stub tests with `fakeApi`: R1 registers at `session.start`, the hook answers without `next`, a bad name is denied. R4 clear on a user prompt and no clear on blindfold's own submit. R5: a 2nd press does nothing, a `drop` shows the toast.
- R6: the JSON text of every answer, toast, and request holds no fake value.

## Boundaries

- Always: answer from the real enrollment status. Clear before a submit.
- Ask first: a change to the tool name, the texts in R3 and R5, or `isDeferred`.
- Never: return a value. Await `$.prompt.submit` inside a hook. Retry a dropped Continue.

## Success criteria

- The 4 commands pass. Every requirement R1 to R6 has a test that names it.
- The tool shows in a session as `mcp__blindfold__request_secret` (checked in the milestone 5 live run, G2).

## Decisions

- Q37. `request_secret` is not deferred (`isDeferred: false`), so Claude sees it without a ToolSearch and knows to ask instead of asking for a paste. It adds its description to every request. Accepted (agent decision, owner delegated 2026-11-06).
- Q38. A user Stop does not clear the request, because no hook reports it reliably. A Continue after a Stop is dropped by the host ("the session was stopped and nobody has sent input since"), and the request clears with the toast in R5. The design listed Stop as a clear event. Accepted (agent decision, owner delegated 2026-11-06).
- Pi review F62 (`reviews/step4-code-pi.md`) is applied in R4. Accepted (agent decision).
- Pi review F65 (`reviews/ui-spec-pi.md`) is applied in R2. Accepted (agent decision).
