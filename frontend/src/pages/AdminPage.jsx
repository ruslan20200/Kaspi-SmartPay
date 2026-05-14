import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getABSHealth,
  getABSStatus,
  getAdminQueue,
  getAdminStats,
  resetABS,
  resetDemo,
  setSimulationMode,
  toggleABS,
} from '../api.js';

const SIMULATION_MODES = ['NORMAL', 'AMOUNT_MISMATCH', 'CREDIT_NOT_FOUND', 'ALREADY_CLOSED', 'HARD_ERROR'];

function formatTenge(value = 0) {
  return `${new Intl.NumberFormat('ru-KZ').format(Number(value)).replace(/\u00a0/g, ' ')} KZT`;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ru-KZ', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortId(value) {
  return value ? String(value).slice(0, 10) : '-';
}

export default function AdminPage() {
  const navigate = useNavigate();
  const previousQueueSize = useRef(0);
  const [now, setNow] = useState(new Date());
  const [absStatus, setAbsStatus] = useState({ online: false, mode: 'auto' });
  const [queue, setQueue] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [manualReview, setManualReview] = useState([]);
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState([]);
  const [uptime, setUptime] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [flashQueue, setFlashQueue] = useState(false);
  const [error, setError] = useState('');

  const healthBlocks = useMemo(() => {
    const latest = [...health].slice(0, 60).reverse();
    const padding = Array.from({ length: Math.max(0, 60 - latest.length) }, (_, index) => ({
      id: `empty-${index}`,
      empty: true,
    }));
    return [...padding, ...latest];
  }, [health]);

  async function loadDashboard() {
    try {
      const [absData, queueData, statsData, healthData] = await Promise.all([
        getABSStatus(),
        getAdminQueue(),
        getAdminStats(),
        getABSHealth(),
      ]);
      const nextQueue = queueData.queue || [];
      if (nextQueue.length !== previousQueueSize.current) {
        setFlashQueue(true);
        window.setTimeout(() => setFlashQueue(false), 650);
      }
      previousQueueSize.current = nextQueue.length;
      setAbsStatus(absData);
      setQueue(nextQueue);
      setDecisions(queueData.penalty_decisions || []);
      setManualReview(queueData.manual_review || []);
      setStats(statsData);
      setHealth(healthData.health || []);
      setUptime(healthData.uptime_percent || 0);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    loadDashboard();
    const refreshTimer = window.setInterval(loadDashboard, 3000);
    const clockTimer = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  async function forceAbs(online) {
    setSyncing(online);
    try {
      await toggleABS(online);
      await loadDashboard();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      window.setTimeout(() => setSyncing(false), 900);
    }
  }

  async function enableAuto() {
    try {
      await resetABS();
      await loadDashboard();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function handleSimulationMode(mode) {
    try {
      await setSimulationMode(mode);
      await loadDashboard();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function handleDemoReset() {
    try {
      await resetDemo();
      await loadDashboard();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return (
    <main className="admin-screen">
      <header className="admin-header">
        <div>
          <p>Kaspi SmartPay 24/7</p>
          <h1>Trust & Penalty Policy Control Center</h1>
        </div>
        <time>{now.toLocaleString('ru-KZ')}</time>
      </header>

      {error && <div className="notice error">{error}</div>}

      <section className="abs-control">
        <div className="abs-state">
          <span className={`pulse-dot large ${absStatus.online ? 'online' : 'offline'}`} />
          <div>
            <strong>{absStatus.online ? 'ONLINE' : 'OFFLINE'}</strong>
            <p>{absStatus.mode === 'manual' ? 'Manual mode' : 'AUTO 09:00-18:00 Asia/Almaty'}</p>
          </div>
        </div>
        <div className="abs-buttons">
          <button onClick={() => forceAbs(false)}>Force OFFLINE</button>
          <button onClick={() => forceAbs(true)}>Force ONLINE</button>
          <button onClick={enableAuto}>AUTO 09:00-18:00</button>
          <button onClick={handleDemoReset}>Reset demo</button>
        </div>
        <label className="simulation-select">
          Simulation mode
          <select value={stats?.abs_simulation_mode || absStatus.simulation_mode || 'NORMAL'} onChange={(event) => handleSimulationMode(event.target.value)}>
            {SIMULATION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
      </section>

      {syncing && <div className="sync-banner">Worker will capture pending reserves after ABS accepts sync.</div>}

      <section className="metric-grid">
        <Metric title="Protected payments" value={stats?.protected_count ?? 0} />
        <Metric title="Review required" value={stats?.review_required_count ?? 0} />
        <Metric title="Not protected" value={stats?.not_protected_count ?? 0} />
        <Metric title="Manual review" value={stats?.manual_review_count ?? 0} />
        <Metric title="Total protected amount" value={formatTenge(stats?.total_protected_amount ?? 0)} />
        <Metric title="Total reserved amount" value={formatTenge(stats?.total_reserved_amount ?? 0)} />
        <Metric title="Support tickets avoided" value={stats?.support_tickets_avoided_demo ?? 0} />
        <Metric title="Customer trust saved" value={formatTenge(stats?.customer_trust_saved_amount ?? 0)} />
        <Metric title="ABS availability" value={stats?.abs_online ? 'ONLINE' : 'OFFLINE'} note={`${uptime}% uptime last hour`} />
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <h2>Penalty Decisions</h2>
          <button onClick={() => navigate('/')}>Customer payment page</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>payment_id</th>
                <th>client_id</th>
                <th>amount</th>
                <th>accepted_at</th>
                <th>cutoff_at</th>
                <th>ABS at acceptance</th>
                <th>policy_status</th>
                <th>policy_decision</th>
                <th>reason</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((item) => (
                <tr key={item.payment_id}>
                  <td>{shortId(item.payment_id)}</td>
                  <td>{item.client_id}</td>
                  <td>{formatTenge(Math.round(Number(item.amount_tiyin) / 100))}</td>
                  <td>{formatDateTime(item.accepted_at)}</td>
                  <td>{formatDateTime(item.cutoff_at)}</td>
                  <td>{item.abs_status_at_acceptance || '-'}</td>
                  <td><span className={`status-pill ${String(item.policy_status).toLowerCase()}`}>{item.policy_status}</span></td>
                  <td>{item.policy_decision}</td>
                  <td>{item.protection_reason || '-'}</td>
                  <td>{item.status}</td>
                </tr>
              ))}
              {!decisions.length && <EmptyRow columns={10} text="No payments yet" />}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <h2>Reconciliation Exceptions</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>payment_id</th>
                <th>error_code</th>
                <th>reason</th>
                <th>amount</th>
                <th>reserved status</th>
                <th>accepted_at</th>
                <th>event_hash</th>
                <th>action</th>
              </tr>
            </thead>
            <tbody>
              {manualReview.map((item) => (
                <tr key={item.payment_id}>
                  <td>{shortId(item.payment_id)}</td>
                  <td>{item.reconciliation_error || '-'}</td>
                  <td>{item.manual_review_reason || '-'}</td>
                  <td>{formatTenge(Math.round(Number(item.amount_tiyin) / 100))}</td>
                  <td>Reserve locked</td>
                  <td>{formatDateTime(item.accepted_at)}</td>
                  <td className="mono">{shortId(item.event_hash)}</td>
                  <td>Manual workflow</td>
                </tr>
              ))}
              {!manualReview.length && <EmptyRow columns={8} text="No reconciliation exceptions" />}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`admin-panel queue-panel ${flashQueue ? 'flash' : ''}`}>
        <div className="panel-title">
          <h2>Pending ABS Queue</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>accepted_at</th>
                <th>client</th>
                <th>amount</th>
                <th>priority</th>
                <th>retries</th>
                <th>next sync info</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item, index) => (
                <tr key={item.id}>
                  <td>{index + 1}</td>
                  <td>{formatDateTime(item.accepted_at)}</td>
                  <td>{item.client_id}</td>
                  <td>{formatTenge(Math.round(Number(item.amount_tiyin) / 100))}</td>
                  <td>{item.priority >= 10 ? 'High' : 'Normal'}</td>
                  <td>{item.retry_count}</td>
                  <td>{item.last_error || 'Next worker tick'}</td>
                  <td>{item.status}</td>
                </tr>
              ))}
              {!queue.length && <EmptyRow columns={8} text="Pending queue is clear" />}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <h2>ABS Health</h2>
        </div>
        <div className="health-grid">
          {healthBlocks.map((item) => (
            <span
              key={item.id}
              className={item.empty ? 'empty' : item.is_online ? 'online' : 'offline'}
              title={item.empty ? 'No data' : `${formatDateTime(item.checked_at)} | ${item.is_online ? 'online' : 'offline'} | ${item.response_ms}ms`}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function Metric({ title, value, note }) {
  return (
    <article className="metric-card">
      <span>{title}</span>
      <strong>{value}</strong>
      {note && <p>{note}</p>}
    </article>
  );
}

function EmptyRow({ columns, text }) {
  return (
    <tr>
      <td colSpan={columns} className="empty-cell">
        {text}
      </td>
    </tr>
  );
}
