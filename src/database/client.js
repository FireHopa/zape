'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadDatabaseConfig } = require('./config');

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function jsonEncode(value) {
  if (value === undefined) return null;
  return JSON.stringify(value === null ? null : value);
}

function convertPgPlaceholders(sql) {
  const order = [];
  const converted = String(sql).replace(/\$(\d+)/g, (_, number) => {
    order.push(Number(number) - 1);
    return '?';
  });
  return { sql: converted, order };
}

class SqliteClient {
  constructor(url) {
    const { DatabaseSync } = require('node:sqlite');
    const raw = String(url || '').replace(/^sqlite:/, '');
    const filename = raw === ':memory:' || raw === '' ? ':memory:' : path.resolve(raw);
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.dialect = 'sqlite';
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  async query(sql, params = []) {
    const text = String(sql).trim();
    const { sql: converted, order } = convertPgPlaceholders(text);
    const values = order.length ? order.map((index) => iso(params[index])) : params.map(iso);
    const statement = this.db.prepare(converted);
    const isRead = /^(SELECT|WITH|PRAGMA)/i.test(text) || /\bRETURNING\b/i.test(text);
    if (isRead) {
      const rows = statement.all(...values);
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...values);
    return { rows: [], rowCount: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid };
  }
  async exec(sql) { this.db.exec(String(sql)); }
  async transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = await fn(this);
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  async close() { this.db.close(); }
}

class PostgresClient {
  constructor(config) {
    const { Pool } = require('pg');
    const sslMode = String(config.ssl || 'require').toLowerCase();
    const ssl = ['0', 'false', 'disable', 'off'].includes(sslMode) ? false : { rejectUnauthorized: sslMode !== 'no-verify' };
    this.dialect = 'postgres';
    this.pool = new Pool({
      connectionString: config.url,
      ssl,
      max: config.max,
      statement_timeout: config.statementTimeoutMs,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      application_name: 'zape',
    });
  }
  async query(sql, params = []) { return this.pool.query(sql, params); }
  async exec(sql) { return this.pool.query(sql); }
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = { dialect: 'postgres', query: (sql, params = []) => client.query(sql, params), exec: (sql) => client.query(sql) };
      const value = await fn(tx);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
  async close() { await this.pool.end(); }
}

function createDatabase(config = loadDatabaseConfig()) {
  if (!config.url) throw new Error('DATABASE_URL ausente.');
  return config.dialect === 'sqlite' ? new SqliteClient(config.url) : new PostgresClient(config);
}

module.exports = { createDatabase, SqliteClient, PostgresClient, jsonEncode };
