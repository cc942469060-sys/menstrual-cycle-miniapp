// Regressions for the ongoing-event flow, prediction windows, statistics, gap flags, and backup restore.
const test = require('node:test');
const assert = require('node:assert/strict');
const { C, S, copy, record, stateWith, storage, page } = require('./helpers.cjs');

const starts = (first, intervals) => intervals.reduce((list, n) => [...list, C.addDays(list[list.length - 1], n)], [first]);
const ongoingRecord = start => record(start, 1, { end: null, status: 'ongoing' });
const excluded = e => e.p.data.excludedIntervals.map(item => `${item.start}->${item.end}`);
const tapDelta = delta => ({ currentTarget: { dataset: { delta } } });

// ---- Ongoing events ----

test('an ongoing event is shown on the calendar from its start through today', () => {
  const e = page(stateWith(), { today: '2026-10-01T09:00:00' });
  e.tap('2026-10-01');
  e.p.markOngoing();
  e.setNow('2026-10-04T09:00:00');
  e.p.renderCalendar();
  const cells = e.p.data.calendarGrid.filter(c => c.date >= '2026-10-01' && c.date <= '2026-10-05');
  assert.deepEqual(cells.map(c => c.isMarked), [true, true, true, true, false]);
  assert.equal(cells[0].isPeriodStart, true);
  assert.equal(cells.some(c => c.isPeriodEnd), false);
  assert.equal(e.p.data.ongoingStart, '2026-10-01');
  assert.equal(e.p.data.ongoingDay, 4);
  assert.equal(e.p.data.predictionStatusText, '经期第 4 天（进行中）');
  assert.equal(e.p.data.periodRows[0].durationText, '进行中 · 第 4 天');
});

test('tapping a later day of an ongoing event ends it there instead of creating a draft', () => {
  const e = page(stateWith(), { today: '2026-10-01T09:00:00' });
  e.tap('2026-10-01');
  e.p.markOngoing();
  const id = e.p._state.periods[0].id;
  e.setNow('2026-10-04T09:00:00');
  e.wx.options.sheetIndex = 0;
  e.tap('2026-10-03');
  assert.deepEqual(e.wx.sheets.at(-1).itemList, ['设为结束日：10-03（共 3 天）', '编辑这条记录']);
  assert.equal(e.snapshot().draft, null);
  assert.deepEqual(e.p._state.periods.map(p => [p.id, p.start, p.end, p.status]), [[id, '2026-10-01', '2026-10-03', 'completed']]);
  assert.equal(e.p.data.typicalPeriodLength, 3);
});

test('an ongoing event can still be opened for editing from the calendar', () => {
  const e = page(stateWith([ongoingRecord('2026-10-01')]));
  e.wx.options.sheetIndex = 1;
  e.tap('2026-10-02');
  assert.equal(e.p.data.editorVisible, true);
  assert.equal(e.p.data.editorId, 'p-2026-10-01');
  assert.equal(e.p.data.editorOngoing, true);
});

test('the ongoing tip ends the event today in one tap or opens the editor ready for an end date', () => {
  const e = page(stateWith([ongoingRecord('2026-09-30')]));
  e.p.editOngoing();
  assert.equal(e.p.data.editorVisible, true);
  assert.equal(e.p.data.editorOngoing, false);
  assert.equal(e.p.data.editorEnd, '2026-10-03');
  e.p.closeEditor();
  e.p.endOngoingToday();
  assert.deepEqual(e.p._state.periods.map(p => [p.end, p.status]), [['2026-10-03', 'completed']]);
  assert.equal(e.p.data.ongoingStart, '');
});

test('a long-running ongoing event asks the user to confirm whether it has ended', () => {
  const long = C.computePredictions(stateWith([ongoingRecord('2026-09-20')]), '2026-10-03');
  assert.equal(long.ongoingDay, 14);
  assert.equal(long.ongoingLong, true);
  assert.match(long.predictionMessage, /已持续 14 天/);
  const short = C.computePredictions(stateWith([ongoingRecord('2026-09-30')]), '2026-10-03');
  assert.equal(short.ongoingLong, false);
});

// ---- Estimated windows ----

test('fertile windows stop after two cycles, so no month is fully covered', () => {
  const state = stateWith(starts('2026-05-01', [25, 32, 28, 30]).map(start => record(start)));
  const today = '2026-09-03';
  const r = C.computePredictions(state, today);
  assert.equal(r.quality, 'regular');
  assert.deepEqual(r.upcomingPeriods.map(p => !!p.fertileStart), r.upcomingPeriods.map((p, i) => i < 2));
  for (let k = 0; k < 12; k++) {
    const year = 2026 + Math.floor((8 + k) / 12);
    const month = ((8 + k) % 12) + 1;
    const days = C.generateCalendarGrid(year, month, state.periods, r, null, today).filter(c => c.isCurrentMonth);
    assert(days.some(c => !c.isMarked && !c.isPredicted && !c.isFertile && !c.isOvulation), `${year}-${month} is fully marked`);
    assert(!days.some(c => c.isPredicted && (c.isFertile || c.isOvulation)), `${year}-${month} marks a predicted day as fertile`);
  }
});

