# blindfold

blindfold is a Claude Code mod that keeps the secret values in your env files out of the conversation with Claude. It hides them in tool results, prompts, file mentions, agent tasks, and the stored transcript. When Claude needs a key that is missing, it asks for it by name with the `request_secret` tool, and you type the value into a native dialog with hidden text. blindfold saves the value to your env file. Claude sees the name, never the value.

Tested with Claude Code v2.1.318 on macOS. The Linux and Windows code ships but is not tested.

To install blindfold, run `/plugin install blindfold --marketplace davegomez/mods` in a Claude Code session. For the shell and the desktop app, see [Install a mod](../README.md#install-a-mod).

- [Tutorial: give Claude a key it asked for](#tutorial-give-claude-a-key-it-asked-for)
- How-to guides: [protect more env files](#how-to-protect-more-env-files), [add a value in your editor](#how-to-add-a-value-in-your-editor), [choose whether values are saved](#how-to-choose-whether-values-are-saved), [choose how you enter a value](#how-to-choose-how-you-enter-a-value), [dismiss a request](#how-to-dismiss-a-request), [read a file again after you edit it](#how-to-read-a-file-again-after-you-edit-it), [stop protecting a file](#how-to-stop-protecting-a-file)
- [Reference](#reference)
- [Explanation](#explanation)

## Tutorial: give Claude a key it asked for

In this tutorial, we let Claude ask for a key that does not exist yet, enter it in the dialog, and let Claude go on. It takes about 3 minutes and needs a Mac.

1. Make an empty folder, run `git init` in it, and start Claude Code there. The folder has no `.env` file yet.

2. Send this prompt:

   ```text
   Use request_secret to ask me for STRIPE_API_KEY. The reason is: the payment test needs it.
   ```

   Claude calls the tool and ends its turn. Notice 3 signs of the request:

   - a toast: `Claude asks for STRIPE_API_KEY. Run /secrets or use the band.`
   - the band above the prompt: `Claude asks for STRIPE_API_KEY:` and the reason, with the buttons `1` Enter it here (blindfold saves it to .env), `2` Add it myself, and `3` Dismiss
   - the status line: `STRIPE_API_KEY requested, run /secrets`

3. Run `/secrets set STRIPE_API_KEY`. You can also press `1` while the prompt is empty. A dialog titled `blindfold` opens. It reads `Enter the value for STRIPE_API_KEY.` and the reason below it.

4. Type a made-up value, such as `not-a-real-key-123456`. The field shows dots. Click `Save`.

5. Look at the band again. It now ends with `STRIPE_API_KEY is set.` and shows `4` Continue and `3` Dismiss. blindfold has created `.env` with mode `600`, so only you can read it, and has added `/.env` to `.gitignore`.

6. Run `/secrets continue`, or press `4` while the prompt is empty. Claude gets the message `STRIPE_API_KEY is now set. Continue the task that needed it.` and goes on.

7. Send this prompt:

   ```text
   Show me the content of .env.
   ```

   Notice that Claude sees `[secret: STRIPE_API_KEY]` where the value is.

You have given Claude a key without putting it in the conversation. From now on, every value in `.env` that looks like a secret is hidden from Claude in the same way.

## How-to guides

### How to protect more env files

blindfold reads `.env` in the project folder by default.

1. Open `/config`, or `~/.claude/settings.json`.
2. Set `envFiles` to the files, separated by commas. Each path is relative to the project folder.

   ```json
   {
     "pluginConfigs": {
       "blindfold@davegomez": {
         "options": { "envFiles": ".env,.env.local,config/.env.test" }
       }
     }
   }
   ```

blindfold reads up to 10 files of 1 MiB or less each. It does not read a symbolic link or a file outside the project folder. A change to this setting reloads the mod and clears an open request.

### How to add a value in your editor

1. Run `/secrets add STRIPE_API_KEY`, or press `2` in the band. blindfold answers `Add STRIPE_API_KEY= to .env in your editor, then press Refresh.`
2. Add the line in your editor and save the file.
3. Run `/secrets refresh`, or press Refresh in the pane.

If a request was open for that name, it is now ready. Run `/secrets continue`.

### How to choose whether values are saved

Set `saveToEnvFile` in `/config` or under `pluginConfigs`:

- `ask` (the default): the band offers `1` Enter it here, `2` Add it myself, and `3` Dismiss. `/secrets set NAME` counts as the answer Enter it.
- `always`: the band offers `1` Enter it, and the value is saved without a question.
- `never`: blindfold opens no dialog and tells you to add the line in your editor, as in [How to add a value in your editor](#how-to-add-a-value-in-your-editor).

### How to choose how you enter a value

Set `inputMethod` in `/config` or under `pluginConfigs`:

- `auto` (the default) uses the native dialog of your system.
- `native` uses only the native dialog. When your system has none, blindfold tells you to add the value in your editor.
- `terminal` is not available yet and works as `auto`.

On Linux, the native dialog needs a graphical session and `zenity` or `kdialog`.

### How to dismiss a request

Run `/secrets dismiss`, press `3` in the band, or press Dismiss in the pane. Any prompt you send also clears the request.

### How to read a file again after you edit it

Run `/secrets refresh`, or press Refresh in the pane. blindfold also reads a listed file again when a tool call names it, so a change that Claude makes is seen at once.

### How to stop protecting a file

1. Remove the file from `envFiles`.
2. To drop its values in the current session, run `/secrets` and press `Forget <file>` in the pane.

Forget alone lasts only until blindfold reads the listed files again, for example after Refresh.

## Reference

### Commands

| Command | What it does |
| :- | :- |
| `/secrets` | Opens the `blindfold` pane. |
| `/secrets set NAME` | Opens the dialog for `NAME` and saves the value. With `saveToEnvFile` set to `never`, shows the line to add by hand. |
| `/secrets add NAME` | Shows the line to add by hand: `Add NAME= to FILE in your editor, then press Refresh.` |
| `/secrets continue` | Sends Claude `NAME is now set. Continue the task that needed it.` when the request is ready. Otherwise answers `Nothing is ready to continue.` |
| `/secrets dismiss` | Clears the open request. Answers `Nothing is requested now.` |
| `/secrets refresh` | Reads the listed env files again. Answers `blindfold read the env files again.` |

`/secrets` takes a name, never a value, because Claude Code stores the command line in the transcript. A name uses letters, digits, and `_`, starts with a letter or `_`, and has at most 64 characters. Any other argument, and a name that holds a known secret value, is refused with `/secrets takes a name, never a value.` blindfold then stores the command line without the arguments.

Only 1 dialog runs at a time. A 2nd start answers `blindfold is already asking for a value.`

### The `request_secret` tool

Claude sees it as `mcp__blindfold__request_secret`, with 2 inputs: `name` and `reason`. Claude gets 1 of these answers:

| Case | Answer |
| :- | :- |
| The name has a value in a listed file | `NAME is set in .env. Use it by name through the app's env loader.` |
| The name is missing or empty | `NAME is not set. The user was asked to enter it. End your turn. Do not ask the user to paste it in chat.` A request opens. |
| A listed file could not be read | One of the answers above, followed by `blindfold cannot confirm the env file now.` |
| The name breaks the name rule, or looks like a secret | A refusal, and no request opens. |

The reason is cut to 120 characters. A reason that holds a secret is shown as `(reason hidden: it held a secret)`.

At most 1 request is open. A new request replaces the old one. A request clears on Continue, Dismiss, a prompt you send, a settings change, or the end of the session.

### The band

While a request is open, blindfold adds 1 line above the prompt. A digit typed while the prompt is empty presses the band button with that hotkey.

| State | Text | Buttons |
| :- | :- | :- |
| Pending | `Claude asks for NAME: <reason>.` | `1` Enter it here (blindfold saves it to FILE), or Enter it with `saveToEnvFile` set to `always`. `2` Add it myself. `3` Dismiss. |
| Pending, no listed file can take a value | `Claude asks for NAME: <reason>. No listed env file can take it.` | `1` Use .env. `2` Use .env.local. `3` Dismiss. |
| Ready | `Claude asks for NAME: <reason>. NAME is set.` | `4` Continue. `3` Dismiss. |

When Claude Code shows a question of its own in that place, the band stays hidden. The pane and the status line still show the request.

### The pane

`/secrets` opens the `blindfold` pane. It holds:

- 1 row per name in each listed file, and 1 row for the requested name when it is in no file. Each row shows the name, the file, the state, a git warning, and how many tool results the shield changed for that name in this session, such as `STRIPE_API_KEY in .env: Set, 2 results hidden`. A row never shows a value or its length.
- 1 row for a listed file that blindfold did not read, with its state.
- The result of the last save.
- When no listed file can take a value: `Pick the env file for NAME:` with `Use .env` and `Use .env.local`.
- `Forget <file>` for each listed file, `Refresh`, and `Continue` when the request is ready.

| State | Meaning |
| :- | :- |
| `Set` | The name has a value. |
| `Requested` | Claude asked for the name, and it has no value. |
| `Empty` | The name is in the file with an empty value. |
| `Missing` | The file does not exist. blindfold creates it on the first save. |
| `Stale, could not be read` | The file is too large, not a regular file, or the read failed. |
| `Refused, blindfold will not read it` | The path is absolute, leaves the project folder, is a symbolic link, or is past the 10th entry. |

The git warnings are `not ignored by git` and `tracked by git`. A name or a path that holds a known secret value reads `hidden, because it holds a secret value` and has no buttons.

In the terminal, the pane has letter hotkeys: `e` Enter value and `d` Dismiss on the requested row, `c` Continue, and `r` Refresh. In a pane narrower than 60 columns, each row's buttons sit below its text.

### Settings

| Setting | Default | Values |
| :- | :- | :- |
| `envFiles` | `.env` | The env files to protect, separated by commas, relative to the project folder. Up to 10 files of 1 MiB or less each. |
| `saveToEnvFile` | `ask` | `ask`, `always`, or `never`. |
| `inputMethod` | `auto` | `auto`, `native`, or `terminal`. `terminal` works as `auto` for now. |

Set them in the install screen, in `/config`, or under `pluginConfigs` in `~/.claude/settings.json`, under the plugin ID `blindfold@davegomez`.

### Status line

Claude Code shows the mod name before the text. blindfold shows the first that applies:

| Text | When |
| :- | :- |
| `degraded, FILE could not be read. New values may not be hidden.` | A listed file is stale or refused. |
| `NAME not saved, run /secrets` | The last save failed. |
| `NAME requested, run /secrets` | A request is open. |

### Toasts

| Toast | When |
| :- | :- |
| `Claude asks for NAME. Run /secrets or use the band.` | A request opens. |
| `blindfold hid N secrets in your prompt` | Your prompt held secrets, and blindfold replaced them. |
| `blindfold hid a secret that an earlier check missed. Rotate it.` | The last check before a transcript row is stored found a secret. |
| `Continue was not sent. Ask Claude again.` | Claude Code did not take the Continue message. |

A toast is never the only signal. The pane and the status line hold every state.

### What the shield hides

A value is protected when its name holds `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PWD`, `DSN`, `AUTH`, `CREDENTIAL`, or `PRIVATE`, in any case, or when the value looks like a secret, such as a database URL with a password. A value shorter than 8 characters is not hidden as a known value. A value removed from the file stays hidden until the session ends or you forget the file.

The shield also finds the base64, URL, and hex forms of each known value, private key blocks, the key formats of common vendors, and values after words such as `token=` or `Bearer`.

| Where | What blindfold does |
| :- | :- |
| Your prompt | Replaces the secret. A prompt with a slash command and a secret is dropped. |
| A tool call's arguments | Refuses a call that holds a known value, a private key, or a vendor key, and tells Claude to use the env variable name. |
| A tool result | Replaces the secret, or withholds the whole result when it cannot scan it. |
| An `@` mention | Refuses a listed env file, and any file named `.env` or `.env.*`. |
| Context, sections, attachments, skill text | Replaces the secret, or leaves the text out. |
| An agent task | Refuses the agent. |
| A message to or from another session | Refuses an outgoing message. Replaces the secret in an incoming one. |
| The stored transcript | Checks each row again before it is stored. |

A known value becomes `[secret: NAME]`. Any other find becomes `[secret hidden]`. A marker never turns back into a value.

### The dialog

| System | Dialog |
| :- | :- |
| macOS | `osascript` dialog with hidden text, titled `blindfold`, with `Cancel` and `Save`. |
| Linux | `zenity`, else `kdialog`, with hidden text. Needs a graphical session. |
| Windows | A PowerShell dialog with a password field. |

The dialog closes after 5 minutes. Cancel, an empty value, and the time limit save nothing, and the request stays open. blindfold keeps the value exactly as typed, with spaces, quotes, `$`, and non-ASCII text.

### The save

blindfold saves to the first listed file that it could read, else to the first listed file that is missing. The steps run in this order, and the first failure stops the save:

| Step | What happens | Refused when |
| :- | :- | :- |
| `path` | Checks the target path. | The path has characters other than letters, digits, `.`, `_`, `-`, and `/`, is a link, is outside the project folder, or is not a regular file. |
| `git` | Makes sure git ignores the file, and adds `/FILE` to `.gitignore` if needed. Skipped outside a git repository. | git tracks the file, or the file sits inside another git repository. |
| `create` | Creates a missing file with mode `600`. | The folder does not exist, the file appeared meanwhile, or, on macOS and Linux, the system cannot make a hard link. |
| `changed` | Reads the file again. | The file changed since the first read. |
| `value` | Builds the new file text. | The name is in the file more than once, the value has control characters or is longer than 65,536 characters, or the file is too large. |
| `write` | Writes the file. Other lines stay as they were. | The write fails. |
| `verify` | Reads the file back. | The file does not hold exactly the value. |
| `mode` | Checks that a new file still has mode `600`, and repairs it. | The mode cannot be read or repaired. |

A failure shows `Not saved: step <step>, <reason>.`, such as `Not saved: step git, tracked.` A repaired mode shows `Saved. The file was readable by others for a moment.` No message names the value.

The shield knows the value before the write, so it stays hidden even when a later step fails.

### Live test results

A live run on 2026-11-07, Claude Code v2.1.318, macOS, in a scratch git repository with a made-up value:

- The dialog showed dots, and VoiceOver read its text.
- `.env` held the value byte for byte, with mode `600`, and git ignored it.
- Claude saw the marker when it read `.env`.
- Cancel changed no file. The dialog closed after 5 minutes.
- `/secrets set NAME extra` was refused, and the transcript kept no arguments.
- The value was in neither the transcript nor the debug log.
- The `request_secret` tool was still there after `/clear`.

### Stored data

blindfold stores nothing. Values live in memory while the session runs and are dropped when it ends.

### License

blindfold is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

## Explanation

### Why Claude asks by name

A value you paste into the chat goes into the transcript and into every later request to the model. With `request_secret`, Claude names what it needs and ends its turn. The value travels from the dialog to the env file and nowhere else. Claude then uses the key through the app's own env loader, such as `process.env.STRIPE_API_KEY`.

For the same reason, `/secrets` takes a name and never a value. blindfold cannot hide a value it does not know yet, and the command line is stored as typed.

### Why the save runs in this order

The value goes on disk only after git ignores the file and a new file has mode `600`. A crash between the steps then leaves an empty, private, ignored file, not a value that git could commit. blindfold creates the file through a hard link, which fails when the file already exists, so it never overwrites a file that appeared meanwhile.

### Why other mods can see the value

Mods run in a chain. A mod earlier in the chain sees the result of the dialog and the text of the file write before blindfold gets it. blindfold cannot hide a call from those mods. Other mods are trusted code, as any mod runs with your permissions.

### Limits

- Tested on macOS only. The Linux and Windows code ships but is not tested.
- On Windows, blindfold does not set mode `600`. The folder's access rules apply. A narrow window exists in which a file that another program creates at the same moment is overwritten.
- A value that blindfold does not know yet, and that looks like a name, cannot be told from a name. Type only names after `/secrets`.
- Mods earlier in the chain can see the value in the dialog result and the file write.
- Images and other media are not scanned.
- A crash during the file write can damage the file.
- On macOS and Linux, the save needs hard links. On every system, it refuses a folder that does not exist. It never creates folders.
- Programs that read your env file can still show or send the value. Claude refers to a secret by name, but a command that prints the file prints it to that program's output. blindfold hides it from Claude only.
- The screen can show a transcript row for a moment before the last check rewrites it.
- If the band or the pane does not take the keys in your terminal, every button has a `/secrets` command.
- The shield works only while the mod runs. If the mod stops or crashes, text passes unchanged.
