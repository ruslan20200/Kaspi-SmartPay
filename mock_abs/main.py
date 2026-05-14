from __future__ import annotations

import time
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


ALMATY_TZ = ZoneInfo("Asia/Almaty")
STARTED_AT = time.monotonic()

app = FastAPI(title="Kaspi Legacy ABS Mock", version="3.0.0")

abs_override: Optional[bool] = None
simulation_mode: str = "NORMAL"


class ToggleRequest(BaseModel):
    online: bool


class SimulationModeRequest(BaseModel):
    mode: Literal["NORMAL", "AMOUNT_MISMATCH", "CREDIT_NOT_FOUND", "ALREADY_CLOSED", "HARD_ERROR"]


class SyncCreditRequest(BaseModel):
    credit_id: str = Field(min_length=1)
    amount: int = Field(gt=0)
    payment_id: str = Field(min_length=1)
    original_time: str
    client_id: str = Field(min_length=1)


def _today() -> date:
    return datetime.now(ALMATY_TZ).date()


def _initial_credits() -> dict[str, dict[str, dict]]:
    today = _today()
    tomorrow = today + timedelta(days=1)
    return {
        "client_001": {
            "credit-001": {
                "credit_id": "credit-001",
                "client_id": "client_001",
                "name": "Kaspi Installment 24 months",
                "total_amount": 500_000 * 100,
                "remaining_amount": 250_000 * 100,
                "due_date": today.isoformat(),
                "status": "ACTIVE",
            },
            "credit-002": {
                "credit_id": "credit-002",
                "client_id": "client_001",
                "name": "Kaspi Cash Loan",
                "total_amount": 1_000_000 * 100,
                "remaining_amount": 750_000 * 100,
                "due_date": tomorrow.isoformat(),
                "status": "ACTIVE",
            },
        },
        "client_002": {
            "credit-003": {
                "credit_id": "credit-003",
                "client_id": "client_002",
                "name": "Kaspi Installment 12 months",
                "total_amount": 200_000 * 100,
                "remaining_amount": 180_000 * 100,
                "due_date": today.isoformat(),
                "status": "ACTIVE",
            }
        },
    }


credits: dict[str, dict[str, dict]] = _initial_credits()
posted_payments: dict[str, dict] = {}


def is_operational() -> bool:
    if abs_override is not None:
        return abs_override

    current_hour = datetime.now(ALMATY_TZ).hour
    return 9 <= current_hour < 18


def _mode() -> str:
    return "manual" if abs_override is not None else "auto"


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _structured_error(status_code: int, error_code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"success": False, "error_code": error_code, "message": message},
    )


@app.get("/abs/status")
async def get_abs_status():
    now = datetime.now(ALMATY_TZ)
    return {"online": is_operational(), "mode": _mode(), "hour": now.hour, "simulation_mode": simulation_mode}


@app.post("/abs/toggle")
async def toggle_abs(payload: ToggleRequest):
    global abs_override
    abs_override = payload.online
    return {
        "online": is_operational(),
        "mode": _mode(),
        "hour": datetime.now(ALMATY_TZ).hour,
        "simulation_mode": simulation_mode,
    }


@app.get("/abs/simulation-mode")
async def get_simulation_mode():
    return {"mode": simulation_mode}


@app.post("/abs/simulation-mode")
async def set_simulation_mode(payload: SimulationModeRequest):
    global simulation_mode
    simulation_mode = payload.mode
    return {"mode": simulation_mode}


@app.post("/abs/reset")
async def reset_abs():
    global abs_override, credits, posted_payments, simulation_mode
    abs_override = None
    credits = _initial_credits()
    posted_payments = {}
    simulation_mode = "NORMAL"
    return {
        "online": is_operational(),
        "mode": _mode(),
        "hour": datetime.now(ALMATY_TZ).hour,
        "simulation_mode": simulation_mode,
    }


@app.post("/abs/sync-credit")
async def sync_credit(payload: SyncCreditRequest):
    if not is_operational():
        return {"success": False, "error": "ABS unavailable outside banking day"}

    if simulation_mode == "HARD_ERROR":
        return _structured_error(500, "HARD_ERROR", "Legacy ABS hard error")

    existing = posted_payments.get(payload.payment_id)
    if existing is not None:
        return {
            "success": True,
            "posted_at": existing["posted_at"],
            "payment_id": payload.payment_id,
            "idempotent": True,
            "remaining_amount": existing["remaining_amount"],
        }

    if simulation_mode == "AMOUNT_MISMATCH":
        return _structured_error(
            409,
            "AMOUNT_MISMATCH",
            "ABS remaining amount differs from Kaspi Sync credit cache",
        )
    if simulation_mode == "CREDIT_NOT_FOUND":
        return _structured_error(404, "CREDIT_NOT_FOUND", "Credit not found in legacy ABS")
    if simulation_mode == "ALREADY_CLOSED":
        return _structured_error(409, "ALREADY_CLOSED", "Credit is already closed in legacy ABS")

    client_credits = credits.get(payload.client_id, {})
    credit = client_credits.get(payload.credit_id)
    if credit is None:
        return _structured_error(404, "CREDIT_NOT_FOUND", "Credit not found in legacy ABS")

    credit["remaining_amount"] = max(int(credit["remaining_amount"]) - payload.amount, 0)
    posted_at = _now_utc()
    posted_payments[payload.payment_id] = {
        "posted_at": posted_at,
        "credit_id": payload.credit_id,
        "client_id": payload.client_id,
        "amount": payload.amount,
        "original_time": payload.original_time,
        "remaining_amount": credit["remaining_amount"],
    }

    return {
        "success": True,
        "posted_at": posted_at,
        "payment_id": payload.payment_id,
        "idempotent": False,
        "remaining_amount": credit["remaining_amount"],
    }


@app.get("/abs/credits/{client_id}")
async def get_credits(client_id: str):
    client_credits = list(credits.get(client_id, {}).values())
    return {"client_id": client_id, "credits": deepcopy(client_credits)}


@app.get("/abs/health")
async def get_health():
    return {"status": "ok", "uptime": int(time.monotonic() - STARTED_AT)}
