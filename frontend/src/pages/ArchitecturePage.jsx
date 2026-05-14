import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getArchitecture } from '../api.js';

const FLOW_NODES = [
  { id: 'mobile_app', title: 'Mobile App', hint: 'Customer pay', icon: 'phone', x: 42, y: 196 },
  { id: 'api_gateway', title: 'API Gateway', hint: 'FastAPI edge', icon: 'gateway', x: 210, y: 196 },
  { id: 'trust_layer', title: 'Trust Layer', hint: 'Policy proof', icon: 'shield', x: 386, y: 196 },
  { id: 'wallet_ledger', title: 'Wallet Ledger', hint: 'Reserve funds', icon: 'ledger', x: 566, y: 116 },
  { id: 'pending_queue', title: 'Pending Queue', hint: 'Durable sync', icon: 'queue', x: 566, y: 286 },
  { id: 'worker', title: 'Celery Worker', hint: 'Retry loop', icon: 'worker', x: 746, y: 286 },
  { id: 'legacy_abs', title: 'Legacy ABS', hint: 'Core banking', icon: 'bank', x: 746, y: 116 },
  { id: 'manual_review', title: 'Manual Review', hint: 'Bank action', icon: 'review', x: 746, y: 440 },
];

const FLOW_CONNECTIONS = [
  { id: 'c1', from: 'mobile_app', to: 'api_gateway', path: 'M162 238 C180 238 190 238 210 238' },
  { id: 'c2', from: 'api_gateway', to: 'trust_layer', path: 'M330 238 C352 238 364 238 386 238' },
  { id: 'c3', from: 'trust_layer', to: 'wallet_ledger', path: 'M506 238 C548 238 526 158 566 158' },
  { id: 'c4', from: 'trust_layer', to: 'pending_queue', path: 'M506 238 C548 238 526 328 566 328' },
  { id: 'c5', from: 'pending_queue', to: 'worker', path: 'M686 328 C708 328 724 328 746 328' },
  { id: 'c6', from: 'worker', to: 'legacy_abs', path: 'M806 286 C806 246 806 198 806 200' },
  { id: 'c7', from: 'worker', to: 'manual_review', path: 'M806 370 C806 394 806 416 806 440' },
];

const NODE_WIDTH = 120;
const NODE_HEIGHT = 84;

