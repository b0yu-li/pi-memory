# Project-scoped pi-memory — design

Reference intake: `ref/pi-memory` (jayzeng/pi-memory). This document defines **our** jobs and how they differ.

## Decisions locked

| Topic | Decision |
|-------|----------|
| Scope | Project-local `<projectRoot>/.pi/memory/` + per-project qmd collection |
| `memory_read` + `memory_search` | **Keep both** — open known path vs discover unknown facts |
| Scratchpad | **Drop** — fewer scopes; daily + MEMORY are enough |
| Context injection | **Hybrid**: stable system-prompt core + turn-scoped retrieval message (not ref’s per-turn system rebuild) |

## What ref gets wrong for us

| Concern | ref (`pi-memory`) | Ours |
|---------|-------------------|------|
| Storage root | `~/.pi/agent/memory` (global; `PI_MEMORY_DIR` override only) | `<projectRoot>/.pi/memory/` |
| qmd collection | Single global name `pi-memory` | One collection per project: `pi-mem-<basename>-<hash12>` |
| Project identity | None | Derived from session `cwd` (walk up to `.git`, else cwd) |
| Cross-project bleed | Prefs/decisions from repo A inject into repo B | Impossible by default |
| Scratchpad | First-class tool + always injected | Removed |
| Selective recall | Opt-in `PI_MEMORY_SNAPSHOT=per-turn` rebuilds **system prompt** every turn (busts KV cache) | Stable system core + retrieved snippets as a **turn message** |

## Core jobs

### Job 1 — Project binding

- Resolve **project root** from session `cwd` (git root preferred).
- Resolve **memory dir** = `<projectRoot>/.pi/memory` (override: `PI_MEMORY_DIR`).
- Derive **qmd collection name** from absolute project root (stable hash).
- Re-bind paths on `session_start` when cwd/project changes.
- Expose binding via `memory_status`.

### Job 2 — Durable store

```
<project>/.pi/memory/
  MEMORY.md           # curated long-term
  daily/YYYY-MM-DD.md # append-only daily log
  recovery/<uuid>.json
```

No `SCRATCHPAD.md`. Plain markdown; git-friendly. Prefer gitignoring `.pi/memory/` unless the team wants shared memory.

### Job 3 — CRUD tools

| Tool | Job |
|------|-----|
| `memory_write` | Append/overwrite long-term or append daily (stamped entries) |
| `memory_read` | Read MEMORY / daily / list dailies (known location) |
| `memory_forget` | Substring delete by stamped entry; write recovery record |
| `memory_restore` | Restore from recovery ID |
| `memory_search` | Discover facts via qmd across the project store |
| `memory_status` | Health / paths / qmd / collection |

**Why both read and search:** `memory_read` opens a file you already know; `memory_search` finds entries you don’t. Different jobs.

### Job 4 — Context injection (first principles)

**Goal:** high recall quality + low token waste + preserve prefix/KV cache when possible.

**Insight:** “Context injection” ≠ “rebuild system prompt every turn.”

Ref’s three modes:

| Mode | Behavior | Quality | Tokens / cache |
|------|----------|---------|----------------|
| `stable` (ref default) | Snapshot once; same bytes every turn | Always-on dump; no prompt-relevance | Cheap cache; many unrelated tokens |
| `refresh` | Re-snapshot on long-term write / day rollover | Fresher dump | Occasional full cache bust |
| `per-turn` | Rebuild system block + qmd keyword top-3 on user prompt | Better relevance | **Busts KV cache every turn** |

Ref per-turn mechanics (`searchRelevantMemories`):

1. Sanitize prompt (strip controls, ≤200 chars)
2. `qmd search` keyword, `-n 3`, 3s timeout
3. Format snippets → `## Relevant memories (auto-retrieved)`
4. Fold into `buildMemoryContext` inside the **system** prompt (priority after today daily)

That couples **relevance** to **prefix instability**. Unnecessary.

#### Our hybrid model

```
  session_start
       │
       ▼
  Stable CORE snapshot ──► system prompt (byte-stable across turns)
       │                    = today daily (≤3K, tail)
       │                    + MEMORY.md (≤4K, middle-truncate)
       │                    total soft cap ~7K (no scratchpad, no yesterday)
       │
  before_agent_start (each user prompt)
       │
       ├─ emit stable CORE as system append (unchanged bytes)
       │
       └─ if qmd up: keyword search prompt → top-N snippets
              │
              └─ return as turn-scoped `message` (not system rewrite)
                 e.g. "[memory] relevant entries: …"
                 fails soft (empty / timeout → no message)
```

| Layer | What | Where | Changes when |
|-------|------|-------|--------------|
| **Core** | Today’s daily + MEMORY.md | System prompt | Session start; forget/restore; optional refresh on long-term write |
| **Retrieved** | Top-N qmd hits for this prompt | Turn message via `before_agent_start` | Every user prompt (only this tail changes) |
| **On-demand** | Full file / deeper search | `memory_read` / `memory_search` | Agent chooses |

Why this wins:

- **Quality:** prompt-relevant facts still auto-surface (no reliance on the model remembering to search).
- **Token efficiency:** drop scratchpad + yesterday from always-on; retrieval capped (~2.5K); avoid dumping full MEMORY when search hits are enough for the turn.
- **Cache:** system prefix stays stable; only the new turn message varies (same cost as any user turn).

Fallback if qmd missing: core-only injection; tools still work.

### Job 5 — Search (optional qmd, project-scoped)

- Auto-`collection add` this project’s memory dir under the derived collection name.
- Powers `memory_search` and hybrid turn retrieval.
- Debounced `qmd update` + background `qmd embed` after writes.

### Job 6 — Health

- `memory_status`: project root, memory dir, inventory, qmd + collection + embeddings, config.

## Explicitly out / deferred

| Item | Status |
|------|--------|
| Scratchpad | **Cut** |
| Ref `per-turn` system rebuild | **Rejected** (replaced by hybrid) |
| Yesterday daily in always-on | **Cut** (use search / read) |
| Exit-summary LLM on quit | Deferred |
| Compact handoff | Deferred |
| Global + project dual layer | Deferred |
| Knowledge graph | Won’t build |

## Config (target)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_MEMORY_DIR` | `<project>/.pi/memory` | Absolute store override |
| `PI_MEMORY_PROJECT_ROOT` | git root / cwd | Project root override |
| `PI_MEMORY_CORE` | `today+memory` | Always-on core composition |
| `PI_MEMORY_RETRIEVE` | `on` | Turn-message qmd retrieval (`off` to disable) |
| `PI_MEMORY_QMD_UPDATE` | `background` | `background` \| `manual` \| `off` |

## Success criteria

1. Two project roots never share MEMORY.md or the same qmd collection.
2. `memory_status` shows project `.pi/memory`, not `~/.pi/agent/memory`.
3. No scratchpad tool or files in the product surface.
4. System memory core is byte-stable across turns; retrieval arrives as a turn message.
5. Without qmd: write/read/forget/restore/core-inject/status still work.
6. With qmd: search + turn retrieval only hit this project’s store.

## Implementation status

- Scaffold exists (`index.ts`) with project binding, CRUD, stable inject, qmd — still includes scratchpad and lacks hybrid turn-message retrieval.
- **Next implement step (not done yet):** drop scratchpad; switch Job 4 to hybrid per this doc.
