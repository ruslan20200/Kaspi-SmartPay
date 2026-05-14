import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { getReceipt, getStatus } from '../api/api.js';

function formatTenge(value = 0) {
  return `${new Intl.NumberFormat('ru-KZ').format(Number(value || 0)).replace(/\u00a0/g, ' ')} ₸`;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortId(value, size = 12) {
  return value ? `${String(value).slice(0, size)}...` : '-';
}

function statusCopy(status) {
  if (status === 'SYNCED_ABS') return { title: 'Подтверждено АБС', tone: 'success', mark: 'OK' };
  if (status === 'MANUAL_REVIEW') return { title: 'Требуется банковская проверка', tone: 'warn', mark: '!' };
  if (status === 'FAILED') return { title: 'Платёж не завершён', tone: 'danger', mark: 'X' };
  return { title: 'Платёж принят 24/7', tone: 'pending', mark: '..' };
}

function policyTitle(policyStatus) {
  if (policyStatus === 'PROTECTED') return 'Защита от пени активна';
  if (policyStatus === 'REVIEW_REQUIRED') return 'Требуется банковская проверка';
  if (policyStatus === 'NOT_PROTECTED') return 'Защита от пени не применена';
  return 'Policy decision pending';
}

async function copyText(value) {
  if (!value || !navigator.clipboard) return;
  await navigator.clipboard.writeText(String(value)).catch(() => {});
}

export default function SuccessPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const paymentId = searchParams.get('payment_id') || location.state?.paymentData?.payment_id || '';
  const notifiedRef = useRef(false);
  const [status, setStatus] = useState(location.state?.paymentData || null);
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');

  async function loadPayment() {
    if (!paymentId) return;
    try {
      const [statusData, receiptData] = await Promise.all([getStatus(paymentId), getReceipt(paymentId)]);
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
        new Notification('Kaspi Sync: платёж подтверждён АБС');
      }
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    loadPayment();
    const timer = window.setInterval(() => {
      const currentStatus = status?.status || receipt?.status;
      if (!currentStatus || currentStatus === 'PENDING_ABS') loadPayment();
    }, 3000);
    return () => window.clearInterval(timer);
  });

  if (!paymentId) {
    return (
      <div className="app-frame">
        <header className="top-app-bar">
          <button className="back-button" type="button" aria-label="Назад" onClick={() => navigate('/')} />
          <strong>Квитанция</strong>
          <span />
        </header>
        <main className="mobile-shell">
          <section className="receipt-card">
            <h1>Payment not found</h1>
            <button className="primary-action" type="button" onClick={() => navigate('/')}>На главную</button>
          </section>
        </main>
      </div>
    );
  }

  const currentStatus = status?.status || receipt?.status || 'PENDING_ABS';
  const copy = statusCopy(currentStatus);
  const policyStatus = receipt?.policy_status || status?.policy_status || 'UNKNOWN';
  const audit = receipt?.audit_proof || {};
  const eventHash = audit.event_hash || receipt?.event_hash || status?.event_hash || '';
  const timelineDone = currentStatus === 'SYNCED_ABS' || currentStatus === 'MANUAL_REVIEW' || currentStatus === 'FAILED';

  return (
    <div className="app-frame">
      <header className="top-app-bar">
        <button className="back-button" type="button" aria-label="Назад" onClick={() => navigate('/')} />
        <strong>Квитанция</strong>
        <Link className="text-link" to="/admin">Admin</Link>
      </header>

      <main className="mobile-shell receipt-shell">
        <section className="receipt-hero">
          <div className={`receipt-mark ${copy.tone}`}>{copy.mark}</div>
          <h1>{copy.title}</h1>
          <span>Сумма платежа</span>
          <strong>{formatTenge(receipt?.amount_tenge || status?.amount_tenge || 0)}</strong>
          <p>{receipt?.credit_name || status?.credit_id || 'Kaspi Credit'} · {receipt?.client_id || status?.client_id || '-'}</p>
        </section>

        {currentStatus === 'PENDING_ABS' && (
          <section className="sync-card">
            <div className="progress-bar"><span /></div>
            <p>{status?.estimated_sync_time || 'Ожидаем синхронизацию с legacy ABS'}</p>
          </section>
        )}

        {currentStatus === 'MANUAL_REVIEW' && (
          <section className="inline-alert warn">
            {receipt?.manual_review_reason || status?.manual_review_reason || 'Платёж удержан для банковской проверки.'}
          </section>
        )}

        {currentStatus === 'FAILED' && (
          <section className="inline-alert danger">
            {status?.abs_error || receipt?.reconciliation_error || 'Синхронизация не завершилась.'}
          </section>
        )}

        {error && <section className="inline-alert danger">{error}</section>}

        <section className={`receipt-card policy-card ${String(policyStatus).toLowerCase()}`}>
          <h2>Penalty Decision</h2>
          <p className="policy-headline">{policyTitle(policyStatus)}</p>
          <div className="receipt-lines stacked">
            <Info label="policy_status" value={policyStatus} />
            <Info label="policy_decision" value={receipt?.policy_decision || status?.policy_decision || '-'} />
            <Info label="accepted_at" value={formatDateTime(receipt?.accepted_at || status?.accepted_at)} />
            <Info label="cutoff_at" value={formatDateTime(receipt?.cutoff_at || status?.cutoff_at)} />
            <Info label="penalty_protected" value={receipt?.penalty_protected || status?.penalty_protected ? 'true' : 'false'} />
            <Info label="protection_reason" value={receipt?.protection_reason || status?.protection_reason || '-'} />
          </div>
        </section>

        <section className="receipt-card">
          <h2>Audit Proof</h2>
          <div className="receipt-lines stacked">
            <Info label="payment_id" value={audit.payment_id || paymentId} mono />
            <Info label="request_id" value={audit.request_id || receipt?.request_id || status?.request_id || '-'} mono />
            <Info label="ABS status at acceptance" value={audit.abs_status_at_acceptance || receipt?.abs_status_at_acceptance || '-'} />
            <Info label="wallet reserve event id" value={audit.wallet_reserve_event_id || receipt?.wallet_reserve_event_id || '-'} mono />
            <Info label="event_hash" value={eventHash || '-'} mono />
            <Info label="accepted_at" value={formatDateTime(audit.accepted_at || receipt?.accepted_at || status?.accepted_at)} />
          </div>
        </section>

        <section className="receipt-card">
          <h2>Sync timeline</h2>
          <ol className="timeline">
            <TimelineItem done label="Payment accepted" value={formatDateTime(receipt?.accepted_at || status?.accepted_at)} />
            <TimelineItem done={Boolean(receipt?.wallet_reserve_event_id || status?.wallet_reserve_event_id)} label="Wallet reserved" value={shortId(receipt?.wallet_reserve_event_id || status?.wallet_reserve_event_id)} />
            <TimelineItem done={policyStatus !== 'UNKNOWN'} label="Policy evaluated" value={policyStatus} />
            <TimelineItem done label="Pending ABS sync" value="PENDING_ABS" />
            <TimelineItem done={timelineDone} label="ABS confirmed / Manual review / Failed" value={currentStatus} tone={copy.tone} />
          </ol>
        </section>

        <section className="receipt-actions">
          <button className="primary-action" type="button" onClick={() => navigate('/')}>На главную</button>
          <button className="secondary-action" type="button" onClick={() => copyText(paymentId)}>Copy payment_id</button>
          <button className="secondary-action" type="button" onClick={() => copyText(eventHash)}>Copy event_hash</button>
        </section>
      </main>
    </div>
  );
}

function Info({ label, value, mono = false }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : ''}>{value}</dd>
    </div>
  );
}

function TimelineItem({ done, label, value, tone = '' }) {
  return (
    <li className={done ? `done ${tone}` : ''}>
      <span />
      <div>
        <strong>{label}</strong>
        <small>{value || '-'}</small>
      </div>
    </li>
  );
}
