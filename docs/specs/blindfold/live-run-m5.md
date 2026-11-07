# Live run: milestone 5

Gates G1, G2, G3 (design 1i) and F58, on macOS. The agent drives the Claude Code session in a herdr pane and checks every file. The owner does only the steps marked OWNER. The fake value is made up and is used nowhere else.

Fake value: `fake ñ "q" $HOME x` (spaces, double quotes, `$`, non-ASCII).

## Setup (agent)

1. A scratch git repository `~/.cache/blindfold-m5` with 1 commit, an empty `.gitignore`, and no `.env`.
2. A Claude Code session in a herdr pane, cwd the scratch repository: `claude --plugin-dir <repo>/blindfold --debug-file <scratch>/debug.log`.
3. 1 prompt per check. Each prompt spends plan usage; the owner approves the run once.

## Steps

| # | Who | Action | Pass when |
|---|---|---|---|
| 1 | agent | Prompt: call `request_secret` for `BLINDFOLD_FAKE_TOKEN`, reason "live test". | The tool is `mcp__blindfold__request_secret` (G2). The band, the toast, and the status line show the request. |
| 2 | OWNER | Press `1` in the band. Type the fake value in the dialog. Press OK. | The field shows dots, not text (G1). |
| 3 | agent | Read `.env` bytes, `stat -f %Lp .env`, `.gitignore`, `git check-ignore -q -- ./.env`. | `.env` holds the value unchanged in the dotenv dialect, mode `600`, `/.env` in `.gitignore`, ignored (G1 encoding, G3, F49). |
| 4 | agent | Press `4` Continue in the band. Prompt: show the content of `.env`. | Claude continues. The tool result shows the masked value only. |
| 5 | agent | `/secrets set OTHER_FAKE`. | The dialog opens. |
| 6 | OWNER | Press Cancel. | The dialog closes, and no file changes (G1 cancel). |
| 7 | agent | `/secrets set BLINDFOLD_FAKE_TOKEN extra`. | The refusal text shows. The transcript row keeps only the canonical args (F64). |
| 8 | agent | Search the transcript JSONL and `debug.log` for the fake value and for its parts `fake ñ` and `$HOME x`. | No match (G2). |
| 9 | agent | `/clear`, then prompt: list your tools that start with `mcp__blindfold`. | The tool is there (F58). |
| 10 | agent | `/secrets set TIMEOUT_FAKE`, then leave the dialog open for 5 minutes. | `pgrep osascript` finds no dialog after 300 s, and the outcome is a cancel (G1 timeout). |
| 11 | OWNER, optional | Turn on VoiceOver (Cmd+F5) during step 5. | VoiceOver reads the prompt text (G1 screen reader). |

## After the run (agent)

Remove the scratch repository and the debug log. Record each result, pass or fail, in `tasks/todo.md` under Checkpoint G. A failed G3 mode check (F49) blocks the release.
