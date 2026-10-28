const CALL_RE = /^助手请求调用工具（name=([^,，()\r\n]+)[,，]\s*id=([^()\r\n]+)）：(\{.*\})$/u;
const LEGACY_PREFIX = '助手请求调用工具（';
const TOOL_CALLS_OPEN = '<tool_calls>';
const FEEDBACK_TOOL = 'web_relay_compat_feedback';
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/gu;
const DSML_MARKER_SOURCE = '(?:｜{1,2}DSML｜{1,2}|\|{1,2}DSML\|{1,2})';
const DSML_TAG_RE = new RegExp('<\\s*(\\/?)\\s*' + DSML_MARKER_SOURCE + '\\s*(tool_calls|calls|invoke|parameter)\\b([^>]*)>', 'giu');

export function visibleToolNameSet(options) {
  return new Set((options?.tools || []).map(tool => String(tool?.name || '')).filter(Boolean));
}

function protocolComparable(text) {
  return String(text || '').replace(INVISIBLE_RE, '').trimStart();
}

export function protocolPrefixState(text) {
  const value = protocolComparable(text);
  if (!value) return 'candidate';
  const lower = value.toLowerCase();
  const asciiPrefixes = [
    LEGACY_PREFIX,
    TOOL_CALLS_OPEN,
    '<||dsml||tool_calls>',
    '<|dsml|tool_calls>',
  ];
  for (const prefix of asciiPrefixes) {
    const p = prefix.toLowerCase();
    if (p.startsWith(lower)) return 'candidate';
    if (lower.startsWith(p)) return 'match';
  }
  if (/^<\s*(?:｜{1,2}DSML｜{1,2})\s*(?:tool_calls|calls)\b/iu.test(value)) return 'match';
  if (/^<\s*(?:｜{1,2}DSML｜{1,2})?$/iu.test(value)) return 'candidate';
  return 'miss';
}

function stableId(name, args, index) {
  let hash = 2166136261;
  const text = String(name) + '\n' + String(args) + '\n' + String(index);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 'web_' + index + '_' + (hash >>> 0).toString(16);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeArguments(value) {
  if (isPlainObject(value)) return { value, json: JSON.stringify(value) };
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? { value: parsed, json: JSON.stringify(parsed) } : null;
  } catch {
    return null;
  }
}

function normalizeRawCall(item, index) {
  if (!isPlainObject(item)) return { ok: false, skipped: { index, name: '(invalid)', reason: 'call_not_object' } };
  const fn = isPlainObject(item.function) ? item.function : null;
  const name = typeof item.name === 'string' ? item.name.trim()
    : typeof fn?.name === 'string' ? fn.name.trim() : '';
  if (!name) return { ok: false, skipped: { index, name: '(missing)', reason: 'missing_tool_name' } };
  const rawArgs = Object.prototype.hasOwnProperty.call(item, 'arguments') ? item.arguments : fn?.arguments;
  const normalized = normalizeArguments(rawArgs);
  if (!normalized) return { ok: false, skipped: { index, name, reason: 'arguments_not_object' } };
  const id = typeof item.id === 'string' && item.id ? item.id : stableId(name, normalized.json, index);
  return { ok: true, call: { name, id, arguments: normalized.json } };
}

function validateRawCalls(rawCalls, allowedNames) {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return { ok: false, reason: 'empty_calls', calls: [], skipped: [] };
  const ids = new Set();
  const calls = [];
  const skipped = [];
  for (let index = 0; index < rawCalls.length; index += 1) {
    const normalized = normalizeRawCall(rawCalls[index], index);
    if (!normalized.ok) {
      skipped.push(normalized.skipped);
      continue;
    }
    const call = normalized.call;
    if (!allowedNames.has(call.name)) {
      skipped.push({ index, name: call.name, reason: 'tool_not_available' });
      continue;
    }
    if (ids.has(call.id)) {
      skipped.push({ index, name: call.name, reason: 'duplicate_call_id' });
      continue;
    }
    ids.add(call.id);
    calls.push(call);
  }
  if (calls.length === 0 && skipped.length > 0) return { ok: false, reason: 'no_executable_calls', calls, skipped };
  return { ok: true, calls, skipped };
}

