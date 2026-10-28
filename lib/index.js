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
  serializeHarnessRolloverPrompt,
} from './protocol.js';
import { parseRelayToolCalls, protocolPrefixState, visibleToolNameSet } from './parser.js';
import {
  authValueForEndpoint,
  chooseEndpoint,
  drainReader,
  endpointCandidates,
  explicitUserCancellation,
  modelCatalog,
} from './transport.js';

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

async function* sseJson(response, transport) {
  const reader = response.body?.getReader();
  if (!reader) throw new LlmError('gateway response has no stream body', 'PROVIDER_PROTOCOL_ERROR');
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
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
  } finally {
    if (completed || transport.controller.signal.aborted) {
      try { reader.releaseLock(); } catch {}
      transport.cleanup();
    } else {
      // DSH may stop consuming because the UI changed, a client transport was
      // replaced, or a generic AbortSignal fired. Do not immediately close the
      // local Gateway socket: the original AI Gateway treats disconnect as a
      // reason to stop the webpage generation. Drain the response in the
      // background instead so an active answer can finish normally.
      transport.detached = true;
      void drainReader(reader, transport.controller, transport.detachedDrainMs)
        .finally(() => transport.cleanup());
    }
  }
}


function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function firstCount(...values) {
  for (const value of values) {
    const count = safeCount(value);
    if (count !== undefined) return count;
  }
  return undefined;
}

function normalizeProviderUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;

  const promptTotal = firstCount(
    raw.prompt_tokens,
    raw.input_tokens,
    raw.inputTokens,
    raw.promptTokens,
    raw.input,
  );
  const outputTokens = firstCount(
    raw.completion_tokens,
    raw.output_tokens,
    raw.outputTokens,
    raw.completionTokens,
    raw.output,
  );

  if (promptTotal === undefined || outputTokens === undefined) return undefined;

  const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
    ? raw.prompt_tokens_details
    : raw.input_tokens_details && typeof raw.input_tokens_details === 'object'
      ? raw.input_tokens_details
      : {};

  const cacheReadTokens = firstCount(
    raw.cache_read_input_tokens,
    raw.cacheReadTokens,
    raw.cached_tokens,
    details.cached_tokens,
    details.cache_read_tokens,
  );
  const cacheWriteTokens = firstCount(
    raw.cache_creation_input_tokens,
    raw.cacheWriteTokens,
    details.cache_creation_tokens,
    details.cache_write_tokens,
  );

  // OpenAI/DeepSeek-style prompt_tokens normally includes cached prompt tokens.
  // DSH requires inputTokens to be the uncached bucket when cache buckets are
  // reported separately.
  const separatedCache = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const inputTokens = Math.max(0, promptTotal - separatedCache);

  const providerTotal = firstCount(
    raw.total_tokens,
    raw.totalTokens,
    raw.total,
  );
  const computedTotal = promptTotal + outputTokens;
  const totalTokens = providerTotal !== undefined && providerTotal >= computedTotal
    ? providerTotal
    : computedTotal;

  const completionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object'
    ? raw.completion_tokens_details
    : raw.output_tokens_details && typeof raw.output_tokens_details === 'object'
      ? raw.output_tokens_details
      : {};
  const reasoningTokens = firstCount(
    raw.reasoning_tokens,
    raw.reasoningTokens,
    completionDetails.reasoning_tokens,
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined || reasoningTokens > outputTokens ? {} : { reasoningTokens }),
  };
}

function roughTokenEstimate(text) {
  const value = String(text || '');
  if (!value) return 0;
  // Match DSH token-meter's fixed-density fallback: 4 UTF-16 characters
  // per token. This is deterministic and intentionally not presented as
  // provider billing usage.
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalizedUsageTotal(usage) {
  try {
    const normalized = normalizeProviderUsage(usage);
    return normalized ? normalized.totalTokens : 0;
  } catch {
    return 0;
  }
}

function fallbackInputText(options) {
  const parts = [];
  const append = value => {
    if (typeof value === 'string' && value) parts.push(value);
  };
  const visitContent = content => {
    if (typeof content === 'string') { append(content); return; }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      append(block.text);
      append(block.reasoning);
      if (block.type === 'tool-call') {
        append(block.name);
        append(block.arguments);
      }
      if (block.type === 'tool-result') visitContent(block.content);
    }
  };
  try {
    append(options?.system);
    if (Array.isArray(options?.messages)) {
      for (const message of options.messages) visitContent(message?.content);
    }
  } catch {
    // Usage estimation must never be allowed to break a model call.
  }
  return parts.join('\n');
}

