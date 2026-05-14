import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  demoReset,
  getABSHealth,
  getABSStatus,
  getAdminQueue,
  getAdminStats,
  resetABS,
  setSimulationMode,
  toggleABS,
} from '../api/api.js';

const SIMULATION_MODES = ['NORMAL', 'AMOUNT_MISMATCH', 'CREDIT_NOT_FOUND', 'ALREADY_CLOSED', 'HARD_ERROR'];

function formatTenge(value = 0) {
  return `${new Intl.NumberFormat('ru-KZ').format(Number(value || 0)).replace(/\u00a0/g, ' ')} ₸`;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortId(value, size = 10) {
  return value ? String(value).slice(0, size) : '-';
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
  const [busy, setBusy] = useState(false);
  const [flashQueue, setFlashQueue] = useState(false);
  const [error, setError] = useState('');

  const healthBlocks = useMemo(() => {
    const latest = [...health].slice(0, 48).reverse();
    const padding = Array.from({ length: Math.max(0, 48 - latest.length) }, (_, index) => ({
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

  async function runControl(task) {
    setBusy(true);
    setError('');
    try {
      await task();
      await loadDashboard();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-frame">
      <header className="admin-topbar">
        <button className="back-button" type="button" aria-label="Назад" onClick={() => navigate('/')} />
        <div>
          <strong>Kaspi Sync Admin</strong>
          <span>Asia/Almaty · {now.toLocaleTimeString('ru-RU')}</span>
        </div>
        <Link to="/" className="text-link">Client</Link>
      </header>

      <main className="admin-shell">
        {error && <section className="inline-alert danger">{error}</section>}

        <section className="admin-hero">
          <div>
            <span className={`abs-chip ${absStatus.online ? 'online' : 'offline'}`}>
              {absStatus.online ? 'ABS ONLINE' : 'ABS OFFLINE'}
            </span>
            <h1>Trust & Penalty Policy Control Center</h1>
            <p>Simulation: {stats?.abs_simulation_mode || absStatus.simulation_mode || 'NORMAL'} · Mode: {absStatus.mode || 'auto'}</p>
          </div>
          <div className="admin-counts">
            <span>
              Pending
              <b>{stats?.pending_count ?? stats?.pending_abs_sync ?? queue.length}</b>
            </span>
            <span>
              Manual review
              <b>{stats?.manual_review_count ?? manualReview.length}</b>
            </span>
          </div>
        </section>

        <section className="control-panel">
          <div className="panel-title">
            <h2>ABS controls</h2>
            <span>{busy ? 'Applying...' : `${uptime}% uptime last hour`}</span>
          </div>
          <div className="control-grid">
            <button type="button" disabled={busy} onClick={() => runControl(() => toggleABS(true))}>Force ONLINE</button>
            <button type="button" disabled={busy} onClick={() => runControl(() => toggleABS(false))}>Force OFFLINE</button>
            <button type="button" disabled={busy} onClick={() => runControl(resetABS)}>AUTO mode</button>
            <button type="button" disabled={busy} onClick={() => runControl(demoReset)}>Demo reset</button>
          </div>
          <label className="soft-select">
            Simulation mode selector
            <select
              value={stats?.abs_simulation_mode || absStatus.simulation_mode || 'NORMAL'}
              disabled={busy}
              onChange={(event) => runControl(() => setSimulationMode(event.target.value))}
            >
              {SIMULATION_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode}</option>
              ))}
            </select>
          </label>
        </section>

        <section className="metric-grid">
          <Metric title="Protected payments" value={stats?.protected_count ?? 0} />
          <Metric title="Review required payments" value={stats?.review_required_count ?? 0} />
          <Metric title="Not protected payments" value={stats?.not_protected_count ?? 0} />
          <Metric title="Manual review payments" value={stats?.manual_review_count ?? 0} />
          <Metric title="Total protected amount" value={formatTenge(stats?.total_protected_amount ?? 0)} />
          <Metric title="Total reserved amount" value={formatTenge(stats?.total_reserved_amount ?? 0)} />
          <Metric title="Support tickets avoided demo" value={stats?.support_tickets_avoided_demo ?? 0} />
          <Metric title="Customer trust saved amount" value={formatTenge(stats?.customer_trust_saved_amount ?? 0)} />
        </section>

        <AdminTable title="Penalty Decisions">
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
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((item) => (
                <tr key={item.payment_id}>
                  <td className="mono">{shortId(item.payment_id)}</td>
                  <td>{item.client_id}</td>
                  <td>{formatTenge(Math.round(Number(item.amount_tiyin || 0) / 100))}</td>
                  <td>{formatDateTime(item.accepted_at)}</td>
                  <td>{formatDateTime(item.cutoff_at)}</td>
                  <td>{item.abs_status_at_acceptance || '-'}</td>
                  <td><span className={`badge ${String(item.policy_status).toLowerCase()}`}>{item.policy_status}</span></td>
                  <td>{item.policy_decision}</td>
                  <td>{item.status}</td>
                </tr>
              ))}
              {!decisions.length && <EmptyRow columns={9} text="No penalty decisions yet" />}
            </tbody>
          </table>
        </AdminTable>

        <AdminTable title="Reconciliation Exceptions">
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
              </tr>
            </thead>
            <tbody>
              {manualReview.map((item) => (
                <tr key={item.payment_id}>
                  <td className="mono">{shortId(item.payment_id)}</td>
                  <td>{item.reconciliation_error || '-'}</td>
                  <td>{item.manual_review_reason || '-'}</td>
                  <td>{formatTenge(Math.round(Number(item.amount_tiyin || 0) / 100))}</td>
                  <td>Reserve locked</td>
                  <td>{formatDateTime(item.accepted_at)}</td>
                  <td className="mono">{shortId(item.event_hash)}</td>
                </tr>
              ))}
              {!manualReview.length && <EmptyRow columns={7} text="No reconciliation exceptions" />}
            </tbody>
          </table>
        </AdminTable>

        <section className={`admin-card ${flashQueue ? 'flash' : ''}`}>
          <div className="panel-title">
            <h2>Pending ABS Queue</h2>
            <span>{queue.length} items</span>
          </div>
          <div className="queue-list">
            {queue.map((item, index) => (
              <article key={item.id || item.payment_id}>
                <span className="queue-index">{index + 1}</span>
                <div>
                  <strong>{item.client_id} · {formatTenge(Math.round(Number(item.amount_tiyin || 0) / 100))}</strong>
                  <small>{formatDateTime(item.accepted_at)} · retry {item.retry_count}</small>
                  <p>{item.last_error || 'Next worker tick'}</p>
                </div>
                <span className="badge pending">{item.status}</span>
              </article>
            ))}
            {!queue.length && <p className="empty-copy">Pending queue is clear</p>}
          </div>
        </section>

        <section className="admin-card">
          <div className="panel-title">
            <h2>ABS Health</h2>
            <span>{uptime}%</span>
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
    </div>
  );
}

function Metric({ title, value }) {
  return (
    <article className="metric-card">
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AdminTable({ title, children }) {
  return (
    <section className="admin-card">
      <div className="panel-title">
        <h2>{title}</h2>
      </div>
      <div className="table-scroll">{children}</div>
    </section>
  );
}

function EmptyRow({ columns, text }) {
  return (
    <tr>
      <td colSpan={columns} className="empty-cell">{text}</td>
    </tr>
  );
}
