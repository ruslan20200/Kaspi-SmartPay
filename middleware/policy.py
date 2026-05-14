from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Any
from zoneinfo import ZoneInfo


ALMATY_TZ = ZoneInfo("Asia/Almaty")


def _parse_cutoff_time(value: str | None) -> time | None:
    if not value:
        return None
    try:
        hour, minute = value.split(":", maxsplit=1)
        return time(int(hour), int(minute), 0)
    except (TypeError, ValueError):
        return None


def _as_aware_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def evaluate_penalty_policy(
    accepted_at: datetime | None,
    due_date: date | None,
    cutoff_time: str | None,
    abs_status_at_acceptance: str | None,
    reserve_success: bool,
    grace_policy: str | None,
    abs_downtime_grace_enabled: bool | None,
    manual_review_after_cutoff: bool | None,
) -> dict[str, Any]:
    cutoff = _parse_cutoff_time(cutoff_time)
    if (
        accepted_at is None
        or due_date is None
        or cutoff is None
        or not abs_status_at_acceptance
        or not grace_policy
        or abs_downtime_grace_enabled is None
        or manual_review_after_cutoff is None
        or not reserve_success
    ):
        return {
            "cutoff_at": None,
            "deadline_at": None,
            "penalty_protected": False,
            "policy_status": "REVIEW_REQUIRED",
            "policy_decision": "INSUFFICIENT_POLICY_DATA",
            "protection_reason": "Credit policy data is incomplete; manual review required",
        }

    local_accepted_at = _as_aware_datetime(accepted_at).astimezone(ALMATY_TZ)
    local_cutoff_at = datetime.combine(due_date, cutoff, tzinfo=ALMATY_TZ)
    local_deadline_at = datetime.combine(due_date, time(23, 59, 59, 999999), tzinfo=ALMATY_TZ)
    normalized_abs_status = abs_status_at_acceptance.upper()

    if local_accepted_at <= local_cutoff_at:
        return {
            "cutoff_at": local_cutoff_at.astimezone(timezone.utc),
            "deadline_at": local_deadline_at.astimezone(timezone.utc),
            "penalty_protected": True,
            "policy_status": "PROTECTED",
            "policy_decision": "ACCEPTED_BEFORE_CUTOFF",
            "protection_reason": "Payment accepted before product cutoff and wallet funds were reserved",
        }

    if normalized_abs_status == "ONLINE":
        return {
            "cutoff_at": local_cutoff_at.astimezone(timezone.utc),
            "deadline_at": local_deadline_at.astimezone(timezone.utc),
            "penalty_protected": False,
            "policy_status": "NOT_PROTECTED",
            "policy_decision": "AFTER_CUTOFF_NOT_PROTECTED",
            "protection_reason": "Payment accepted after product cutoff",
        }

    if normalized_abs_status == "OFFLINE" and abs_downtime_grace_enabled and manual_review_after_cutoff:
        return {
            "cutoff_at": local_cutoff_at.astimezone(timezone.utc),
            "deadline_at": local_deadline_at.astimezone(timezone.utc),
            "penalty_protected": False,
            "policy_status": "REVIEW_REQUIRED",
            "policy_decision": "ABS_DOWNTIME_REVIEW_REQUIRED",
            "protection_reason": "Payment accepted after cutoff during ABS downtime; requires bank review",
        }

    if normalized_abs_status == "OFFLINE" and abs_downtime_grace_enabled and not manual_review_after_cutoff:
        return {
            "cutoff_at": local_cutoff_at.astimezone(timezone.utc),
            "deadline_at": local_deadline_at.astimezone(timezone.utc),
            "penalty_protected": True,
            "policy_status": "PROTECTED",
            "policy_decision": "ABS_DOWNTIME_GRACE_APPLIED",
            "protection_reason": "ABS downtime grace policy applied",
        }

    return {
        "cutoff_at": local_cutoff_at.astimezone(timezone.utc),
        "deadline_at": local_deadline_at.astimezone(timezone.utc),
        "penalty_protected": False,
        "policy_status": "REVIEW_REQUIRED",
        "policy_decision": "INSUFFICIENT_POLICY_DATA",
        "protection_reason": "Credit policy data is incomplete; manual review required",
    }
