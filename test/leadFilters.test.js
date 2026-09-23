import test from 'node:test';
import assert from 'node:assert';
import { assembleBoard, isWorkable } from '../src/leadFilters.js';

const mobile = (id, status, extra = {}) => ({
  id, status, phone: `+2764${String(1000000 + id).slice(-7)}`, tier: null, ...extra,
});
const landline = (id, status) => ({
  id, status, phone: `+2721${String(1000000 + id).slice(-7)}`, tier: null,
});

test('unsent landlines and rejected leads are not workable', () => {
  assert.equal(isWorkable(mobile(1, 'new')), true);
  assert.equal(isWorkable(landline(2, 'new')), false);
  assert.equal(isWorkable(mobile(3, 'new', { tier: 'rejected' })), false);
  assert.equal(isWorkable(landline(4, 'opener_sent')), true);
});

test('newest unsent leads jump in front of awaiting-reply and are not crowded out', () => {
  const awaiting = Array.from({ length: 20 }, (_, i) => mobile(i + 1, 'opener_sent'));
  const olderNew = mobile(50, 'new');
  const pasted = [mobile(114, 'new'), mobile(124, 'new')];
  const board = assembleBoard([...awaiting, olderNew, ...pasted], { size: 20 });

  assert.equal(board[0].id, 124);
  assert.equal(board[1].id, 114);
  assert.equal(board[2].id, 50);
  assert.equal(board.filter((l) => l.status === 'new').length, 3);
  assert.equal(board.filter((l) => l.status === 'opener_sent').length, 20);
  assert.ok(board.every((l, i) => i < 3 || l.status === 'opener_sent'));
});

test('unsent cap keeps a working set; awaiting is not sliced', () => {
  const news = Array.from({ length: 30 }, (_, i) => mobile(200 + i, 'new'));
  const awaiting = Array.from({ length: 5 }, (_, i) => mobile(10 + i, 'opener_sent'));
  const board = assembleBoard([...news, ...awaiting], { size: 20 });

  const fresh = board.filter((l) => l.status === 'new');
  assert.equal(fresh.length, 20);
  assert.equal(fresh[0].id, 229);
  assert.equal(fresh.at(-1).id, 210);
  assert.equal(board.filter((l) => l.status === 'opener_sent').length, 5);
});
