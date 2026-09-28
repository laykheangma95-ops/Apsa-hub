# APSA — Internal Alpha Incident & Support Runbook

**Audience:** whoever is on call for Internal Alpha (today: the project owner and
the engineer on the current PR). **Scope:** Core Business OS (Alpha A). Contains
no secrets. Safe to commit.

Ground rules for every incident:

- **Collect identifiers, not payloads.** Request ID (`req_…`, shown to the
  merchant as "Support reference"), organization ID, member (user) ID, order
  number / order ID, payment ID, delivery ID, approximate time (with timezone).
- **Never ask a merchant for their password, a reset link, a verification code or
  a screenshot of cookies/dev tools.**
- **Read before you write.** Every fix to money, stock or status goes through the
  application (its RPCs keep history and audit). A manual `UPDATE` on `orders`,
  `payments`, `inventory_movements`, `deliveries`, `memberships` or `audit_logs`
  is never the fix — it destroys the evidence and bypasses the invariants.
- **Logs to search:** the deployment's function logs (Vercel / Cloudflare) for
  structured JSON lines — filter by `requestId`, `event`, `organizationId`.
  Useful events: `server_fn.unexpected_error`, `server_fn.failed`,
  `server_fn.rejected`, `rate_limit.exceeded`, `rate_limit.backend_degraded`,
  `auth.*.provider_failed`, `server.env_missing`, `webhook.rejected`. Supabase
  dashboard → Logs for Postgres/Auth.
- **Escalate to the project owner immediately** for anything involving another
  tenant's data, money disagreement over one order that you cannot explain from
  history rows, or suspected compromise.

---

## 1. Merchant cannot sign in

1. **Containment:** none needed unless many merchants are affected (then treat as
   §6 elevated error rate).
2. **Collect:** the email they use (from the merchant, verbally — do not log it),
   the message they see, the support reference if shown, time of attempt.
3. **Inspect (safe):**
   - Message "Too many sign-in attempts" → `rate_limit.exceeded` with
     `ruleId: auth.sign_in.identity` or `auth.sign_in.ip`. It clears on its own
     (≤ 15 min). Many merchants behind one shop Wi-Fi → IP bucket (50/15 min).
   - Support reference shown → search that `requestId`: `auth.sign_in.provider_failed`
     (Supabase Auth outage / misconfig) or `auth.sign_in.access_state_failed`
     (membership lookup failed — DB issue).
   - Supabase dashboard → Authentication → Users: confirmed? banned?
   - Redirected to "access denied" → their membership is `suspended`/`removed`
     (Team screen).
   - "Check your email" loop → unverified; use the verification resend.
4. **Do NOT:** reset their password for them, confirm their email in the
   dashboard without identity verification, delete rate-limit rows to "unlock"
   them (it clears by itself; deleting hides an attack).
5. **Escalate** if: `auth.*.provider_failed` for several merchants; sign-ins
   blocked by `auth.sign_in.ip` from many unrelated merchants (possible abuse or a
   misconfigured `RATE_LIMIT_CLIENT_IP_HEADER`).

## 2. Order creation error

1. **Containment:** if systemic (every order fails), tell merchants to record
   sales on paper with time + amount; do not ask them to retry repeatedly.
2. **Collect:** support reference (`req_…`) if shown, organization, member,
   what was in the basket, POS vs. Conversation → Order vs. manual.
3. **Inspect (safe):**
   - Search the `requestId`: `server_fn.unexpected_error` with `domain: orders`
     → scrubbed `errorMessage`, `errorCode`, stack frames.
   - `rate_limit.exceeded` `orders.create.member` / `.organization` → volume
     limit (60/min/member, 600/min/org). Real merchants should never hit this;
     if they do, the values need review (see docs/OPERABILITY.md §5.2).
   - "Already used for a different order request" (409) → idempotency conflict:
     the client reused a key for a changed basket. Retrying from a fresh sheet
     fixes it.
   - Did the order actually get created? Look it up by order number / recent
     orders for that member **before** asking the merchant to retry. A retry of the
     same attempt is safe (idempotent replay returns the same order).
4. **Do NOT:** insert an order row, edit `total_minor`/amounts (DB forbids it —
   migration 044), or clear `idempotency_key`.
5. **Escalate** if: orders fail for more than one merchant; an order exists
   without its lines or with a total that disagrees with its lines.

## 3. Payment state dispute

1. **Containment:** tell staff not to record another payment for that order until
   resolved (prevents a genuine duplicate).
2. **Collect:** order number, payment ID(s), method, amount, reference (KHQR/bank),
   who recorded it, when.
