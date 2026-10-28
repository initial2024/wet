import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const ENVELOPE_PREFIX = '<<<DSH_WEB_RELAY_V2_ATTACHMENT_ENVELOPE>>>';
export const ENVELOPE_SUFFIX = '<<<END_DSH_WEB_RELAY_V2_ATTACHMENT_ENVELOPE>>>';
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_SINGLE_ATTACHMENT_BYTES = 16 * 1024 * 1024;

const FILE_PATH_RE = /["“]((?:\/|[A-Za-z]:[\\/])[^"”\r\n]*?[\\/]attachments[\\/][^"”\r\n]+)["”]/g;

export function mimeFromName(name = '') {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json') || lower.endsWith('.xml')) return 'text/plain';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

export function extractProjectedFilePaths(text) {
  const output = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(FILE_PATH_RE)) {
    const path = match[1];
    if (!path || seen.has(path)) continue;
    seen.add(path);
    output.push(path);
  }
  return output;
}

function flattenNestedContent(content, callNames) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') out.push(String(block.text || ''));
    else if (block.type === 'reasoning') out.push(`[思考记录]\n${String(block.text || block.reasoning || '')}`);
    else if (block.type === 'image') {
      const ref = block.attachment || {};
      out.push(`[图片附件: ${ref.name || String(ref.attachmentId || 'image')}]`);
    } else if (block.type === 'file') {
      const ref = block.attachment || {};
      out.push(`[文件附件: ${ref.name || String(ref.attachmentId || 'file')}]`);
    } else if (block.type === 'tool-call') {
      // Tool calls are already represented structurally by DSH and their
      // results are serialized below. Keep only the id→name mapping here.
      // Re-emitting a textual call transcript primes Web models to imitate
      // legacy/DSML markup on the next turn.
      callNames.set(String(block.id || ''), String(block.name || ''));
    } else if (block.type === 'tool-result') {
      out.push(flattenNestedContent(block.content, callNames));
    }
  }
  return out.filter(Boolean).join('\n');
}

export function serializeHarnessPrompt(options) {
  const callNames = new Map();
  for (const message of options.messages || []) {
    for (const block of message?.content || []) {
      if (block?.type === 'tool-call') callNames.set(String(block.id || ''), String(block.name || ''));
    }
  }

  const sections = [];
  if (typeof options.system === 'string' && options.system) sections.push(`[系统]\n${options.system}`);

  if (Array.isArray(options.tools) && options.tools.length) {
    const tools = options.tools.map(tool => {
      const schema = JSON.stringify(tool.parameters || {});
      return `- ${tool.name}: ${tool.description || ''}\n  参数JSON Schema: ${schema}`;
    }).join('\n');
    sections.push(
      `[工具调用约束]\n可用工具如下：\n${tools}\n\n`
      + '这些工具已经通过 Provider 的原生 tool/function 接口提供。'
      + '需要调用工具时，必须使用 Provider 原生 tool call；不要把工具调用编码进普通助手正文，'
      + '也不要输出任何文本化、XML 风格或自定义标记形式的工具协议。\n'
      + '工具失败只是一次普通工具结果；根据该结果继续使用其他可用工具或给出最终回答，'
      + '不得因为单个工具失败伪造新的协议标记。\n'
      + '不要伪造“工具返回”。'
    );
  }

  for (const message of options.messages || []) {
    const source = message?.source || {};
    if (source.kind === 'tool') {
      const block = Array.isArray(message.content) ? message.content.find(item => item?.type === 'tool-result') : null;
      const callId = String(source.callId || block?.toolCallId || '');
      const name = callNames.get(callId) || 'unknown';
      const body = flattenNestedContent(block?.content || message.content || [], callNames);
      sections.push(`工具返回（name=${name}, id=${callId}）：\n${body || '(no output)'}`);
      continue;
    }
    const body = flattenNestedContent(message?.content || [], callNames);
    if (!body) continue;
    if (message.role === 'system') sections.push(`[系统]\n${body}`);
    else if (message.role === 'developer') sections.push(`[开发者]\n${body}`);
    else if (message.role === 'assistant') sections.push(`助手：${body}`);
    else sections.push(`用户：${body}`);
  }
  return sections.join('\n\n');
}

export function makeAttachmentIdForPath(path) {
  return `file:${createHash('sha256').update(String(path)).digest('hex')}`;
}

export function attachmentNameForPath(path) {
  return basename(String(path).replaceAll('\\', '/')) || 'attachment.bin';
}

export function encodeRelayEnvelope(prompt, attachments) {
  const payload = { v: 2, prompt: String(prompt || ''), attachments };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `${ENVELOPE_PREFIX}${encoded}${ENVELOPE_SUFFIX}`;
}

export function decodeRelayEnvelope(text) {
  const value = String(text || '');
  const start = value.indexOf(ENVELOPE_PREFIX);
  const end = value.indexOf(ENVELOPE_SUFFIX, start + ENVELOPE_PREFIX.length);
  if (start < 0 || end < 0) throw new Error('invalid envelope');
  const encoded = value.slice(start + ENVELOPE_PREFIX.length, end).trim();
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}
