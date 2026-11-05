# Claude's proposal: "blindfold"

Written independently of Pi's proposal. Doc citations use `docs/mods/<file>` and the section name. UNVERIFIED marks a claim the docs do not confirm.

## 1. The main idea: reference by name, never restore

secret-box gives Claude a placeholder and changes it back to the real value inside the tool input. The docs show 3 problems with that, apart from F1 and F2:

- The permission check runs after `tool.call` rewrites the input (`build/react-to-events.md`, "Guard or change a tool call": "When you call next(e), Claude Code runs the permission check and then the tool"). So the permission prompt shows the real key on screen.
- In auto mode, a changed input is denied: "a hook changed this call's input after the model wrote it" (`test-and-troubleshoot/troubleshoot.md`, "A tool call is denied"). So secret-box restore does not work in auto mode.
- If the classifier ever sees the rewritten command, the key goes to a model. (UNVERIFIED in which order; the troubleshoot entry suggests the classifier sees the model's text, which is good, but the deny makes the feature useless there.)

blindfold never puts a value into a tool input. Claude refers to a secret by its name:

- Code: `process.env.STRIPE_SECRET_KEY`, loaded from `.env` by the project's own loader.
- Shell: `set -a; . ./.env; set +a; curl -u "$STRIPE_SECRET_KEY:" https://api.stripe.com/v1/balance`. The shell expands the variable. The command text, the permission prompt, the classifier, and the transcript hold only the name.

Results:

- F1 changes form. Exfiltration needs `$NAME` in a command that goes to a strange host. The name is visible in the permission prompt, and a `tool.check` hook can act on it (section 4).
- F2 goes away. Claude does not know the value, so it cannot write it into a file. A `Write`/`Edit` that holds a known value exactly is denied as a second layer.
- Auto mode works, because no hook changes the input.
- No placeholder vault, no `LITERAL` escape, no restore logic. Less code to get wrong.

## 2. Collect the secret: native masked dialog first, TUI pane second

`$.process.run` waits inside a mods API call, so the time does not count against the 10 s hook budget (`reference.md`, "Limits"; `build/use-the-mods-api.md`, "Run work in the background"). Its timeout can be up to 10 minutes. A native OS dialog with a real password field therefore needs no busy-wait (fixes F4):

- macOS: `osascript -e 'display dialog "…" default answer "" with hidden answer'` (UNVERIFIED: exact argv and stdout format; test on this machine).
- Linux: `zenity --password` or `kdialog --password` when present.
- Windows: a PowerShell credential prompt (UNVERIFIED).

Benefits: a real masked field (fixes F5 and the 1-frame flash), the OS clipboard, and a screen reader that already knows the control. The value goes from the process stdout to mod memory, never to the transcript. Argv holds only the prompt text, never the value.

Fallback when no dialog program exists (SSH session, headless Linux, Desktop app on WSL is out of scope): a TUI pane with a masked `Input`, as secret-box does. Make it strict: if `onInput` text does not have the form `•*[^•]*` (an edit in the middle), clear the field and show "Edit from the end only, or press Ctrl+U". Note that `onInput` passes the typed text to other mods through `ui.input` (`build/draw-in-the-interface.md`, "Which controls need a key"). Installed mods are trusted code anyway (`overview.md`, "What a mod can reach").

## 3. Flow: Claude asks, the user acts, Claude continues

Tool `request_secret { name, reason, hosts? }`. It does not block:

1. The tool returns at once: "Asked the user for STRIPE_SECRET_KEY. End your turn. You get a message when it is set."
2. The mod shows a band above the prompt: "Claude asks for STRIPE_SECRET_KEY (reason). 1: enter it · 2: refuse". Also a toast and a status line, because the band can be collapsed (`build/draw-in-the-interface.md`, "When the user collapses the band").
3. The user presses `1` (a digit hotkey on the band works from an empty prompt, `reference.md`, "Elements"), or runs `/secret set STRIPE_SECRET_KEY`. Because the user started it, a pane can open at any terminal width (`build/draw-in-the-interface.md`, "When a pane waits for a wider terminal"). This fixes the narrow-terminal problem of secret-box.
4. After the save, the mod calls `$.prompt.submit({ text: "STRIPE_SECRET_KEY is set in .env. Use it by name." })` to start the next turn (`build/use-the-mods-api.md`, "Start a turn from a background job"). Handle a dropped submit with the retry pattern in the same file.

The user can also add a secret without Claude: `/secret set NAME` (registered with `immediate: true`).

## 4. Per-secret host binding (new)

When the user enters a secret, the pane asks which hosts may receive it. The mod fills a default from the key shape (`sk_live_`/`sk_test_` gives `api.stripe.com`, `ghp_` gives `api.github.com`, and so on). The binding lives in `.env` as a comment line, or in a second git-ignored file (`.env.hosts`). It is not a secret, so it can be in a file. It stays out of `$.store` (numbers only).

A `tool.check` hook on Bash (`build/react-to-events.md`, "Approve or refuse a tool call before the user is asked"):

- The command names a known secret variable, and it contains a network program (`curl`, `wget`, `http`, `nc`, `ssh`, …) or a URL whose host is not bound to that secret: return `ask` with a reason such as "STRIPE_SECRET_KEY may go only to api.stripe.com. This command sends to evil.example". The decision goes to the user. Never `allow`.
- `tool.check` runs after `PreToolUse` hooks and before auto mode's classifier, so the `ask` also stops auto mode (UNVERIFIED: whether `ask` in auto mode prompts the user or goes to the classifier).

This is text matching, so it is a speed bump, not a sandbox. It makes the prompt-injection case visible to the user.

## 5. Scrub on the way out, with exact values first

Order of detectors, by precision:

1. Exact values the mod knows: every value in `.env` files of the project with a secret-like name, and every value the user entered. Also their common encodings: base64, URL encoding, and hex (fixes part of "transformed output is not seen").
2. A small curated vendor-prefix list (Stripe, GitHub, AWS, Slack, OpenAI, Anthropic, Google, private key blocks).
3. Entropy, only after a key word (`token=`, `Bearer `, `"api_key":`).

Replace a hit with `[secret: STRIPE_SECRET_KEY]` when the value is known, or `[secret hidden]` when it is not. No placeholder that a tool turns back into a value, so no vault mapping is needed.

Where to scrub:

- `tool.call` result, after `await next(e)` (`build/react-to-events.md`, "Guard or change a tool call").
- `prompt.submit` text and context, `prompt.context`, `prompt.attachment`, `prompt.mention` (deny `@.env`), `agent.spawn` prompt (`reference.md`, "Events").
- `session.append` as the last layer before the transcript is stored (`reference.md`, "Session"). secret-box does not use this event. If this layer finds a value that the earlier layers missed, the value may already be in a model request, so show the rotate advice (section 7).

Every scrub hook gets a `.catch` that fails closed (`build/react-to-events.md`, "Handle a hook that fails"). A `.catch` has a 1 s limit (`reference.md`, "Limits"), so it must not scan, only withhold.

## 6. Git: guard by content, not by file name

- Before a Bash command that runs `git commit`, `git push`, or `gh` (same regex risk as F6), run `git diff --cached` and search the diff for known values (exact match). This catches a key in any file, not only `.env`.
- `.env` writes: `.gitignore` first, `git check-ignore` to confirm, refuse a tracked file. Keep these from secret-box.
- Write `.env` safely: parse with the same assignment rule for read and write (fixes F7), quote with single quotes when the value has no `'` (fixes F3), and set mode 0600 with `chmod` through `$.process.run` (UNVERIFIED: the mode `$.fs.write` uses).

## 7. Usefulness

- `/secret` pane: a list of secret names (never values), the file each lives in, the bound hosts, how many times this session referenced each one, and buttons: set, rotate, remove binding. Numbers only, so a session count is fine in memory. Persist counts in `$.store` only as numbers keyed by session ID, as ember does.
- Rotate advice: when a value of a known vendor shows in a place it should not (the `session.append` layer, or the user pasted it in a prompt that was then scrubbed), show a `Link` to that vendor's key page and a band line "rotate this key".
- "Rescue paste": a `prompt.submit` that holds a key is not sent. The text returns to the prompt with the key replaced by `$NAME`, and the band offers to save the removed value under that name (`build/react-to-events.md`, "Rewrite or add to a prompt": a `drop` puts the text back). UNVERIFIED: whether a hook can drop and also change the text that goes back.
- A short system prompt section that lists secret names and bound hosts, so Claude knows what exists (`prompt.section` / `prompt.compose`, `reference.md`). It changes only when the list changes, to keep the prompt cache.

## 8. Accessibility

- The native dialog is the most accessible path.
- In the TUI: every state in words, not only color. A character count in words. Buttons with visible hotkeys (`plain: true`). The same actions available as `/secret` commands, so a user who cannot use the band can still act.
- VS Code: buttons have no hotkeys, so labels must stand alone (`build/draw-in-the-interface.md`, "Draw in the VS Code extension").

## 9. Threat model and promises

We promise:

- A secret the user enters through blindfold never enters a model request, the transcript file, a permission prompt, or a tool input.
- A known secret printed by a tool, pasted in a prompt, or read from a file reaches Claude as `[secret: NAME]`.
- A known secret is not committed through a command that Claude runs.

We do not promise:

- Protection against a model that sends `$NAME` to a host the user approves at the prompt, or that transforms the value in a way the encodings in section 5 miss.
- Protection against another installed mod, or a process outside Claude Code.
- Detection of an unknown secret with no vendor shape and no key word.

## 10. Open questions for Pi

- Q1. Is `.env` the right home, or do we add an OS keychain mode where the mod writes a temporary 0600 env file per command? The second needs input rewrite, which brings back the auto-mode problem.
- Q2. Is the async flow (section 3) acceptable UX, or must `request_secret` block until the user answers?
- Q3. Do we copy the secret-box detector (MIT) or start with the 3-layer list in section 5 and grow it with tests?
- Q4. Should host binding be on by default, or opt-in?
