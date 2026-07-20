'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PersistentJobQueue, QueueError } = require('../src/persistentJobQueue');

function tempFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-job-queue-'));
  return path.join(root, 'jobs.json');
}

test('deduplica pela chave e rejeita payload diferente', () => {
  const file = tempFile();
  const queue = new PersistentJobQueue({ file, handler: async () => ({ done: true }) });
  const first = queue.enqueue({ tenantId: 'panel', type: 'campaign', idempotencyKey: 'same', payload: { value: 1 } });
  const repeated = queue.enqueue({ tenantId: 'panel', type: 'campaign', idempotencyKey: 'same', payload: { value: 1 } });
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.job.id, first.job.id);
  assert.equal(fs.readFileSync(file, 'utf8').includes('same'), false);
  assert.throws(
    () => queue.enqueue({ tenantId: 'panel', type: 'campaign', idempotencyKey: 'same', payload: { value: 2 } }),
    (error) => error instanceof QueueError && error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
});

test('retry com backoff não duplica item e conclui', async () => {
  const file = tempFile();
  let calls = 0;
  const queue = new PersistentJobQueue({
    file, pollIntervalMs: 50, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3,
    handler: async (job) => {
      calls += 1;
      if (calls === 1) return { retryable: true, itemKey: String(job.cursor), error: { code: 'TEMP' } };
      return { done: true, patch: { cursor: 1, progress: { ...job.progress, processed: 1, sent: 1, pending: 0 } } };
    },
  });
  const { job } = queue.enqueue({ tenantId: 'panel', type: 'campaign', idempotencyKey: 'retry', payload: { contacts: [{}] } });
  queue.stopped = false;
  await queue.tick();
  let current = queue.get(job.id, 'panel');
  assert.equal(current.state, 'queued');
  assert.equal(current.itemAttempts['0'], 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await queue.tick();
  current = queue.get(job.id, 'panel');
  assert.equal(current.state, 'completed');
  assert.equal(current.progress.sent, 1);
  assert.equal(calls, 2);
  queue.stop();
});

test('retoma job running após nova instância', async () => {
  const file = tempFile();
  const first = new PersistentJobQueue({ file, handler: async () => ({ done: true }) });
  const { job } = first.enqueue({ tenantId: 'panel', type: 'campaign', idempotencyKey: 'restart', payload: { contacts: [{}] } });
  first.mutate(job.id, 'panel', (row) => ({
    ...row, state: 'running', startedAt: new Date().toISOString(),
    inFlight: { cursor: 0, startedAt: new Date().toISOString(), executionId: 'run_interrupted' },
  }));

  const second = new PersistentJobQueue({
    file,
    handler: async (row) => ({ done: true, patch: { cursor: 1, progress: { ...row.progress, processed: 1, sent: 1, pending: 0 } } }),
  });
  second.stopped = false;
  await second.tick();
  let recovered = second.get(job.id, 'panel');
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.errors.at(-1).code, 'DELIVERY_UNCERTAIN_AFTER_RESTART');
  second.resume(job.id, 'panel');
  await second.tick();
  recovered = second.get(job.id, 'panel');
  assert.equal(recovered.state, 'completed');
  second.stop();
});

test('pause, resume, cancel e isolamento por tenant', () => {
  const queue = new PersistentJobQueue({ file: tempFile(), handler: async () => ({ done: true }) });
  const { job } = queue.enqueue({ tenantId: 'panel', type: 'campaign', idempotencyKey: 'controls', payload: { contacts: [{}] } });
  assert.equal(queue.pause(job.id, 'panel').state, 'paused');
  assert.equal(queue.resume(job.id, 'panel').state, 'queued');
  assert.equal(queue.get(job.id, 'admin'), null);
  assert.equal(queue.cancel(job.id, 'panel').state, 'canceled');
});

test('falha fatal entra na dead-letter queue', async () => {
  const file = tempFile();
  const queue = new PersistentJobQueue({ file, handler: async () => ({ fatal: true, error: { code: 'FATAL' } }) });
  const { job } = queue.enqueue({ tenantId: 'panel', type: 'campaign', idempotencyKey: 'fatal', payload: { contacts: [{}] } });
  queue.stopped = false;
  await queue.tick();
  const store = queue.read();
  assert.equal(queue.get(job.id, 'panel').state, 'failed');
  assert.equal(store.deadLetters.length, 1);
  assert.equal(store.deadLetters[0].jobId, job.id);
  queue.stop();
});
