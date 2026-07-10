const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zape-crm-"));
process.env.EXTERNAL_CRM_QUEUE_FILE = path.join(tempDir, "queue.json");
process.env.CRM_INTEGRATION_URL = "http://crm.test";
process.env.CRM_INTEGRATION_KEY = "secret";
process.env.CRM_INTEGRATION_ENABLED = "1";

const integration = require("../src/externalCrmIntegration");

test.after(() => {
  integration.stopExternalCrmWorker();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("enfileira uma vez e preserva idempotência local", () => {
  const args = {
    tenantId: "admin",
    webhook: { id: "webhook-1", name: "Landing" },
    target: { enabled: true, source: "WhatsApp" },
    lead: { id: "lead-1", nome: "Maria", whatsapp_digits: "5511999999999", createdAt: new Date().toISOString() },
  };

  const first = integration.enqueueExternalCrmLead(args);
  const second = integration.enqueueExternalCrmLead(args);
  assert.equal(first.queued, true);
  assert.equal(second.duplicate, true);
  const queue = JSON.parse(fs.readFileSync(process.env.EXTERNAL_CRM_QUEUE_FILE, "utf8"));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].eventKey, "zape:admin:lead-1");
});

test("processa entrega sem alterar o evento", async () => {
  global.fetch = async () => ({
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ ok: true, leadId: "crm-1", action: "created" }),
  });

  const result = await integration.processExternalCrmQueue();
  assert.equal(result.processed, 1);
  const queue = JSON.parse(fs.readFileSync(process.env.EXTERNAL_CRM_QUEUE_FILE, "utf8"));
  assert.equal(queue[0].status, "delivered");
  assert.equal(queue[0].response.leadId, "crm-1");
});

test("não perde novos eventos enfileirados durante uma entrega em andamento", async () => {
  const secondLead = {
    tenantId: "admin",
    webhook: { id: "webhook-1", name: "Landing" },
    target: { enabled: true, source: "WhatsApp" },
    lead: { id: "lead-2", nome: "Carlos", whatsapp_digits: "5511888888888", createdAt: new Date().toISOString() },
  };
  const thirdLead = {
    tenantId: "admin",
    webhook: { id: "webhook-1", name: "Landing" },
    target: { enabled: true, source: "WhatsApp" },
    lead: { id: "lead-3", nome: "Ana", whatsapp_digits: "351912345678", createdAt: new Date().toISOString() },
  };

  integration.enqueueExternalCrmLead(secondLead);

  let releaseRequest;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  global.fetch = async () => {
    requestStarted();
    await new Promise((resolve) => { releaseRequest = resolve; });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, leadId: "crm-2", action: "created" }),
    };
  };

  const processing = integration.processExternalCrmQueue();
  await started;
  integration.enqueueExternalCrmLead(thirdLead);
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseRequest();
  await processing;

  const queue = JSON.parse(fs.readFileSync(process.env.EXTERNAL_CRM_QUEUE_FILE, "utf8"));
  const lead2 = queue.find((item) => item.eventKey === "zape:admin:lead-2");
  const lead3 = queue.find((item) => item.eventKey === "zape:admin:lead-3");
  assert.equal(lead2.status, "delivered");
  assert.equal(lead3.status, "pending");
});

test("ActiveCampaign continua como entrada e envia ao CRM por padrão", () => {
  delete process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_TO_CRM_ENABLED;
  process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_ENABLED = "0";
  const target = integration.getLegacyActiveCampaignTarget();
  assert.ok(target);
  assert.equal(target.enabled, true);
  assert.equal(target.source, "WhatsApp");
  delete process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_ENABLED;
});

test("controle da Active afeta somente o repasse ao CRM", () => {
  process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_TO_CRM_ENABLED = "0";
  assert.equal(integration.getLegacyActiveCampaignTarget(), null);
  delete process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_TO_CRM_ENABLED;
});
