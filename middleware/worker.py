from __future__ import annotations

import os
import time
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

import httpx
import psycopg2
import psycopg2.extras
from celery import Celery


REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
ABS_URL = os.getenv("ABS_URL", "http://mock_abs:8001")
MANUAL_REVIEW_ERRORS = {"AMOUNT_MISMATCH", "CREDIT_NOT_FOUND", "ALREADY_CLOSED"}

celery_app = Celery("kaspi_sync", broker=REDIS_URL, backend=REDIS_URL)
celery_app.conf.timezone = "Asia/Almaty"
celery_app.conf.beat_schedule = {
    "poll-and-sync-every-30-seconds": {
        "task": "worker.poll_and_sync",
        "schedule": 30.0,
    }
}


def connect():
    return psycopg2.connect(
        dbname=os.getenv("POSTGRES_DB", "kaspi"),
        user=os.getenv("POSTGRES_USER", "kaspi"),
        password=os.getenv("POSTGRES_PASSWORD", "kaspi123"),
        host=os.getenv("POSTGRES_HOST", "postgres"),
        port=int(os.getenv("POSTGRES_PORT", "5432")),
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def fetch_abs_status() -> tuple[bool, int, dict[str, Any]]:
    started = time.perf_counter()
    try:
        response = httpx.get(f"{ABS_URL}/abs/status", timeout=5.0)
        response.raise_for_status()
        data = response.json()
        online = bool(data.get("online"))
    except Exception as exc:
        data = {"online": False, "error": str(exc)}
        online = False
    response_ms = int((time.perf_counter() - started) * 1000)
    return online, response_ms, data


def log_abs_health(connection, online: bool, response_ms: int) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO abs_health_log (is_online, response_ms) VALUES (%s, %s)",
            (online, response_ms),
        )
    connection.commit()


