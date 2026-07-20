'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLeadQuery, sortLeadItems, paginateLeadItems, MAX_PAGE_SIZE } = require('../src/leadQuery');

function leads(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `lead-${String(index + 1).padStart(5, '0')}`,
    nome: `Lead ${index + 1}`,
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
  }));
}

test('paginação navega por mais de 2.500 leads sem corte', () => {
  const sorted = sortLeadItems(leads(2505), { sortBy: 'createdAt', sortDir: 'desc' });
  const first = paginateLeadItems(sorted, { page: 1, pageSize: 500 });
  const last = paginateLeadItems(sorted, { page: 6, pageSize: 500 });
  assert.equal(first.total, 2505);
  assert.equal(first.items.length, 500);
  assert.equal(first.totalPages, 6);
  assert.equal(first.hasNext, true);
  assert.equal(last.items.length, 5);
  assert.equal(last.hasNext, false);
  assert.equal(last.hasPrev, true);
  assert.equal(new Set([...first.items, ...last.items].map((item) => item.id)).size, 505);
});

test('pageSize é limitado e ordenação inválida volta ao padrão seguro', () => {
  const parsed = parseLeadQuery({ page: '-2', pageSize: '99999', sortBy: 'constructor', sortDir: 'sideways' });
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, MAX_PAGE_SIZE);
  assert.equal(parsed.sortBy, 'createdAt');
  assert.equal(parsed.sortDir, 'desc');
});

test('ordenação é estável por id quando valores principais coincidem', () => {
  const items = [
    { id: 'b', nome: 'Mesmo' },
    { id: 'a', nome: 'Mesmo' },
  ];
  assert.deepEqual(sortLeadItems(items, { sortBy: 'nome', sortDir: 'asc' }).map((item) => item.id), ['a', 'b']);
});
