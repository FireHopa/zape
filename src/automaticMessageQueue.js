'use strict';

const crypto = require('crypto');
const { PersistentJobQueue, QueueError } = require('./persistentJobQueue');

function isoNow() { return new Date().toISOString(); }
function cleanDigits(value) { return String(value || '').replace(/\D+/g, '').replace(/^0+/, ''); }
function cleanText(value) { return String(value || '').trim(); }
function shortError(error) { return String(error?.message || error || 'Falha desconhecida').slice(0, 800); }

function classifyAutomaticMessageError(error) {
  const message = shortError(error);
  const code = String(error?.code || '').trim();
  const status = Number(error?.statusCode || error?.status || 0);

  if (/not on whatsapp|unregistered|does not exist/i.test(message)) {
    return { retryable: false, code: 'NUMBER_NOT_REGISTERED', message };
  }
  if (/texto da mensagem vazio|toDigits vazio|número inválido|telefone inválido/i.test(message)) {
    return { retryable: false, code: code || 'MESSAGE_INVALID', message };
  }
  if (/WA_ACCOUNT_ALREADY_REGISTERED|conta já possui autenticação salva/i.test(`${code} ${message}`)) {
    return { retryable: false, code: 'WA_ACCOUNT_ALREADY_REGISTERED', message };
  }
  if (/auth_failure|novo QR Code foi bloqueado|remova a autenticação antiga|requiresCleanup/i.test(message)) {
    return { retryable: false, code: code || 'WA_AUTH_REQUIRES_ACTION', message };
  }
  if (/WEBJS_ENABLED!=1|Chrome\/Chromium não encontrado/i.test(message)) {
    return { retryable: false, code: code || 'WA_NOT_CONFIGURED', message };
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { retryable: false, code: code || `HTTP_${status}`, message };
  }
  if (/wa_ready_timeout|READY timeout|disconnected|Target closed|Session closed|Protocol error|Execution context was destroyed|Navigation failed|Page crashed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message)) {
    return { retryable: true, code: code || 'WA_TRANSIENT_SESSION_ERROR', message };
  }
  return { retryable: true, code: code || 'WA_SEND_TEMPORARY_ERROR', message };
}

