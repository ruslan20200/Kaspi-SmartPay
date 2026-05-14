import axios from 'axios';

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:8000',
  timeout: 10000,
});

function normalizeError(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail?.error) {
    const balance = detail.balance !== undefined ? ` Доступно: ${detail.balance} ₸.` : '';
    const required = detail.required !== undefined ? ` Нужно: ${detail.required} ₸.` : '';
    return `${detail.error}.${balance}${required}`.trim();
  }
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

function deviceInfo() {
  return {
    user_agent: window.navigator.userAgent,
    platform: window.navigator.platform,
    language: window.navigator.language,
  };
}

export async function createPayment(client_id, credit_id, amount_tenge, request_id) {
  return unwrap(
    api.post('/pay', {
      client_id,
      credit_id,
      amount: String(amount_tenge),
      request_id,
      device_info: deviceInfo(),
    })
  );
}

export async function createLegacyPayment(client_id, credit_id, amount_tenge) {
  return unwrap(
    api.post('/legacy/pay', {
      client_id,
      credit_id,
      amount: String(amount_tenge),
      request_id: `legacy-${crypto.randomUUID()}`,
      device_info: deviceInfo(),
    })
  );
}

export async function getPaymentStatus(payment_id) {
  return unwrap(api.get(`/status/${payment_id}`));
}

export async function getReceipt(payment_id) {
  return unwrap(api.get(`/receipt/${payment_id}`));
}

export async function getWallet(client_id) {
  return unwrap(api.get(`/wallet/${client_id}`));
}

export async function getCredits(client_id) {
  return unwrap(api.get(`/credits/${client_id}`));
}

export async function getAdminQueue() {
  return unwrap(api.get('/admin/queue'));
}

export async function getAdminStats() {
  return unwrap(api.get('/admin/stats'));
}

export async function getABSHealth() {
  return unwrap(api.get('/admin/abs-health'));
}

export async function getArchitecture() {
  return unwrap(api.get('/admin/architecture'));
}

export async function getABSStatus() {
  return unwrap(api.get('/abs/status'));
}

export async function toggleABS(online_bool) {
  return unwrap(api.post('/abs/toggle', { online: online_bool }));
}

export async function getSimulationMode() {
  return unwrap(api.get('/abs/simulation-mode'));
}

export async function setSimulationMode(mode) {
  return unwrap(api.post('/abs/simulation-mode', { mode }));
}

export async function resetABS() {
  return unwrap(api.post('/abs/reset'));
}

export async function resetDemo() {
  return unwrap(api.get('/demo/reset'));
}

export default api;
