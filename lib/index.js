import { readFile, stat } from 'node:fs/promises';
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_SINGLE_ATTACHMENT_BYTES,
  attachmentNameForPath,
  encodeRelayEnvelope,
  extractProjectedFilePaths,
  makeAttachmentIdForPath,
  mimeFromName,
  serializeHarnessPrompt,
} from './protocol.js';
import { parseRelayToolCalls, protocolPrefixState, visibleToolNameSet } from './parser.js';

export const name = 'dsh-web-gateway-v2';
export const inject = ['llm', 'attachments'];

function imageExt(mime) {
  return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.png';
}

function contentTexts(content) {
  const out = [];
  const visit = blocks => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') out.push(String(block.text || ''));
      else if (block.type === 'tool-result') visit(block.content);
    }
  };
  visit(content);
  return out;
}

function imageBlocks(content) {
  const out = [];
  const visit = blocks => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'image' && block.attachment) out.push(block);
      else if (block.type === 'tool-result') visit(block.content);
    }
  };
  visit(content);
  return out;
}

async function gatherAttachments(ctx, options, limits) {
  const output = [];
  const seen = new Set();
  let total = 0;
  const messages = options.messages || [];
  let latestUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') { latestUserIndex = i; break; }
  }
  const add = (item, bytes) => {
    if (seen.has(item.id)) return;
    if (bytes > limits.single) throw new LlmError(`attachment too large: ${item.name} (${bytes} bytes)`, 'ATTACHMENT_TOO_LARGE');
    if (total + bytes > limits.total) throw new LlmError(`attachment batch exceeds ${limits.total} bytes`, 'ATTACHMENT_BATCH_TOO_LARGE');
    total += bytes;
    seen.add(item.id);
    output.push(item);
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    for (const block of imageBlocks(message?.content)) {
      const ref = block.attachment;
      const id = String(ref.attachmentId || '');
      if (!id || seen.has(id)) continue;
      const stored = await ctx.attachments.readImage(ref, options.signal);
      const bytes = Buffer.from(stored.data);
      const mime = stored.mediaType || ref.mediaType || 'image/png';
      const name = ref.name || `image-${output.length + 1}${imageExt(mime)}`;
      add({ id, name, mime, current: messageIndex === latestUserIndex, data: bytes.toString('base64') }, bytes.byteLength);
    }
  }

  // File blocks are intentionally projected to deterministic handle text before
  // adapters. Recover only the provider-owned read-only path from that text.
  const pathRecords = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    for (const text of contentTexts(message?.content)) {
      for (const path of extractProjectedFilePaths(text)) pathRecords.push({ path, current: messageIndex === latestUserIndex });
    }
  }
  for (const record of pathRecords) {
    const path = record.path;
    const id = makeAttachmentIdForPath(path);
    if (seen.has(id)) continue;
    let info;
    try { info = await stat(path); } catch { continue; }
    if (!info.isFile()) continue;
    const name = attachmentNameForPath(path);
    if (info.size > limits.single) throw new LlmError(`attachment too large: ${name} (${info.size} bytes)`, 'ATTACHMENT_TOO_LARGE');
    if (total + info.size > limits.total) throw new LlmError(`attachment batch exceeds ${limits.total} bytes`, 'ATTACHMENT_BATCH_TOO_LARGE');
    const bytes = await readFile(path);
    add({ id, name, mime: mimeFromName(name), current: record.current, data: bytes.toString('base64') }, bytes.byteLength);
  }
  return output;
}

const PROVIDER_HIDDEN_TOOLS = new Set(['web_relay_compat_feedback']);

function providerVisibleTools(tools) {
  return Array.isArray(tools) ? tools.filter(tool => !PROVIDER_HIDDEN_TOOLS.has(String(tool?.name || ''))) : [];
}

function openAiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || {} },
  }));
}

async function* sseJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new LlmError('gateway response has no stream body', 'PROVIDER_PROTOCOL_ERROR');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    signal?.throwIfAborted?.();
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); }
      catch { throw new LlmError('invalid gateway SSE JSON', 'PROVIDER_PROTOCOL_ERROR'); }
    }
  }
}

class WebGatewayAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super();
    this.ctx = ctx;
    this.provider = String(config.provider || 'deepseek-web-v2');
    this.endpoint = String(config.endpoint || 'http://127.0.0.1:1601/v1/chat/completions');
    this.model = String(config.model || 'deepseek-chat');
    this.apiKey = config.apiKey ? String(config.apiKey) : '';
    this.limits = {
      total: Number(config.maxAttachmentBytes || DEFAULT_MAX_ATTACHMENT_BYTES),
      single: Number(config.maxSingleAttachmentBytes || DEFAULT_MAX_SINGLE_ATTACHMENT_BYTES),
    };
  }

  providerInfo(provider) { return { id: provider, name: 'DeepSeek Web Gateway V2' }; }
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: Object.freeze([
        'EMPTY_RESPONSE',
        'RATE_LIMIT',
        'SERVER',
        'TIMEOUT',
        'TRANSPORT',
        'WEB_TOOL_PROTOCOL_MALFORMED',
      ]),
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    });
  }
  listModels(provider) {
    return Promise.resolve([{ provider, id: this.model, name: 'DeepSeek Web (browser)', inputModalities: ['text', 'image'] }]);
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] });
  }

  async *stream(options) {
    const visibleTools = providerVisibleTools(options.tools);
    const prompt = serializeHarnessPrompt({ ...options, tools: visibleTools });
    const attachments = await gatherAttachments(this.ctx, options, this.limits);
    const envelope = encodeRelayEnvelope(prompt, attachments);
    const providerTools = openAiTools(visibleTools);
    const body = {
      model: options.model || this.model,
      stream: true,
      messages: [{ role: 'user', content: envelope }],
      ...(providerTools ? { tools: providerTools } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    };
    const headers = { 'content-type': 'application/json', ...attributionHeaders() };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(this.endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new LlmError(`web gateway HTTP ${response.status}`, 'PROVIDER_HTTP_ERROR', { status: response.status });

    let nextIndex = 0;
    const blocks = new Map();
    const toolByRemote = new Map();
    let usage = null;
    let finishReason = 'stop';

    const ensureText = kind => {
      const key = kind;
      if (blocks.has(key)) return blocks.get(key);
      const state = { index: nextIndex++, kind, text: '' };
      blocks.set(key, state);
      return state;
    };

    for await (const event of sseJson(response, options.signal)) {
      if (event.usage) usage = event.usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : null;
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const state = ensureText('reasoning');
        if (state.text === '') yield { type: 'block-start', index: state.index, blockType: 'reasoning' };
        state.text += delta.reasoning_content;
        yield { type: 'reasoning-delta', index: state.index, text: delta.reasoning_content };
      }
      if (typeof delta.content === 'string' && delta.content) {
        const state = ensureText('text');
        if (state.text === '') yield { type: 'block-start', index: state.index, blockType: 'text' };
        state.text += delta.content;
        yield { type: 'text-delta', index: state.index, text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const remote = Number.isInteger(call.index) ? call.index : 0;
          let state = toolByRemote.get(remote);
          if (!state) {
            state = { index: nextIndex++, id: String(call.id || `call-web-${Date.now()}-${remote}`), name: '', arguments: '' };
            toolByRemote.set(remote, state);
            yield { type: 'block-start', index: state.index, blockType: 'tool-call' };
          }
          if (call.id) state.id = String(call.id);
          if (call.function?.name) state.name = String(call.function.name);
          const args = String(call.function?.arguments || '');
          state.arguments += args;
          yield { type: 'tool-call-delta', index: state.index, id: state.id, ...(state.name ? { name: state.name } : {}), argumentsDelta: args };
        }
      }
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
    }

    const all = [...blocks.values(), ...toolByRemote.values()].sort((a, b) => a.index - b.index);
    for (const state of all) {
      if (state.kind === 'reasoning') yield { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } };
      else if (state.kind === 'text') yield { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } };
      else yield { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.arguments } };
    }
    if (usage) yield { type: 'usage', usage: { inputTokens: Number(usage.prompt_tokens || 0), outputTokens: Number(usage.completion_tokens || 0) } };
    yield { type: 'finish', reason: { kind: finishReason === 'tool_calls' ? 'tool-calls' : finishReason === 'length' ? 'max-tokens' : 'stop' } };
  }
}

const MAX_BUFFER_CHARS = 512 * 1024;
const FEEDBACK_TOOL = 'web_relay_compat_feedback';
const MALFORMED_TOOL_CODE = 'WEB_TOOL_PROTOCOL_MALFORMED';

