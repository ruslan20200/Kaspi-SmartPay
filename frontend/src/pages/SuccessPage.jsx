import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { getPaymentStatus, getReceipt } from '../api.js';

function formatTenge(value = 0) {
  return `${new Intl.NumberFormat('ru-KZ').format(Number(value)).replace(/\u00a0/g, ' ')} KZT`;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ru-KZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortId(value) {
  return value ? `${String(value).slice(0, 12)}...` : '-';
}

function protectionTitle(policyStatus) {
  if (policyStatus === 'PROTECTED') return 'Zashchita ot peni aktivna';
  if (policyStatus === 'REVIEW_REQUIRED') return 'Trebuetsya bankovskaya proverka';
  if (policyStatus === 'NOT_PROTECTED') return 'Zashchita ot peni ne primenena';
  return 'Policy decision pending';
}

export default function SuccessPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const paymentId = searchParams.get('payment_id') || location.state?.paymentData?.payment_id;
  const notifiedRef = useRef(false);
  const [status, setStatus] = useState(location.state?.paymentData || null);
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');

  async function loadPayment() {
    if (!paymentId) return;
    try {
      const [statusData, receiptData] = await Promise.all([getPaymentStatus(paymentId), getReceipt(paymentId)]);
      setStatus(statusData);
      setReceipt(receiptData);
      setError('');

      if (
        statusData.status === 'SYNCED_ABS' &&
        !notifiedRef.current &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        notifiedRef.current = true;
        new Notification('Kaspi SmartPay: payment synced with ABS');
      }
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    loadPayment();
    const timer = window.setInterval(loadPayment, 3000);
    return () => window.clearInterval(timer);
  }, [paymentId]);

  if (!paymentId) {
    return (
      <main className="success-screen">
        <section className="result-card">
          <h1>Payment not found</h1>
          <button className="primary-button" onClick={() => navigate('/')}>
            New payment
          </button>
        </section>
      </main>
    );
  }

  const currentStatus = status?.status || receipt?.status || 'PENDING_ABS';
  const policyStatus = receipt?.policy_status || status?.policy_status || 'UNKNOWN';
  const isSynced = currentStatus === 'SYNCED_ABS';
  const isFailed = currentStatus === 'FAILED';
  const isManualReview = currentStatus === 'MANUAL_REVIEW';
  const amount = receipt?.amount_tenge ?? status?.amount_tenge ?? 0;
  const audit = receipt?.audit_proof || {};

  return (
    <main className="success-screen">
      <section className="result-card wide">
        <div className={`result-icon ${isSynced ? 'synced' : isFailed ? 'failed' : isManualReview ? 'review' : 'pending'}`}>
          {isSynced ? 'OK' : isFailed ? '!' : isManualReview ? 'RV' : '..'}
        </div>

        <h1>
          {isSynced
            ? 'Payment synced with ABS'
            : isFailed
              ? 'Payment sync failed'
              : isManualReview
                ? 'Payment requires bank review'
                : 'Payment accepted by SmartPay 24/7'}
        </h1>
        <strong className="result-amount">{formatTenge(amount)}</strong>
        <p className="result-copy">
          {isManualReview
            ? 'Reserve remains locked while reconciliation exception is reviewed.'
            : isSynced
              ? 'Reserved funds were captured after ABS confirmation.'
              : 'SmartPay holds the reserve and waits for legacy ABS synchronization.'}
        </p>

        {!isSynced && !isFailed && !isManualReview && (
          <div className="progress-box">
            <div className="progress-bar">
              <span />
            </div>
            <p>{status?.estimated_sync_time || 'Waiting for ABS availability'}</p>
          </div>
        )}

        {isManualReview && (
          <div className="notice warning">
            Manual review: {receipt?.manual_review_reason || status?.manual_review_reason || 'ABS reconciliation exception'}
          </div>
        )}
        {isFailed && <div className="notice error">{status?.abs_error || 'Reserve was released after retry limit.'}</div>}
        {error && <div className="notice error">{error}</div>}

        <section className="receipt-section">
          <h2>Payment Status</h2>
          <div className="info-grid">
            <Info label="Status" value={currentStatus} />
            <Info label="ABS sync" value={receipt?.sync_text || '-'} />
            <Info label="Reserved" value={receipt?.wallet_details?.reserved_tenge !== undefined ? formatTenge(receipt.wallet_details.reserved_tenge) : '-'} />
            <Info label="Synced at" value={formatDateTime(receipt?.synced_at)} />
          </div>
        </section>

        <section className={`receipt-section policy-${policyStatus.toLowerCase()}`}>
          <h2>Penalty Decision</h2>
          <p className="policy-title">{protectionTitle(policyStatus)}</p>
          <div className="info-grid">
            <Info label="Policy status" value={policyStatus} />
            <Info label="Policy decision" value={receipt?.policy_decision || status?.policy_decision || '-'} />
            <Info label="Accepted at" value={formatDateTime(receipt?.accepted_at || status?.accepted_at)} />
            <Info label="Product cutoff" value={formatDateTime(receipt?.cutoff_at || status?.cutoff_at)} />
            <Info label="Penalty protected" value={receipt?.penalty_protected ? 'true' : 'false'} />
            <Info label="Reason" value={receipt?.protection_reason || status?.protection_reason || '-'} />
          </div>
        </section>

        <section className="receipt-section">
          <h2>Audit Proof</h2>
          <div className="info-grid">
            <Info label="Payment ID" value={audit.payment_id || paymentId} />
            <Info label="Request ID" value={audit.request_id || receipt?.request_id || '-'} />
            <Info label="ABS at acceptance" value={audit.abs_status_at_acceptance || '-'} />
            <Info label="Wallet reserve event" value={shortId(audit.wallet_reserve_event_id)} />
            <Info label="Event hash" value={audit.event_hash || receipt?.event_hash || '-'} mono />
            <Info label="Accepted at" value={formatDateTime(audit.accepted_at || receipt?.accepted_at)} />
          </div>
        </section>

        <button className="primary-button" onClick={() => navigate('/')}>
          New payment
        </button>
      </section>
    </main>
  );
}

function Info({ label, value, mono = false }) {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </div>
  );
}
