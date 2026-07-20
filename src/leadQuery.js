'use strict';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const ALLOWED_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'nome', 'empresa', 'email', 'whatsapp']);

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function booleanQuery(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'sim', 'on'].includes(normalized)) return true;
  return fallback;
}

function parseLeadQuery(query = {}) {
  const page = positiveInt(query.page, 1, { min: 1, max: 1_000_000 });
  const pageSize = positiveInt(query.pageSize ?? query.limit, DEFAULT_PAGE_SIZE, { min: 1, max: MAX_PAGE_SIZE });
  const sortByCandidate = String(query.sortBy || 'createdAt').trim();
  const sortBy = ALLOWED_SORT_FIELDS.has(sortByCandidate) ? sortByCandidate : 'createdAt';
  const sortDir = String(query.sortDir || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sortBy,
    sortDir,
    dedupe: booleanQuery(query.dedupe, true),
  };
}

function normalizedSortValue(item, sortBy) {
  if (!item) return '';
  if (sortBy === 'whatsapp') return String(item.whatsapp_digits || item.whatsapp_raw || item.whatsapp || '');
  if (sortBy === 'createdAt' || sortBy === 'updatedAt') {
    const timestamp = Date.parse(item[sortBy] || (sortBy === 'updatedAt' ? item.createdAt : ''));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return String(item[sortBy] || '').trim().toLocaleLowerCase('pt-BR');
}

function compareLeadItems(a, b, sortBy, sortDir) {
  const av = normalizedSortValue(a, sortBy);
  const bv = normalizedSortValue(b, sortBy);
  let compared = 0;
  if (typeof av === 'number' && typeof bv === 'number') compared = av - bv;
  else compared = String(av).localeCompare(String(bv), 'pt-BR', { numeric: true, sensitivity: 'base' });
  if (compared === 0) compared = String(a?.id || '').localeCompare(String(b?.id || ''));
  return sortDir === 'asc' ? compared : -compared;
}

function sortLeadItems(items, { sortBy = 'createdAt', sortDir = 'desc' } = {}) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => compareLeadItems(a, b, sortBy, sortDir));
}

function paginateLeadItems(items, query = {}, { paginate = true } = {}) {
  const parsed = parseLeadQuery(query);
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / parsed.pageSize));
  const page = Math.min(parsed.page, totalPages);
  const offset = (page - 1) * parsed.pageSize;
  const pageItems = paginate ? list.slice(offset, offset + parsed.pageSize) : list;

  return {
    items: pageItems,
    total,
    page: paginate ? page : 1,
    pageSize: paginate ? parsed.pageSize : total,
    totalPages: paginate ? totalPages : 1,
    hasNext: paginate ? page < totalPages : false,
    hasPrev: paginate ? page > 1 : false,
    offset: paginate ? offset : 0,
    sortBy: parsed.sortBy,
    sortDir: parsed.sortDir,
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseLeadQuery,
  sortLeadItems,
  paginateLeadItems,
};
