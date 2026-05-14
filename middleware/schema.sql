CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS wallet_ledger (
    client_id VARCHAR(64) PRIMARY KEY,
    balance_tiyin BIGINT NOT NULL CHECK (balance_tiyin >= 0),
    reserved_tiyin BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tiyin >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (reserved_tiyin <= balance_tiyin)
);

CREATE TABLE IF NOT EXISTS payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id VARCHAR(64) NOT NULL,
    credit_id VARCHAR(64) NOT NULL,
    amount_tiyin BIGINT NOT NULL CHECK (amount_tiyin > 0),
    source VARCHAR(64) NOT NULL DEFAULT 'kaspi_gold',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_ABS',
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deadline_at TIMESTAMPTZ NOT NULL,
    penalty_protected BOOLEAN NOT NULL DEFAULT FALSE,
    policy_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    policy_decision TEXT NOT NULL DEFAULT 'UNKNOWN',
    protection_reason TEXT,
    cutoff_at TIMESTAMPTZ,
    grace_policy TEXT NOT NULL DEFAULT 'STANDARD_CUTOFF',
    abs_status_at_acceptance TEXT,
    wallet_reserve_event_id TEXT,
    event_hash TEXT,
    manual_review_reason TEXT,
    reconciliation_error TEXT,
    reconciliation_status TEXT NOT NULL DEFAULT 'NONE',
    synced_at TIMESTAMPTZ,
    request_id VARCHAR(128),
    device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
    abs_error TEXT,
    abs_response JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id VARCHAR(64) NOT NULL REFERENCES wallet_ledger(client_id),
    payment_event_id UUID REFERENCES payment_events(id) ON DELETE SET NULL,
    event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('RESERVE', 'CAPTURE', 'RELEASE')),
    amount_tiyin BIGINT NOT NULL CHECK (amount_tiyin > 0),
    balance_tiyin_after BIGINT NOT NULL,
    reserved_tiyin_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS pending_abs_sync (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_event_id UUID NOT NULL UNIQUE REFERENCES payment_events(id) ON DELETE CASCADE,
    priority INT NOT NULL DEFAULT 0,
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt TIMESTAMPTZ,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS abs_health_log (
    id BIGSERIAL PRIMARY KEY,
    is_online BOOLEAN NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    response_ms INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credits_cache (
    credit_id VARCHAR(64) PRIMARY KEY,
    client_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    total_amount_tiyin BIGINT NOT NULL CHECK (total_amount_tiyin >= 0),
    remaining_amount_tiyin BIGINT NOT NULL CHECK (remaining_amount_tiyin >= 0),
    due_date DATE NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    cutoff_time TEXT NOT NULL DEFAULT '20:00',
    grace_policy TEXT NOT NULL DEFAULT 'STANDARD_CUTOFF',
    abs_downtime_grace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    manual_review_after_cutoff BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS policy_status TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS policy_decision TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS protection_reason TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS cutoff_at TIMESTAMPTZ;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS grace_policy TEXT NOT NULL DEFAULT 'STANDARD_CUTOFF';
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS abs_status_at_acceptance TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS wallet_reserve_event_id TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS event_hash TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS manual_review_reason TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS reconciliation_error TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS reconciliation_status TEXT NOT NULL DEFAULT 'NONE';

ALTER TABLE credits_cache ADD COLUMN IF NOT EXISTS cutoff_time TEXT NOT NULL DEFAULT '20:00';
ALTER TABLE credits_cache ADD COLUMN IF NOT EXISTS grace_policy TEXT NOT NULL DEFAULT 'STANDARD_CUTOFF';
ALTER TABLE credits_cache ADD COLUMN IF NOT EXISTS abs_downtime_grace_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE credits_cache ADD COLUMN IF NOT EXISTS manual_review_after_cutoff BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_status_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_status_check
    CHECK (status IN ('ACCEPTED', 'PENDING_ABS', 'SYNCED_ABS', 'FAILED', 'MANUAL_REVIEW'));

ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_policy_status_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_policy_status_check
    CHECK (policy_status IN ('PROTECTED', 'NOT_PROTECTED', 'REVIEW_REQUIRED', 'UNKNOWN'));

ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_policy_decision_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_policy_decision_check
    CHECK (policy_decision IN (
        'ACCEPTED_BEFORE_CUTOFF',
        'AFTER_CUTOFF_NOT_PROTECTED',
        'ABS_DOWNTIME_GRACE_APPLIED',
        'ABS_DOWNTIME_REVIEW_REQUIRED',
        'INSUFFICIENT_POLICY_DATA',
        'RECONCILIATION_EXCEPTION',
        'UNKNOWN'
    ));

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_request_id
    ON payment_events (client_id, request_id)
    WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_events_client_id ON payment_events (client_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events (status);
CREATE INDEX IF NOT EXISTS idx_payment_events_policy_status ON payment_events (policy_status);
CREATE INDEX IF NOT EXISTS idx_payment_events_event_hash ON payment_events (event_hash);
CREATE INDEX IF NOT EXISTS idx_payment_events_cutoff_at ON payment_events (cutoff_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_accepted_at ON payment_events (accepted_at);
CREATE INDEX IF NOT EXISTS idx_pending_abs_sync_priority ON pending_abs_sync (priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_credits_cache_client_id ON credits_cache (client_id);
CREATE INDEX IF NOT EXISTS idx_abs_health_log_checked_at ON abs_health_log (checked_at DESC);

CREATE OR REPLACE FUNCTION prevent_accepted_at_update()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
        RAISE EXCEPTION 'accepted_at is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_payment_events_accepted_at_immutable'
    ) THEN
        CREATE TRIGGER trg_payment_events_accepted_at_immutable
        BEFORE UPDATE ON payment_events
        FOR EACH ROW
        EXECUTE FUNCTION prevent_accepted_at_update();
    END IF;
END;
$$;

INSERT INTO wallet_ledger (client_id, balance_tiyin, reserved_tiyin)
VALUES
    ('client_001', 75000000, 0),
    ('client_002', 30000000, 0)
ON CONFLICT (client_id) DO NOTHING;

INSERT INTO credits_cache (
    credit_id, client_id, name, total_amount_tiyin, remaining_amount_tiyin,
    due_date, status, cutoff_time, grace_policy, abs_downtime_grace_enabled,
    manual_review_after_cutoff
)
VALUES
    ('credit-001', 'client_001', 'Kaspi Installment 24 months', 50000000, 25000000, CURRENT_DATE, 'ACTIVE', '20:00', 'STANDARD_CUTOFF', TRUE, TRUE),
    ('credit-002', 'client_001', 'Kaspi Cash Loan', 100000000, 75000000, CURRENT_DATE + INTERVAL '1 day', 'ACTIVE', '20:00', 'STANDARD_CUTOFF', TRUE, TRUE),
    ('credit-003', 'client_002', 'Kaspi Installment 12 months', 20000000, 18000000, CURRENT_DATE, 'ACTIVE', '20:00', 'STANDARD_CUTOFF', TRUE, TRUE)
ON CONFLICT (credit_id) DO NOTHING;
