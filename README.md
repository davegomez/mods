# Claude Code Mods

Mods for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview). A mod is a plugin whose TypeScript hooks run inside Claude Code and can observe events, draw in the interface, and add commands.

## Mods

| Mod | What it does |
| :- | :- |
| [ember](ember/README.md) | Tracks how warm the prompt cache stays across idle pauses, and refreshes it before it expires. |

## Try a mod

Load a mod for one session from its directory:

```bash
claude --plugin-dir ./ember
```

The mods are tested with Claude Code v2.1.305. Each mod's README states the version it was tested with.

## Change a mod

1. Load the built-in `plugin-authoring` skill. It knows the events, the API, and the type declarations of the installed Claude Code version.
2. Write a test that fails, in `<mod>/tests/`.
3. Change the code. Keep the logic in pure functions and the hooks module thin.
4. The change is done when both commands pass in the mod directory:

   ```bash
   claude plugin test
   claude plugin validate --strict .
   ```

## Conventions

These rules apply to every mod here:

- The store holds numbers only: counts, token totals, and timestamps. Prompt text, file paths, model output, and tool inputs stay out of it.
- A hook that observes returns the event result unchanged, and it saves to the store without waiting.
- A live model call (`$.model.*`) spends the owner's plan usage. Get the owner's approval before a live run.

## Agent skills

Project skills live in `.agents/skills/` and are linked into `.claude/skills/`. `skills-lock.json` pins the source of each skill.

Use `writing-for-agents` when you write a skill, an `AGENTS.md`, a `CLAUDE.md`, or a README that agents read.
