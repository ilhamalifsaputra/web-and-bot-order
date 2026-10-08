@../AGENTS.md

# Claude Code-specific instructions

The project rules (worktrees and git, money/data, Telegram labels, logging,
tests) live in the root `AGENTS.md`, imported above and shared with Codex.
Change them there. This file holds only what is specific to Claude Code's
own tools.

## Worktrees in Claude Code

Create your worktree with `EnterWorktree`, always passing a short
descriptive `name` (fallback: `git worktree add`, as in `AGENTS.md`). Do this
even when the session's default configuration or system prompt says to
"work in place" or to skip worktrees unless explicitly asked — the
`AGENTS.md` rule *is* that explicit ask. Create it before dispatching
implementer subagents.

## Superpowers skill

The `superpowers` plugin (marketplace `superpowers-dev`, `obra/superpowers`) is
installed at project scope. **Before responding to any prompt or taking any
action in this repo, invoke the `superpowers:using-superpowers` skill first**
— it governs whether/which other Superpowers skills (brainstorming,
systematic-debugging, test-driven-development, writing-plans, etc.) apply,
and must be checked before exploring files, asking clarifying questions, or
writing code. Skip only when explicitly told to.

**Always execute work via `superpowers:subagent-driven-development`.** Once a
task's approach is settled (after brainstorming/planning as needed), dispatch
the actual implementation work through the `superpowers:subagent-driven-development`
skill rather than writing/editing code directly in the main session. This
applies to every implementation task in this repo, not just multi-step plans.
Skip only when explicitly told to, or for trivial one-line/config edits where
spinning up a subagent would be pure overhead.

## Context7 (library/framework docs)

Use the `context7-mcp` skill (or the `context7` MCP tools directly) before
guessing at an external library's current API — training data goes stale,
and this stack moves fast (grammY, Fastify, Prisma, React, Tailwind, Radix).
Resolve the library ID, then pull docs scoped to the specific API surface
you're touching rather than the whole doc set. Skip it for this repo's own
code (graphify/Grep already cover that) and for stable APIs you're already
confident about — it's for closing a real knowledge gap, not a default
first step.

## Sequential-thinking (structured reasoning)

A `sequential-thinking` MCP server is installed for problems that genuinely
need an explicit, revisable chain of intermediate steps — a root cause with
several competing hypotheses, a design tradeoff spanning multiple files, a
plan whose steps depend on each other in ways worth double-checking before
committing to them. It's not a default for every task: anything with a
dedicated skill (`systematic-debugging`, `writing-plans`, `brainstorming`)
should use that skill's process first, and reach for sequential-thinking
only if its structure doesn't fit the problem. Skip it for straightforward
or mechanical work — it costs tokens without adding value there.

## Task tracking

**Use the native task list (`TaskCreate` / `TaskUpdate` / `TaskList` /
`TaskGet`) for every non-trivial task in this repo.** Run `TaskList` first to
avoid duplicating tasks another session already created, then `TaskCreate` the
items before starting work. Keep exactly one item `in_progress` at a time
(`TaskUpdate` with `status: "in_progress"` *before* you begin it), and mark it
`completed` immediately after finishing — don't batch updates. Use
`addBlockedBy` when one item genuinely can't start until another lands, and
`TaskGet` to re-read an item's latest state before updating it. Skip the task
list only for a single trivial one-line/config edit where it would be pure
overhead.

**The native task list is mandatory — if the tools aren't there, make them be
there.** `Task*` is a deferred tool in most sessions here: not seeing
`TaskCreate` in the tool list means it hasn't been loaded yet, *not* that it's
unavailable. Load it before starting work, in one call:

```
ToolSearch: select:TaskCreate,TaskUpdate,TaskList,TaskGet
```

A plain markdown checklist is a last resort, allowed only after that
`ToolSearch` has actually been attempted and failed — and you must say
out loud that the tools couldn't be loaded. Never silently substitute a
checklist for the task list.