test('the second-cycle window widens with the square root of the cycles ahead', () => {
  // Intervals 25–32 (mean 29) after the last start on 08-24: cycle 1 spans day 25–32, cycle 2 day 52–63.
  const r = C.computePredictions(stateWith(starts('2026-05-01', [25, 32, 28, 30]).map(start => record(start))), '2026-09-03');
  const [first, second] = r.upcomingPeriods;
  assert.deepEqual([first.ovulationStart, first.ovulationEnd], [C.addDays('2026-08-24', 25 - 16), C.addDays('2026-08-24', 32 - 10)]);
  assert.deepEqual([second.ovulationStart, second.ovulationEnd], [C.addDays('2026-08-24', 52 - 16), C.addDays('2026-08-24', 63 - 10)]);
});

test('a predicted period day takes precedence over an overlapping estimated window', () => {
  const state = stateWith(starts('2026-05-01', [25, 32, 28, 30]).map(start => record(start)));
  const r = C.computePredictions(state, '2026-09-03');
  assert(r.fertileDates.includes('2026-09-24'));
  const cell = C.generateCalendarGrid(2026, 9, state.periods, r, null, '2026-09-03').find(c => c.date === '2026-09-24');
  assert.equal(cell.isPredicted, true);
  assert.equal(cell.isFertile, false);
  assert.equal(cell.isOvulation, false);
});

test('the window summary names the first window that has not ended yet', () => {
  const state = stateWith(['2026-06-10', '2026-07-08', '2026-08-05', '2026-09-02'].map(start => record(start)));
  const early = C.computePredictions(state, '2026-09-10');
  assert.equal(early.ovulationWindow, '2026-09-14 ~ 2026-09-20');
  assert.equal(early.fertileWindow, '2026-09-09 ~ 2026-09-20');
  const late = C.computePredictions(state, '2026-09-27');
  assert.equal(late.ovulationWindow, '2026-10-12 ~ 2026-10-18');
  assert.equal(late.fertileWindow, '2026-10-07 ~ 2026-10-18');
});

// ---- Prediction settings ----

test('auto-mode settings show, and adjust from, the values predictions actually use', () => {
  const e = page(stateWith(starts('2026-05-01', [32, 32, 32, 32]).map(start => record(start))));
  assert.equal(e.p.data.effectiveCycleLength, 32);
  assert.equal(e.p.data.settingCycleLength, 32);
  assert.equal(e.p.data.settingPeriodLength, 5);
  assert.equal(e.p.data.nextPeriodStart, '2026-10-08');
  e.p.changeCycleLength(tapDelta(1));
  const prefs = e.p._state.preferences;
  assert.deepEqual([prefs.predictionMode, prefs.manualCycleLength, prefs.manualPeriodLength], ['manual', 33, 5]);
  assert.equal(e.p.data.nextPeriodStart, '2026-10-09');
});

test('manual adjustment still works when the observed period is not shorter than the cycle', () => {
  const e = page(stateWith([record('2026-08-01', 30)]));
  assert.equal(e.p.data.quality, 'unavailable');
  assert.equal(e.p.data.settingPeriodLength, 27);
  e.p.changePeriodLength(tapDelta(-1));
  assert.deepEqual([e.p._state.preferences.manualCycleLength, e.p._state.preferences.manualPeriodLength], [28, 26]);
});

test('manual mode without any recorded interval does not claim to differ from records', () => {
  const none = C.computePredictions(stateWith([record('2026-09-20')], { predictionMode: 'manual', manualCycleLength: 30, manualPeriodLength: 5 }), '2026-10-03');
  assert.equal(none.quality, 'limited');
  assert.match(none.predictionMessage, /尚无可比较的记录间隔/);
  assert.doesNotMatch(none.predictionMessage, /与已记录间隔不同/);
  const differ = C.computePredictions(stateWith([record('2026-08-01'), record('2026-08-29')], { predictionMode: 'manual', manualCycleLength: 35, manualPeriodLength: 5 }), '2026-10-03');
  assert.match(differ.predictionMessage, /与已记录间隔不同/);
});

// ---- Missing-record flags ----

const flagged = () => [record('2026-06-01'), record('2026-06-29'), record('2026-07-27'), record('2026-09-21', 5, { excludeGap: true })];
const backfill = e => e.p.saveEvent({ id: '', start: '2026-08-24', end: '2026-08-28', ongoing: false, excludeGap: false });

