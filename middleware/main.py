from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, time as datetime_time, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import asyncpg
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from audit import build_event_hash
from database import close_pool, get_pool, init_db
from models import (
    AdminStats,
    PaymentRequest,
    PaymentResponse,
    PaymentState,
    PaymentStatus,
    ReceiptData,
    SimulationModeRequest,
    ToggleABSRequest,
    WalletInfo,
)
from policy import evaluate_penalty_policy


logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

ABS_URL = os.getenv("ABS_URL", "http://mock_abs:8001")
ALMATY_TZ = ZoneInfo("Asia/Almaty")
MANUAL_REVIEW_ERRORS = {"AMOUNT_MISMATCH", "CREDIT_NOT_FOUND", "ALREADY_CLOSED"}


def tenge_to_tiyin(value: int | str) -> int:
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid amount")

    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")

    tiyins = amount * Decimal("100")
    if tiyins != tiyins.to_integral_value():
        raise HTTPException(status_code=400, detail="Amount precision cannot be smaller than tiyin")

    return int(tiyins)


def tiyins_to_tenge(tiyins: int) -> int:
    return int(tiyins // 100)


def deadline_for_due_date(due_date: date) -> datetime:
    local_deadline = datetime.combine(due_date, datetime_time(23, 59, 59, 999999), tzinfo=ALMATY_TZ)
    return local_deadline.astimezone(timezone.utc)


def priority_for_due_date(due_date: date) -> int:
    return 10 if due_date == datetime.now(ALMATY_TZ).date() else 0


def serialize_record(record: Any) -> dict[str, Any]:
    data = dict(record)
    for key, value in data.items():
        if isinstance(value, UUID):
            data[key] = str(value)
        elif isinstance(value, (datetime, date)):
            data[key] = value.isoformat()
    return data


def json_safe(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


def policy_receipt_text(policy_status: str, policy_decision: str) -> str:
    if policy_status == "PROTECTED":
        return "Kaspi Sync protection: active. Basis: accepted_at before cutoff or grace policy."
    if policy_status == "REVIEW_REQUIRED":
        if policy_decision == "ABS_DOWNTIME_REVIEW_REQUIRED":
            return "Kaspi Sync protection: bank review required. Basis: payment accepted after cutoff during ABS downtime."
        return "Kaspi Sync protection: bank review required."
    return "Kaspi Sync protection: not applied. Basis: payment accepted after cutoff."


async def reset_database(connection: asyncpg.Connection) -> None:
    today = datetime.now(ALMATY_TZ).date()
    tomorrow = today.fromordinal(today.toordinal() + 1)

    await connection.execute("DELETE FROM pending_abs_sync")
    await connection.execute("DELETE FROM wallet_events")
    await connection.execute("DELETE FROM payment_events")
    await connection.execute("DELETE FROM abs_health_log")
    await connection.execute(
        """
        INSERT INTO wallet_ledger (client_id, balance_tiyin, reserved_tiyin)
        VALUES ('client_001', 75000000, 0), ('client_002', 30000000, 0)
        ON CONFLICT (client_id) DO UPDATE
        SET balance_tiyin = EXCLUDED.balance_tiyin,
            reserved_tiyin = 0,
            updated_at = NOW()
        """
    )
    await connection.execute("DELETE FROM credits_cache")
    await connection.executemany(
        """
        INSERT INTO credits_cache (
            credit_id, client_id, name, total_amount_tiyin,
            remaining_amount_tiyin, due_date, status, cutoff_time,
            grace_policy, abs_downtime_grace_enabled, manual_review_after_cutoff,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', '20:00',
                'STANDARD_CUTOFF', TRUE, TRUE, NOW())
        """,
        [
            ("credit-001", "client_001", "Kaspi Installment 24 months", 50000000, 25000000, today),
            ("credit-002", "client_001", "Kaspi Cash Loan", 100000000, 75000000, tomorrow),
            ("credit-003", "client_002", "Kaspi Installment 12 months", 20000000, 18000000, today),
        ],
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    if os.getenv("DEMO_RESET_ON_START", "false").lower() == "true":
        pool = await get_pool()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await reset_database(connection)
    yield
    await close_pool()


app = FastAPI(
    title="Kaspi Sync - Trust & Penalty Policy Layer",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def fetch_abs_status(log_health: bool = True) -> dict[str, Any]:
    started = time.perf_counter()
    status = {"online": False, "mode": "error", "hour": datetime.now(ALMATY_TZ).hour}
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(f"{ABS_URL}/abs/status")
            response.raise_for_status()
            status.update(response.json())
    except Exception as exc:
        status["error"] = str(exc)

    status["response_ms"] = int((time.perf_counter() - started) * 1000)

    if log_health:
        try:
            pool = await get_pool()
            async with pool.acquire() as connection:
                await connection.execute(
                    "INSERT INTO abs_health_log (is_online, response_ms) VALUES ($1, $2)",
                    bool(status["online"]),
                    int(status["response_ms"]),
                )
        except Exception:
            logger.exception("Could not write ABS health log")

    return status


async def fetch_abs_simulation_mode() -> str:
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(f"{ABS_URL}/abs/simulation-mode")
            response.raise_for_status()
            return str(response.json().get("mode", "NORMAL"))
    except Exception:
        return "UNKNOWN"


async def get_wallet_row(connection: asyncpg.Connection, client_id: str) -> asyncpg.Record:
    row = await connection.fetchrow(
        """
        SELECT client_id, balance_tiyin, reserved_tiyin,
               balance_tiyin - reserved_tiyin AS available_tiyin,
               updated_at
        FROM wallet_ledger
        WHERE client_id = $1
        """,
        client_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Wallet not found")
    return row


async def payment_response(payment_id: UUID, message: str | None = None) -> PaymentResponse:
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT p.*, w.balance_tiyin, w.reserved_tiyin,
               w.balance_tiyin - w.reserved_tiyin AS available_tiyin
        FROM payment_events p
        JOIN wallet_ledger w ON w.client_id = p.client_id
        WHERE p.id = $1
        """,
        payment_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Payment not found")

    default_message = (
        "Payment synced with legacy ABS"
        if row["status"] == PaymentState.SYNCED_ABS.value
        else "Payment accepted by Kaspi Sync Trust Layer; ABS synchronization is pending."
    )
    return PaymentResponse(
        payment_id=row["id"],
        request_id=row["request_id"],
        client_id=row["client_id"],
        credit_id=row["credit_id"],
        amount=row["amount_tiyin"],
        amount_tenge=tiyins_to_tenge(row["amount_tiyin"]),
        status=row["status"],
        accepted_at=row["accepted_at"],
        deadline_at=row["deadline_at"],
        cutoff_at=row["cutoff_at"],
        penalty_protected=row["penalty_protected"],
        penalty_protection=row["penalty_protected"],
        policy_status=row["policy_status"],
        policy_decision=row["policy_decision"],
        protection_reason=row["protection_reason"],
        abs_status_at_acceptance=row["abs_status_at_acceptance"],
        wallet_reserve_event_id=row["wallet_reserve_event_id"],
        event_hash=row["event_hash"],
        wallet_balance_after=tiyins_to_tenge(row["balance_tiyin"]),
        wallet_reserved_after=tiyins_to_tenge(row["reserved_tiyin"]),
        wallet_available_after=tiyins_to_tenge(row["available_tiyin"]),
        message=message or default_message,
    )


async def enqueue_pending(payment_id: UUID, priority: int, error: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as connection:
        async with connection.transaction():
            payment = await connection.fetchrow(
                "SELECT id, status FROM payment_events WHERE id = $1 FOR UPDATE",
                payment_id,
            )
            if payment is None:
                raise HTTPException(status_code=404, detail="Payment not found")
            if payment["status"] in (
                PaymentState.SYNCED_ABS.value,
                PaymentState.FAILED.value,
                PaymentState.MANUAL_REVIEW.value,
            ):
                return
            await connection.execute(
                """
                UPDATE payment_events
                SET status = 'PENDING_ABS', abs_error = $2
                WHERE id = $1
                """,
                payment_id,
                error,
            )
            await connection.execute(
                """
                INSERT INTO pending_abs_sync (payment_event_id, priority, last_error)
                VALUES ($1, $2, $3)
                ON CONFLICT (payment_event_id) DO UPDATE
                SET priority = GREATEST(pending_abs_sync.priority, EXCLUDED.priority),
                    last_error = EXCLUDED.last_error
                """,
                payment_id,
                priority,
                error,
            )


async def capture_payment(payment_id: UUID, abs_response: dict[str, Any]) -> None:
    pool = await get_pool()
    posted_at = abs_response.get("posted_at")
    synced_at = datetime.fromisoformat(posted_at) if posted_at else datetime.now(timezone.utc)

    async with pool.acquire() as connection:
        async with connection.transaction():
            payment = await connection.fetchrow("SELECT * FROM payment_events WHERE id = $1 FOR UPDATE", payment_id)
            if payment is None:
                raise HTTPException(status_code=404, detail="Payment not found")
            if payment["status"] in (PaymentState.SYNCED_ABS.value, PaymentState.FAILED.value):
                return

            wallet = await connection.fetchrow(
                "SELECT * FROM wallet_ledger WHERE client_id = $1 FOR UPDATE",
                payment["client_id"],
            )
            if wallet is None:
                raise HTTPException(status_code=404, detail="Wallet not found")
            if wallet["reserved_tiyin"] < payment["amount_tiyin"]:
                raise HTTPException(status_code=409, detail="Wallet reserve is inconsistent")

            updated_wallet = await connection.fetchrow(
                """
                UPDATE wallet_ledger
                SET balance_tiyin = balance_tiyin - $1,
                    reserved_tiyin = reserved_tiyin - $1,
                    updated_at = NOW()
                WHERE client_id = $2
                RETURNING balance_tiyin, reserved_tiyin
                """,
                payment["amount_tiyin"],
                payment["client_id"],
            )
            await connection.execute(
                """
                INSERT INTO wallet_events (
                    client_id, payment_event_id, event_type, amount_tiyin,
                    balance_tiyin_after, reserved_tiyin_after, details
                )
                VALUES ($1, $2, 'CAPTURE', $3, $4, $5, $6::jsonb)
                """,
                payment["client_id"],
                payment_id,
                payment["amount_tiyin"],
                updated_wallet["balance_tiyin"],
                updated_wallet["reserved_tiyin"],
                {"abs_response": abs_response},
            )
            await connection.execute(
                """
                UPDATE payment_events
                SET status = 'SYNCED_ABS',
                    synced_at = $2,
                    abs_error = NULL,
                    reconciliation_status = 'NONE',
                    abs_response = $3::jsonb
                WHERE id = $1
                """,
                payment_id,
                synced_at,
                abs_response,
            )
            if abs_response.get("remaining_amount") is not None:
                await connection.execute(
                    """
                    UPDATE credits_cache
                    SET remaining_amount_tiyin = $1, updated_at = NOW()
                    WHERE credit_id = $2
                    """,
                    int(abs_response["remaining_amount"]),
                    payment["credit_id"],
                )
            await connection.execute("DELETE FROM pending_abs_sync WHERE payment_event_id = $1", payment_id)


async def mark_manual_review(payment_id: UUID, error_code: str, message: str, abs_response: dict[str, Any]) -> None:
    pool = await get_pool()
    async with pool.acquire() as connection:
        async with connection.transaction():
            payment = await connection.fetchrow("SELECT * FROM payment_events WHERE id = $1 FOR UPDATE", payment_id)
            if payment is None or payment["status"] == PaymentState.SYNCED_ABS.value:
                return
            await connection.execute(
                """
                UPDATE payment_events
                SET status = 'MANUAL_REVIEW',
                    manual_review_reason = $2,
                    reconciliation_error = $3,
                    reconciliation_status = 'EXCEPTION',
                    policy_status = 'REVIEW_REQUIRED',
                    policy_decision = 'RECONCILIATION_EXCEPTION',
                    penalty_protected = FALSE,
                    protection_reason = 'ABS reconciliation exception requires manual review',
                    abs_error = $3,
                    abs_response = $4::jsonb
                WHERE id = $1
                """,
                payment_id,
                message,
                error_code,
                abs_response,
            )
            await connection.execute("DELETE FROM pending_abs_sync WHERE payment_event_id = $1", payment_id)


async def sync_payment_with_abs(payment: asyncpg.Record) -> tuple[str, str]:
    payload = {
        "credit_id": payment["credit_id"],
        "amount": payment["amount_tiyin"],
        "payment_id": str(payment["id"]),
        "original_time": payment["accepted_at"].isoformat(),
        "client_id": payment["client_id"],
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(f"{ABS_URL}/abs/sync-credit", json=payload)
            if response.status_code >= 500:
                return "pending", f"ABS hard error: HTTP {response.status_code}"
            result = response.json()
    except Exception as exc:
        return "pending", str(exc)

    if result.get("success"):
        await capture_payment(payment["id"], result)
        return "synced", "Payment synced with legacy ABS immediately"

    error_code = str(result.get("error_code") or "")
    message = str(result.get("message") or result.get("error") or "ABS sync failed")
    if error_code in MANUAL_REVIEW_ERRORS:
        await mark_manual_review(payment["id"], error_code, message, result)
        return "manual_review", message

    return "pending", message


@app.post("/pay", response_model=PaymentResponse)
async def pay(payload: PaymentRequest):
    amount_tiyin = tenge_to_tiyin(payload.amount)
    pool = await get_pool()

    if payload.request_id:
        existing = await pool.fetchrow(
            "SELECT id FROM payment_events WHERE client_id = $1 AND request_id = $2",
            payload.client_id,
            payload.request_id,
        )
        if existing:
            return await payment_response(existing["id"], "Duplicate request handled idempotently")

    abs_status = await fetch_abs_status(log_health=True)
    abs_online = bool(abs_status.get("online"))
    abs_status_at_acceptance = "ONLINE" if abs_online else "OFFLINE"

    try:
        async with pool.acquire() as connection:
            async with connection.transaction():
                credit = await connection.fetchrow(
                    """
                    SELECT *
                    FROM credits_cache
                    WHERE credit_id = $1 AND client_id = $2 AND status = 'ACTIVE'
                    """,
                    payload.credit_id,
                    payload.client_id,
                )
                if credit is None:
                    raise HTTPException(status_code=404, detail="Credit not found")
                if amount_tiyin > credit["remaining_amount_tiyin"]:
                    raise HTTPException(status_code=400, detail="Amount exceeds credit remainder")

                wallet = await connection.fetchrow(
                    """
                    SELECT client_id, balance_tiyin, reserved_tiyin,
                           balance_tiyin - reserved_tiyin AS available_tiyin
                    FROM wallet_ledger
                    WHERE client_id = $1
                    FOR UPDATE
                    """,
                    payload.client_id,
                )
                if wallet is None:
                    raise HTTPException(status_code=404, detail="Wallet not found")
                if wallet["available_tiyin"] < amount_tiyin:
                    raise HTTPException(
                        status_code=400,
                        detail={
                            "error": "Insufficient funds",
                            "balance": tiyins_to_tenge(wallet["available_tiyin"]),
                            "required": tiyins_to_tenge(amount_tiyin),
                        },
                    )

                accepted_at = datetime.now(timezone.utc)
                policy = evaluate_penalty_policy(
                    accepted_at=accepted_at,
                    due_date=credit["due_date"],
                    cutoff_time=credit["cutoff_time"],
                    abs_status_at_acceptance=abs_status_at_acceptance,
                    reserve_success=True,
                    grace_policy=credit["grace_policy"],
                    abs_downtime_grace_enabled=credit["abs_downtime_grace_enabled"],
                    manual_review_after_cutoff=credit["manual_review_after_cutoff"],
                )
                deadline_at = policy["deadline_at"] or deadline_for_due_date(credit["due_date"])

                payment = await connection.fetchrow(
                    """
                    INSERT INTO payment_events (
                        client_id, credit_id, amount_tiyin, status, accepted_at,
                        deadline_at, cutoff_at, penalty_protected, policy_status,
                        policy_decision, protection_reason, grace_policy,
                        abs_status_at_acceptance, request_id, device_info
                    )
                    VALUES ($1, $2, $3, 'PENDING_ABS', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
                    RETURNING *
                    """,
                    payload.client_id,
                    payload.credit_id,
                    amount_tiyin,
                    accepted_at,
                    deadline_at,
                    policy["cutoff_at"],
                    policy["penalty_protected"],
                    policy["policy_status"],
                    policy["policy_decision"],
                    policy["protection_reason"],
                    credit["grace_policy"],
                    abs_status_at_acceptance,
                    payload.request_id,
                    payload.device_info,
                )

                updated_wallet = await connection.fetchrow(
                    """
                    UPDATE wallet_ledger
                    SET reserved_tiyin = reserved_tiyin + $1,
                        updated_at = NOW()
                    WHERE client_id = $2
                    RETURNING balance_tiyin, reserved_tiyin
                    """,
                    amount_tiyin,
                    payload.client_id,
                )
                reserve_event = await connection.fetchrow(
                    """
                    INSERT INTO wallet_events (
                        client_id, payment_event_id, event_type, amount_tiyin,
                        balance_tiyin_after, reserved_tiyin_after, details
                    )
                    VALUES ($1, $2, 'RESERVE', $3, $4, $5, $6::jsonb)
                    RETURNING id
                    """,
                    payload.client_id,
                    payment["id"],
                    amount_tiyin,
                    updated_wallet["balance_tiyin"],
                    updated_wallet["reserved_tiyin"],
                    json_safe({"reason": "Kaspi Sync Trust Layer accepted payment", "policy": policy}),
                )

                payment_for_hash = dict(payment)
                payment_for_hash["wallet_reserve_event_id"] = str(reserve_event["id"])
                event_hash = build_event_hash(payment_for_hash)
                payment = await connection.fetchrow(
                    """
                    UPDATE payment_events
                    SET wallet_reserve_event_id = $2,
                        event_hash = $3
                    WHERE id = $1
                    RETURNING *
                    """,
                    payment["id"],
                    str(reserve_event["id"]),
                    event_hash,
                )

                await connection.execute(
                    """
                    INSERT INTO pending_abs_sync (payment_event_id, priority, last_error)
                    VALUES ($1, $2, $3)
                    """,
                    payment["id"],
                    priority_for_due_date(credit["due_date"]),
                    None if abs_online else "ABS unavailable at acceptance",
                )
    except asyncpg.UniqueViolationError:
        if payload.request_id:
            existing = await pool.fetchrow(
                "SELECT id FROM payment_events WHERE client_id = $1 AND request_id = $2",
                payload.client_id,
                payload.request_id,
            )
            if existing:
                return await payment_response(existing["id"], "Duplicate request handled idempotently")
        raise

    if abs_online:
        result, message = await sync_payment_with_abs(payment)
        if result == "pending":
            await enqueue_pending(payment["id"], priority_for_due_date(credit["due_date"]), message)
            return await payment_response(payment["id"], "Payment accepted by Trust Layer; ABS sync is pending.")
        if result == "manual_review":
            return await payment_response(payment["id"], "Payment accepted but reconciliation requires bank review.")
        return await payment_response(payment["id"], message)

    return await payment_response(payment["id"], "Payment accepted by Trust Layer; ABS sync is pending.")


@app.post("/legacy/pay")
async def legacy_pay(payload: PaymentRequest):
    amount_tiyin = tenge_to_tiyin(payload.amount)
    payment_id = f"legacy-{payload.request_id or uuid4()}"
    body = {
        "credit_id": payload.credit_id,
        "amount": amount_tiyin,
        "payment_id": payment_id,
        "original_time": datetime.now(timezone.utc).isoformat(),
        "client_id": payload.client_id,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(f"{ABS_URL}/abs/sync-credit", json=body)
            if response.status_code >= 500:
                raise HTTPException(status_code=502, detail="Legacy ABS hard error")
            result = response.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Legacy ABS error: {exc}")

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message") or result.get("error") or "ABS rejected payment")

    return {
        "payment_id": payment_id,
        "status": "SYNCED_ABS",
        "message": "Legacy ABS accepted direct payment",
        "amount_tenge": tiyins_to_tenge(amount_tiyin),
        "abs_response": result,
    }


@app.get("/status/{payment_id}", response_model=PaymentStatus)
async def get_status(payment_id: UUID):
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT p.*, q.retry_count
        FROM payment_events p
        LEFT JOIN pending_abs_sync q ON q.payment_event_id = p.id
        WHERE p.id = $1
        """,
        payment_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Payment not found")

    estimated = None
    if row["status"] == PaymentState.PENDING_ABS.value:
        estimated = "Within 30 seconds after ABS is online"

    return PaymentStatus(
        payment_id=row["id"],
        client_id=row["client_id"],
        credit_id=row["credit_id"],
        amount_tiyin=row["amount_tiyin"],
        amount_tenge=tiyins_to_tenge(row["amount_tiyin"]),
        source=row["source"],
        status=row["status"],
        accepted_at=row["accepted_at"],
        deadline_at=row["deadline_at"],
        cutoff_at=row["cutoff_at"],
        penalty_protected=row["penalty_protected"],
        policy_status=row["policy_status"],
        policy_decision=row["policy_decision"],
        protection_reason=row["protection_reason"],
        abs_status_at_acceptance=row["abs_status_at_acceptance"],
        wallet_reserve_event_id=row["wallet_reserve_event_id"],
        event_hash=row["event_hash"],
        synced_at=row["synced_at"],
        request_id=row["request_id"],
        abs_error=row["abs_error"],
        retry_count=row["retry_count"],
        estimated_sync_time=estimated,
        manual_review_reason=row["manual_review_reason"],
        reconciliation_error=row["reconciliation_error"],
        reconciliation_status=row["reconciliation_status"],
        device_info=row["device_info"],
        abs_response=row["abs_response"],
    )


@app.get("/receipt/{payment_id}", response_model=ReceiptData)
async def get_receipt(payment_id: UUID):
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT p.*, c.name AS credit_name, w.balance_tiyin, w.reserved_tiyin,
               w.balance_tiyin - w.reserved_tiyin AS available_tiyin
        FROM payment_events p
        LEFT JOIN credits_cache c ON c.credit_id = p.credit_id
        JOIN wallet_ledger w ON w.client_id = p.client_id
        WHERE p.id = $1
        """,
        payment_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Payment not found")

    sync_text = "confirmed" if row["status"] == PaymentState.SYNCED_ABS.value else "pending"
    if row["status"] == PaymentState.MANUAL_REVIEW.value:
        sync_text = "manual review"
    elif row["status"] == PaymentState.FAILED.value:
        sync_text = "failed"

    audit_proof = {
        "payment_id": str(row["id"]),
        "request_id": row["request_id"],
        "accepted_at": row["accepted_at"].isoformat(),
        "cutoff_at": row["cutoff_at"].isoformat() if row["cutoff_at"] else None,
        "deadline_at": row["deadline_at"].isoformat(),
        "abs_status_at_acceptance": row["abs_status_at_acceptance"],
        "wallet_reserve_event_id": row["wallet_reserve_event_id"],
        "policy_status": row["policy_status"],
        "policy_decision": row["policy_decision"],
        "penalty_protected": row["penalty_protected"],
        "protection_reason": row["protection_reason"],
        "event_hash": row["event_hash"],
    }
    wallet_details = {
        "balance_tenge": tiyins_to_tenge(row["balance_tiyin"]),
        "reserved_tenge": tiyins_to_tenge(row["reserved_tiyin"]),
        "available_tenge": tiyins_to_tenge(row["available_tiyin"]),
        "reserve_event_id": row["wallet_reserve_event_id"],
    }
    sync_details = {
        "status": row["status"],
        "synced_at": row["synced_at"].isoformat() if row["synced_at"] else None,
        "retryable_error": row["abs_error"],
        "manual_review_reason": row["manual_review_reason"],
        "reconciliation_error": row["reconciliation_error"],
        "reconciliation_status": row["reconciliation_status"],
        "abs_response": row["abs_response"],
    }

    return ReceiptData(
        payment_id=row["id"],
        request_id=row["request_id"],
        client_id=row["client_id"],
        credit_id=row["credit_id"],
        credit_name=row["credit_name"] or row["credit_id"],
        amount_tenge=tiyins_to_tenge(row["amount_tiyin"]),
        source=row["source"],
        status=row["status"],
        accepted_at=row["accepted_at"],
        deadline_at=row["deadline_at"],
        cutoff_at=row["cutoff_at"],
        synced_at=row["synced_at"],
        penalty_protected=row["penalty_protected"],
        policy_status=row["policy_status"],
        policy_decision=row["policy_decision"],
        protection_reason=row["protection_reason"],
        abs_status_at_acceptance=row["abs_status_at_acceptance"],
        wallet_reserve_event_id=row["wallet_reserve_event_id"],
        event_hash=row["event_hash"],
        manual_review_reason=row["manual_review_reason"],
        reconciliation_error=row["reconciliation_error"],
        reconciliation_status=row["reconciliation_status"],
        penalty_text=policy_receipt_text(row["policy_status"], row["policy_decision"]),
        sync_text=f"ABS synchronization: {sync_text}",
        audit_proof=audit_proof,
        wallet_details=wallet_details,
        sync_details=sync_details,
    )


@app.get("/wallet/{client_id}", response_model=WalletInfo)
async def get_wallet(client_id: str):
    pool = await get_pool()
    async with pool.acquire() as connection:
        row = await get_wallet_row(connection, client_id)
    return WalletInfo(
        client_id=row["client_id"],
        balance_tenge=tiyins_to_tenge(row["balance_tiyin"]),
        reserved_tenge=tiyins_to_tenge(row["reserved_tiyin"]),
        available_tenge=tiyins_to_tenge(row["available_tiyin"]),
        balance_tiyin=row["balance_tiyin"],
        reserved_tiyin=row["reserved_tiyin"],
        available_tiyin=row["available_tiyin"],
        updated_at=row["updated_at"],
    )


@app.get("/credits/{client_id}")
async def get_credits(client_id: str):
    pool = await get_pool()
    abs_status = await fetch_abs_status(log_health=False)

    if abs_status.get("online"):
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(f"{ABS_URL}/abs/credits/{client_id}")
                response.raise_for_status()
                for credit in response.json().get("credits", []):
                    await pool.execute(
                        """
                        INSERT INTO credits_cache (
                            credit_id, client_id, name, total_amount_tiyin,
                            remaining_amount_tiyin, due_date, status, updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                        ON CONFLICT (credit_id) DO UPDATE
                        SET name = EXCLUDED.name,
                            total_amount_tiyin = EXCLUDED.total_amount_tiyin,
                            remaining_amount_tiyin = EXCLUDED.remaining_amount_tiyin,
                            due_date = EXCLUDED.due_date,
                            status = EXCLUDED.status,
                            updated_at = NOW()
                        """,
                        credit["credit_id"],
                        credit["client_id"],
                        credit["name"],
                        int(credit["total_amount"]),
                        int(credit["remaining_amount"]),
                        date.fromisoformat(credit["due_date"]),
                        credit.get("status", "ACTIVE"),
                    )
        except Exception:
            logger.exception("Could not refresh credits from ABS")

    rows = await pool.fetch(
        """
        SELECT credit_id, client_id, name, total_amount_tiyin, remaining_amount_tiyin,
               due_date, status, cutoff_time, grace_policy, abs_downtime_grace_enabled,
               manual_review_after_cutoff, updated_at
        FROM credits_cache
        WHERE client_id = $1
        ORDER BY due_date ASC, credit_id ASC
        """,
        client_id,
    )
    return {"client_id": client_id, "credits": [serialize_record(row) for row in rows]}


@app.get("/admin/queue")
async def get_admin_queue():
    pool = await get_pool()
    queue_rows = await pool.fetch(
        """
        SELECT q.id, q.payment_event_id, q.priority, q.retry_count, q.created_at,
               q.last_attempt, q.last_error, p.client_id, p.credit_id, p.amount_tiyin,
               p.status, p.accepted_at, p.deadline_at, p.cutoff_at, p.penalty_protected,
               p.policy_status, p.policy_decision, p.protection_reason,
               p.abs_status_at_acceptance, p.event_hash
        FROM pending_abs_sync q
        JOIN payment_events p ON p.id = q.payment_event_id
        WHERE p.status = 'PENDING_ABS'
        ORDER BY q.priority DESC, q.created_at ASC
        """
    )
    decision_rows = await pool.fetch(
        """
        SELECT id AS payment_id, client_id, credit_id, amount_tiyin, status, accepted_at,
               cutoff_at, abs_status_at_acceptance, policy_status, policy_decision,
               protection_reason, event_hash
        FROM payment_events
        ORDER BY accepted_at DESC
        LIMIT 100
        """
    )
    manual_rows = await pool.fetch(
        """
        SELECT id AS payment_id, client_id, credit_id, amount_tiyin, status, accepted_at,
               cutoff_at, manual_review_reason, reconciliation_error, reconciliation_status,
               wallet_reserve_event_id, event_hash
        FROM payment_events
        WHERE status = 'MANUAL_REVIEW'
        ORDER BY accepted_at DESC
        """
    )
    return {
        "queue": [serialize_record(row) for row in queue_rows],
        "penalty_decisions": [serialize_record(row) for row in decision_rows],
        "manual_review": [serialize_record(row) for row in manual_rows],
    }


@app.get("/admin/stats", response_model=AdminStats)
async def get_admin_stats():
    pool = await get_pool()
    abs_status = await fetch_abs_status(log_health=False)
    simulation_mode = await fetch_abs_simulation_mode()
    row = await pool.fetchrow(
        """
        SELECT
            (SELECT COUNT(*)::INT FROM pending_abs_sync q
             JOIN payment_events p ON p.id = q.payment_event_id
             WHERE p.status = 'PENDING_ABS') AS pending_abs_sync,
            COUNT(*) FILTER (WHERE status = 'SYNCED_ABS')::INT AS synced_payments,
            COUNT(*) FILTER (WHERE status = 'FAILED')::INT AS failed_payments,
            COUNT(*) FILTER (WHERE status = 'MANUAL_REVIEW')::INT AS manual_review_payments,
            COUNT(*) FILTER (WHERE policy_status = 'PROTECTED')::INT AS protected_payments,
            COUNT(*) FILTER (WHERE policy_status = 'REVIEW_REQUIRED')::INT AS review_required_payments,
            COUNT(*) FILTER (WHERE policy_status = 'NOT_PROTECTED')::INT AS not_protected_payments,
            COALESCE((SELECT SUM(reserved_tiyin) FROM wallet_ledger), 0)::BIGINT AS total_reserved_tiyin,
            COALESCE(SUM(amount_tiyin) FILTER (WHERE policy_status = 'PROTECTED'), 0)::BIGINT AS total_protected_tiyin,
            COALESCE(SUM(amount_tiyin) FILTER (WHERE policy_status IN ('PROTECTED', 'REVIEW_REQUIRED')), 0)::BIGINT AS trust_saved_tiyin,
            COALESCE((SELECT SUM(p.amount_tiyin)
                      FROM pending_abs_sync q
                      JOIN payment_events p ON p.id = q.payment_event_id
                      WHERE p.status = 'PENDING_ABS'), 0)::BIGINT AS total_pending_tiyin,
            (SELECT MIN(created_at) FROM pending_abs_sync) AS oldest_pending
        FROM payment_events
        """
    )
    protected_count = row["protected_payments"]
    review_required_count = row["review_required_payments"]
    return AdminStats(
        pending_count=row["pending_abs_sync"],
        synced_count=row["synced_payments"],
        failed_count=row["failed_payments"],
        manual_review_count=row["manual_review_payments"],
        protected_count=protected_count,
        review_required_count=review_required_count,
        not_protected_count=row["not_protected_payments"],
        total_reserved_amount=tiyins_to_tenge(row["total_reserved_tiyin"]),
        total_protected_amount=tiyins_to_tenge(row["total_protected_tiyin"]),
        support_tickets_avoided_demo=protected_count + review_required_count,
        customer_trust_saved_amount=tiyins_to_tenge(row["trust_saved_tiyin"]),
        pending_abs_sync=row["pending_abs_sync"],
        synced_payments=row["synced_payments"],
        failed_payments=row["failed_payments"],
        penalty_protected_payments=protected_count,
        total_pending_tenge=tiyins_to_tenge(row["total_pending_tiyin"]),
        oldest_pending=row["oldest_pending"],
        abs_online=bool(abs_status.get("online")),
        abs_mode=str(abs_status.get("mode", "auto")),
        abs_simulation_mode=simulation_mode,
    )


@app.get("/admin/abs-health")
async def get_admin_abs_health():
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT id, is_online, checked_at, response_ms
        FROM abs_health_log
        ORDER BY checked_at DESC
        LIMIT 100
        """
    )
    uptime = await pool.fetchval(
        """
        SELECT COALESCE(ROUND(100.0 * AVG(CASE WHEN is_online THEN 1 ELSE 0 END)), 0)::INT
        FROM abs_health_log
        WHERE checked_at >= NOW() - INTERVAL '1 hour'
        """
    )
    return {"health": [serialize_record(row) for row in rows], "uptime_percent": int(uptime or 0)}


@app.get("/abs/status")
async def proxy_abs_status():
    return await fetch_abs_status(log_health=True)


@app.post("/abs/toggle")
async def proxy_abs_toggle(payload: ToggleABSRequest):
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(f"{ABS_URL}/abs/toggle", json=payload.model_dump())
            response.raise_for_status()
            return response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ABS toggle failed: {exc}")


@app.post("/abs/reset")
async def proxy_abs_reset():
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(f"{ABS_URL}/abs/reset")
            response.raise_for_status()
            return response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ABS reset failed: {exc}")


@app.get("/abs/simulation-mode")
async def proxy_get_simulation_mode():
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(f"{ABS_URL}/abs/simulation-mode")
            response.raise_for_status()
            return response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ABS simulation mode read failed: {exc}")


@app.post("/abs/simulation-mode")
async def proxy_set_simulation_mode(payload: SimulationModeRequest):
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(f"{ABS_URL}/abs/simulation-mode", json=payload.model_dump())
            response.raise_for_status()
            return response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ABS simulation mode update failed: {exc}")


@app.get("/demo/reset")
async def demo_reset():
    pool = await get_pool()
    async with pool.acquire() as connection:
        async with connection.transaction():
            await reset_database(connection)

    abs_reset = None
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(f"{ABS_URL}/abs/reset")
            response.raise_for_status()
            abs_reset = response.json()
    except Exception as exc:
        abs_reset = {"error": str(exc)}

    return {"status": "ok", "message": "Demo data reset", "abs": abs_reset}


@app.get("/demo/scenarios")
async def demo_scenarios():
    return {
        "scenarios": [
            {
                "id": "legacy_offline_fails",
                "title": "Legacy offline fails",
                "steps": ["Force ABS OFFLINE", "Try Direct Legacy Mode", "Observe ABS unavailable error"],
            },
            {
                "id": "kaspi_sync_offline_accepted",
                "title": "Kaspi Sync offline accepted and pending",
                "steps": ["Force ABS OFFLINE", "Pay through Kaspi Sync", "Open receipt with Penalty Decision and Audit Proof"],
            },
            {
                "id": "abs_online_sync_success",
                "title": "ABS online sync success",
                "steps": ["Force ABS ONLINE", "Wait for worker", "Payment becomes SYNCED_ABS and reserve is captured"],
            },
            {
                "id": "amount_mismatch_manual_review",
                "title": "Amount mismatch goes to manual review",
                "steps": ["Set simulation mode AMOUNT_MISMATCH", "Create Kaspi Sync payment", "Worker moves it to MANUAL_REVIEW"],
            },
        ]
    }