export function parsePseudoToolCalls(text, allowedNames) {
  const lines = String(text || '').trim().split(/\r?\n/u).filter(Boolean);
  if (!lines.length) return { ok: false, reason: 'empty', protocol: false };
  const ids = new Set();
  const calls = [];
  for (const line of lines) {
    const match = line.match(CALL_RE);
    if (!match) return { ok: false, reason: 'non_protocol_text', protocol: line.startsWith(LEGACY_PREFIX) };
    const name = match[1].trim();
    const id = match[2].trim();
    if (!allowedNames.has(name)) return { ok: false, reason: 'hidden_tool:' + name, protocol: true };
    if (!id || ids.has(id)) return { ok: false, reason: 'duplicate_or_empty_id', protocol: true };
    let args;
    try { args = JSON.parse(match[3]); } catch { return { ok: false, reason: 'invalid_json', protocol: true }; }
    if (!isPlainObject(args)) return { ok: false, reason: 'args_not_object', protocol: true };
    ids.add(id);
    calls.push({ name, id, arguments: JSON.stringify(args) });
  }
  return { ok: true, calls, skipped: [], prose: '', protocol: true };
}

function normalizeDsmlTags(text) {
  return String(text || '').replace(INVISIBLE_RE, '').replace(DSML_TAG_RE, (_match, slash, rawTag, attrs) => {
    const tag = rawTag === 'calls' ? 'tool_calls' : rawTag;
    return '<' + slash + tag + attrs + '>';
  });
}

function protocolSpace(ch) {
  return ch !== undefined && (/\s/u.test(ch) || /[\u200B-\u200D\u2060\uFEFF]/u.test(ch));
}

