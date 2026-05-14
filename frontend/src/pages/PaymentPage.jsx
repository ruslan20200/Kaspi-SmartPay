import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createLegacyPayment, createPayment, getABSStatus, getCredits, getWallet } from '../api.js';

const CLIENTS = [
  { id: 'client_001', label: 'Client 001' },
  { id: 'client_002', label: 'Client 002' },
];

function formatTenge(value = 0) {
  return `${new Intl.NumberFormat('ru-KZ').format(Number(value)).replace(/\u00a0/g, ' ')} KZT`;
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('ru-KZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function dueLabel(value) {
  const due = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (due.getTime() === today.getTime()) return { text: 'Today', tone: 'danger' };
  if (due.getTime() === tomorrow.getTime()) return { text: 'Tomorrow', tone: 'warn' };
  return { text: formatDate(value), tone: 'muted' };
}

export default function PaymentPage() {
  const navigate = useNavigate();
  const syncRequestId = useRef(null);
  const [selectedClient, setSelectedClient] = useState('client_001');
  const [wallet, setWallet] = useState(null);
  const [credits, setCredits] = useState([]);
  const [absStatus, setAbsStatus] = useState({ online: false, mode: 'auto' });
  const [loading, setLoading] = useState(true);
  const [selectedCredit, setSelectedCredit] = useState(null);
  const [mode, setMode] = useState('sync');
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [comparison, setComparison] = useState(null);

  const selectedCreditAmount = useMemo(() => {
    if (!selectedCredit) return 0;
    return Math.round(Number(selectedCredit.remaining_amount_tiyin || 0) / 100);
  }, [selectedCredit]);

  async function loadAbsStatus() {
    try {
      setAbsStatus(await getABSStatus());
    } catch {
      setAbsStatus({ online: false, mode: 'error' });
    }
  }

  async function loadClientData(clientId = selectedClient) {
    setLoading(true);
    setError('');
    try {
      const [walletData, creditsData] = await Promise.all([getWallet(clientId), getCredits(clientId)]);
      setWallet(walletData);
      setCredits(creditsData.credits || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAbsStatus();
    const timer = window.setInterval(loadAbsStatus, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelectedCredit(null);
    setComparison(null);
    loadClientData(selectedClient);
  }, [selectedClient]);

  async function handleConfirmPayment() {
    if (!selectedCredit || paying) return;

    setPaying(true);
    setError('');
    setComparison(null);

    try {
      if (mode === 'legacy') {
        const result = await createLegacyPayment(selectedClient, selectedCredit.credit_id, selectedCreditAmount);
        setComparison({
          type: 'legacy-success',
          title: 'Legacy result: accepted by ABS',
          detail: `Payment ${result.payment_id} was posted directly because ABS was online.`,
        });
        await Promise.all([loadClientData(selectedClient), loadAbsStatus()]);
        setSelectedCredit(null);
        return;
      }

      if (!syncRequestId.current) {
        syncRequestId.current = crypto.randomUUID();
      }
      const paymentData = await createPayment(
        selectedClient,
        selectedCredit.credit_id,
        selectedCreditAmount,
        syncRequestId.current
      );
      syncRequestId.current = null;
      navigate(`/success?payment_id=${paymentData.payment_id}`, { state: { paymentData } });
    } catch (requestError) {
      if (mode === 'legacy') {
        setComparison({
          type: 'legacy-failed',
          title: 'Legacy result: failed because ABS is unavailable',
          detail: requestError.message,
        });
      } else {
        setError(requestError.message);
      }
    } finally {
      if (mode === 'sync') syncRequestId.current = null;
      setPaying(false);
    }
  }

  return (
    <main className="payment-screen">
      <header className="payment-header">
        <div className="brand-lockup">
          <span className="brand-circle">K</span>
          <div>
            <strong>Kaspi Sync</strong>
            <p>Trust & Penalty Policy Layer for legacy ABS payments</p>
          </div>
        </div>
        <div className="abs-indicator">
          <span className={`pulse-dot ${absStatus.online ? 'online' : 'offline'}`} />
          <strong>{absStatus.online ? 'ABS ONLINE' : 'ABS OFFLINE, Trust Layer active'}</strong>
        </div>
      </header>

      <section className="mode-switch" aria-label="Payment mode">
        <button className={mode === 'legacy' ? 'active' : ''} disabled={paying} onClick={() => setMode('legacy')}>
          Direct Legacy Mode
        </button>
        <button className={mode === 'sync' ? 'active' : ''} disabled={paying} onClick={() => setMode('sync')}>
          Kaspi Sync Middleware Mode
        </button>
      </section>

      <section className="mode-explainer">
        <article className={mode === 'legacy' ? 'active' : ''}>
          <h2>Direct Legacy Mode</h2>
          <p>Payment goes straight to legacy ABS. If ABS is closed or unavailable, the customer gets an error.</p>
        </article>
        <article className={mode === 'sync' ? 'active' : ''}>
          <h2>Kaspi Sync Middleware Mode</h2>
          <p>
            Payment is accepted in the Trust Layer: accepted_at is fixed, funds are reserved, policy engine decides
            penalty protection, and ABS sync happens later.
          </p>
        </article>
      </section>

      <section className="client-tabs">
        {CLIENTS.map((client) => (
          <button key={client.id} className={selectedClient === client.id ? 'active' : ''} disabled={paying} onClick={() => setSelectedClient(client.id)}>
            {client.label}
          </button>
        ))}
      </section>

      {error && <div className="notice error">{error}</div>}
      {comparison && (
        <div className={`notice ${comparison.type.includes('failed') ? 'error' : 'success'}`}>
          <strong>{comparison.title}</strong>
          <span>{comparison.detail}</span>
        </div>
      )}

      <section className="dashboard-grid">
        <div className="gold-card">
          <div>
            <p>Kaspi Gold</p>
            <strong>{wallet ? formatTenge(wallet.available_tenge) : '...'}</strong>
          </div>
          <span>
            Available: {wallet ? formatTenge(wallet.available_tenge) : '...'} | Reserved:{' '}
            {wallet ? formatTenge(wallet.reserved_tenge) : '...'}
          </span>
        </div>

        <div className="credits-section">
          <div className="section-heading">
            <p>Customer credits</p>
            <h1>{mode === 'legacy' ? 'Legacy shows the banking-day limit' : 'Kaspi Sync accepts payments 24/7'}</h1>
          </div>

          {loading && <div className="empty-state">Loading customer data...</div>}

          <div className="credit-list">
            {credits.map((credit) => {
              const due = dueLabel(credit.due_date);
              const amount = Math.round(Number(credit.remaining_amount_tiyin) / 100);
              return (
                <article className="credit-card" key={credit.credit_id}>
                  <div>
                    <h2>{credit.name}</h2>
                    <p>Remaining: {formatTenge(amount)}</p>
                    <span className={`due ${due.tone}`}>Due: {due.text}</span>
                  </div>
                  <button disabled={paying} onClick={() => setSelectedCredit(credit)}>
                    Pay
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {selectedCredit && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title">Confirm payment</h2>
            <dl className="confirm-list">
              <div>
                <dt>Credit</dt>
                <dd>{selectedCredit.name}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{formatTenge(selectedCreditAmount)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>Kaspi Gold</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{mode === 'legacy' ? 'Direct Legacy Mode' : 'Kaspi Sync Middleware Mode'}</dd>
              </div>
            </dl>

            {mode === 'sync' && (
              <div className="offline-warning">
                Kaspi Sync will reserve funds, calculate the cutoff policy decision, and issue an audit-proof receipt.
              </div>
            )}
            {!absStatus.online && mode === 'legacy' && (
              <div className="legacy-warning">Legacy ABS is offline now. Direct payment will fail.</div>
            )}

            <div className="modal-actions">
              <button className="ghost-button" disabled={paying} onClick={() => setSelectedCredit(null)}>
                Cancel
              </button>
              <button className="primary-button" disabled={paying} onClick={handleConfirmPayment}>
                {paying ? 'Processing...' : mode === 'legacy' ? 'Pay via Legacy' : 'Confirm Kaspi Sync'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