function createAutomaticMessageQueue({
  file,
  sendMessage,
  getTenantWhatsApp,
  logger = console,
  pollIntervalMs = 500,
  maxAttempts = 5,
  baseDelayMs = 30000,
  maxDelayMs = 600000,
  readyTimeoutMs = 60000,
} = {}) {
  if (typeof sendMessage !== 'function') throw new Error('sendMessage obrigatório.');

  const queue = new PersistentJobQueue({
    file,
    pollIntervalMs,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    handler: async (job) => {
      const payload = job.payload || {};
      const toDigits = cleanDigits(payload.toDigits);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const cursor = Math.max(0, Number(job.cursor || 0));
      const item = messages[cursor] || null;
      const text = cleanText(item?.text);

      if (!toDigits || !messages.length) {
        return {
          fatal: true,
          error: { code: 'AUTOMATIC_MESSAGE_INVALID', message: 'Telefone ou mensagens automáticas estão vazios.' },
          patch: { delivery: { status: 'dead_letter', failedAt: isoNow() } },
        };
      }
      if (!item) {
        return { done: true, patch: { progress: { ...job.progress, pending: 0 }, delivery: { status: 'sent', sentAt: isoNow() } } };
      }
      if (!text) {
        return {
          fatal: true,
          error: { code: 'AUTOMATIC_MESSAGE_INVALID', message: `Mensagem automática ${cursor + 1} está vazia.` },
          patch: { delivery: { status: 'dead_letter', failedAt: isoNow(), messageIndex: cursor } },
        };
      }

      try {
        const sent = await sendMessage(job.tenantId, {
          toDigits,
          nome: cleanText(payload.nome),
          text,
          waitReadyMs: Number(payload.waitReadyMs || readyTimeoutMs),
        });
        const messageId = String(sent?.id?._serialized || sent?.id?.id || '').trim() || null;
        const processed = Number(job.progress.processed || 0) + 1;
        const nextCursor = cursor + 1;
        const done = nextCursor >= messages.length;
        const deliveries = [
          ...(Array.isArray(job.deliveries) ? job.deliveries : []),
          { messageIndex: cursor, status: 'sent', sentAt: isoNow(), messageId },
        ].slice(-50);
        logger.log?.(`[AUTO_MESSAGE][${job.tenantId}] enviada`, {
          jobId: job.id,
          sourceType: payload.source?.type || 'automatic',
          leadId: payload.source?.leadId || null,
          messageIndex: cursor,
          messageId,
        });
        return {
          done,
          patch: {
            cursor: nextCursor,
            deliveries,
            progress: {
              ...job.progress,
              total: messages.length,
              processed,
              sent: Number(job.progress.sent || 0) + 1,
              pending: Math.max(0, messages.length - processed),
            },
            delivery: done
              ? { status: 'sent', sentAt: isoNow(), messageCount: messages.length, lastMessageId: messageId }
              : { status: 'sending', lastSentAt: isoNow(), messageIndex: cursor },
          },
        };
      } catch (error) {
        const info = classifyAutomaticMessageError(error);
        if (info.retryable && typeof getTenantWhatsApp === 'function') {
          try {
            const wa = getTenantWhatsApp(job.tenantId);
            await wa?.recoverAfterSendFailure?.(error);
          } catch (recoveryError) {
            logger.error?.(`[AUTO_MESSAGE][${job.tenantId}] falha ao reconstruir cliente`, shortError(recoveryError));
          }
        }
        logger.error?.(`[AUTO_MESSAGE][${job.tenantId}] falha`, {
          jobId: job.id,
          code: info.code,
          retryable: info.retryable,
          messageIndex: cursor,
          attempt: Number(job.itemAttempts?.[String(cursor)] || 0) + 1,
          error: info.message,
        });
        const failedDelivery = {
          status: 'dead_letter',
          failedAt: isoNow(),
          messageIndex: cursor,
          errorCode: info.code,
          error: info.message,
        };
        if (!info.retryable) {
          return {
            fatal: true,
            error: { code: info.code, message: info.message },
            patch: {
              progress: {
                ...job.progress,
                total: messages.length,
                processed: Number(job.progress.processed || 0) + 1,
                failed: Number(job.progress.failed || 0) + 1,
                pending: Math.max(0, messages.length - Number(job.progress.processed || 0) - 1),
              },
              delivery: failedDelivery,
            },
          };
        }
        return {
          retryable: true,
          itemKey: String(cursor),
          fatalOnExhausted: true,
          deadLetterOnExhausted: true,
          error: { code: info.code, message: info.message },
          onExhaustedPatch: { delivery: failedDelivery },
          patch: {
            delivery: {
              status: 'retrying',
              lastFailedAt: isoNow(),
              messageIndex: cursor,
              errorCode: info.code,
              error: info.message,
            },
          },
        };
      }
    },
  });

  function enqueueBatch({ tenantId, toDigits, nome, messages, source, idempotencyPrefix, waitReadyMs: perMessageReadyTimeout } = {}) {
    const tenant = String(tenantId || '').trim().toLowerCase();
    const digits = cleanDigits(toDigits);
    const items = (Array.isArray(messages) ? messages : [messages])
      .map(cleanText)
      .filter(Boolean)
      .slice(0, 20)
      .map((text, messageIndex) => ({ text, messageIndex }));
    const key = cleanText(idempotencyPrefix) || `automatic:${crypto.randomUUID()}`;
    if (!tenant || !digits || !items.length || !key) {
      throw new QueueError('AUTOMATIC_MESSAGE_INVALID', 'tenantId, telefone, mensagem e idempotencyKey são obrigatórios.');
    }
    const result = queue.enqueue({
      tenantId: tenant,
      type: 'automatic_whatsapp_message',
      idempotencyKey: key,
      progress: { total: items.length },
      payload: {
        toDigits: digits,
        nome: cleanText(nome),
        messages: items,
        waitReadyMs: Number(perMessageReadyTimeout || readyTimeoutMs),
        source: source && typeof source === 'object' ? source : {},
        queuedAt: isoNow(),
      },
    });
    return {
      configured: items.length,
      queued: result.created ? items.length : 0,
      existing: result.created ? 0 : items.length,
      jobs: [{ id: result.job.id, state: result.job.state, created: result.created }],
      job: result.job,
      created: result.created,
    };
  }

  function enqueueMessage({ tenantId, toDigits, nome, text, source, idempotencyKey, waitReadyMs: perMessageReadyTimeout } = {}) {
    return enqueueBatch({
      tenantId,
      toDigits,
      nome,
      messages: [text],
      source,
      idempotencyPrefix: idempotencyKey,
      waitReadyMs: perMessageReadyTimeout,
    });
  }

  return {
    queue,
    start: () => queue.start(),
    stop: () => queue.stop(),
    stats: (tenantId) => queue.stats(tenantId),
    list: (tenantId, limit) => queue.list(tenantId, limit),
    enqueueMessage,
    enqueueBatch,
  };
}

module.exports = {
  classifyAutomaticMessageError,
  createAutomaticMessageQueue,
};