3. **Inspect (safe):** Payment detail screen — event history (record, verify,
   reverse, refund, correct) is immutable and shows who/when. Order Settlement
   (received / refunded / net vs total). `audit_logs` for `payments.*` on that
   resource. `duplicate_suspected` flag. Refunds keep `payment_status=paid` and set
   `refund_status` (approved semantics, CORRECTIONS.md "Approved financial
   semantics").
4. **Do NOT:** edit `payments.amount_minor`, delete payment events, set an order's
   `payment_status` directly (the deprecated transition always rejects — by design).
   Corrections go through reverse / refund / correct in the app, with a reason.
5. **Escalate** if: history rows and the merchant's bank statement disagree and
   no app action explains it; a refund appears that nobody on staff recorded.

## 4. Inventory mismatch

1. **Containment:** if stock is visibly wrong, stop confirming orders for the
   affected variant until counted.
2. **Collect:** variant (SKU), location, the count the merchant expects vs. shown,
   recent orders touching it.
3. **Inspect (safe):** stock = sum of `inventory_movements` (ledger — there is no
   editable count). Inventory detail shows each movement with type, reference
   (order), actor and reason. Confirm→consume and confirm→cancel→release happen in
   the same transaction as the order transition (migration 026).
4. **Do NOT:** insert or delete ledger rows by hand. Fix with a **manual adjustment**
   in the app (requires `inventory.adjust`, a reason, and a mandatory audit record).
5. **Escalate** if: a movement exists with no matching order/actor; a confirmed
   order has no consume movement (would indicate a broken transaction invariant).

## 5. Delivery state issue

1. **Containment:** none usually; the merchant can keep delivering.
2. **Collect:** delivery ID / order number, current state shown, desired state.
3. **Inspect (safe):** delivery status history; the state machine rejects invalid
   transitions and anything from a terminal state (`delivered`, `cancelled`).
   COD amount/currency on the delivery.
4. **Do NOT:** update `deliveries.status` in SQL; move an order's fulfillment state
   by hand to "match" the delivery.
5. **Escalate** if: an order shows fulfilled with no delivered delivery, or COD
   collected is not reflected as a payment after staff recorded it.

## 6. Elevated error rate

1. **Containment:** if a deploy just happened, **roll back** to the previous
   deployment in the hosting dashboard (fastest, no data change). Do not hot-fix
   in production.
2. **Collect:** time window, deploy ID, affected `domain`/`operation` counts.
3. **Inspect (safe):** group `server_fn.unexpected_error` by `operation` and
   `errorCode`; check `server.env_missing` (misconfigured deploy);
   `rate_limit.backend_degraded` (database unreachable or migration 045 missing);
   Supabase status page and dashboard (connections, CPU).
4. **Do NOT:** disable RLS, widen grants, or switch to the service key in the
   browser "to get it working".
5. **Escalate** if: errors persist after rollback; database is unreachable; any
   `permission denied` spike after a migration.

## 7. Suspected tenant-data issue

(Organization A sees anything belonging to Organization B.)

1. **Containment — immediately:** screenshot what is visible (no customer data in
   chat — describe it), note the URL/screen, **stop using that screen**. If
   confirmed, put the app in maintenance (roll back / pause the deployment) until
   understood. This is a **SEV-1**.
2. **Collect:** both organization IDs, member ID, screen/URL, time, request IDs.
3. **Inspect (safe, read-only):** the server function behind the screen and its
   organization resolution (always `resolveActiveOrganizationId`, never client
   input); RLS policies on the table; `audit_logs` for exports.
4. **Do NOT:** delete anything, "fix" the row's `organization_id`, or notify
   affected merchants before the owner decides.
5. **Escalate:** always, immediately, to the project owner.

## 8. Suspected security incident

(Leaked key, unknown admin activity, credential stuffing, forged webhook.)

1. **Containment:** rotate the suspected secret (Supabase service-role key / anon
   key, `RATE_LIMIT_KEY_SECRET`, provider secrets) in the provider dashboard and
   the deployment env, then redeploy. Revoke sessions for affected accounts
   (Supabase → Users → sign out). Rotating the service key also resets rate-limit
   buckets (by design).
2. **Collect:** time window, request IDs, `rate_limit.exceeded` patterns by
   `ruleId`, `audit_logs` for permission changes / exports / refunds, Supabase Auth
   logs.
3. **Inspect (safe):** `audit_logs` (append-only), team/role changes, new API keys.
4. **Do NOT:** delete logs or audit rows; post details in public channels; test the
   exploit against production.
5. **Escalate:** always, immediately. The owner decides on disclosure.