test('back-filling a flagged gap asks which part is still missing', () => {
  const e = page(stateWith(flagged()));
  e.wx.options.sheetIndex = 0;
  backfill(e);
  assert.equal(e.wx.sheets.length, 1);
  assert.match(e.wx.sheets[0].alertText, /2026-09-21/);
  assert.deepEqual(e.wx.sheets[0].itemList, ['已补齐，都没有漏录', '07-27 ~ 08-24 仍有漏录', '08-24 ~ 09-21 仍有漏录', '两段都仍有漏录']);
  assert.deepEqual(copy(e.p.data.cycleLengths), [28, 28, 28, 28]);
  assert.equal(e.p.data.quality, 'regular');
  assert.notEqual(e.p.data.fertileWindow, '');
});

test('each answer about a split gap flags exactly the chosen intervals', () => {
  const cases = [[1, ['2026-07-27->2026-08-24']], [2, ['2026-08-24->2026-09-21']], [3, ['2026-07-27->2026-08-24', '2026-08-24->2026-09-21']]];
  for (const [index, expected] of cases) {
    const e = page(stateWith(flagged()));
    e.wx.options.sheetIndex = index;
    backfill(e);
    assert.deepEqual(excluded(e), expected, `answer ${index}`);
  }
});

test('dismissing the split-gap question saves nothing and keeps the draft', () => {
  const e = page(stateWith(flagged()));
  e.tap('2026-08-24');
  e.wx.options.sheetIndex = null;
  e.tap('2026-08-28');
  assert.equal(e.p._state.periods.length, 4);
  assert.equal(e.p.data.pendingStart, '2026-08-24');
});

test('editing a record that already sits between the same neighbours does not ask again', () => {
  const e = page(stateWith([...flagged().slice(0, 3), record('2026-08-24'), record('2026-09-21', 5, { excludeGap: true })]));
  e.p.openEditor('p-2026-08-24');
  e.p.onEditorEndChange({ detail: { value: '2026-08-27' } });
  e.p.saveEditor();
  assert.equal(e.wx.sheets.length, 0);
  assert.equal(e.p._state.periods.find(p => p.id === 'p-2026-08-24').end, '2026-08-27');
});

test('deleting a record moves its missing-record flag onto the merged interval', () => {
  const e = page(stateWith([record('2026-06-01'), record('2026-06-29', 5, { excludeGap: true }), record('2026-07-27')]));
  e.p.openEditor('p-2026-06-29');
  e.p.deleteEditorRecord();
  assert.match(e.wx.modals.at(-1).content, /漏录标记会转到 2026-07-27/);
  assert.equal(e.p._state.periods.find(p => p.id === 'p-2026-07-27').excludeGap, true);
  assert.deepEqual(excluded(e), ['2026-06-01->2026-07-27']);
});

// ---- Statistics ----

test('an interval containing an unreviewed legacy start is not counted as a cycle', () => {
  const raw = { markedDates: [], setupCompleted: true };
  for (const start of ['2026-06-01', '2026-06-29', '2026-07-27', '2026-08-24']) for (let i = 0; i < 5; i++) raw.markedDates.push(C.addDays(start, i));
  const e = page(raw);
  const ids = e.p._state.periods.map(p => p.id);
  for (const id of [ids[0], ids[2]]) { e.p.openEditor(id); e.p.saveEditor(); }
  assert.deepEqual(copy(e.p.data.cycleLengths), []);
  assert.deepEqual(excluded(e), ['2026-06-01->2026-07-27']);
  assert.equal(e.p.data.excludedIntervals[0].reason, 'review');
  assert.match(e.p.data.recordedIntervalText, /1 个跨越待核对记录/);
  // The newer 08-24 legacy record is still unreviewed, so the latest confirmed start is not trusted.
  assert.equal(e.p.data.predictionStatus, 'review');
  assert.equal(e.p.data.nextPeriodStart, '');
  for (const id of [ids[1], ids[3]]) { e.p.openEditor(id); e.p.saveEditor(); }
  assert.deepEqual(copy(e.p.data.cycleLengths), [28, 28, 28]);
});

test('statistics and predictions use the same recent window', () => {
  const periods = [record('2025-01-01', 40)];
  let start = C.addDays('2025-01-01', 60);
  for (let i = 0; i < 13; i++) { periods.push(record(start)); start = C.addDays(start, 30); }
  const r = C.computePredictions(stateWith(periods), '2026-03-20');
  assert.equal(r.cycleLengths.length, 13);
  assert.equal(r.cycleSampleCount, 12);
  assert.deepEqual([r.avgCycleLength, r.effectiveCycleLength], [30, 30]);
  assert.deepEqual([r.typicalPeriodLength, r.effectivePeriodLength], [5, 5]);
});

