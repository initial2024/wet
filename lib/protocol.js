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


function truncateMiddle(value, maxChars) {
  const text = String(value || '').trim();
  if (!maxChars || text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor(maxChars * 0.68));
  const tail = Math.max(0, maxChars - head - 44);
  return `${text.slice(0, head)}\n...[自动续接压缩了较早内容]...\n${text.slice(text.length - tail)}`;
}

export function serializeHarnessRolloverPrompt(options, {
  maxChars = 30000,
  systemMaxChars = 8000,
  recentMessages = 10,
} = {}) {
  const callNames = new Map();
  for (const message of options.messages || []) {
    for (const block of message?.content || []) {
      if (block?.type === 'tool-call') {
        callNames.set(String(block.id || ''), String(block.name || ''));
      }
    }
  }

  const sections = [
    '[OmniGate 自动续接交接]\n上一网页对话已经出现明确的上下文/对话上限提示。现在是在同一任务的新网页对话。\n直接继续未完成工作，不要要求用户重复信息，不要从头重做已经完成的步骤；若交接内容与最后用户指令冲突，以最后用户指令为准。',
  ];

  const fixed = [];
  if (typeof options.system === 'string' && options.system) {
    fixed.push(`[系统]\n${truncateMiddle(options.system, systemMaxChars)}`);
  }
  for (const message of options.messages || []) {
    if (message?.role !== 'system' && message?.role !== 'developer') continue;
    const body = flattenNestedContent(message?.content || [], callNames);
    if (!body) continue;
    fixed.push(`[${message.role === 'system' ? '系统' : '开发者'}]\n${truncateMiddle(body, 3000)}`);
  }
  if (fixed.length) sections.push(`[仍然有效的约束]\n${fixed.join('\n\n')}`);

  if (Array.isArray(options.tools) && options.tools.length) {
    const tools = options.tools
      .map(tool => `- ${tool.name}: ${tool.description || ''}`)
      .join('\n');
    sections.push(
      `[工具连续性]\n可用工具名称保持不变：\n${truncateMiddle(tools, 5000)}\n`
      + '继续使用 Provider 原生 tool/function call；不要把工具协议伪造成普通正文，也不要伪造工具返回。'
    );
  }

  const messages = options.messages || [];
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && messages[i]?.source?.kind !== 'tool') {
      lastUserIndex = i;
      break;
    }
  }

  const start = Math.max(0, messages.length - recentMessages);
  const recent = [];
  for (let i = start; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role === 'system' || message.role === 'developer') continue;
    const source = message?.source || {};

    if (source.kind === 'tool') {
      const block = Array.isArray(message.content)
        ? message.content.find(item => item?.type === 'tool-result')
        : null;
      const callId = String(source.callId || block?.toolCallId || '');
      const name = callNames.get(callId) || 'unknown';
      const body = flattenNestedContent(block?.content || message.content || [], callNames);
      recent.push(
        `工具返回（name=${name}, id=${callId}）：\n${truncateMiddle(body || '(no output)', 2200)}`
      );
      continue;
    }

    const body = flattenNestedContent(message?.content || [], callNames);
    if (!body) continue;
    const limit = i === lastUserIndex ? 5000 : 2400;
    const role = message.role === 'assistant' ? '助手' : '用户';
    recent.push(`${role}：${truncateMiddle(body, limit)}`);
  }
  if (recent.length) sections.push(`[最近关键上下文]\n${recent.join('\n\n')}`);

  sections.push(
    '[继续执行规则]\n'
    + '1. 直接继续当前未完成任务。\n'
    + '2. 不重复已经完成的回答/步骤。\n'
    + '3. 当前轮附件会由宿主重新上传；历史附件只按名称/语义引用。\n'
    + '4. 不因为短暂停顿、网络抖动或暂时没有新 token 而宣称任务结束。'
  );

  return truncateMiddle(sections.join('\n\n'), maxChars);
}

export function makeAttachmentIdForPath(path) {
  return `file:${createHash('sha256').update(String(path)).digest('hex')}`;
}

export function attachmentNameForPath(path) {
  return basename(String(path).replaceAll('\\', '/')) || 'attachment.bin';
}

export function encodeRelayEnvelope(prompt, attachments, rolloverPrompt = '') {
  const payload = {
    v: 2,
    prompt: String(prompt || ''),
    rolloverPrompt: String(rolloverPrompt || prompt || ''),
    attachments,
  };
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
