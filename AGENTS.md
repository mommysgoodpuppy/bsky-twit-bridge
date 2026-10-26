# AGENTS.md

A bot that mirrors @SadlyItsBradley on X to sadlyitsbradleybot.bsky.social. See `README.md`.

- `markdown/`: plans, work in progress and notes that should outlast a session. Keep project memory here, not
  in a harness's own memory system (Claude Code memory, Codex memories and the like).
- Use `_scratch/` for agent scratch files, experiments and local test artifacts. It is ignored by Git. Global
  tmp may be used but is not persistent; project-local, don't use `project/tmp/` or others, only `_scratch/`.
- Check: `deno task check`. Run: `deno task start` (cron + HTTP), `deno task dryrun` (no posting).
- Production runs on `cachyos` under `../deno-ldeploy`, which deploys every push to `main` within 2 minutes.
  Status: https://bradbot.petplay.fi.
- Never run it locally with the real credentials: a second copy posts every tweet again. `deno task reset`
  deletes every post the bot made.
- Its KV (production: `~/git/deno-ldeploy/data/apps/bsky-twit-bridge/kv.sqlite3` on `cachyos`) records which
  tweets were mirrored; losing it makes the bot re-post.

## Related projects

- `../deno-ldeploy`: hosts it; owns the env file, KV location, routing and the tunnel.

## Git

Manage git however you see fit. Primary is `main`.

- Commit as the configured git identity. No `Co-Authored-By` or other co-author trailers.
- Never push, open PRs or issues, or publish anything to external sites unless asked for that specific action.
- End every agent-made commit message with:

  ```
  Agent: <harness> <version>; model <exact model id>; thread <harness thread/session id>
  ```

  For example,
  `Agent: Claude Code 2.1.296; model claude-opus-5-5; thread 941be8c7-aca1-4664-b284-7cc0eed69e21`.
