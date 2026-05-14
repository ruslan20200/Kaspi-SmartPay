from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class PaymentState(str, Enum):
    ACCEPTED = "ACCEPTED"
    PENDING_ABS = "PENDING_ABS"
    SYNCED_ABS = "SYNCED_ABS"
    FAILED = "FAILED"
    MANUAL_REVIEW = "MANUAL_REVIEW"


class PolicyStatus(str, Enum):
    PROTECTED = "PROTECTED"
    NOT_PROTECTED = "NOT_PROTECTED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    UNKNOWN = "UNKNOWN"


class PolicyDecision(str, Enum):
    ACCEPTED_BEFORE_CUTOFF = "ACCEPTED_BEFORE_CUTOFF"
    AFTER_CUTOFF_NOT_PROTECTED = "AFTER_CUTOFF_NOT_PROTECTED"
    ABS_DOWNTIME_GRACE_APPLIED = "ABS_DOWNTIME_GRACE_APPLIED"
    ABS_DOWNTIME_REVIEW_REQUIRED = "ABS_DOWNTIME_REVIEW_REQUIRED"
    INSUFFICIENT_POLICY_DATA = "INSUFFICIENT_POLICY_DATA"
    RECONCILIATION_EXCEPTION = "RECONCILIATION_EXCEPTION"
    UNKNOWN = "UNKNOWN"


class PaymentRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    credit_id: str = Field(min_length=1, max_length=64)
    amount: int | str = Field(description="Amount in tenge. Floats are rejected.")
    request_id: Optional[str] = Field(default=None, max_length=128)
    device_info: dict[str, Any] = Field(default_factory=dict)

    @field_validator("amount", mode="before")
    @classmethod
    def reject_float_money(cls, value: Any) -> Any:
        if isinstance(value, bool) or isinstance(value, float):
            raise ValueError("Amount must be an integer or decimal string, never a float")
        return value


class PaymentResponse(BaseModel):
    payment_id: UUID
    request_id: Optional[str] = None
    client_id: str
    credit_id: str
    amount: int
    amount_tenge: int
    status: PaymentState
    accepted_at: datetime
    deadline_at: datetime
    cutoff_at: Optional[datetime] = None
    penalty_protected: bool
    penalty_protection: bool
    policy_status: PolicyStatus
    policy_decision: PolicyDecision
    protection_reason: Optional[str] = None
    abs_status_at_acceptance: Optional[str] = None
    wallet_reserve_event_id: Optional[str] = None
    event_hash: Optional[str] = None
    wallet_balance_after: int
    wallet_reserved_after: int
    wallet_available_after: int
    message: str


class PaymentStatus(BaseModel):
    payment_id: UUID
    client_id: str
    credit_id: str
    amount_tiyin: int
    amount_tenge: int
    source: str
    status: PaymentState
    accepted_at: datetime
    deadline_at: datetime
    cutoff_at: Optional[datetime] = None
    penalty_protected: bool
    policy_status: PolicyStatus = PolicyStatus.UNKNOWN
    policy_decision: PolicyDecision = PolicyDecision.UNKNOWN
    protection_reason: Optional[str] = None
    abs_status_at_acceptance: Optional[str] = None
    wallet_reserve_event_id: Optional[str] = None
    event_hash: Optional[str] = None
    synced_at: Optional[datetime] = None
    request_id: Optional[str] = None
    abs_error: Optional[str] = None
    retry_count: Optional[int] = None
    estimated_sync_time: Optional[str] = None
    manual_review_reason: Optional[str] = None
    reconciliation_error: Optional[str] = None
    reconciliation_status: Optional[str] = None
    device_info: dict[str, Any] = Field(default_factory=dict)
    abs_response: dict[str, Any] = Field(default_factory=dict)


class ReceiptData(BaseModel):
    payment_id: UUID
    request_id: Optional[str] = None
    client_id: str
    credit_id: str
    credit_name: str
    amount_tenge: int
    source: str
    status: PaymentState
    accepted_at: datetime
    deadline_at: datetime
    cutoff_at: Optional[datetime] = None
    synced_at: Optional[datetime] = None
    penalty_protected: bool
    policy_status: PolicyStatus
    policy_decision: PolicyDecision
    protection_reason: Optional[str] = None
    abs_status_at_acceptance: Optional[str] = None
    wallet_reserve_event_id: Optional[str] = None
    event_hash: Optional[str] = None
    manual_review_reason: Optional[str] = None
    reconciliation_error: Optional[str] = None
    reconciliation_status: Optional[str] = None
    penalty_text: str
    sync_text: str
    audit_proof: dict[str, Any]
    wallet_details: dict[str, Any]
    sync_details: dict[str, Any]


class AdminStats(BaseModel):
    pending_count: int
    synced_count: int
    failed_count: int
    manual_review_count: int
    protected_count: int
    review_required_count: int
    not_protected_count: int
    total_reserved_amount: int
    total_protected_amount: int
    support_tickets_avoided_demo: int
    customer_trust_saved_amount: int
    pending_abs_sync: int
    synced_payments: int
    failed_payments: int
    penalty_protected_payments: int
    total_pending_tenge: int
    oldest_pending: Optional[datetime] = None
    abs_online: bool
    abs_mode: str
    abs_simulation_mode: str = "NORMAL"


class WalletInfo(BaseModel):
    client_id: str
    balance_tenge: int
    reserved_tenge: int
    available_tenge: int
    balance_tiyin: int
    reserved_tiyin: int
    available_tiyin: int
    updated_at: datetime


class ToggleABSRequest(BaseModel):
    online: bool


class SimulationModeRequest(BaseModel):
    mode: str = Field(pattern="^(NORMAL|AMOUNT_MISMATCH|CREDIT_NOT_FOUND|ALREADY_CLOSED|HARD_ERROR)$")
