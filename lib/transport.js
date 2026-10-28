export const DEFAULT_LOCAL_ENDPOINTS = Object.freeze([
  'http://127.0.0.1:1601/v1/chat/completions',
  'http://127.0.0.1:8787/v1/chat/completions',
]);

export const DEFAULT_MODELS = Object.freeze([
  Object.freeze({ id: 'deepseek-chat', name: 'DeepSeek Web', inputModalities: ['text', 'image'] }),
  Object.freeze({ id: 'chatgpt-web', name: 'ChatGPT Web', inputModalities: ['text', 'image'] }),
  Object.freeze({ id: 'grok-web-fast', name: 'Grok Web', inputModalities: ['text', 'image'] }),
  Object.freeze({ id: 'glm-web-flash', name: 'GLM Web', inputModalities: ['text', 'image'] }),
]);

function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return null;
  const url = new URL(raw);
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/v1/chat/completions';
  } else if (url.pathname === '/v1' || url.pathname === '/v1/') {
    url.pathname = '/v1/chat/completions';
  }
  return url.toString().replace(/\/$/u, '');
}

export function endpointCandidates(config = {}) {
  const ordered = [];
  const add = value => {
    let normalized;
    try { normalized = normalizeEndpoint(value); } catch { return; }
    if (normalized && !ordered.includes(normalized)) ordered.push(normalized);
  };

  add(config.endpoint);
  if (Array.isArray(config.endpointCandidates)) {
    for (const value of config.endpointCandidates) add(value);
  }
  for (const value of DEFAULT_LOCAL_ENDPOINTS) add(value);
  return ordered;
}

export function isLoopbackEndpoint(endpoint) {
  try {
    const host = new URL(endpoint).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function authValueForEndpoint(endpoint, configuredKey = '') {
  const key = String(configuredKey || '').trim();
  if (key) return 'Bearer ' + key;
  return isLoopbackEndpoint(endpoint) ? 'Bearer dsh-local' : '';
}

export function explicitUserCancellation(signal) {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  const pieces = [
    typeof reason === 'string' ? reason : '',
    reason && typeof reason === 'object' ? reason.name : '',
    reason && typeof reason === 'object' ? reason.code : '',
    reason && typeof reason === 'object' ? reason.message : '',
  ].filter(Boolean).join(' ').toLowerCase();

  return /user.{0,12}(cancel|abort|stop)|cancel.{0,12}by.{0,12}user|stop.{0,12}generation|manual.{0,12}(cancel|stop)|explicit.{0,12}(cancel|abort)/u.test(pieces);
}

function probeUrl(endpoint) {
  const url = new URL(endpoint);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function probeEndpoint(fetchImpl, endpoint, timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('probe_timeout')), timeoutMs);
  try {
    // Any HTTP response proves that a listener exists on this endpoint. The
    // root path is deliberately used so no chat submission can be duplicated.
    await fetchImpl(probeUrl(endpoint), {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function chooseEndpoint(fetchImpl, candidates, preferred = '', timeoutMs = 900) {
  const ordered = [];
  if (preferred && candidates.includes(preferred)) ordered.push(preferred);
  for (const endpoint of candidates) {
    if (!ordered.includes(endpoint)) ordered.push(endpoint);
  }

  for (const endpoint of ordered) {
    if (await probeEndpoint(fetchImpl, endpoint, timeoutMs)) return endpoint;
  }
  return null;
}

export function modelCatalog(config = {}) {
  const extra = Array.isArray(config.models) ? config.models : [];
  const merged = [];
  const seen = new Set();
  for (const item of [...DEFAULT_MODELS, ...extra]) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({
      id,
      name: String(item?.name || id),
      inputModalities: Array.isArray(item?.inputModalities) && item.inputModalities.length
        ? [...item.inputModalities]
        : ['text', 'image'],
    });
  }
  return merged;
}

export async function drainReader(reader, controller, maxMs = 3_660_000) {
  const timer = setTimeout(() => {
    try { controller.abort(new Error('detached_drain_timeout')); } catch {}
  }, maxMs);

  try {
    while (!controller.signal.aborted) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Detached draining is best effort. Its purpose is to keep the local
    // gateway socket alive long enough for the webpage generation to finish.
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch {}
  }
}
