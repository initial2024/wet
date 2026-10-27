const CALL_RE = /^助手请求调用工具（name=([^,，()\r\n]+)[,，]\s*id=([^()\r\n]+)）：(\{.*\})$/u;
const PREFIX = '助手请求调用工具（';

export function visibleToolNameSet(options) {
  return new Set((options?.tools || []).map(tool => String(tool?.name || '')).filter(Boolean));
}

export function protocolPrefixState(text) {
  const value = String(text || '');
  if (PREFIX.startsWith(value)) return 'candidate';
  if (!value.startsWith(PREFIX)) return 'miss';
  return 'match';
}

export function parsePseudoToolCalls(text, allowedNames) {
  const lines = String(text || '').trim().split(/\r?\n/u).filter(Boolean);
  if (!lines.length) return { ok: false, reason: 'empty' };
  const ids = new Set();
  const calls = [];
  for (const line of lines) {
    const match = line.match(CALL_RE);
    if (!match) return { ok: false, reason: 'non_protocol_text' };
    const name = match[1].trim();
    const id = match[2].trim();
    if (!allowedNames.has(name)) return { ok: false, reason: `hidden_tool:${name}` };
    if (!id || ids.has(id)) return { ok: false, reason: 'duplicate_or_empty_id' };
    let args;
    try { args = JSON.parse(match[3]); } catch { return { ok: false, reason: 'invalid_json' }; }
    if (!args || Array.isArray(args) || typeof args !== 'object') return { ok: false, reason: 'args_not_object' };
    ids.add(id);
    calls.push({ name, id, arguments: JSON.stringify(args) });
  }
  return { ok: true, calls };
}
