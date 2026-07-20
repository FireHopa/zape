'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JOB_STATES = Object.freeze([
  'draft', 'queued', 'running', 'paused', 'completed',
  'completed_with_errors', 'failed', 'canceled',
]);

function isoNow() { return new Date().toISOString(); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
}
function payloadHash(payload) { return hash(JSON.stringify(stable(payload))); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }

class QueueError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

class PersistentJobQueue {
  constructor({ file, handler, pollIntervalMs = 250, maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 60000 } = {}) {
    if (!file) throw new Error('Queue file obrigatório.');
    if (typeof handler !== 'function') throw new Error('Queue handler obrigatório.');
    this.file = path.resolve(file);
    this.handler = handler;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 250);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
    this.baseDelayMs = Math.max(50, Number(baseDelayMs) || 1000);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 60000);
    this.timer = null;
    this.processing = false;
    this.stopped = true;
  }

  empty() { return { version: 1, jobs: [], deadLetters: [] }; }
  ensureDir() { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); }
  read() {
    this.ensureDir();
    if (!fs.existsSync(this.file)) return this.empty();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        version: 1,
        jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
        deadLetters: Array.isArray(raw.deadLetters) ? raw.deadLetters : [],
      };
    } catch (cause) {
      const error = new QueueError('JOB_QUEUE_CORRUPTED', 'Fila persistente indisponível ou corrompida.', 503);
      error.cause = cause;
      throw error;
    }
  }
  write(store) {
    this.ensureDir();
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  enqueue({ tenantId, type, payload, idempotencyKey, progress } = {}) {
    const tenant = String(tenantId || '').trim().toLowerCase();
    const key = String(idempotencyKey || '').trim();
    if (!tenant || !type || !key) throw new QueueError('JOB_INVALID', 'tenantId, type e idempotencyKey são obrigatórios.');
    const store = this.read();
    const keyHash = hash(`${tenant}:${type}:${key}`);
    const bodyHash = payloadHash(payload || {});
    const existing = store.jobs.find((job) => job.idempotencyKeyHash === keyHash);
    if (existing) {
      if (existing.payloadHash !== bodyHash) throw new QueueError('IDEMPOTENCY_CONFLICT', 'A chave de idempotência já foi usada com outro payload.', 409);
      return { job: existing, created: false };
    }
    const now = isoNow();
    const total = Number(progress?.total ?? payload?.contacts?.length ?? 0);
    const job = {
      id: id('job'), tenantId: tenant, type: String(type), state: 'queued',
      idempotencyKeyHash: keyHash, payloadHash: bodyHash, payload: payload || {},
      attempts: 0, maxAttempts: this.maxAttempts, cursor: 0, nextRunAt: now,
      progress: { total, processed: 0, sent: 0, delivered: 0, read: 0, responded: 0, failed: 0, pending: total },
      itemAttempts: {}, errors: [], createdAt: now, updatedAt: now, startedAt: null, completedAt: null,
    };
    store.jobs.push(job); this.write(store);
    return { job, created: true };
  }

  get(jobId, tenantId) {
    const job = this.read().jobs.find((row) => row.id === String(jobId));
    if (!job || (tenantId && job.tenantId !== String(tenantId).toLowerCase())) return null;
    return job;
  }
  stats(tenantId) {
    const tid = String(tenantId || '').toLowerCase();
    const jobs = this.read().jobs.filter((row) => !tid || row.tenantId === tid);
    const byState = {};
    for (const job of jobs) byState[job.state] = (byState[job.state] || 0) + 1;
    const stalled = jobs.filter((job) => job.state === 'running' && Date.now() - Date.parse(job.updatedAt || job.startedAt || 0) > 300000).length;
    return { total: jobs.length, byState, stalled, workerRunning: !this.stopped, processing: this.processing };
  }
  list(tenantId, limit = 100) {
    const tid = String(tenantId || '').toLowerCase();
    return this.read().jobs.filter((row) => !tid || row.tenantId === tid).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.max(1, Math.min(Number(limit)||100, 500)));
  }
  mutate(jobId, tenantId, fn) {
    const store = this.read();
    const index = store.jobs.findIndex((row) => row.id === String(jobId) && (!tenantId || row.tenantId === String(tenantId).toLowerCase()));
    if (index < 0) return null;
    const next = fn({ ...store.jobs[index], progress: { ...store.jobs[index].progress }, itemAttempts: { ...store.jobs[index].itemAttempts } });
    if (!next) return store.jobs[index];
    next.updatedAt = isoNow(); store.jobs[index] = next; this.write(store); return next;
  }
  pause(jobId, tenantId) { return this.mutate(jobId, tenantId, (job) => ['queued','running'].includes(job.state) ? { ...job, state: 'paused' } : job); }
  resume(jobId, tenantId) { return this.mutate(jobId, tenantId, (job) => job.state === 'paused' ? { ...job, state: 'queued', nextRunAt: isoNow(), inFlight: null } : job); }
  cancel(jobId, tenantId) { return this.mutate(jobId, tenantId, (job) => ['completed','completed_with_errors','failed','canceled'].includes(job.state) ? job : { ...job, state: 'canceled', cancelAfterCursor: Number(job.cursor || 0) + (job.state === 'running' ? 1 : 0), completedAt: isoNow() }); }
  fail(jobId, tenantId, error = {}) {
    const failed = this.mutate(jobId, tenantId, (job) => ({
      ...job, state: 'failed', nextRunAt: null, completedAt: isoNow(),
      errors: [...(job.errors || []).slice(-49), { code: error.code || 'JOB_FAILED', message: error.message || 'Falha ao preparar o job.', at: isoNow(), fatal: true }],
    }));
    if (!failed) return null;
    const store = this.read();
    if (!store.deadLetters.some((row) => row.jobId === failed.id)) {
      store.deadLetters.push({ jobId: failed.id, tenantId: failed.tenantId, type: failed.type, failedAt: isoNow(), errors: failed.errors.slice(-10) });
      this.write(store);
    }
    return failed;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollIntervalMs);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  retryDelay(attempt) { return Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** Math.max(0, attempt - 1))); }

  async tick() {
    if (this.stopped || this.processing) return;
    this.processing = true;
    try {
      const store = this.read();
      const nowMs = Date.now();
      const job = store.jobs.find((row) => row.state === 'running' || (row.state === 'queued' && Date.parse(row.nextRunAt || 0) <= nowMs));
      if (!job) return;
      if (job.state === 'running' && job.inFlight) {
        this.mutate(job.id, job.tenantId, (row) => ({
          ...row, state: 'paused', nextRunAt: null,
          errors: [...(row.errors || []).slice(-49), {
            code: 'DELIVERY_UNCERTAIN_AFTER_RESTART',
            message: 'O processo reiniciou durante um envio. O job foi pausado para evitar disparo duplicado.',
            at: isoNow(), itemKey: String(row.inFlight.cursor),
          }],
        }));
        return;
      }
      const current = this.mutate(job.id, job.tenantId, (row) => ({
        ...row, state: 'running', startedAt: row.startedAt || isoNow(), attempts: row.attempts + 1,
        inFlight: { cursor: Number(row.cursor || 0), startedAt: isoNow(), executionId: id('run') },
      }));
      if (!current || current.state !== 'running') return;
      let result;
      try { result = await this.handler(current); }
      catch (error) { result = { retryable: true, error: { code: error.code || 'WORKER_ERROR', message: error.message || String(error) } }; }
      this.applyResult(current.id, current.tenantId, result || {});
    } finally { this.processing = false; }
  }

  applyResult(jobId, tenantId, result) {
    let exhaustedDeadLetter = null;
    const updated = this.mutate(jobId, tenantId, (job) => {
      const patch = result.patch && typeof result.patch === 'object' ? result.patch : {};
      patch.inFlight = null;
      if (job.state === 'paused' || job.state === 'canceled') {
        return { ...job, ...patch, state: job.state, progress: { ...job.progress, ...(patch.progress || {}) }, nextRunAt: null };
      }
      if (result.fatal) {
        const next = { ...job, ...patch, state: 'failed', completedAt: isoNow(), nextRunAt: null };
        next.errors = [...job.errors.slice(-49), { ...(result.error || { code: 'JOB_FATAL', message: 'Falha fatal do worker.' }), at: isoNow(), fatal: true }];
        return next;
      }
      const next = { ...job, ...patch, progress: { ...job.progress, ...(patch.progress || {}) } };
      if (result.done) {
        next.state = next.progress.failed > 0 ? 'completed_with_errors' : 'completed';
        next.completedAt = isoNow(); next.nextRunAt = null; return next;
      }
      if (result.retryable) {
        const itemKey = String(result.itemKey ?? job.cursor);
        const count = Number(job.itemAttempts[itemKey] || 0) + 1;
        next.itemAttempts[itemKey] = count;
        if (count < job.maxAttempts) {
          next.state = 'queued'; next.nextRunAt = new Date(Date.now() + this.retryDelay(count)).toISOString();
          if (result.error) next.errors = [...job.errors.slice(-49), { ...result.error, at: isoNow(), itemKey, attempt: count }];
          return next;
        }
        if (result.onExhaustedPatch) Object.assign(next, result.onExhaustedPatch);
        next.progress = { ...next.progress, failed: Number(next.progress.failed||0)+1, processed: Number(next.progress.processed||0)+1 };
        next.progress.pending = Math.max(0, next.progress.total - next.progress.processed);
        if (result.fatalOnExhausted) {
          next.state = 'failed';
          next.nextRunAt = null;
          next.completedAt = isoNow();
        } else {
          next.cursor = Number(next.cursor||0)+1;
          next.state = next.cursor >= next.progress.total ? 'completed_with_errors' : 'queued';
          next.nextRunAt = next.state === 'queued' ? isoNow() : null;
          if (!next.nextRunAt) next.completedAt = isoNow();
        }
        const exhaustedError = { ...(result.error||{}), at: isoNow(), itemKey, attempt: count, exhausted: true };
        next.errors = [...job.errors.slice(-49), exhaustedError];
        if (result.deadLetterOnExhausted) {
          exhaustedDeadLetter = {
            jobId: job.id,
            tenantId: job.tenantId,
            type: job.type,
            itemKey,
            failedAt: isoNow(),
            exhausted: true,
            errors: [exhaustedError],
          };
        }
        return next;
      }
      next.state = 'queued'; next.nextRunAt = result.delayMs ? new Date(Date.now()+Number(result.delayMs)).toISOString() : isoNow();
      return next;
    });
    if (updated && (updated.state === 'failed' || exhaustedDeadLetter)) {
      const store = this.read();
      const deadLetter = exhaustedDeadLetter || {
        jobId: updated.id,
        tenantId: updated.tenantId,
        type: updated.type,
        failedAt: isoNow(),
        errors: updated.errors.slice(-10),
      };
      const duplicate = store.deadLetters.some((row) =>
        row.jobId === deadLetter.jobId && String(row.itemKey || '') === String(deadLetter.itemKey || '')
      );
      if (!duplicate) {
        store.deadLetters.push(deadLetter);
        this.write(store);
      }
    }
    return updated;
  }
}

module.exports = { PersistentJobQueue, QueueError, JOB_STATES, payloadHash };
