# pi-memory (project-scoped)

Our rebuild of the [ref pi-memory](./ref/pi-memory) extension with **true project-scoped** storage and search.

See [design.md](./design.md) for job boundaries vs the reference.

## Layout

```
<projectRoot>/.pi/memory/
  MEMORY.md
  SCRATCHPAD.md
  daily/YYYY-MM-DD.md
  recovery/<uuid>.json
```

Project root = git root walked from session `cwd`, else `cwd`. Override with `PI_MEMORY_PROJECT_ROOT` or `PI_MEMORY_DIR`.

qmd collection name: `pi-mem-<basename>-<sha12 of abs root>` — never the global `pi-memory` collection.

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

`memory_write`, `memory_read`, `memory_forget`, `memory_restore`, `scratchpad`, `memory_search`, `memory_status`

## v1 scope

In: project binding, CRUD, stable prompt injection, per-project qmd search.

Out: exit-summary LLM, selective per-turn search injection, dual global+project layers, compact handoff (see design.md).