function findBalancedJsonArrayEnd(text, start) {
  let i = start;
  while (i < text.length && protocolSpace(text[i])) i += 1;
  if (text[i] !== '[') return -1;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[' || ch === '{') { stack.push(ch); continue; }
    if (ch === ']' || ch === '}') {
      const expected = ch === ']' ? '[' : '{';
      if (stack.pop() !== expected) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function closingNoiseOnly(value) {
  const normalized = normalizeDsmlTags(value).trim();
  if (!normalized) return true;
  return /^(?:<\/(?:parameter|invoke|tool_calls)>\s*)+$/iu.test(normalized);
}

function parseTaggedJson(text, allowedNames) {
  const normalized = normalizeDsmlTags(text);
  const openMatch = /<\s*tool_calls\s*>/iu.exec(normalized);
  if (!openMatch) return null;
  const bodyStart = openMatch.index + openMatch[0].length;
  const bodyEnd = findBalancedJsonArrayEnd(normalized, bodyStart);
  if (bodyEnd === -1) return { ok: false, reason: 'unbalanced_json_array', protocol: true };

  let rawCalls;
  try { rawCalls = JSON.parse(normalized.slice(bodyStart, bodyEnd).trim()); }
  catch { return { ok: false, reason: 'invalid_tagged_json', protocol: true }; }

  let remainder = normalized.slice(bodyEnd).trim();
  const close = /^<\s*\/\s*tool_calls\s*>/iu.exec(remainder);
  if (close) remainder = remainder.slice(close[0].length).trim();
  if (!closingNoiseOnly(remainder)) return { ok: false, reason: 'unexpected_protocol_tail', protocol: true };

  const validated = validateRawCalls(rawCalls, allowedNames);
  return {
    ...validated,
    protocol: true,
    prose: normalized.slice(0, openMatch.index).trim(),
  };
}

function decodeEntities(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attributeValue(attrs, name) {
  const match = new RegExp('(?:^|\\\\s)' + name + '\\\\s*=\\\\s*([\\\"\\\'])(.*?)\\\\1', 'iu').exec(attrs);
  return match ? decodeEntities(match[2]) : null;
}

function unwrapCdata(value) {
  const trimmed = value.trim();
  const match = /^<!\[CDATA\[([\s\S]*?)\]\]>$/u.exec(trimmed);
  return match ? match[1] : trimmed;
}

function parseDsml(text, allowedNames) {
  if (!/(?:｜{1,2}DSML｜{1,2}|\|{1,2}DSML\|{1,2})/u.test(text)) return null;
  const normalized = normalizeDsmlTags(text);
  const openMatch = /<\s*tool_calls\s*>/iu.exec(normalized);
  if (!openMatch) return { ok: false, reason: 'missing_dsml_tool_calls_open', protocol: true };
  const bodyStart = openMatch.index + openMatch[0].length;
  const closeRe = /<\s*\/\s*tool_calls\s*>/giu;
  closeRe.lastIndex = bodyStart;
  const close = closeRe.exec(normalized);
  if (!close) return { ok: false, reason: 'missing_dsml_tool_calls_close', protocol: true };
  const body = normalized.slice(bodyStart, close.index);

  const rawCalls = [];
  const invokeRe = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/giu;
  let cursor = 0;
  let invoke;
  while ((invoke = invokeRe.exec(body)) !== null) {
    if (body.slice(cursor, invoke.index).trim() !== '') return { ok: false, reason: 'unexpected_dsml_body', protocol: true };
    cursor = invokeRe.lastIndex;
    const name = attributeValue(invoke[1], 'name');
    if (!name) return { ok: false, reason: 'missing_dsml_name', protocol: true };
    const args = {};
    const paramBody = invoke[2];
    const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/giu;
    let paramCursor = 0;
    let parameter;
    while ((parameter = paramRe.exec(paramBody)) !== null) {
      if (paramBody.slice(paramCursor, parameter.index).trim() !== '') return { ok: false, reason: 'unexpected_dsml_parameter_body', protocol: true };
      paramCursor = paramRe.lastIndex;
      const paramName = attributeValue(parameter[1], 'name');
      const stringFlag = attributeValue(parameter[1], 'string');
      if (!paramName || (stringFlag !== 'true' && stringFlag !== 'false')) return { ok: false, reason: 'invalid_dsml_parameter', protocol: true };
      if (Object.prototype.hasOwnProperty.call(args, paramName)) return { ok: false, reason: 'duplicate_dsml_parameter', protocol: true };
      const rawValue = decodeEntities(unwrapCdata(parameter[2]));
      if (stringFlag === 'true') args[paramName] = rawValue;
      else {
        try { args[paramName] = JSON.parse(rawValue); }
        catch { return { ok: false, reason: 'invalid_dsml_json_value', protocol: true }; }
      }
    }
    if (paramBody.slice(paramCursor).trim() !== '') return { ok: false, reason: 'unexpected_dsml_parameter_tail', protocol: true };
    rawCalls.push({ name, arguments: args });
  }
  if (body.slice(cursor).trim() !== '' || rawCalls.length === 0) return { ok: false, reason: 'empty_or_malformed_dsml', protocol: true };
  const validated = validateRawCalls(rawCalls, allowedNames);
  return {
    ...validated,
    protocol: true,
    prose: normalized.slice(0, openMatch.index).trim(),
  };
}

export function parseRelayToolCalls(text, allowedNames) {
  const legacy = parsePseudoToolCalls(text, allowedNames);
  if (legacy.ok || legacy.protocol) return legacy;

  // DSML normalizes its outer marker to <tool_calls>, so it must be parsed
  // before the tagged-JSON branch or the latter will misclassify its invoke body
  // as a missing JSON array.
  if (/(?:｜{1,2}DSML｜{1,2}|\|{1,2}DSML\|{1,2})/u.test(String(text || ''))) {
    const dsml = parseDsml(text, allowedNames);
    if (dsml) return dsml;
  }

  const tagged = parseTaggedJson(text, allowedNames);
  if (tagged) return tagged;
  return { ok: false, reason: 'not_tool_protocol', protocol: false };
}

export const _test = {
  normalizeDsmlTags,
  parseTaggedJson,
  parseDsml,
  findBalancedJsonArrayEnd,
  validateRawCalls,
};
