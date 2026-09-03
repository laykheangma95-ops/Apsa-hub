# APSA — CORRECTIONS & AMENDMENTS LOG

**Document:** `CORRECTIONS.md`  
**Project:** APSA  
**Status:** Active — source of truth for overrides, clarifications, and corrections to all other APSA documents  
**Audience:** Claude Code, Lovable, Codex, all engineers, all AI agents working on this project  
**Rule:** When this file contradicts any other APSA document, **this file wins.**

---

# 1. PURPOSE

This document exists to prevent a common failure in AI-assisted development:

> An AI agent reads an outdated instruction in one document, implements it, and breaks something that was already corrected in a later conversation.

CORRECTIONS.md is the amendment log for all APSA source-of-truth documents.

When a decision changes, when a document contains an error, or when a clarification supersedes earlier guidance — it is recorded here first.

Every agent, engineer, or tool working on APSA **must read this file before acting on any other document.**

---

# 2. HOW TO READ THIS FILE

Each correction entry contains:

- **Date** — when the correction was made
- **Affects** — which document(s) the correction applies to
- **Section** — the section or topic being corrected
- **Original** — what the document previously said (or implied)
- **Correction** — what is now true
- **Reason** — why the correction was made

Corrections are listed newest first.

---

# 3. ACTIVE CORRECTIONS

No corrections have been recorded yet.

This section will be updated as decisions evolve, errors are found, or earlier guidance is superseded.

---

# 4. CORRECTION ENTRY FORMAT

When adding a new correction, use this exact format:

```
---

### CORRECTION-[NNN]

**Date:** YYYY-MM-DD  
**Affects:** [filename(s)]  
**Section:** [section name or topic]  
**Original:** [what the document said]  
**Correction:** [what is now true]  
**Reason:** [why this changed]
```

Number entries sequentially starting from CORRECTION-001.

---

# 5. RULES FOR ALL AGENTS

1. Read this file before reading any other APSA document.
2. If a correction in this file conflicts with another document, follow this file.
3. Do not implement something from another document if a correction here explicitly overrides it.
4. If you discover a contradiction between documents that is not yet recorded here, stop and flag it rather than guessing.
5. Do not modify this file yourself unless explicitly instructed by the project owner.

---

# 6. DOCUMENT HIERARCHY

When documents conflict, apply this priority order (highest to lowest):

1. `CORRECTIONS.md` — this file
2. Direct instruction in the current session
3. `APSA_MASTER_PLAN.md` — product and engineering vision
4. `ARCHITECTURE.md` — structural and technical constraints
5. `SECURITY.md` — security requirements (non-negotiable)
6. `PERMISSIONS_MATRIX.md` — role and access rules
7. `DATA_MODEL.md` — data structure and relationships
8. `API_AND_EVENTS.md` — API contracts and event standards
9. `MVP_ROADMAP.md` — implementation sequence
10. `UX_FLOWS.md` — user journeys and screen flows

---

*This file should remain under version control and be updated whenever a meaningful decision changes.*