function isNativeToolChunk(chunk) {
  return chunk?.type === 'tool-call-delta'
    || (chunk?.type === 'block-start' && chunk.blockType === 'tool-call')
    || (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call');
}

function isTextChunk(chunk) {
  return chunk?.type === 'text-delta'
    || (chunk?.type === 'block-start' && chunk.blockType === 'text')
    || (chunk?.type === 'block-end' && chunk.block?.type === 'text');
}

function isSuccessfulStop(chunk) {
  return chunk?.type === 'finish' && chunk?.reason?.kind === 'stop';
}

function maxBlockIndex(chunks) {
  let max = -1;
  for (const chunk of chunks) {
    if (Number.isInteger(chunk?.index)) max = Math.max(max, chunk.index);
  }
  return max;
}

function feedbackCall(skipped) {
  const argumentsJson = JSON.stringify({ skipped });
  let hash = 2166136261;
  for (let i = 0; i < argumentsJson.length; i += 1) {
    hash ^= argumentsJson.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {
    name: FEEDBACK_TOOL,
    id: 'web_feedback_' + (hash >>> 0).toString(16),
    arguments: argumentsJson,
  };
}

function skippedProse(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return '';
  const detail = skipped.map(item => String(item.name || 'unknown') + ': ' + String(item.reason || 'unknown')).join('; ');
  return '[Web Gateway compatibility] Skipped ' + skipped.length + ' invalid/unavailable tool call(s): ' + detail + '. Continue with the calls that did execute.';
}

function rebuildNativeStream(parsed, buffered, allowedNames) {
  const out = [];
  const usage = [];
  for (const chunk of buffered) {
    if (chunk?.type === 'finish') continue;
    if (chunk?.type === 'usage') { usage.push(chunk); continue; }
    if (isTextChunk(chunk)) continue;
    if (isNativeToolChunk(chunk)) continue;
    out.push(chunk);
  }

  let index = maxBlockIndex(out) + 1;
  const proseParts = [];
  if (typeof parsed.prose === 'string' && parsed.prose.trim()) proseParts.push(parsed.prose.trim());

  const executable = [...parsed.calls];
  if (Array.isArray(parsed.skipped) && parsed.skipped.length > 0) {
    if (allowedNames.has(FEEDBACK_TOOL)) executable.push(feedbackCall(parsed.skipped));
    else proseParts.push(skippedProse(parsed.skipped));
  }

  const prose = proseParts.filter(Boolean).join('\n\n');
  if (prose) {
    out.push({ type: 'block-start', index, blockType: 'text' });
    out.push({ type: 'text-delta', index, text: prose });
    out.push({ type: 'block-end', index, block: { type: 'text', text: prose } });
    index += 1;
  }

  for (const call of executable) {
    out.push({ type: 'block-start', index, blockType: 'tool-call' });
    out.push({ type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments });
    out.push({ type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } });
    index += 1;
  }

  out.push(...usage);
  out.push({ type: 'finish', reason: { kind: 'tool-calls' } });
  return out;
}

function malformedFinish(reason) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: MALFORMED_TOOL_CODE,
        message: 'DeepSeek Web Gateway returned malformed tool-call protocol: ' + String(reason || 'unknown'),
      },
    },
  };
}

async function* compatStream(ctx, options, next) {
  const buffered = [];
  let text = '';
  let state = 'candidate';
  let finish = null;
  let passthrough = false;

  const downstream = next();
  for await (const chunk of downstream) {
    if (passthrough) { yield chunk; continue; }

    buffered.push(chunk);

    // Native provider tool calls are already canonical. Do not second-guess them.
    if (isNativeToolChunk(chunk)) {
      for (const held of buffered) yield held;
      buffered.length = 0;
      passthrough = true;
      continue;
    }

    // Reasoning chunks are intentionally retained while we wait for the first
    // visible text. DeepSeek may reason before emitting textual tool protocol.
    if (chunk?.type === 'text-delta' && state !== 'miss') {
      text += String(chunk.text || '');
      state = text.length > MAX_BUFFER_CHARS ? 'miss' : protocolPrefixState(text);
    }

    if (chunk?.type === 'finish') finish = chunk;

    if (state === 'miss') {
      for (const held of buffered) yield held;
      buffered.length = 0;
      passthrough = true;
    }
  }

  if (passthrough) return;
  if (!isSuccessfulStop(finish) || state !== 'match') {
    for (const held of buffered) yield held;
    return;
  }

  const allowedNames = visibleToolNameSet(options);
  const parsed = parseRelayToolCalls(text, allowedNames);
  if (!parsed.ok) {
    if (parsed.protocol) {
      // Do not turn a malformed envelope into a fake internal tool call. A
      // bounded provider retry re-runs this same Agent step without persisting
      // the failed partial output.
      yield malformedFinish(parsed.reason);
      return;
    }
    for (const held of buffered) yield held;
    return;
  }

  if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
    yield malformedFinish('no executable calls');
    return;
  }

  for (const chunk of rebuildNativeStream(parsed, buffered, allowedNames)) yield chunk;
}

export function apply(ctx, config = {}) {
  const adapter = new WebGatewayAdapter(ctx, config);
  ctx.llm.registerAdapter([adapter.provider], adapter);
  ctx.on('llm/stream', (options, next) => compatStream(ctx, options, next), { global: true, prepend: true });
}
