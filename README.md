# Claude Code Mods

Mods for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview). A mod is a plugin whose TypeScript hooks run inside Claude Code and can observe events, draw in the interface, and add commands.

## Mods

| Mod | What it does |
| :- | :- |
| [blindfold](blindfold/README.md) | Keeps the values in your env files out of the conversation, and lets Claude ask for a missing secret that you enter in a native dialog. |
| [ember](ember/README.md) | Tracks how warm the prompt cache stays across idle pauses, and refreshes it before it expires. |

## Install a mod

In a Claude Code session, run `/plugin install ember --marketplace davegomez/mods`. Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin marketplace add davegomez/mods
claude plugin install ember@davegomez
```

In the desktop app, `/plugin` does not run. Click + next to the prompt box, then Plugins. Choose Add marketplace, enter `davegomez/mods`, then choose Add plugin.

Without a GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` before you install. Without it, installs and updates from `/plugin` fail.

Auto-update is off for third-party marketplaces. To turn it on, open `/plugin`, go to the Marketplaces tab, select `davegomez`, and choose Enable auto-update.

A mod runs with your permissions. Read its README before you install it.

Each mod's README states the Claude Code version it was tested with.

## License

The mods are licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). Each mod folder holds its `LICENSE` file.
