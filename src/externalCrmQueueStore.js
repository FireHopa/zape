const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TABLE = 'zape_external_crm_queue';
const MAX_TABLE_NAME = 64;

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? '').trim();
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function safeTableName(value) {
  const table = clean(value || DEFAULT_TABLE);
  if (!/^[a-zA-Z0-9_]+$/.test(table) || table.length > MAX_TABLE_NAME) {
    throw Object.assign(new Error('EXTERNAL_CRM_MYSQL_TABLE inválida.'), { code: 'EXTERNAL_CRM_QUEUE_INVALID_TABLE' });
  }
  return table;
}

function jsonFilePath() {
  const configured = clean(process.env.EXTERNAL_CRM_QUEUE_FILE);
  return configured || path.join(__dirname, '..', 'data', 'external_crm_queue.json');
}

function resolveQueueStorageConfig(env = process.env) {
  const requestedMode = clean(env.EXTERNAL_CRM_QUEUE_STORAGE || 'json').toLowerCase();
  const mode = requestedMode === 'mysql' ? 'mysql' : 'json';
  return {
    mode,
    requireMysql: boolEnv(env.EXTERNAL_CRM_QUEUE_REQUIRE_MYSQL, mode === 'mysql'),
    autoMigrateJson: boolEnv(env.EXTERNAL_CRM_QUEUE_AUTO_MIGRATE_JSON, true),
    archiveMigratedJson: boolEnv(env.EXTERNAL_CRM_QUEUE_ARCHIVE_MIGRATED_JSON, true),
    jsonFile: clean(env.EXTERNAL_CRM_QUEUE_FILE) || jsonFilePath(),
    mysql: {
      host: clean(env.EXTERNAL_CRM_MYSQL_HOST || env.MYSQL_HOST || '127.0.0.1'),
      port: Number(env.EXTERNAL_CRM_MYSQL_PORT || env.MYSQL_PORT || 3306),
      user: clean(env.EXTERNAL_CRM_MYSQL_USER || env.MYSQL_USER),
      password: String(env.EXTERNAL_CRM_MYSQL_PASSWORD || env.MYSQL_PASSWORD || ''),
      database: clean(env.EXTERNAL_CRM_MYSQL_DATABASE || env.MYSQL_DATABASE),
      connectionLimit: Math.max(1, Math.min(20, Number(env.EXTERNAL_CRM_MYSQL_CONNECTION_LIMIT || 5))),
      connectTimeout: Math.max(1000, Number(env.EXTERNAL_CRM_MYSQL_CONNECT_TIMEOUT_MS || 10000)),
      table: safeTableName(env.EXTERNAL_CRM_MYSQL_TABLE || DEFAULT_TABLE),
      ssl: clean(env.EXTERNAL_CRM_MYSQL_SSL || '').toLowerCase(),
    },
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJsonQueue(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Formato da fila JSON inválido.');
    return parsed;
  } catch (error) {
    const wrapped = new Error('Fila do CRM externo indisponível ou corrompida.');
    wrapped.code = 'EXTERNAL_CRM_QUEUE_CORRUPTED';
    wrapped.cause = error;
    throw wrapped;
  }
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toIso(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toMysqlDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function rowToItem(row) {
  return {
    id: String(row.id || ''),
    eventKey: String(row.event_key || ''),
    tenantId: String(row.tenant_id || ''),
    externalLeadId: String(row.external_lead_id || ''),
    payload: jsonValue(row.payload_json, {}),
    status: String(row.status || ''),
    attempts: Number(row.attempts || 0),
    nextAttemptAt: toIso(row.next_attempt_at),
    lastAttemptAt: toIso(row.last_attempt_at),
    lastError: String(row.last_error || ''),
    lastHttpStatus: Number(row.last_http_status || 0),
    response: jsonValue(row.response_json, null),
    attemptHistory: jsonValue(row.attempt_history_json, []),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deliveredAt: toIso(row.delivered_at),
  };
}

function itemSqlValues(item) {
  return [
    item.id || crypto.randomUUID(),
    item.eventKey,
    item.tenantId || '',
    item.externalLeadId || '',
    item.payload?.eventType || '',
    item.payload?.metadata?.channel || item.payload?.metadata?.transport || 'WhatsApp',
    JSON.stringify(item.payload || {}),
    item.status || 'pending',
    Number(item.attempts || 0),
    toMysqlDate(item.nextAttemptAt),
    toMysqlDate(item.lastAttemptAt),
    item.lastError || '',
    Number(item.lastHttpStatus || 0),
    item.response == null ? null : JSON.stringify(item.response),
    JSON.stringify(Array.isArray(item.attemptHistory) ? item.attemptHistory : []),
    toMysqlDate(item.createdAt || nowIso()),
    toMysqlDate(item.updatedAt || nowIso()),
    toMysqlDate(item.deliveredAt),
  ];
}

class ExternalCrmQueueStore {
  constructor(config = resolveQueueStorageConfig()) {
    this.config = config;
    this.mode = config.mode;
    this.pool = null;
    this.initialized = false;
    this.initializing = null;
    this.fallbackReason = '';
    this.lastMigration = { attempted: false, imported: 0, skipped: 0, archivedTo: '', error: '' };
  }

  async initialize() {
    if (this.initialized) return this.getHealth();
    if (this.initializing) return this.initializing;
    this.initializing = this.#initializeInternal();
    try { return await this.initializing; } finally { this.initializing = null; }
  }

  async #initializeInternal() {
    if (this.mode !== 'mysql') {
      this.initialized = true;
      return this.getHealth();
    }
    try {
      const mysql = require('mysql2/promise');
      const ssl = this.config.mysql.ssl === 'require' ? { rejectUnauthorized: false } : undefined;
      this.pool = mysql.createPool({
        host: this.config.mysql.host,
        port: this.config.mysql.port,
        user: this.config.mysql.user,
        password: this.config.mysql.password,
        database: this.config.mysql.database,
        connectionLimit: this.config.mysql.connectionLimit,
        connectTimeout: this.config.mysql.connectTimeout,
        waitForConnections: true,
        queueLimit: 0,
        enableKeepAlive: true,
        timezone: 'Z',
        ssl,
      });
      await this.pool.query('SELECT 1');
      await this.#ensureMysqlTable();
      if (this.config.autoMigrateJson) await this.#migrateJsonToMysql();
      this.initialized = true;
      return this.getHealth();
    } catch (error) {
      this.fallbackReason = String(error?.message || error).slice(0, 1000);
      if (this.pool) await this.pool.end().catch(() => undefined);
      this.pool = null;
      if (this.config.requireMysql) {
        const wrapped = new Error(`Fila MySQL indisponível: ${this.fallbackReason}`);
        wrapped.code = 'EXTERNAL_CRM_MYSQL_QUEUE_UNAVAILABLE';
        throw wrapped;
      }
      this.mode = 'json';
      this.initialized = true;
      return this.getHealth();
    }
  }

  async #ensureMysqlTable() {
    const table = this.config.mysql.table;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS \`${table}\` (
      id CHAR(36) NOT NULL PRIMARY KEY,
      event_key VARCHAR(255) NOT NULL,
      tenant_id VARCHAR(120) NOT NULL DEFAULT '',
      external_lead_id VARCHAR(120) NOT NULL DEFAULT '',
      event_type VARCHAR(120) NOT NULL DEFAULT '',
      channel VARCHAR(80) NOT NULL DEFAULT 'WhatsApp',
      payload_json JSON NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at DATETIME(3) NULL,
      last_attempt_at DATETIME(3) NULL,
      last_error TEXT NULL,
      last_http_status INT NOT NULL DEFAULT 0,
      response_json JSON NULL,
      attempt_history_json JSON NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      delivered_at DATETIME(3) NULL,
      UNIQUE KEY uq_zape_crm_queue_event_key (event_key),
      INDEX idx_zape_crm_queue_due (status, next_attempt_at, created_at),
      INDEX idx_zape_crm_queue_tenant_created (tenant_id, created_at),
      INDEX idx_zape_crm_queue_event_type_created (event_type, created_at),
      INDEX idx_zape_crm_queue_delivered (status, delivered_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async #migrateJsonToMysql() {
    const filePath = this.config.jsonFile;
    this.lastMigration.attempted = true;
    if (!fs.existsSync(filePath)) return;
    let items;
    try { items = readJsonQueue(filePath); } catch (error) {
      this.lastMigration.error = error.message;
      if (this.config.requireMysql) throw error;
      return;
    }
    if (!items.length) return;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const item of items) {
        const result = await connection.query(
          `INSERT IGNORE INTO \`${this.config.mysql.table}\` (
            id,event_key,tenant_id,external_lead_id,event_type,channel,payload_json,status,attempts,
            next_attempt_at,last_attempt_at,last_error,last_http_status,response_json,attempt_history_json,
            created_at,updated_at,delivered_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          itemSqlValues({ ...item, attemptHistory: item.attemptHistory || [] }),
        );
        if (Number(result?.[0]?.affectedRows || 0)) this.lastMigration.imported += 1;
        else this.lastMigration.skipped += 1;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      this.lastMigration.error = String(error?.message || error);
      throw error;
    } finally {
      connection.release();
    }
    if (this.config.archiveMigratedJson && !this.lastMigration.error) {
      const archivePath = `${filePath}.migrated-${Date.now()}.bak`;
      fs.renameSync(filePath, archivePath);
      this.lastMigration.archivedTo = archivePath;
    }
  }

  async listAll() {
    await this.initialize();
    if (this.mode === 'json') return readJsonQueue(this.config.jsonFile);
    const [rows] = await this.pool.query(`SELECT * FROM \`${this.config.mysql.table}\` ORDER BY created_at ASC`);
    return rows.map(rowToItem);
  }

  async findByEventKey(eventKey) {
    await this.initialize();
    if (this.mode === 'json') return readJsonQueue(this.config.jsonFile).find((item) => item.eventKey === eventKey) || null;
    const [rows] = await this.pool.query(`SELECT * FROM \`${this.config.mysql.table}\` WHERE event_key = ? LIMIT 1`, [eventKey]);
    return rows[0] ? rowToItem(rows[0]) : null;
  }

  async insert(item) {
    await this.initialize();
    if (this.mode === 'json') {
      const items = readJsonQueue(this.config.jsonFile);
      const existing = items.find((entry) => entry.eventKey === item.eventKey);
      if (existing) return { inserted: false, item: existing };
      items.push(item);
      atomicWriteJson(this.config.jsonFile, items);
      return { inserted: true, item };
    }
    try {
      await this.pool.query(
        `INSERT INTO \`${this.config.mysql.table}\` (
          id,event_key,tenant_id,external_lead_id,event_type,channel,payload_json,status,attempts,
          next_attempt_at,last_attempt_at,last_error,last_http_status,response_json,attempt_history_json,
          created_at,updated_at,delivered_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        itemSqlValues(item),
      );
      return { inserted: true, item };
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return { inserted: false, item: await this.findByEventKey(item.eventKey) };
      throw error;
    }
  }

  async update(item) {
    await this.initialize();
    if (this.mode === 'json') {
      const items = readJsonQueue(this.config.jsonFile);
      const index = items.findIndex((entry) => String(entry.id) === String(item.id));
      if (index < 0) return null;
      items[index] = item;
      atomicWriteJson(this.config.jsonFile, items);
      return item;
    }
    await this.pool.query(
      `UPDATE \`${this.config.mysql.table}\` SET
        tenant_id=?, external_lead_id=?, event_type=?, channel=?, payload_json=?, status=?, attempts=?,
        next_attempt_at=?, last_attempt_at=?, last_error=?, last_http_status=?, response_json=?, attempt_history_json=?,
        updated_at=?, delivered_at=? WHERE id=?`,
      [
        item.tenantId || '', item.externalLeadId || '', item.payload?.eventType || '',
        item.payload?.metadata?.channel || item.payload?.metadata?.transport || 'WhatsApp',
        JSON.stringify(item.payload || {}), item.status || 'pending', Number(item.attempts || 0),
        toMysqlDate(item.nextAttemptAt), toMysqlDate(item.lastAttemptAt), item.lastError || '', Number(item.lastHttpStatus || 0),
        item.response == null ? null : JSON.stringify(item.response), JSON.stringify(item.attemptHistory || []),
        toMysqlDate(item.updatedAt || nowIso()), toMysqlDate(item.deliveredAt), item.id,
      ],
    );
    return item;
  }

  async claimDue(limit = 10) {
    await this.initialize();
    const at = nowIso();
    const staleAt = new Date(Date.now() - Math.max(60_000, Number(process.env.EXTERNAL_CRM_SENDING_STALE_MS || 300_000)));
    if (this.mode === 'json') {
      const items = readJsonQueue(this.config.jsonFile);
      const now = Date.now();
      const due = items
        .filter((item) => item.status === 'pending' || (item.status === 'sending' && Date.parse(item.updatedAt || '') <= staleAt.getTime()))
        .filter((item) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(0, limit);
      const ids = new Set(due.map((item) => item.id));
      const claimed = items.map((item) => {
        if (!ids.has(item.id)) return item;
        return { ...item, status: 'sending', attempts: Number(item.attempts || 0) + 1, lastAttemptAt: at, updatedAt: at };
      });
      atomicWriteJson(this.config.jsonFile, claimed);
      return claimed.filter((item) => ids.has(item.id));
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        `SELECT * FROM \`${this.config.mysql.table}\`
          WHERE ((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3)))
             OR (status='sending' AND updated_at <= ?))
          ORDER BY created_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
        [staleAt, Number(limit)],
      );
      const ids = rows.map((row) => row.id);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await connection.query(
          `UPDATE \`${this.config.mysql.table}\` SET status='sending', attempts=attempts+1,
             last_attempt_at=?, updated_at=? WHERE id IN (${placeholders})`,
          [toMysqlDate(at), toMysqlDate(at), ...ids],
        );
      }
      await connection.commit();
      return rows.map((row) => rowToItem({ ...row, status: 'sending', attempts: Number(row.attempts || 0) + 1, last_attempt_at: at, updated_at: at }));
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async retry({ tenantId = '', eventKey = '' } = {}) {
    await this.initialize();
    const tenant = clean(tenantId);
    const event = clean(eventKey);
    const at = nowIso();
    if (this.mode === 'json') {
      const items = readJsonQueue(this.config.jsonFile);
      let retried = 0;
      const next = items.map((item) => {
        const eligible = item.status === 'failed_permanent'
          && (!tenant || String(item.tenantId) === tenant)
          && (!event || String(item.eventKey) === event);
        if (!eligible) return item;
        retried += 1;
        return { ...item, status: 'pending', attempts: 0, nextAttemptAt: at, lastAttemptAt: '', lastError: '', lastHttpStatus: 0, response: null, updatedAt: at };
      });
      if (retried) atomicWriteJson(this.config.jsonFile, next);
      return retried;
    }
    const conditions = ["status='failed_permanent'"];
    const params = [toMysqlDate(at), toMysqlDate(at)];
    if (tenant) { conditions.push('tenant_id=?'); params.push(tenant); }
    if (event) { conditions.push('event_key=?'); params.push(event); }
    const [result] = await this.pool.query(
      `UPDATE \`${this.config.mysql.table}\` SET status='pending', attempts=0, next_attempt_at=?,
       last_attempt_at=NULL, last_error='', last_http_status=0, response_json=NULL, updated_at=?
       WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return Number(result.affectedRows || 0);
  }

  async prune({ deliveredRetentionMs, maxRows = 100000 } = {}) {
    await this.initialize();
    const cutoffDate = new Date(Date.now() - deliveredRetentionMs);
    const cutoff = cutoffDate.toISOString();
    if (this.mode === 'json') {
      let items = readJsonQueue(this.config.jsonFile);
      items = items.filter((item) => item.status !== 'delivered' || !item.deliveredAt || Date.parse(item.deliveredAt) >= Date.parse(cutoff));
      if (items.length > maxRows) {
        let excess = items.length - maxRows;
        items = items.filter((item) => {
          if (excess > 0 && item.status === 'delivered') { excess -= 1; return false; }
          return true;
        });
      }
      atomicWriteJson(this.config.jsonFile, items);
      return;
    }
    await this.pool.query(`DELETE FROM \`${this.config.mysql.table}\` WHERE status='delivered' AND delivered_at < ?`, [cutoffDate]);
    const [[countRow]] = await this.pool.query(`SELECT COUNT(*) AS total FROM \`${this.config.mysql.table}\``);
    const excess = Math.max(0, Number(countRow?.total || 0) - maxRows);
    if (excess) {
      await this.pool.query(`DELETE FROM \`${this.config.mysql.table}\` WHERE status='delivered' ORDER BY delivered_at ASC LIMIT ${Math.trunc(excess)}`);
    }
  }

  async getMonitorSnapshot(options = {}) {
    await this.initialize();
    if (this.mode !== 'mysql') return null;
    const table = `\`${this.config.mysql.table}\``;
    const from = toMysqlDate(options.from);
    const to = toMysqlDate(options.to);
    const periodConditions = [];
    const periodParams = [];
    if (from) { periodConditions.push('created_at >= ?'); periodParams.push(from); }
    if (to) { periodConditions.push('created_at <= ?'); periodParams.push(to); }
    const periodWhere = periodConditions.length ? `WHERE ${periodConditions.join(' AND ')}` : '';

    const [[countsRow]] = await this.pool.query(`SELECT
      COUNT(*) AS total,
      SUM(status='pending') AS pending,
      SUM(status='sending') AS sending,
      SUM(status='delivered') AS delivered,
      SUM(status='failed_permanent') AS failed_permanent,
      ROUND(AVG(CASE WHEN delivered_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, created_at, delivered_at) / 1000 END),0) AS average_delivery_ms
      FROM ${table} ${periodWhere}`, periodParams);

    const [actionRows] = await this.pool.query(`SELECT
      COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.action')),'null'),'') AS action,
      COUNT(*) AS total
      FROM ${table} ${periodWhere}${periodWhere ? ' AND' : ' WHERE'} status='delivered'
      GROUP BY action`, periodParams);
    const actions = { created: 0, updated: 0, reactivated: 0, other: 0 };
    for (const row of actionRows) {
      const action = String(row.action || '');
      if (Object.prototype.hasOwnProperty.call(actions, action)) actions[action] = Number(row.total || 0);
      else actions.other += Number(row.total || 0);
    }

    const [eventTypeRows] = await this.pool.query(`SELECT COALESCE(NULLIF(event_type,''),'unknown') AS event_type, COUNT(*) AS total
      FROM ${table} ${periodWhere} GROUP BY event_type ORDER BY total DESC`, periodParams);
    const eventTypes = Object.fromEntries(eventTypeRows.map((row) => [String(row.event_type || 'unknown'), Number(row.total || 0)]));

    const [tenantRows] = await this.pool.query(`SELECT tenant_id,
      COUNT(*) AS total,
      SUM(status='pending') AS pending,
      SUM(status='sending') AS sending,
      SUM(status='delivered') AS delivered,
      SUM(status='failed_permanent') AS failed_permanent,
      SUM(status='delivered' AND JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.action'))='created') AS created,
      SUM(status='delivered' AND JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.action'))='updated') AS updated,
      SUM(status='delivered' AND JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.action'))='reactivated') AS reactivated,
      MAX(delivered_at) AS last_delivered_at
      FROM ${table} ${periodWhere}
      GROUP BY tenant_id ORDER BY total DESC`, periodParams);

    const [dailyRows] = await this.pool.query(`SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS date,
      COUNT(*) AS detected,
      SUM(status='delivered') AS delivered,
      SUM(status='failed_permanent') AS failed,
      SUM(status IN ('pending','sending')) AS pending,
      ROUND(AVG(CASE WHEN delivered_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, created_at, delivered_at) / 1000 END),0) AS average_delivery_ms
      FROM ${table} ${periodWhere}
      GROUP BY DATE_FORMAT(created_at,'%Y-%m-%d') ORDER BY date ASC`, periodParams);

    const [[oldestPendingRow]] = await this.pool.query(`SELECT created_at FROM ${table}
      WHERE status IN ('pending','sending') ORDER BY created_at ASC LIMIT 1`);
    const [[lastDeliveredRow]] = await this.pool.query(`SELECT delivered_at,updated_at FROM ${table}
      WHERE status='delivered' ORDER BY COALESCE(delivered_at,updated_at) DESC LIMIT 1`);

    const filteredConditions = [...periodConditions];
    const filteredParams = [...periodParams];
    const status = clean(options.status);
    const tenantId = clean(options.tenantId).toLowerCase();
    const eventType = clean(options.eventType);
    const search = clean(options.search).toLowerCase();
    if (status) { filteredConditions.push('status=?'); filteredParams.push(status); }
    if (tenantId) { filteredConditions.push('LOWER(tenant_id)=?'); filteredParams.push(tenantId); }
    if (eventType) { filteredConditions.push('event_type=?'); filteredParams.push(eventType); }
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      filteredConditions.push(`(LOWER(event_key) LIKE ? ESCAPE '\\\\' OR LOWER(external_lead_id) LIKE ? ESCAPE '\\\\'
        OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.lead.name')),'')) LIKE ? ESCAPE '\\\\'
        OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.lead.phone')),'')) LIKE ? ESCAPE '\\\\'
        OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.leadId')),'')) LIKE ? ESCAPE '\\\\'
        OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.responsible')),'')) LIKE ? ESCAPE '\\\\')`);
      filteredParams.push(like, like, like, like, like, like);
    }
    const filteredWhere = filteredConditions.length ? `WHERE ${filteredConditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, Number(options.limit || 50)));
    const offset = Math.max(0, Number(options.offset || 0));
    const [[totalRow]] = await this.pool.query(`SELECT COUNT(*) AS total FROM ${table} ${filteredWhere}`, filteredParams);
    const [eventRows] = await this.pool.query(`SELECT * FROM ${table} ${filteredWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...filteredParams, limit, offset]);

    return {
      counts: {
        total: Number(countsRow?.total || 0),
        pending: Number(countsRow?.pending || 0),
        sending: Number(countsRow?.sending || 0),
        delivered: Number(countsRow?.delivered || 0),
        failedPermanent: Number(countsRow?.failed_permanent || 0),
      },
      averageDeliveryMs: Number(countsRow?.average_delivery_ms || 0),
      actions,
      eventTypes,
      tenants: tenantRows.map((row) => ({
        tenantId: String(row.tenant_id || 'unknown'), total: Number(row.total || 0), pending: Number(row.pending || 0),
        sending: Number(row.sending || 0), delivered: Number(row.delivered || 0), failedPermanent: Number(row.failed_permanent || 0),
        created: Number(row.created || 0), updated: Number(row.updated || 0), reactivated: Number(row.reactivated || 0),
        lastDeliveredAt: toIso(row.last_delivered_at), lastError: '',
      })),
      daily: dailyRows.map((row) => ({
        date: String(row.date || ''), detected: Number(row.detected || 0), delivered: Number(row.delivered || 0),
        failed: Number(row.failed || 0), pending: Number(row.pending || 0), averageDeliveryMs: Number(row.average_delivery_ms || 0),
      })),
      oldestPendingAt: toIso(oldestPendingRow?.created_at),
      lastDeliveredAt: toIso(lastDeliveredRow?.delivered_at || lastDeliveredRow?.updated_at),
      events: eventRows.map(rowToItem),
      pagination: { total: Number(totalRow?.total || 0), limit, offset, hasMore: offset + limit < Number(totalRow?.total || 0) },
    };
  }

  async getHealth() {
    let sizeBytes = 0;
    let jsonExists = false;
    try {
      const stat = fs.statSync(this.config.jsonFile);
      sizeBytes = stat.size;
      jsonExists = true;
    } catch { /* ignore */ }
    return {
      configuredMode: this.config.mode,
      activeMode: this.mode,
      mysqlConnected: Boolean(this.pool && this.mode === 'mysql'),
      fallbackReason: this.fallbackReason,
      jsonFile: { path: this.config.jsonFile, exists: jsonExists, sizeBytes },
      mysql: this.mode === 'mysql' ? {
        host: this.config.mysql.host,
        port: this.config.mysql.port,
        database: this.config.mysql.database,
        table: this.config.mysql.table,
      } : null,
      migration: { ...this.lastMigration },
    };
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => undefined);
    this.pool = null;
    this.initialized = false;
  }
}

const defaultExternalCrmQueueStore = new ExternalCrmQueueStore();

module.exports = {
  ExternalCrmQueueStore,
  defaultExternalCrmQueueStore,
  resolveQueueStorageConfig,
  readJsonQueue,
};