def get_pending_batch(connection) -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT q.id AS queue_id, q.payment_event_id, q.priority, q.retry_count,
                   p.client_id, p.credit_id, p.amount_tiyin, p.accepted_at, p.status
            FROM pending_abs_sync q
            JOIN payment_events p ON p.id = q.payment_event_id
            WHERE p.status = 'PENDING_ABS'
            ORDER BY q.priority DESC, q.created_at ASC
            LIMIT 50
            """
        )
        return list(cursor.fetchall())


def post_to_abs(row: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "credit_id": row["credit_id"],
        "amount": int(row["amount_tiyin"]),
        "payment_id": str(row["payment_event_id"]),
        "original_time": row["accepted_at"].isoformat(),
        "client_id": row["client_id"],
    }
    try:
        response = httpx.post(f"{ABS_URL}/abs/sync-credit", json=payload, timeout=5.0)
        if response.status_code >= 500:
            return {"success": False, "error_code": "HARD_ERROR", "error": f"HTTP {response.status_code}"}
        return response.json()
    except Exception as exc:
        return {"success": False, "error_code": "NETWORK_ERROR", "error": str(exc)}


def capture_payment(connection, row: dict[str, Any], abs_response: dict[str, Any]) -> bool:
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM payment_events WHERE id = %s FOR UPDATE", (row["payment_event_id"],))
                payment = cursor.fetchone()
                if payment is None:
                    return False
                if payment["status"] == "SYNCED_ABS":
                    cursor.execute("DELETE FROM pending_abs_sync WHERE payment_event_id = %s", (payment["id"],))
                    return False
                if payment["status"] in ("FAILED", "MANUAL_REVIEW"):
                    cursor.execute("DELETE FROM pending_abs_sync WHERE payment_event_id = %s", (payment["id"],))
                    return False

                cursor.execute("SELECT * FROM wallet_ledger WHERE client_id = %s FOR UPDATE", (payment["client_id"],))
                wallet = cursor.fetchone()
                if wallet is None or wallet["reserved_tiyin"] < payment["amount_tiyin"]:
                    raise RuntimeError("Wallet reserve is inconsistent")

                cursor.execute(
                    """
                    UPDATE wallet_ledger
                    SET balance_tiyin = balance_tiyin - %s,
                        reserved_tiyin = reserved_tiyin - %s,
                        updated_at = NOW()
                    WHERE client_id = %s
                    RETURNING balance_tiyin, reserved_tiyin
                    """,
                    (payment["amount_tiyin"], payment["amount_tiyin"], payment["client_id"]),
                )
                updated_wallet = cursor.fetchone()

                cursor.execute(
                    """
                    INSERT INTO wallet_events (
                        client_id, payment_event_id, event_type, amount_tiyin,
                        balance_tiyin_after, reserved_tiyin_after, details
                    )
                    VALUES (%s, %s, 'CAPTURE', %s, %s, %s, %s)
                    """,
                    (
                        payment["client_id"],
                        payment["id"],
                        payment["amount_tiyin"],
                        updated_wallet["balance_tiyin"],
                        updated_wallet["reserved_tiyin"],
                        psycopg2.extras.Json({"abs_response": abs_response, "worker": True}),
                    ),
                )

                posted_at = abs_response.get("posted_at")
                synced_at = datetime.fromisoformat(posted_at) if posted_at else datetime.now(timezone.utc)
                cursor.execute(
                    """
                    UPDATE payment_events
                    SET status = 'SYNCED_ABS',
                        synced_at = %s,
                        abs_error = NULL,
                        reconciliation_status = 'NONE',
                        abs_response = %s
                    WHERE id = %s
                    """,
                    (synced_at, psycopg2.extras.Json(abs_response), payment["id"]),
                )
                if abs_response.get("remaining_amount") is not None:
                    cursor.execute(
                        """
                        UPDATE credits_cache
                        SET remaining_amount_tiyin = %s, updated_at = NOW()
                        WHERE credit_id = %s
                        """,
                        (int(abs_response["remaining_amount"]), payment["credit_id"]),
                    )
                cursor.execute("DELETE FROM pending_abs_sync WHERE payment_event_id = %s", (payment["id"],))
        return True
    except Exception as exc:
        print(f"CAPTURE failed for {row['payment_event_id']}: {exc}")
        return False


def record_manual_review(connection, row: dict[str, Any], result: dict[str, Any]) -> bool:
    error_code = str(result.get("error_code") or "RECONCILIATION_EXCEPTION")
    message = str(result.get("message") or result.get("error") or "ABS reconciliation exception")
    with connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM payment_events WHERE id = %s FOR UPDATE", (row["payment_event_id"],))
            payment = cursor.fetchone()
            if payment is None or payment["status"] == "SYNCED_ABS":
                cursor.execute("DELETE FROM pending_abs_sync WHERE id = %s", (row["queue_id"],))
                return False
            cursor.execute(
                """
                UPDATE payment_events
                SET status = 'MANUAL_REVIEW',
                    manual_review_reason = %s,
                    reconciliation_error = %s,
                    reconciliation_status = 'EXCEPTION',
                    policy_status = 'REVIEW_REQUIRED',
                    policy_decision = 'RECONCILIATION_EXCEPTION',
                    penalty_protected = FALSE,
                    protection_reason = 'ABS reconciliation exception requires manual review',
                    abs_error = %s,
                    abs_response = %s
                WHERE id = %s
                """,
                (message, error_code, error_code, psycopg2.extras.Json(result), payment["id"]),
            )
            cursor.execute("DELETE FROM pending_abs_sync WHERE id = %s", (row["queue_id"],))
    return True


def record_failure(connection, row: dict[str, Any], error: str) -> bool:
    released = False
    with connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM pending_abs_sync WHERE id = %s FOR UPDATE", (row["queue_id"],))
            queue = cursor.fetchone()
            if queue is None:
                return False

            next_retry = int(queue["retry_count"]) + 1
            cursor.execute(
                """
                UPDATE pending_abs_sync
                SET retry_count = %s, last_attempt = NOW(), last_error = %s
                WHERE id = %s
                """,
                (next_retry, error, row["queue_id"]),
            )

            if next_retry < 5:
                return False

            cursor.execute("SELECT * FROM payment_events WHERE id = %s FOR UPDATE", (row["payment_event_id"],))
            payment = cursor.fetchone()
            if payment is None or payment["status"] in ("SYNCED_ABS", "FAILED", "MANUAL_REVIEW"):
                cursor.execute("DELETE FROM pending_abs_sync WHERE id = %s", (row["queue_id"],))
                return False

            cursor.execute("SELECT * FROM wallet_ledger WHERE client_id = %s FOR UPDATE", (payment["client_id"],))
            wallet = cursor.fetchone()
            if wallet is None:
                raise RuntimeError("Wallet not found for release")

            release_amount = min(int(payment["amount_tiyin"]), int(wallet["reserved_tiyin"]))
            cursor.execute(
                """
                UPDATE wallet_ledger
                SET reserved_tiyin = reserved_tiyin - %s,
                    updated_at = NOW()
                WHERE client_id = %s
                RETURNING balance_tiyin, reserved_tiyin
                """,
                (release_amount, payment["client_id"]),
            )
            updated_wallet = cursor.fetchone()
            cursor.execute(
                """
                INSERT INTO wallet_events (
                    client_id, payment_event_id, event_type, amount_tiyin,
                    balance_tiyin_after, reserved_tiyin_after, details
                )
                VALUES (%s, %s, 'RELEASE', %s, %s, %s, %s)
                """,
                (
                    payment["client_id"],
                    payment["id"],
                    release_amount,
                    updated_wallet["balance_tiyin"],
                    updated_wallet["reserved_tiyin"],
                    psycopg2.extras.Json({"error": error, "worker": True}),
                ),
            )
            cursor.execute(
                """
                UPDATE payment_events
                SET status = 'FAILED', abs_error = %s
                WHERE id = %s
                """,
                (error, payment["id"]),
            )
            cursor.execute("DELETE FROM pending_abs_sync WHERE id = %s", (row["queue_id"],))
            released = True
    return released


@celery_app.task(name="worker.poll_and_sync")
def poll_and_sync():
    with closing(connect()) as connection:
        online, response_ms, status = fetch_abs_status()
        log_abs_health(connection, online, response_ms)

        if not online:
            print(f"ABS offline ({status.get('mode', 'unknown')}), queue waits")
            return {"online": False, "synced": 0, "total": 0}

        pending = get_pending_batch(connection)
        synced = 0
        failed_final = 0
        manual_review = 0

        for row in pending:
            result = post_to_abs(row)
            if result.get("success"):
                if capture_payment(connection, row, result):
                    synced += 1
                    print(
                        f"Synced payment {row['payment_event_id']} "
                        f"client={row['client_id']} amount={row['amount_tiyin']}"
                    )
                continue

            error_code = str(result.get("error_code") or "")
            if error_code in MANUAL_REVIEW_ERRORS:
                if record_manual_review(connection, row, result):
                    manual_review += 1
                    print(f"Manual review for payment {row['payment_event_id']}: {error_code}")
                continue

            error = str(result.get("message") or result.get("error") or "ABS sync failed")
            if record_failure(connection, row, error):
                failed_final += 1

        print(f"Synced {synced} of {len(pending)}; manual_review={manual_review}; failed_final={failed_final}")
        return {
            "online": True,
            "synced": synced,
            "total": len(pending),
            "failed_final": failed_final,
            "manual_review": manual_review,
        }
