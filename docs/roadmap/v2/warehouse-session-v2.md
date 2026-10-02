# Warehouse Session V2 Architecture

> **Status:** Deferred — intentionally excluded from V1  
> **Type:** Architecture Decision Record  
> **Last updated:** 2026-10-02

---

## Background

### Current V1 Architecture

Scan-to-Pack V1 uses a **client-maintained packing session**. The browser holds
temporary packing progress while the server authoritatively validates every scan
against trusted state:

- **Parcel ownership** — the parcel belongs to the claimed order and organization
- **Order eligibility** — the order is in a packable fulfillment status
- **Product / variant identity** — the scanned barcode resolves to a real SKU
- **Quantity limits** — the scanned quantity does not exceed the ordered quantity
- **Permissions** — the user holds the `packing:scan` permission for the workspace

Inventory is **never mutated** during packing in V1. Stock adjustments occur
downstream when the order transitions to shipped/delivered, consistent with the
ledger-based inventory model defined in `ARCHITECTURE.md`.

### Why This Is Sufficient for Launch

APSA's launch customers are small-to-medium Cambodian commerce operators:

- Facebook sellers
- Instagram sellers
- Small retail shops
- Teams of 1–5 staff

Their typical packing workflow is **short and uninterrupted**:

1. Open an order
2. Scan items into the parcel
3. Finish packing
4. Print the shipping label
5. Hand the parcel to the courier

A single operator packs a single order on a single device in a single sitting.
The session rarely lasts more than a few minutes. Persistent server-owned
sessions provide **no additional value** during this workflow and would add
complexity without benefiting the target user.

---

## Why Not in V1

A persistent server session introduces:

- Additional database tables and migrations
- Session lifecycle management (create, resume, expire, abandon)
- Conflict resolution for concurrent modifications
- Real-time synchronization infrastructure
- Recovery and replay logic

None of these capabilities are needed when:

- One person packs one order at a time
- Packing completes in a single sitting
- There is no second device to synchronize with
- Interruptions are resolved by simply re-scanning

The V1 design is a **product-scoping decision**, not a technical limitation.
The server validation layer is already structured to support a persistent session
in the future — the transition path is additive, not a rewrite.

---

## When to Build V2

Implement server-owned pack sessions when any of these conditions emerge:

| Trigger | Why It Matters |
|---|---|
| Multiple warehouse workers | Concurrent packing requires coordination |
| Multiple devices per worker | Progress must roam across devices |
| Resumed packing after interruption | Client state is lost on refresh/logout |
| Warehouse shift handoffs | One worker starts, another finishes |
| Batch packing | Multiple orders packed in a single flow |
| Warehouse management features | Supervisor visibility into in-progress work |

The general signal is: **APSA customers are operating warehouses, not kitchen
tables.** When the product crosses that threshold, V2 becomes load-bearing.

---

## V2 Goals

### Server-Owned Pack Session

- The server creates, owns, and governs the pack session lifecycle
- Client renders server state; client-side state is a cache, not the source of truth

### Persistent Progress

- Packing progress survives browser refresh, tab close, and logout
- Workers resume exactly where they left off

### Multi-Device Synchronization

- A pack session is accessible from any authorized device
- Real-time updates propagate across connected clients

### Concurrent Workers

- Multiple workers can pack different parcels within the same order
- Locking or optimistic concurrency prevents conflicting scans

### Transactional Scan Recording

- Each scan is recorded as a server-side event
- Scans are idempotent — duplicate scan submissions do not corrupt state

### Audit Trail

- Full history of who scanned what, when, and on which device
- Supports compliance, dispute resolution, and operational analytics

### Server-Owned Completion

- The server determines when a parcel is fully packed (ready-to-seal state)
- Completion triggers downstream workflows (label generation, courier handoff)

### Future Integration Points

- **Courier integration** — pack completion feeds directly into pickup scheduling
- **Returns integration** — reverse logistics reuses the scan infrastructure

---

## Out of Scope for V1

The following capabilities are **intentionally excluded** from V1. This is not
technical debt — it is deliberate scope control:

- Persistent pack session
- Distributed synchronization
- Warehouse collaboration (multi-worker on the same parcel)
- Resumable packing across sessions
- Scan idempotency (server-recorded scans)

---

## Roadmap Placement

Warehouse Session V2 should be implemented **after** the following modules are
production-stable:

1. **Courier Integration** — pack completion must connect to courier pickup
2. **Returns / Reverse Logistics** — scan infrastructure is reused for receiving returns
3. **Receiving** — inbound goods scanning shares the barcode/scan UX patterns
4. **Stock Count** — physical inventory counts validate the ledger model under load

V2 belongs to the phase where APSA evolves from a **social-commerce platform**
into a **warehouse operations platform**. Building it before that evolution would
be premature optimization.

---

## Migration Path

The V1 → V2 transition is **additive**:

1. Add `pack_sessions` and `pack_scan_events` tables
2. Server creates a session on first scan (or explicit start)
3. Client switches from local state to server-fetched session state
4. Existing server validation functions (`validateScanEligibility`,
   `validateParcelOwnership`, etc.) remain unchanged — they gain a caller,
   not a rewrite
5. Client packing UI remains largely the same; the data source changes

No V1 code needs to be deleted. The server validation layer was designed with
this extension in mind.
