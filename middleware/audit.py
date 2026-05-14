from __future__ import annotations

from datetime import date, datetime
from hashlib import sha256
from typing import Any


def _stable(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def build_event_hash(payment_event: dict[str, Any]) -> str:
    canonical = "|".join(
        [
            _stable(payment_event.get("payment_id") or payment_event.get("id")),
            _stable(payment_event.get("client_id")),
            _stable(payment_event.get("credit_id")),
            _stable(payment_event.get("amount_tiyin")),
            _stable(payment_event.get("accepted_at")),
            _stable(payment_event.get("cutoff_at")),
            _stable(payment_event.get("policy_status")),
            _stable(payment_event.get("policy_decision")),
            _stable(payment_event.get("penalty_protected")),
            _stable(payment_event.get("abs_status_at_acceptance")),
            _stable(payment_event.get("request_id")),
        ]
    )
    return f"sha256:{sha256(canonical.encode('utf-8')).hexdigest()}"
