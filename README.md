# Kaspi SmartPay 24/7

Trust & Penalty Policy Layer for legacy ABS payments.

SmartPay Penalty Shield is a hackathon demo showing how a bank can accept and prove time-critical loan payments even when a legacy ABS is unavailable outside the banking day.

## What Problem We Solve

Legacy ABS systems can be offline at night, on weekends, or during maintenance windows. A simple queue can store a payment for later, but it does not answer the banking question that matters:

> Did the customer pay on time, who proves it, and why should penalties be applied or not applied?

SmartPay Penalty Shield adds a policy layer:

- fixes immutable `accepted_at`;
- reserves funds in a wallet ledger;
- calculates `cutoff_at`, `policy_status`, `policy_decision`, and `protection_reason`;
- generates a dispute-proof receipt with `event_hash`;
- syncs with legacy ABS when it is available;
- routes reconciliation exceptions to `MANUAL_REVIEW` while keeping the reserve locked.

## Architecture

- Client UI: Direct Legacy Mode vs SmartPay Middleware Mode.
- Middleware Trust Layer: accepts payments 24/7, owns idempotency and policy decisions.
- Wallet Ledger: reserve, capture, release events in integer tiyin.
- Policy Engine: cutoff/grace/ABS downtime decisions in `Asia/Almaty`.
- Audit Proof: deterministic SHA-256 event hash.
- Pending ABS Sync: durable queue for deferred synchronization.
- Mock Legacy ABS: banking-day availability plus exception simulation.
- Celery Worker: captures successful syncs, retries hard failures, sends reconciliation exceptions to manual review.
- Admin Dashboard: ABS controls, policy metrics, penalty decisions, reconciliation exceptions, and pending queue.

## Demo Flow

```bash
docker compose up -d --build
```

Open:

- Customer UI: <http://localhost:3000>
- Admin dashboard: <http://localhost:3000/admin>
- Middleware API: <http://localhost:8000/docs>
- Mock ABS: <http://localhost:8001/abs/status>

Suggested story:

1. Open `/admin`.
2. Force ABS `OFFLINE`.
3. Open `/`.
4. Select `Direct Legacy Mode` and pay: the legacy payment fails because ABS is unavailable.
5. Select `SmartPay Middleware Mode` and pay: SmartPay accepts the payment, reserves funds, calculates policy, and opens a receipt.
6. On `/success?payment_id=...`, show `Penalty Decision` and `Audit Proof`.
7. Return to `/admin`; show pending queue and policy metrics.
8. Force ABS `ONLINE`; wait for the worker; payment becomes `SYNCED_ABS` and reserve is captured.
9. Set simulation mode `AMOUNT_MISMATCH`.
10. Create another SmartPay payment while ABS is online or bring ABS online after queueing.
11. Worker moves the payment to `MANUAL_REVIEW`; reserve remains locked and the admin dashboard shows a reconciliation exception.

## Why This Is More Than a Queue

A queue says: "we will try later."

SmartPay Penalty Shield says:

- when the payment was accepted: immutable `accepted_at`;
- what product deadline applied: `cutoff_at` and `deadline_at`;
- whether penalty protection is active, not active, or needs review;
- why the policy decision was made;
- what wallet reserve event backs the receipt;
- what deterministic `event_hash` proves the accepted event;
- which ABS reconciliation exceptions need bank review.

## Policy Decisions

The policy engine evaluates:

- `ACCEPTED_BEFORE_CUTOFF`: protected when accepted before product cutoff and reserve succeeded.
- `AFTER_CUTOFF_NOT_PROTECTED`: not protected when accepted after cutoff while ABS is online.
- `ABS_DOWNTIME_REVIEW_REQUIRED`: after cutoff during ABS downtime; safe default is bank review.
- `ABS_DOWNTIME_GRACE_APPLIED`: protected if a demo policy disables manual review after cutoff.
- `INSUFFICIENT_POLICY_DATA`: review required when policy data is incomplete.
- `RECONCILIATION_EXCEPTION`: review required when ABS returns business exceptions like amount mismatch.

Supported payment statuses:

- `ACCEPTED`
- `PENDING_ABS`
- `SYNCED_ABS`
- `FAILED`
- `MANUAL_REVIEW`

## API Endpoints

Payment:

- `POST /legacy/pay`
- `POST /pay`
- `GET /status/{payment_id}`
- `GET /receipt/{payment_id}`
- `GET /wallet/{client_id}`
- `GET /credits/{client_id}`

ABS control:

- `GET /abs/status`
- `POST /abs/toggle`
- `POST /abs/reset`
- `GET /abs/simulation-mode`
- `POST /abs/simulation-mode`

Admin and demo:

- `GET /admin/stats`
- `GET /admin/queue`
- `GET /admin/abs-health`
- `GET /demo/reset`
- `GET /demo/scenarios`

Mock ABS simulation modes:

- `NORMAL`
- `AMOUNT_MISMATCH`
- `CREDIT_NOT_FOUND`
- `ALREADY_CLOSED`
- `HARD_ERROR`

## Data Safety Notes

- `middleware/schema.sql` uses `CREATE TABLE IF NOT EXISTS`.
- New columns are added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Normal container restart does not drop pending payments.
- `/demo/reset` intentionally clears demo ledger/events/queue/health/cache and resets mock ABS state.
- Money is stored as integer tiyin in `BIGINT`.
- The frontend sends amount as a string; backend rejects floats.

## Test Plan

Backend syntax:

```bash
python -m py_compile mock_abs/main.py
python -m py_compile middleware/main.py
python -m py_compile middleware/database.py
python -m py_compile middleware/models.py
python -m py_compile middleware/worker.py
python -m py_compile middleware/policy.py
python -m py_compile middleware/audit.py
```

Docker and frontend:

```bash
docker compose config --quiet
cd frontend
npm run build
cd ..
docker compose build
docker compose up -d
```

Smoke API:

- `GET http://localhost:8001/abs/status`
- Force ABS offline through `/abs/toggle`.
- `POST http://localhost:8000/legacy/pay` should fail while ABS is unavailable.
- `POST http://localhost:8000/pay` should create `PENDING_ABS`.
- `GET /receipt/{payment_id}` should include policy fields, `event_hash`, and `audit_proof`.
- Repeat `/pay` with the same `request_id`; it should return the same `payment_id`.
- Force ABS online; worker should move payment to `SYNCED_ABS`.
- Wallet reserved amount should return to zero after capture.
- Set simulation mode `AMOUNT_MISMATCH`; another SmartPay payment should become `MANUAL_REVIEW`.
- Manual review keeps reserved money locked.

Browser smoke:

- `/` opens and shows both payment modes.
- `/success?payment_id=...` works after browser refresh.
- Penalty Decision block is visible.
- Audit Proof block is visible.
- `/admin` opens and shows Policy Metrics, Simulation mode selector, and Manual review table.

## Troubleshooting

- Docker Desktop must be running.
- Ports used: `3000`, `8000`, `8001`, `5432`, `6379`.
- If a port is busy, stop the conflicting service or update `docker-compose.yml`.
- CRA `npm audit` warnings are non-blocking for this hackathon demo.
- If demo data looks stale, use `/demo/reset` from the admin dashboard.