function formatTenge(value = 0) {
  return `${new Intl.NumberFormat('ru-KZ').format(Number(value || 0)).replace(/\u00a0/g, ' ')} KZT`;
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

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortId(value) {
  return value ? String(value).slice(0, 10) : '-';
}

function nodeTone(nodeId, data) {
  if (!data) return 'idle';
  if (nodeId === 'legacy_abs') return data.abs.online ? 'healthy' : 'critical';
  if (nodeId === 'pending_queue' && data.queue.pending_count > 0) return 'warning';
  if (nodeId === 'worker' && data.worker.status === 'ATTENTION_REQUIRED') return 'critical';
  if (nodeId === 'worker' && ['SYNCING', 'WAITING_FOR_ABS'].includes(data.worker.status)) return 'warning';
  if (nodeId === 'manual_review' && data.payments.manual_review_count > 0) return 'critical';
  if (data.last_payment?.active_nodes?.includes(nodeId)) return 'active';
  return 'idle';
}

function nodeMeta(nodeId, data) {
  if (!data) return 'Waiting';
  if (nodeId === 'legacy_abs') return data.abs.online ? `ONLINE ${data.abs.response_ms}ms` : 'OFFLINE';
  if (nodeId === 'pending_queue') return `${data.queue.pending_count} pending`;
  if (nodeId === 'worker') return data.worker.status;
  if (nodeId === 'manual_review') return `${data.payments.manual_review_count} review`;
  if (data.last_payment?.active_nodes?.includes(nodeId)) return 'Active';
  return 'Idle';
}

function connectionTone(connection, data, activeSet) {
  if (!data) return 'waiting';
  if (connection.to === 'legacy_abs' && !data.abs.online) return 'blocked';
  if (connection.to === 'manual_review' && data.payments.manual_review_count > 0) return 'blocked';
  if (connection.to === 'pending_queue' && data.queue.pending_count > 0) return 'waiting';
  if (activeSet.has(connection.from) || activeSet.has(connection.to)) return 'running';
  return 'idle';
}

function runtimeEvent(data) {
  if (!data) return { label: 'Waiting for telemetry', tone: 'waiting' };
  if (!data.abs.online) return { label: 'ABS offline, payments route through queue', tone: 'blocked' };
  if (data.worker.status === 'ATTENTION_REQUIRED') return { label: 'Worker needs manual attention', tone: 'blocked' };
  if (data.queue.pending_count > 0) return { label: 'Queue is draining to ABS', tone: 'waiting' };
  if (data.last_payment) return { label: `Last payment ${data.last_payment.status}`, tone: 'running' };
  return { label: 'System idle, ready for payment', tone: 'success' };
}

function Icon({ name }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'phone' && <path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 15h4M9 6h6" />}
      {name === 'gateway' && <path d="M4 8h16M4 16h16M7 5v6m10-6v6M7 13v6m10-6v6" />}
      {name === 'shield' && <path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-5" />}
      {name === 'ledger' && <path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h3" />}
      {name === 'queue' && <path d="M5 7h10a4 4 0 0 1 0 8H8m0 0 3-3m-3 3 3 3M5 11h8" />}
      {name === 'worker' && <path d="M9 3h6l1 3 3 1v6l-3 1-1 3H9l-1-3-3-1V7l3-1 1-3Zm3 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />}
      {name === 'bank' && <path d="M4 10h16L12 4 4 10Zm2 2v7m4-7v7m4-7v7m4-7v7M4 20h16" />}
      {name === 'review' && <path d="M5 4h14v11H9l-4 4V4Zm4 4h6m-6 4h4" />}
    </svg>
  );
}

export default function ArchitecturePage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());

  async function loadArchitecture() {
    try {
      const nextData = await getArchitecture();
      setData(nextData);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    loadArchitecture();
    const refreshTimer = window.setInterval(loadArchitecture, 2500);
    const clockTimer = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  const activeSet = useMemo(() => new Set(data?.last_payment?.active_nodes || []), [data]);
  const lastPayment = data?.last_payment;
  const event = runtimeEvent(data);

  return (
    <main className="admin-screen architecture-screen">
      <header className="admin-header architecture-commandbar">
        <div>
          <p>Kaspi Sync</p>
          <h1>Live Architecture Map</h1>
          <span className={`runtime-banner ${event.tone}`}>{event.label}</span>
        </div>
        <div className="architecture-header-actions">
          <time>{now.toLocaleString('ru-KZ')}</time>
          <button className="ghost-button" onClick={() => navigate('/admin')}>Back to admin</button>
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}

      <section className="metric-grid architecture-metrics">
        <Metric title="ABS status" value={data?.abs.online ? 'ONLINE' : 'OFFLINE'} tone={data?.abs.online ? 'healthy' : 'critical'} note={data ? `${data.abs.mode} | ${data.abs.simulation_mode}` : '-'} />
        <Metric title="Worker status" value={data?.worker.status || 'IDLE'} tone={data?.worker.status === 'ATTENTION_REQUIRED' ? 'critical' : data?.worker.status === 'IDLE' ? 'idle' : 'warning'} note={data?.worker.message || '-'} />
        <Metric title="Pending queue" value={data?.queue.pending_count ?? 0} tone={(data?.queue.pending_count ?? 0) > 0 ? 'warning' : 'idle'} note={`Oldest ${formatDuration(data?.queue.oldest_pending_age_seconds)}`} />
        <Metric title="Reserved amount" value={formatTenge(data?.wallet.total_reserved_tenge ?? 0)} tone={(data?.wallet.total_reserved_tenge ?? 0) > 0 ? 'warning' : 'idle'} note="Wallet reserve" />
        <Metric title="Synced payments" value={data?.payments.synced_count ?? 0} tone="healthy" note={`${data?.payments.offline_accepted_count ?? 0} offline accepted`} />
        <Metric title="Manual review" value={data?.payments.manual_review_count ?? 0} tone={(data?.payments.manual_review_count ?? 0) > 0 ? 'critical' : 'idle'} note={formatTenge(data?.wallet.manual_review_locked_tenge ?? 0)} />
      </section>

      <section className="architecture-layout">
        <div className="admin-panel architecture-map-panel">
          <div className="panel-title">
            <h2>Payment Flow</h2>
            <span className="live-stamp">Refresh 2.5s | {formatDateTime(data?.generated_at)}</span>
          </div>
          <div className="architecture-flow" aria-label="Live payment architecture flow">
            <svg className="flow-wires" viewBox="0 0 920 560" aria-hidden="true">
              {FLOW_CONNECTIONS.map((connection) => {
                const tone = connectionTone(connection, data, activeSet);
                return (
                  <g key={connection.id} className={`flow-wire ${tone}`}>
                    <path d={connection.path} />
                    {tone !== 'idle' && (
                      <circle r="5">
                        <animateMotion dur={tone === 'blocked' ? '2.6s' : '1.65s'} repeatCount="indefinite" path={connection.path} />
                      </circle>
                    )}
                  </g>
                );
              })}
            </svg>
            {FLOW_NODES.map((node) => {
              const tone = nodeTone(node.id, data);
              const isActive = activeSet.has(node.id);
              return (
                <article
                  className={`flow-node ${tone} ${isActive ? 'is-active' : ''}`}
                  key={node.id}
                  style={{ left: node.x, top: node.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
                >
                  <span className={`node-port input ${tone}`} />
                  <span className={`node-port output ${tone}`} />
                  <span className={`node-light ${tone}`} />
                  <span className="node-icon"><Icon name={node.icon} /></span>
                  <div>
                    <strong>{node.title}</strong>
                    <p>{node.hint}</p>
                  </div>
                  <small>{nodeMeta(node.id, data)}</small>
                </article>
              );
            })}
            <div className="flow-legend" aria-hidden="true">
              <span><i className="legend-dot idle" /> idle</span>
              <span><i className="legend-dot waiting" /> waiting</span>
              <span><i className="legend-dot running" /> running</span>
              <span><i className="legend-dot blocked" /> blocked</span>
            </div>
          </div>
        </div>

        <aside className="admin-panel last-payment-panel">
          <div className="panel-title">
            <h2>Last Payment</h2>
          </div>
          {lastPayment ? (
            <div className="last-payment-details">
              <div>
                <span>payment_id</span>
                <strong className="mono">{shortId(lastPayment.payment_id)}</strong>
              </div>
              <div>
                <span>amount</span>
                <strong>{formatTenge(lastPayment.amount_tenge)}</strong>
              </div>
              <div>
                <span>status</span>
                <strong className={`payment-state ${String(lastPayment.status).toLowerCase()}`}>{lastPayment.status}</strong>
              </div>
              <div>
                <span>risk_score</span>
                <strong className={`risk-pill ${String(lastPayment.risk_score).toLowerCase()}`}>{lastPayment.risk_score}</strong>
              </div>
              <div>
                <span>policy_status</span>
                <strong>{lastPayment.policy_status || '-'}</strong>
              </div>
              <div>
                <span>accepted_at</span>
                <strong>{formatDateTime(lastPayment.accepted_at)}</strong>
              </div>
            </div>
          ) : (
            <p className="empty-state">No payments yet. Create a Kaspi Sync payment to light up the map.</p>
          )}
        </aside>
      </section>
    </main>
  );
}

function Metric({ title, value, note, tone = 'idle' }) {
  return (
    <article className={`metric-card live-metric ${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      {note && <p>{note}</p>}
    </article>
  );
}
