import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createLegacyPayment,
  createPayment,
  getABSStatus,
  getCredits,
  getSimulationMode,
  getWallet,
  requestId,
} from '../api/api.js';
import BottomNav from '../components/BottomNav.jsx';
import InstallPrompt from '../components/InstallPrompt.jsx';

const CLIENTS = [
  { id: 'client_001', label: 'Client 001', card: '0341' },
  { id: 'client_002', label: 'Client 002', card: '1198' },
];

function formatTenge(value = 0) {
  return `${new Intl.NumberFormat('ru-KZ').format(Number(value || 0)).replace(/\u00a0/g, ' ')} ₸`;
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });
}

function dueTone(value) {
  const due = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (due.getTime() === today.getTime()) return { text: 'Due today', tone: 'danger' };
  if (due.getTime() === tomorrow.getTime()) return { text: 'Due tomorrow', tone: 'warn' };
  return { text: formatDate(value), tone: 'muted' };
}

function creditPaymentAmount(credit) {
  const remaining = Math.round(Number(credit?.remaining_amount_tiyin || 0) / 100);
  if (!remaining) return 0;
  return Math.min(remaining, 47917);
}

export default function PaymentPage() {
  const navigate = useNavigate();
  const syncRequestId = useRef(null);
  const [selectedClient, setSelectedClient] = useState(CLIENTS[0].id);
  const [wallet, setWallet] = useState(null);
  const [credits, setCredits] = useState([]);
  const [selectedCreditId, setSelectedCreditId] = useState('');
  const [absStatus, setAbsStatus] = useState({ online: false, mode: 'auto' });
  const [simulationMode, setSimulationMode] = useState('NORMAL');
  const [loading, setLoading] = useState(true);
  const [paymentMode, setPaymentMode] = useState('sync');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [resultPreview, setResultPreview] = useState(null);

  const selectedClientMeta = CLIENTS.find((client) => client.id === selectedClient) || CLIENTS[0];
  const selectedCredit = useMemo(
    () => credits.find((credit) => credit.credit_id === selectedCreditId) || credits[0] || null,
    [credits, selectedCreditId]
  );
  const amount = useMemo(() => creditPaymentAmount(selectedCredit), [selectedCredit]);
  const due = dueTone(selectedCredit?.due_date);
  const reservedAfter = (wallet?.reserved_tenge || 0) + (paymentMode === 'sync' && confirmOpen ? amount : 0);
  const availableAfter = Math.max((wallet?.available_tenge || 0) - (paymentMode === 'sync' && confirmOpen ? amount : 0), 0);

  async function loadAbs() {
    try {
      const [statusData, modeData] = await Promise.all([getABSStatus(), getSimulationMode().catch(() => null)]);
      setAbsStatus(statusData);
      if (modeData?.mode) setSimulationMode(modeData.mode);
    } catch {
      setAbsStatus({ online: false, mode: 'error' });
    }
  }

  async function loadClient(clientId = selectedClient) {
    setLoading(true);
    setError('');
    try {
      const [walletData, creditsData] = await Promise.all([getWallet(clientId), getCredits(clientId)]);
      const nextCredits = creditsData.credits || [];
      setWallet(walletData);
      setCredits(nextCredits);
      setSelectedCreditId(nextCredits[0]?.credit_id || '');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAbs();
    const timer = window.setInterval(loadAbs, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setConfirmOpen(false);
    setResultPreview(null);
    syncRequestId.current = null;
    loadClient(selectedClient);
  }, [selectedClient]);

  function openConfirm(nextMode) {
    if (!selectedCredit || paying) return;
    setPaymentMode(nextMode);
    setError('');
    setConfirmOpen(true);
    if (nextMode === 'sync' && !syncRequestId.current) {
      syncRequestId.current = requestId('kaspi-sync');
    }
  }

  async function submitPayment() {
    if (!selectedCredit || paying) return;
    setPaying(true);
    setError('');
    setResultPreview(null);

    try {
      if (paymentMode === 'legacy') {
        const legacy = await createLegacyPayment(selectedClient, selectedCredit.credit_id, amount);
        setResultPreview({
          tone: 'success',
          title: 'Legacy accepted by ABS',
          body: `ABS приняла прямой платёж ${legacy.payment_id}.`,
        });
        setConfirmOpen(false);
        await Promise.all([loadClient(selectedClient), loadAbs()]);
        return;
      }

      const payment = await createPayment(selectedClient, selectedCredit.credit_id, amount, syncRequestId.current);
      syncRequestId.current = null;
      navigate(`/success?payment_id=${payment.payment_id}`, { state: { paymentData: payment } });
    } catch (requestError) {
      if (paymentMode === 'legacy') {
        setResultPreview({
          tone: 'danger',
          title: 'Legacy failed because ABS unavailable',
          body: requestError.message,
        });
        setConfirmOpen(false);
      } else {
        setError(requestError.message);
      }
    } finally {
      if (paymentMode !== 'sync') syncRequestId.current = null;
      setPaying(false);
    }
  }

  return (
    <div className="app-frame">
      <header className="top-app-bar">
        <button className="back-button" type="button" aria-label="Назад" />
        <div>
          <strong>Мой Банк</strong>
          <span>Kaspi Sync</span>
        </div>
        <span className={`abs-chip ${absStatus.online ? 'online' : 'offline'}`}>
          {absStatus.online ? 'ABS ONLINE' : 'ABS OFFLINE'}
        </span>
      </header>

      <main className="mobile-shell with-nav">
        <InstallPrompt />

        <section className="wallet-card">
          <div className="wallet-topline">
            <span>Kaspi Gold</span>
            <select value={selectedClient} onChange={(event) => setSelectedClient(event.target.value)} disabled={paying}>
              {CLIENTS.map((client) => (
                <option key={client.id} value={client.id}>{client.label}</option>
              ))}
            </select>
          </div>
          <p className="wallet-number">• {selectedClientMeta.card}</p>
          <strong>{wallet ? formatTenge(wallet.available_tenge) : '...'}</strong>
          <div className="balance-grid">
            <span>
              Доступно
              <b>{formatTenge(availableAfter)}</b>
            </span>
            <span>
              В резерве
              <b>{formatTenge(reservedAfter)}</b>
            </span>
          </div>
        </section>

        <section className="credit-detail-card">
          <div className="status-row">
            <span className={`status-dot ${due.tone}`} />
            <div>
              <h1>{selectedCredit?.name || 'Кредит'}</h1>
              <p>Договор {selectedCredit?.credit_id || '-'}</p>
            </div>
            <span className={`badge ${due.tone}`}>{due.text}</span>
          </div>

          <div className="amount-block">
            <span>Ежемесячный платёж</span>
            <strong>{formatTenge(amount)}</strong>
          </div>

          <div className="detail-list">
            <div>
              <span>Остаток долга</span>
              <strong>{formatTenge(Math.round(Number(selectedCredit?.remaining_amount_tiyin || 0) / 100))}</strong>
            </div>
            <div>
              <span>Срок оплаты</span>
              <strong>{formatDate(selectedCredit?.due_date)}</strong>
            </div>
            <div>
              <span>Cutoff time</span>
              <strong>{selectedCredit?.cutoff_time || '20:00'} Asia/Almaty</strong>
            </div>
            <div>
              <span>Simulation</span>
              <strong>{simulationMode}</strong>
            </div>
          </div>

          {credits.length > 1 && (
            <label className="soft-select">
              Выбрать кредит
              <select value={selectedCredit?.credit_id || ''} onChange={(event) => setSelectedCreditId(event.target.value)}>
                {credits.map((credit) => (
                  <option key={credit.credit_id} value={credit.credit_id}>{credit.name}</option>
                ))}
              </select>
            </label>
          )}
        </section>

        <section className="mode-comparison" aria-label="Payment mode comparison">
          <article className="mode-card">
            <div>
              <span className="mode-icon legacy">ABS</span>
              <h2>Direct Legacy Mode</h2>
              <p>Платёж напрямую идёт в legacy ABS. Если ABS закрыта — клиент получает ошибку.</p>
            </div>
            <button className="secondary-action" type="button" disabled={loading || paying} onClick={() => openConfirm('legacy')}>
              Оплатить через Legacy
            </button>
          </article>

          <article className="mode-card recommended">
            <div>
              <span className="mode-icon smart">24/7</span>
              <h2>Kaspi Sync Middleware Mode</h2>
              <p>Kaspi Sync фиксирует accepted_at, резервирует деньги, применяет penalty policy и синхронизирует ABS позже.</p>
            </div>
            <button className="primary-action" type="button" disabled={loading || paying} onClick={() => openConfirm('sync')}>
              Оплатить через Kaspi Sync
            </button>
          </article>
        </section>

        {resultPreview && (
          <section className={`result-preview ${resultPreview.tone}`}>
            <strong>{resultPreview.title}</strong>
            <span>{resultPreview.body}</span>
          </section>
        )}

        {error && <section className="inline-alert danger">{error}</section>}
      </main>

      <BottomNav />

      {confirmOpen && selectedCredit && (
        <div className="sheet-backdrop" role="presentation" onClick={() => !paying && setConfirmOpen(false)}>
          <section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <h2 id="confirm-title">
              {paymentMode === 'legacy' ? 'Подтвердить Legacy платёж' : 'Подтвердить Kaspi Sync'}
            </h2>
            <dl className="receipt-lines">
              <div>
                <dt>Сумма</dt>
                <dd>{formatTenge(amount)}</dd>
              </div>
              <div>
                <dt>credit_id</dt>
                <dd>{selectedCredit.credit_id}</dd>
              </div>
              <div>
                <dt>expected accepted_at</dt>
                <dd>{new Date().toLocaleString('ru-RU')}</dd>
              </div>
              <div>
                <dt>request_id</dt>
                <dd className="mono">{paymentMode === 'sync' ? syncRequestId.current : 'legacy-generated'}</dd>
              </div>
            </dl>

            {paymentMode === 'sync' ? (
              <p className="policy-note">Kaspi Sync сохранит accepted_at, проверит cutoff_at и оставит audit proof с event_hash.</p>
            ) : (
              <p className="policy-note legacy-note">Если ABS сейчас недоступна, прямой legacy платёж вернёт ошибку без защиты от пени.</p>
            )}

            <div className="sheet-actions">
              <button className="ghost-action" type="button" disabled={paying} onClick={() => setConfirmOpen(false)}>Отмена</button>
              <button className="primary-action" type="button" disabled={paying} onClick={submitPayment}>
                {paying ? 'Обработка...' : 'Подтвердить'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
