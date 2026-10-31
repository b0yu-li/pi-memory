# pi-memory (project-scoped PoC)

Our rebuild of the [ref pi-memory](./ref/pi-memory) extension with **true project-scoped** storage and **hybrid** context injection.

See [design.md](./design.md) for job boundaries vs the reference.

## Zero config by default

Project-scoped memory works out of the box — **no environment variables required.**
Each project automatically gets its own isolated store, and qmd never mixes collections between projects.

The only commands you need after install are in [Install](#install) below. Everything in [Configuration](#configuration) is optional override territory.

## Layout

```
<projectRoot>/.pi/memory/
  MEMORY.md
  daily/YYYY-MM-DD.md
  recovery/<uuid>.json
```

No scratchpad. Project root = git root from session `cwd`, else `cwd`.

qmd collection: `pi-mem-<basename>-<sha12 of abs root>` — never the global `pi-memory` collection.

## Install

```bash
pi install https://github.com/b0yu-li/pi-memory.git
```

Optional search backend (recommended — enables turn retrieval and `memory_search`):

```bash
npm install -g @tobilu/qmd
```

On macOS, qmd needs Homebrew SQLite for extension support:

```bash
brew install sqlite
```

### Install (dev)

```bash
pi install ./   # from this repo
# or
pi -e ./index.ts
```

## Configuration

All settings are **optional** and default to sensible values. You should not need any of them for normal use.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PI_MEMORY_PROJECT_ROOT` | git root / cwd | Force a different project root |
| `PI_MEMORY_DIR` | `<projectRoot>/.pi/memory` | Absolute store path override |
| `PI_MEMORY_CORE` | `today+memory` | Always-on core composition |
| `PI_MEMORY_RETRIEVE` | `on` | Turn-message qmd retrieval (`off` to disable) |
| `PI_MEMORY_QMD_UPDATE` | `background` | `background` \| `manual` \| `off` |
| `PI_MEMORY_SNAPSHOT` | `stable` | `per-turn` rebuilds the system prompt every turn (busts KV cache — avoid) |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | internal | Timeout for qmd searches |
| `PI_MEMORY_EMBED_PROBE_TIMEOUT_MS` | internal | Timeout for embed availability probe |

> **Warning — the classic misconfiguration.** Do **not** set `PI_MEMORY_DIR` to an
> agent-global path such as `$PWD/.pi/agent/memory` (left over from the reference
> extension). That silently moves the store out of the project and defeats
> project scoping. Leave it unset unless you truly need a custom location.

## Injection (hybrid)

| Layer | What | Where |
|-------|------|-------|
| **Core** | Today’s daily + MEMORY.md (capped) | System prompt (byte-stable across turns) |
| **Retrieved** | qmd keyword top-3 for this prompt | Turn message (`customType: pi-memory-retrieve`) |
| **On-demand** | Full file / deeper search | `memory_read` / `memory_search` |

## Tags & links

Content conventions (not a schema). Prefer:

```markdown
#decision [[database-choice]] Chose PostgreSQL for all backend services.
#preference [[package-manager]] Always use pnpm in this repo, never npm.
```

Keyword search and turn retrieval find `#decision` / `database-choice` via qmd FTS.

## Tools

`memory_write`, `memory_read`, `memory_forget`, `memory_restore`, `memory_search`, `memory_status`

## Try it

```bash
pi
# then: memory_status — should show <project>/.pi/memory + pi-mem-… collection
```

If you use direnv and keep a project `.envrc`, run `direnv allow` first — but
remember the [warning](#configuration): leaving `PI_MEMORY_*` unset is correct.

## Tests

```bash
npm test          # unit
npm run build     # tsc --noEmit
```

E2E / eval (tags + hybrid) — designed in design.md; not in this PoC yet.
