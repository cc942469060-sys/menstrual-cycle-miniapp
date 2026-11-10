// Regressions for setting damaged data aside instead of blocking every record.
const test = require('node:test');
const assert = require('node:assert/strict');
const { S, V, record, stateWith, storage, page } = require('./helpers.cjs');

function damaged() {
  const state = stateWith([record('2026-08-01'), record('2026-08-29')]);
  state.periods.push({ ...record('2026-09-26'), status: 'broken' });
  return state;
}

test('a single damaged record can be set aside while the other records keep working', () => {
  const raw = damaged();
  const wx = storage(raw);
  const e = page(undefined, { storage: wx });
  assert.notEqual(e.p.data.loadError, '');
  assert.match(e.p.data.repairText, /隔离 1 条格式异常的记录/);
  e.p.repairData();
  assert.equal(e.p.data.loadError, '');
  assert.equal(e.p.data.repairText, '');
  assert.deepEqual(e.p._state.periods.map(p => p.start), ['2026-08-01', '2026-08-29']);
  assert.deepEqual(wx.values.get(S.REPAIR_BACKUP), raw);
  assert.equal(e.p.data.periodCount, 2);
  assert.match(e.p.data.migrationMessage, /已隔离 1 条/);
  assert.equal(e.wx.toasts.at(-1).title, '已修复，可以继续使用');
});

test('settings and drafts that fail validation fall back to defaults during repair', () => {
  const raw = stateWith([record('2026-09-01')], { predictionMode: 'manual', manualCycleLength: 5, manualPeriodLength: 3 });
  raw.draft = { start: 'not-a-date', end: null };
  const plan = S.planRepair(raw, '2026-10-03');
  assert.deepEqual([plan.removedCount, plan.resetPreferences, plan.droppedDraft], [0, true, true]);
  assert.equal(plan.state.preferences.predictionMode, 'auto');
  assert.equal(plan.state.draft, null);
  assert.equal(plan.state.periods.length, 1);
  assert.match(V.repairText(plan), /把预测设置恢复为默认、丢弃未完成的录入/);
});

test('ambiguous damage and newer schema versions are never repaired automatically', () => {
  const overlap = stateWith([record('2026-09-01'), record('2026-09-03')]);
  const twoOngoing = stateWith([record('2026-08-01', 1, { end: null, status: 'ongoing' }), record('2026-09-01', 1, { end: null, status: 'ongoing' })]);
  const newer = { ...stateWith(), schemaVersion: 3 };
  for (const raw of [overlap, twoOngoing, newer]) {
    assert.equal(S.planRepair(raw, '2026-10-03'), null);
    const wx = storage(raw);
    const e = page(undefined, { storage: wx });
    assert.notEqual(e.p.data.loadError, '');
    assert.equal(e.p.data.repairText, '');
    assert.equal(S.repair(wx, '2026-10-03').ok, false);
    assert.deepEqual(wx.values.get(S.KEY), raw);
    assert.equal(wx.values.has(S.REPAIR_BACKUP), false);
  }
});

test('repair changes nothing when the original cannot be backed up or the user cancels', () => {
  const raw = damaged();
  const wx = storage(raw);
  wx.options.writeFailure = key => key === S.REPAIR_BACKUP;
  const result = S.repair(wx, '2026-10-03');
  assert.equal(result.ok, false);
  assert.match(result.message, /无法备份原数据/);
  assert.deepEqual(wx.values.get(S.KEY), raw);
  const cancelled = page(undefined, { storage: storage(raw) });
  cancelled.wx.options.confirm = false;
  cancelled.p.repairData();
  assert.notEqual(cancelled.p.data.loadError, '');
  assert.deepEqual(cancelled.snapshot(), raw);
});
