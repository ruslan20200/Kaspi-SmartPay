import axios from 'axios';

const baseURL =
  process.env.REACT_APP_API_URL ||
  process.env.VITE_API_URL ||
  'http://localhost:8000';

const api = axios.create({
  baseURL,
  timeout: 10000,
});

function normalizeError(error) {
  const detail = error?.response?.data?.detail;
  const data = error?.response?.data;

  if (typeof detail === 'string') return detail;
  if (detail?.error) {
    const balance = detail.balance !== undefined ? ` Доступно: ${detail.balance} ₸.` : '';
    const required = detail.required !== undefined ? ` Нужно: ${detail.required} ₸.` : '';
    return `${detail.error}.${balance}${required}`.trim();
  }
  if (data?.message) return data.message;
  if (data?.error) return data.error;
  if (error?.message) return error.message;
  return 'Не удалось выполнить запрос';
}

async function unwrap(promise) {
  try {
    const response = await promise;
    return response.data;
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

function requestId(prefix = 'kaspi-sync') {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function deviceInfo() {
  return {
    user_agent: window.navigator.userAgent,
    platform: window.navigator.platform,
    language: window.navigator.language,
    pwa: window.matchMedia?.('(display-mode: standalone)').matches || false,
  };
}

export function createPayment(client_id, credit_id, amount_tenge, paymentRequestId) {
  return unwrap(
    api.post('/pay', {
      client_id,
      credit_id,
      amount: String(amount_tenge),
      request_id: paymentRequestId,
      device_info: deviceInfo(),
    })
  );
}

export function createLegacyPayment(client_id, credit_id, amount_tenge) {
  return unwrap(
    api.post('/legacy/pay', {
      client_id,
      credit_id,
      amount: String(amount_tenge),
      request_id: requestId('legacy'),
      device_info: deviceInfo(),
    })
  );
}

export function getStatus(payment_id) {
  return unwrap(api.get(`/status/${payment_id}`));
}

export function getPaymentStatus(payment_id) {
  return getStatus(payment_id);
}

export function getReceipt(payment_id) {
  return unwrap(api.get(`/receipt/${payment_id}`));
}

export function getWallet(client_id) {
  return unwrap(api.get(`/wallet/${client_id}`));
}

export function getCredits(client_id) {
  return unwrap(api.get(`/credits/${client_id}`));
}

export function getAdminStats() {
  return unwrap(api.get('/admin/stats'));
}

export function getAdminQueue() {
  return unwrap(api.get('/admin/queue'));
}

export function getAbsHealth() {
  return unwrap(api.get('/admin/abs-health'));
}

export function getABSHealth() {
  return getAbsHealth();
}

export function getAbsStatus() {
  return unwrap(api.get('/abs/status'));
}

export function getABSStatus() {
  return getAbsStatus();
}

export function setAbsMode(online) {
  return unwrap(api.post('/abs/toggle', { online }));
}

export function toggleABS(online) {
  return setAbsMode(online);
}

export function getSimulationMode() {
  return unwrap(api.get('/abs/simulation-mode'));
}

export function setSimulationMode(mode) {
  return unwrap(api.post('/abs/simulation-mode', { mode }));
}

export function resetABS() {
  return unwrap(api.post('/abs/reset'));
}

export function demoReset() {
  return unwrap(api.get('/demo/reset'));
}

export function resetDemo() {
  return demoReset();
}

export { requestId };
export default api;
