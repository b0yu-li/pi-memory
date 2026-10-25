# pi-memory (project-scoped PoC)

Our rebuild of the [ref pi-memory](./ref/pi-memory) extension with **true project-scoped** storage and **hybrid** context injection.

See [design.md](./design.md) for job boundaries vs the reference.

## Layout

```
<projectRoot>/.pi/memory/
  MEMORY.md
  daily/YYYY-MM-DD.md
  recovery/<uuid>.json
```

No scratchpad. Project root = git root from session `cwd`, else `cwd`. Override with `PI_MEMORY_PROJECT_ROOT` or `PI_MEMORY_DIR`.

qmd collection: `pi-mem-<basename>-<sha12 of abs root>` — never the global `pi-memory` collection.

## Injection (hybrid)

| Layer | What | Where |
|-------|------|-------|
| **Core** | Today’s daily + MEMORY.md (capped) | System prompt (byte-stable across turns) |
| **Retrieved** | qmd keyword top-3 for this prompt | Turn message (`customType: pi-memory-retrieve`) |
| **On-demand** | Full file / deeper search | `memory_read` / `memory_search` |

Disable turn retrieval: `PI_MEMORY_RETRIEVE=off`.

## Tags & links

Content conventions (not a schema). Prefer:

```markdown
#decision [[database-choice]] Chose PostgreSQL for all backend services.
#preference [[package-manager]] Always use pnpm in this repo, never npm.
```

Keyword search and turn retrieval find `#decision` / `database-choice` via qmd FTS.

## Install (dev)

```bash
pi install ./   # from this repo
# or
pi -e ./index.ts
```

Optional search:

```bash
npm install -g @tobilu/qmd
```

## Tools

`memory_write`, `memory_read`, `memory_forget`, `memory_restore`, `memory_search`, `memory_status`

## Try it

```bash
direnv allow   # if using .envrc
pi -e ./index.ts
# then: memory_status — should show <project>/.pi/memory + pi-mem-… collection
```

## Tests

```bash
npm test          # unit
npm run build     # tsc --noEmit
```

E2E / eval (tags + hybrid) — designed in design.md; not in this PoC yet.