test('one unusually long bleed does not stretch the predicted period', () => {
  const lengths = [5, 5, 5, 15, 5, 5];
  const periods = starts('2026-01-05', [30, 30, 30, 30, 30]).map((start, i) => record(start, lengths[i]));
  const r = C.computePredictions(stateWith(periods), '2026-07-10');
  assert.deepEqual([r.typicalPeriodLength, r.effectivePeriodLength], [5, 5]);
  assert.equal(C.median([5, 7]), 6);
  assert.equal(C.median([]), null);
});

// ---- Backup restore ----

test('data cleared by a reset can be restored from the reset backup', () => {
  const original = stateWith([record('2026-08-01'), record('2026-08-29')]);
  const e = page(original);
  e.p.resetAll();
  assert.equal(e.p._state.periods.length, 0);
  e.wx.options.sheetIndex = 0;
  e.p.restoreFromBackup();
  assert.deepEqual(e.wx.sheets.at(-1).itemList, ['首次重置前 · 2 条记录']);
  assert.match(e.wx.modals.at(-1).content, /2026-08-01 ~ 2026-08-29/);
  assert.deepEqual(e.snapshot(), original);
  assert.equal(e.p.data.periodCount, 2);
  assert.equal(e.p.data.showSetup, false);
});

test('restoring keeps the replaced data restorable, so a restore can be undone', () => {
  const current = stateWith([record('2026-09-01')]);
  const older = stateWith([record('2026-07-01'), record('2026-07-29')]);
  const wx = storage(current);
  wx.values.set(S.RESET_BACKUP, copy(older));
  assert.equal(S.restore(wx, S.RESET_BACKUP, '2026-10-03').ok, true);
  assert.deepEqual(wx.values.get(S.KEY), older);
  assert.deepEqual(wx.values.get(S.RESTORE_BACKUP), current);
  // The reset backup now matches the current data, so only the pre-restore copy is offered.
  assert.deepEqual(S.listBackups(wx, '2026-10-03').map(item => [item.key, item.count]), [[S.RESTORE_BACKUP, 1]]);
  assert.equal(S.restore(wx, S.RESTORE_BACKUP, '2026-10-03').ok, true);
  assert.deepEqual(wx.values.get(S.KEY), current);
});

test('a legacy backup restores as records awaiting review', () => {
  const wx = storage(stateWith([record('2026-09-01')]));
  wx.values.set(S.LEGACY_BACKUP, { markedDates: ['2026-08-01', '2026-08-02', '2026-08-03'] });
  const result = S.restore(wx, S.LEGACY_BACKUP, '2026-10-03');
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.periods.map(p => [p.start, p.end, p.status]), [['2026-08-01', '2026-08-03', 'needsReview']]);
  assert(result.warnings.length > 0);
});

test('restore changes nothing when a backup is invalid or the current data cannot be set aside', () => {
  const current = stateWith([record('2026-09-01')]);
  const bad = storage(current);
  bad.values.set(S.RESET_BACKUP, { schemaVersion: 2, periods: 'broken' });
  assert.equal(S.restore(bad, S.RESET_BACKUP, '2026-10-03').ok, false);
  assert.deepEqual(S.listBackups(bad, '2026-10-03'), []);
  assert.equal(bad.writes.length, 0);
  const blocked = storage(current);
  blocked.values.set(S.RESET_BACKUP, copy(stateWith([record('2026-07-01')])));
  blocked.options.writeFailure = key => key === S.RESTORE_BACKUP;
  assert.equal(S.restore(blocked, S.RESET_BACKUP, '2026-10-03').ok, false);
  assert.deepEqual(blocked.values.get(S.KEY), current);
  assert.equal(S.restore(blocked, S.KEY, '2026-10-03').ok, false);
});

test('restore is available from the error card when the current data cannot be read', () => {
  const wx = storage({ bad: true });
  wx.values.set(S.RESET_BACKUP, copy(stateWith([record('2026-09-01')])));
  const e = page(undefined, { storage: wx });
  assert.notEqual(e.p.data.loadError, '');
  e.p.restoreFromBackup();
  assert.equal(e.p.data.loadError, '');
  assert.equal(e.p._state.periods.length, 1);
  assert.deepEqual(wx.values.get(S.RESTORE_BACKUP), { bad: true });
});

test('without any backup the user is told so instead of seeing an empty menu', () => {
  const e = page(stateWith([record('2026-09-01')]));
  e.p.restoreFromBackup();
  assert.equal(e.wx.sheets.length, 0);
  assert.equal(e.wx.toasts.at(-1).title, '暂无可恢复的备份');
});