async function* usageFallbackStream(options, next) {
  const inputText = fallbackInputText(options);
  let visibleOutputText = '';
  let sawPositiveUsage = false;

  for await (const chunk of next()) {
    let syntheticUsage = null;
    try {
      if (chunk?.type === 'usage' && normalizedUsageTotal(chunk.usage) > 0) {
        sawPositiveUsage = true;
      }

      if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
        visibleOutputText += String(chunk.text || '');
      } else if (chunk?.type === 'tool-call-delta') {
        if (chunk.name) visibleOutputText += String(chunk.name);
        visibleOutputText += String(chunk.argumentsDelta || '');
      }

      if (chunk?.type === 'finish' && !sawPositiveUsage) {
        const kind = chunk?.reason?.kind ?? chunk?.reason;
        const terminalFailure = kind === 'error' || kind === 'aborted' || kind === 'cancelled';
        if (!terminalFailure) {
          const inputTokens = roughTokenEstimate(inputText);
          const outputTokens = roughTokenEstimate(visibleOutputText);
          if (inputTokens + outputTokens > 0) {
            syntheticUsage = {
              type: 'usage',
              usage: {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
              },
            };
            sawPositiveUsage = true;
          }
        }
      }
    } catch {
      // Fail open: accounting must never take the LLM gateway down.
    }

    if (syntheticUsage) yield syntheticUsage;
    yield chunk;
  }
}

class WebGatewayAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super();
    this.ctx = ctx;
    this.provider = String(config.provider || 'deepseek-web-v2');
    this.model = String(config.model || 'deepseek-chat');
    this.apiKey = config.apiKey ? String(config.apiKey) : '';
    this.endpoints = endpointCandidates(config);
    this.selectedEndpoint = '';
    this.selectedEndpointAt = 0;
    this.endpointCacheMs = Number(config.endpointCacheMs || 30_000);
    this.endpointProbeTimeoutMs = Number(config.endpointProbeTimeoutMs || 900);
    this.hardRequestTimeoutMs = Number(config.hardRequestTimeoutMs || 3_660_000);
    this.detachedDrainMs = Number(config.detachedDrainMs || 3_660_000);
    this.models = modelCatalog(config);
    this.limits = {
      total: Number(config.maxAttachmentBytes || DEFAULT_MAX_ATTACHMENT_BYTES),
      single: Number(config.maxSingleAttachmentBytes || DEFAULT_MAX_SINGLE_ATTACHMENT_BYTES),
    };
  }

  providerInfo(provider) { return { id: provider, name: 'AI Gateway Web Bridge' }; }
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
    return Promise.resolve(this.models.map(model => ({ provider, ...model })));
  }
  resolveModel(provider, model) {
    const id = String(model || this.model);
    const found = this.models.find(item => item.id === id);
    return Promise.resolve(found
      ? { provider, ...found }
      : { provider, id, name: id, inputModalities: ['text', 'image'] });
  }

  async resolveEndpoint() {
    const now = Date.now();
    if (this.selectedEndpoint && now - this.selectedEndpointAt < this.endpointCacheMs) {
      return this.selectedEndpoint;
    }
    const endpoint = await chooseEndpoint(
      fetch,
      this.endpoints,
      this.selectedEndpoint,
      this.endpointProbeTimeoutMs,
    );
    if (!endpoint) {
      throw new LlmError(
        'no local AI Gateway detected on 127.0.0.1:1601 or 127.0.0.1:8787',
        'TRANSPORT',
      );
    }
    this.selectedEndpoint = endpoint;
    this.selectedEndpointAt = now;
    return endpoint;
  }

  createProtectedTransport(options) {
    const controller = new AbortController();
    let cleaned = false;
    const hardTimer = setTimeout(() => {
      try { controller.abort(new Error('gateway_hard_timeout')); } catch {}
    }, this.hardRequestTimeoutMs);

    const onCallerAbort = () => {
      // Only a clearly identified user stop is allowed to tear down a live
      // webpage generation. Generic abort/disconnect events are intentionally
      // ignored here and handled by detached draining instead.
      if (explicitUserCancellation(options.signal)) {
        try { controller.abort(options.signal?.reason || new Error('user_cancelled')); } catch {}
      }
    };
    options.signal?.addEventListener?.('abort', onCallerAbort, { once: true });

    return {
      controller,
      detached: false,
      detachedDrainMs: this.detachedDrainMs,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(hardTimer);
        options.signal?.removeEventListener?.('abort', onCallerAbort);
      },
    };
  }

  async *stream(options) {
    const visibleTools = providerVisibleTools(options.tools);
    const prompt = serializeHarnessPrompt({ ...options, tools: visibleTools });
    const rolloverPrompt = serializeHarnessRolloverPrompt({ ...options, tools: visibleTools });
    const attachments = await gatherAttachments(this.ctx, options, this.limits);
    const envelope = encodeRelayEnvelope(prompt, attachments, rolloverPrompt);
    const providerTools = openAiTools(visibleTools);
    const body = {
      model: options.model || this.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: envelope }],
      ...(providerTools ? { tools: providerTools } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    };
    const endpoint = await this.resolveEndpoint();
    const headers = { 'content-type': 'application/json', ...attributionHeaders() };
    const auth = authValueForEndpoint(endpoint, this.apiKey);
    if (auth) headers.authorization = auth;

    const transport = this.createProtectedTransport(options);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: transport.controller.signal,
      });
    } catch (error) {
      transport.cleanup();
      this.selectedEndpoint = '';
      this.selectedEndpointAt = 0;
      if (transport.controller.signal.aborted && explicitUserCancellation(options.signal)) {
        throw error;
      }
      throw new LlmError(
        'AI Gateway transport failed: ' + String(error?.message || error),
        'TRANSPORT',
      );
    }

    if (!response.ok) {
      transport.cleanup();
      if (response.status === 404 || response.status === 405) {
        this.selectedEndpoint = '';
        this.selectedEndpointAt = 0;
      }
      throw new LlmError(
        `web gateway HTTP ${response.status}`,
        'PROVIDER_HTTP_ERROR',
        { status: response.status, endpoint },
      );
    }

    let nextIndex = 0;
    const blocks = new Map();
    const toolByRemote = new Map();
    let usage = null;
    let finishReason = 'stop';
    let visibleOutputText = '';

    const ensureText = kind => {
      const key = kind;
      if (blocks.has(key)) return blocks.get(key);
      const state = { index: nextIndex++, kind, text: '' };
      blocks.set(key, state);
      return state;
    };

    try {
      for await (const event of sseJson(response, transport)) {
      if (event.usage) usage = event.usage;
      else if (event.data?.usage) usage = event.data.usage;
      else if (event.meta?.usage) usage = event.meta.usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : null;
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const state = ensureText('reasoning');
        if (state.text === '') yield { type: 'block-start', index: state.index, blockType: 'reasoning' };
        state.text += delta.reasoning_content;
        visibleOutputText += delta.reasoning_content;
        yield { type: 'reasoning-delta', index: state.index, text: delta.reasoning_content };
      }
      if (typeof delta.content === 'string' && delta.content) {
        const state = ensureText('text');
        if (state.text === '') yield { type: 'block-start', index: state.index, blockType: 'text' };
        state.text += delta.content;
        visibleOutputText += delta.content;
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
          if (call.function?.name) visibleOutputText += String(call.function.name);
          visibleOutputText += args;
          yield { type: 'tool-call-delta', index: state.index, id: state.id, ...(state.name ? { name: state.name } : {}), argumentsDelta: args };
        }
      }
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
      }
    } finally {
      if (!transport.detached) transport.cleanup();
    }

    const all = [...blocks.values(), ...toolByRemote.values()].sort((a, b) => a.index - b.index);
    for (const state of all) {
      if (state.kind === 'reasoning') yield { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } };
      else if (state.kind === 'text') yield { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } };
      else yield { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.arguments } };
    }
    const normalizedUsage = normalizeProviderUsage(usage);
    if (normalizedUsage && normalizedUsage.totalTokens > 0) {
      yield { type: 'usage', usage: normalizedUsage };
    } else {
      // Web/LAN relays may omit usage or return an all-zero placeholder.
      // Use the same deterministic density heuristic as DSH token-meter so
      // the native UI does not misleadingly show 0 for a non-empty request.
      const inputTokens = roughTokenEstimate(prompt);
      const outputTokens = roughTokenEstimate(visibleOutputText);
      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
    }
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
  const providers = [...new Set([
    adapter.provider,
    'deepseek-web-v2',
    'original-web-gateway',
  ])];
  ctx.llm.registerAdapter(providers, adapter);
  ctx.on('llm/stream', (options, next) => usageFallbackStream(options, () => compatStream(ctx, options, next)), { global: true, prepend: true });
}
