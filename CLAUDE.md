# CLAUDE.md

## Workspace Routing (Read First)

Before opening files, read the matching router to pinpoint the exact file — never list or read full directories:

| Area | Router | Covers |
| :--- | :--- | :--- |
| Product & Code | `product.md` | agent loop, LLM clients, tools, CLI/TUI |
| Operations & Infra | `operations.md` | build scripts, Docker, CI/CD, deploy, config |
| Content & Docs | `content.md` | guides, specs, release docs, licenses |

## Core Rules

1. **Think before coding.** State assumptions; if uncertain or multiple interpretations exist, ask. Push back when a simpler approach exists.
2. **Simplicity first.** Minimum code that solves the problem. No speculative features, abstractions, or configurability. No error handling for impossible scenarios.
3. **Surgical changes.** Touch only what the task requires. Match existing style. Clean up only orphans your own change created; mention unrelated dead code, don't delete it.
4. **Goal-driven.** State how to verify in the plan; put verification commands in the final summary for the user to run. Follow the `plan-flow` skill for planning.

## Efficiency

- Locate code with grep first; Read only exact line ranges (offset/limit). Never read whole files >300 lines unless necessary.
- Max 5 read/search calls before proposing a fix or asking for direction.
- Symptom matching: grep the symptom, read only the matched file. No adjacent files without approval.

---

**Working if:** fewer unnecessary diff changes, fewer rewrites, questions come before implementation.
