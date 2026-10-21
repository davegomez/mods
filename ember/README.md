# ember

ember is a Claude Code mod that measures how warm your prompt cache stays across idle pauses, and refreshes the cache shortly before it expires. It changes no request, prompt, or tool call, and it never submits a prompt. Its only model calls are the refresh forks, which are on by default.

> **Unverified.** Nobody has yet measured on a live session that a refresh keeps the main cache warm without a new full write. A [live test](#live-test-results) measured the cache report, but no refresh ran. Until the [probe](#how-to-check-that-the-refresh-works) passes, treat the refresh savings as estimates. Each refresh spends plan usage or API credit.

Tested with Claude Code v2.1.306.

To install ember, run `/plugin install ember --marketplace davegomez/mods` in a Claude Code session. For the shell and the desktop app, see [Install a mod](../README.md#install-a-mod).

- [Tutorial: see your cache warmth](#tutorial-see-your-cache-warmth)
- How-to guides: [turn the refresh off](#how-to-turn-the-refresh-off), [set the TTL for your plan](#how-to-set-the-ttl-for-your-plan), [show the cache in your status line](#how-to-show-the-cache-in-your-status-line), [tune the refresh](#how-to-tune-the-refresh), [check that the refresh works](#how-to-check-that-the-refresh-works), [keep the cache of a long conversation](#how-to-keep-the-cache-of-a-long-conversation)
- [Reference](#reference)
- [Explanation](#explanation)

## Tutorial: see your cache warmth

In this tutorial, we start a session with ember, send 2 short prompts, and read the cache report. It takes about 3 minutes.

1. If ember is not installed, install it as shown above. Then start a new Claude Code session.

2. Send this prompt and wait for the answer:

   ```text
   Reply with the word hello.
   ```

3. Run `/ember`. A pane opens. The first line shows the TTL that ember uses, for example `TTL 60m (ttlMinutes option)`. The table has 1 row, `first`, with 1 request.

4. Press Esc to close the pane.

5. Within 2 minutes, send a second prompt:

   ```text
   Reply with the word again.
   ```

6. Run `/ember` again. Notice the new `user` row. Its hit ratio is high, because the second request read the first request's prefix from the cache.

7. Press Esc.

You have measured your own prompt cache. From now on, each pause between your prompts adds a row to the report. When you stay idle for close to the TTL, ember refreshes the cache before it expires.

## How-to guides

### How to turn the refresh off

1. Open `~/.claude/settings.json`.
2. Add the option under the plugin ID `ember@davegomez`.

   ```json
   {
     "pluginConfigs": {
       "ember@davegomez": {
         "options": { "refresh": false }
       }
     }
   }
   ```

3. Start a new session.

ember still logs each pause when the refresh is off, so `/ember-refresh` can tell you later whether to turn it on.

To change when the refresh runs instead, set `refreshLeadSeconds` in the same `options` object. See [Options](#options).

### How to set the TTL for your plan

ember cannot see your plan, so it assumes 60 minutes unless a Claude Code setting says otherwise.

- If you use a Claude subscription within its usage, change nothing. Claude Code uses a 60-minute TTL.
- If you use an API key, a cloud provider, or usage credits, Claude Code uses a 5-minute TTL. Set `"promptCacheTtl": "5m"` in `~/.claude/settings.json`, or set the `ttlMinutes` option to `5` in the install screen or in `/config`. At 5 minutes the refresh stays on unless you set the `refreshShortTtl` option to `false`.
- If you want the 60-minute TTL everywhere, set `"promptCacheTtl": "1h"`. Cache writes then cost 2 times the input price instead of 1.25 times.

Run `/ember` to check the result. The first line names the TTL and its source.

### How to show the cache in your status line

1. In your status line command, read `session_id` from stdin.
2. Find the ember store file and read the `live` object of that session:

   ```bash
   session_id=$(jq -r '.session_id // empty')
   for f in "$HOME"/.claude/plugins/store/ember_*.json; do
     live=$(jq -c --arg k "session:$session_id" '.[$k].live // empty' "$f" 2>/dev/null) && [ -n "$live" ] && break
   done
   echo "$live" | jq -r --argjson now "$(date +%s)" \
     '"\(.ttlMinutes * 60 - ($now - .lastStartMs / 1000) | floor)s left · \(.prefix) cached · hit \(.hit * 100 | round)%"'
   ```

3. Print nothing when the file, the key, or `live` is missing, or when `jq` fails. A file can be half written while you read it.

If your shell runs with `set -f`, use `find` instead of the glob. If you use the VS Code extension, skip this guide: ember sets a status line there for you.

### How to tune the refresh

1. Use Claude Code as usual until `/ember-refresh` has at least 20 returned pauses.
2. Run `/ember-refresh`.
3. Read the `Recommendation` line at the end.
   - If it says to turn the refresh off, [turn it off](#how-to-turn-the-refresh-off).
   - If it names a different lead, set `refreshLeadSeconds` to that value.
   - If your TTL is 5 minutes or less and it says to set `refreshShortTtl` to `false`, set it in the same `options` object. If it says to set it to `true`, set it to `true` or remove it. If it says to keep `refreshShortTtl` on, change nothing.
   - If it says `Not enough data`, wait for more pauses.
4. If the refresh paused itself after 2 misses, read the `Refresh age` table. Misses at ages below your TTL mean that the real TTL is shorter. [Set the TTL for your plan](#how-to-set-the-ttl-for-your-plan).

### How to check that the refresh works

> This guide spends plan usage or API credit: each probe is 1 fork.

1. Start a new Claude Code session with ember installed.
2. Build a cached prefix of at least 10k tokens, for example by asking Claude to read a large file, and let the turn finish.
3. Within 1 minute, run `/ember-probe`. Expect a toast with `hit`, a read of at least 90%, and `created` of at most 1024. Note the `fork steps seen` count: 0 means that fork requests do not reach `turn.step`.
4. Stay idle for 10 minutes, then run `/ember-probe` again. Expect a hit again, because the first probe restarted the TTL.
5. Send a one-word prompt, then run `/ember`. Check that the `user` row has a high hit ratio and that the `agent` and `first` rows did not grow.
6. To check the TTL edge, start a session with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, finish a turn, wait 6 minutes, and run `/ember-probe`. Expect a miss with a read near 0.
7. Run `/ember-refresh` and read the refresh rows.

If steps 3 to 5 pass, the refresh works on your account.

### How to keep the cache of a long conversation

On the 60-minute TTL, Claude Code can compact an idle conversation about 54 minutes after the last request. ember does not refresh a pause where this can happen. To let ember keep the full cache instead:

1. Set `"idleCompaction": false` in `~/.claude/settings.json`.
2. Start a new session.

## Reference

### Commands

| Command | What it does |
| :- | :- |
| `/ember` | Opens the `ember` pane with the cache report. Esc closes it. |
| `/ember-refresh` | Opens the `ember refresh` pane with the refresh analysis across all stored sessions. |
| `/ember-probe` | Sends 1 refresh now and shows its result in a toast. It does not count toward the cap or the circuit breaker. |

You can run all 3 commands while Claude works. `/ember-probe` then refuses with `a turn is running`, and while a refresh runs, with `a refresh is running`.

### The `/ember` pane

From top to bottom:

1. `TTL <minutes>m (<source>)`, dim.
2. The tabs `1: This session` and `2: All sessions`, only when other sessions are stored. Keys `1` and `2` switch them.
3. A table `| Gap type | Requests | Hit |` with each gap type that has requests, or `No requests yet.`
4. The `user` gap bands, the observed TTL bounds, and the counts of compactions and model switches.

Gap types:

| Gap type | The request came |
| :- | :- |
| `first` | first in the session, after a reload, or after `/clear`, `/resume`, or `/branch` |
| `user` | first in a turn, after you sent a prompt |
| `ask` | after Claude asked you a question with `AskUserQuestion` |
| `subagent` | after a subagent ran |
| `tool` | after any other tool call in the turn |
| `compact` | first after a compaction |
| `model-switch` | first after a change of model |
| `agent` | from a subagent |

The hit ratio is `cache read / (input + cache read + cache creation)`, weighted by tokens. The `user` gap bands are `<1m`, `1-5m`, `5-15m`, `15-30m`, `30-60m`, and `>60m`, measured from the end of the previous response. A `user` request is warm when its cache read is at least half of the previous main prefix, and cold when it is less. The observed TTL bounds are the longest warm gap and the shortest cold gap, measured from the start of the previous request.

### The `/ember-refresh` pane

The pane shows the sample size, the refresh hit rate, hits and misses by refresh age, the net saving, and the reasons that pauses were not refreshed. With at least 20 returned pauses, it also shows the Kaplan-Meier share of pauses still idle at 5m, 30m, 55m, 1h, 2h, and 8h, the expected saving per pause of each lead and of `off`, the replay cost of the recorded pauses, and a recommendation. Below 20 returned pauses, it shows `Not enough data`. Example on a sample log:

```text
Refresh on · lead 5m00s (auto) · TTL 60m (ttlMinutes option)
Sample: 30 pauses (28 returned, 2 exits) · 5 refreshes · 4 sessions
Refreshes: 5 hit · 0 miss · 0 refused · hit rate 100%
Net saved: ~620k tokens (4 cold rewrites avoided).
Recommendation: keep refresh on, keep the current lead (lead 5m00s (auto)): about 10k tokens saved per pause.
```

### Options

| Option | Type | Default | Values |
| :- | :- | :- | :- |
| `refresh` | Boolean | `true` | `false` turns the refresh off. |
| `refreshLeadSeconds` | number | `0` | `0` is the automatic lead. Otherwise 10 to 3600 seconds before expiry. A lead that leaves less than 10 s of TTL falls back to automatic. |
| `refreshShortTtl` | Boolean | `true` | `false` stops the refresh when the TTL is 5 minutes or less. Any other value counts as `true`. |
| `ttlMinutes` | number | `60` | 1 to 1440. Used only when no setting in [TTL resolution](#ttl-resolution) applies. |

The install screen of `/plugin install` shows `refreshLeadSeconds` and `ttlMinutes` as empty fields. An empty field uses the default.

Set the options in the install screen, in `/config`, or under `pluginConfigs` in `~/.claude/settings.json`.

### TTL resolution

ember takes the first match, in Claude Code's own order:

1. `FORCE_PROMPT_CACHING_5M=1`: 5 minutes.
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` set to `5m` or `1h`.
3. The `promptCacheTtl` setting set to `5m` or `1h`.
4. `ENABLE_PROMPT_CACHING_1H=1`: 60 minutes.
5. The `ttlMinutes` option.

Other values, and a read that fails, go to the next rule. ember reads the TTL at session start and after `/clear`, `/resume`, and `/branch`. After a refresh miss that read less than half of the prefix, the session uses 5 minutes, shown as `TTL 5m (refresh miss)`.

### Refresh policy

| Rule | Value |
| :- | :- |
| When | While the main thread is idle: no turn, no main request, and no refresh running. |
| Request | `$.model.fork` with the prompt `Reply with the single word ok.` |
| Automatic lead | min(5 min, TTL / 5): 5 minutes before expiry for a 60-minute TTL, 1 minute for 5 minutes. |
| Expiry | TTL after the start of the last request that read the cache: the main request, or the last refresh that hit. |
| Late limit | No refresh starts in the last 5 s before expiry. |
| Cap per pause | `floor(write weight / 0.1)` refreshes: 20 for 60 minutes, 12 for 5 minutes. |
| Hit | Cache read at least 90% of the last main prefix, and cache creation at most 1024 tokens. |
| Miss | Any other result. A miss stops the refresh for that pause. |
| Circuit breaker | 2 misses in a row stop the refresh for the session, with 1 toast. |
| Refused call | An API error, an abort, or a rejected call retries after 30 s, at most 3 times per pause. `nothing-to-fork` stops the pause. |
| No refresh | Refresh off; `claude -p` or the Agent SDK; a turn stopped with Esc; a prefix of 0; a compaction in or before the pause; the circuit breaker; a pause where idle compaction can run; a TTL of 5 minutes or less while `refreshShortTtl` is `false`, also after a refresh miss sets the TTL to 5 minutes. ember logs that pause with the reason `short-ttl`, so `/ember-refresh` can evaluate it. |

Idle compaction can run when the TTL is 60 minutes, `idleCompaction` and `autoCompactEnabled` are not `false`, `DISABLE_AUTO_COMPACT` is not set, and the prefix is at least 90% of `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (default 200,000).

### Notifications

| Where | What |
| :- | :- |
| Toast | Once per idle pause, when the time left first falls to the automatic lead: `cache goes cold in ~4m59s (142k tokens)`. Not shown while a request runs, when the prefix is 0, or while a refresh will still run before expiry. |
| Toast | When the circuit breaker trips: `ember: cache refresh paused after 2 misses in a row. Run /ember-refresh for details.` |
| Status line | VS Code only: `idle 12m03s · last hit 97% · 142k cached · cold in ~47m57s`, or `session hit 95%` while a main request runs. |

### Live test results

One test on 2026-10-20, Claude Code v2.1.305, 1 Claude subscription account, TTL 60m (`ttlMinutes` option). 4 sessions, 12 main requests.

| Gap type | Requests | Hit |
| :- | :- | :- |
| `first` | 5 | 62.6% |
| `user` | 2 | 98.4% |
| `tool` | 5 | 93.3% |
| All | 12 | 83.0% |

The 2 `user` pauses fell in the `5-15m` and `15-30m` bands, and both stayed warm. The longest warm pause was 29m03s, measured from the start of the previous request. That is longer than a 5-minute TTL, so the 60-minute TTL applied on this account. No cold `user` pause was recorded, so the test gives no upper bound for the TTL.

No timed refresh and no `/ember-probe` ran. The 2 pauses that the refresh log recorded ended with a session exit, so no refresh was due. This test does not verify the refresh.

The sample is small: 1 evening on 1 account. Run `/ember` and `/ember-refresh` to see your own numbers.

### Stored data

ember stores numbers only, in the file `~/.claude/plugins/store/ember_davegomez-<hash>.json`. Each session has one key, `session:<session id>`. It holds the gap-type totals, the gap bands, the TTL bounds, the event counts, `live`, and `refresh`. Keys older than 30 days are deleted, and at most 500 session keys are kept.

`live`:

| Field | Meaning |
| :- | :- |
| `lastStartMs` | Start of the last main request with usage, or of the last refresh that hit, in epoch milliseconds. |
| `ttlMinutes` | The resolved TTL. |
| `prefix` | The cached prefix of that request: cache read plus cache creation tokens. |
| `hit` | The hit ratio of that request, 0 to 1. |
| `refreshes` | Refreshes in the current pause. Absent when 0. |
| `savedTokens` | The net saving of the session's refreshes, in input-token units. Absent when 0. |
| `savedPct` | The session's cache saving as a share of the uncached cost, in percent, rounded. A cache read costs 0.1 and a cache write 1.25 (5-minute TTL) or 2 (1-hour TTL) input tokens. Below 0 when the writes cost more than the reads saved. Absent before the first token. |

`refresh.log` keeps the newest 32 records of the session as number arrays:

- Pause: `[0, startMs, lenMs, ageMs, ttlMinutes, source, leadMs, prefix, refreshes, end, skip, cost, saved]`
- Refresh: `[1, startMs, ageMs, ttlMinutes, source, leadMs, prefix, read, creation, input, output, outcome, steps, agentSteps, isProbe]`

`end` is 0 warm, 1 cold, 2 exit, or 3 unknown. `outcome` is 0 hit, 1 miss, or 2 refused. `source` and `skip` are indexes into the lists in `hooks/refresh.ts`.

## Explanation

### Why the cache goes cold while you are away

On each turn, Claude Code sends the whole conversation to the model again. The API keeps the processed start of that conversation, the prefix, for a time to live (TTL) after the start of the last request that read it. During the tool loop, requests come seconds apart, so almost every request reads the prefix from the cache. When you read a diff or go to lunch, the pause can be longer than the TTL. The next request then writes the whole prefix again, which is slower and costs more. ember exists to show this cost and to reduce it.

### Why a refresh can save money, and when it cannot

A cache read costs 0.1 times the input price. A cache write costs 2 times on the 60-minute TTL and 1.25 times on the 5-minute TTL. One read that restarts the TTL is therefore much cheaper than one cold rewrite, but only if you come back. If you never come back, every refresh is waste.

ember does not know when you will return, so it uses the ski-rental rule from online algorithms: it rents (refreshes) until the rent paid equals the price of buying (one cold rewrite), and then it stops. No policy that cannot see the future can do better than 2 times the cost of a policy that knows your return time, and this rule meets that bound. A replay of synthetic traces met the 2 times bound on every trace with a return. It did not meet a stretch goal of 1.25 times on 5 of 15 traces. With the 5-minute TTL, the refresh cost less than having it off on most traces, such as coffee breaks, returns just after expiry, and mixed pauses. It cost more on some traces, such as short returns and overnight returns. With a 5-minute TTL, each refresh buys only a few minutes, and the cap allows only 12. A cold rewrite costs only 1.25 times the input price, so the refreshes have little to save. For this reason the `refreshShortTtl` option exists, and `/ember-refresh` checks whether the refresh saves on your pauses. Set `refreshShortTtl` to `false` when `/ember-refresh` recommends it.

### Why the refresh is unverified

A fork sends the main conversation's last request again with a short prompt after it. The type declarations say that a fork reuses the main thread's last cache breakpoint and adds none of its own. That should make it a read of the prefix that restarts the TTL. Nobody has yet measured this on a live session, and the declarations do not say whether fork requests reach the `turn.step` event. The probe answers both questions. The [live test](#live-test-results) measured the cache report, but no refresh or probe ran.

The savings are API-price estimates in input-token units. The docs say that cached history is read again "at the cached token rate" and still draws plan usage, but Anthropic does not publish how fork reads count toward subscription limits.

### Why ember stays away from idle compaction

On the 60-minute TTL, Claude Code can compact an idle conversation about 54 minutes after the last request. That is before ember's 55-minute refresh, and the docs do not say whether a fork restarts the compaction timer. A refresh that races a compaction pays for a read and then loses the prefix anyway. So ember skips those pauses and leaves the choice to you through the `idleCompaction` setting.

### Why the reports open in panes

Text that a command returns goes into the conversation that the model reads. That text would change the conversation and add to the prefix that ember measures. A pane shows the report to you only.

### Why ember stores only numbers

Every session on the machine shares the store file, and other tools, such as a status line, read it. Counts, token totals, and timestamps are enough to measure the cache. Prompt text, file paths, model output, and tool inputs stay out of the store.
