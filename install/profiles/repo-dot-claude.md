# Create a shared .claude repository

Create a repository called `.claude` holding the Claude Code configuration that
should be shared across projects — skills, agents, slash commands and settings.

BE HONEST WITH ME ABOUT WHAT THIS IS. Unlike `.github`, this name means nothing
to GitHub or to Claude Code: nothing inherits it automatically. It is a
convention for keeping shared configuration in one place and pulling it into
`~/.claude` or a project's `.claude/` deliberately. Say so in the README rather
than implying it is picked up on its own.

First, work out where it should go: `gh api user` and
`gh api user/orgs --jq '.[].login'`. If there is more than one plausible owner,
STOP AND ASK ME which one, as a numbered list.

Then create it — PRIVATE unless I say otherwise, because configuration tends to
name internal systems — and structure it the way Claude Code reads a `.claude`
directory:

- `skills/` — one directory per skill, each with a `SKILL.md`.
- `agents/` — subagent definitions.
- `commands/` — slash commands, one markdown file each.
- `settings.json` — shared settings only. NO credentials, no tokens, no API
  keys, and nothing machine-specific: this repository is copied to other
  machines by definition.
- `README.md` — how to use it. Give the exact commands for both cases: pulling
  it into `~/.claude` for one person, and vendoring it into a project's
  `.claude/`. Say which files each one affects.

Seed each directory with one small, real example rather than an empty
placeholder — an empty directory does not survive git anyway, and a `.gitkeep`
teaches nobody the format.

Then tell me the URL and the two commands from the README.
