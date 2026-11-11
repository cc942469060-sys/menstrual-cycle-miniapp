// Regressions for what the page sends to the view layer and for the calendar interactions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { C, S, V, root, record, stateWith, storage, page } = require('./helpers.cjs');

const starts = (first, intervals) =>
  intervals.reduce((list, n) => [...list, C.addDays(list[list.length - 1], n)], [first]);
const pickCycle = days => ({ detail: { value: String(days - V.CYCLE_PICK_MIN) } });
const pickPeriod = days => ({ detail: { value: String(days - 1) } });
const manualPrefs = e => [
  e.p._state.preferences.predictionMode,
  e.p._state.preferences.manualCycleLength,
  e.p._state.preferences.manualPeriodLength,
];

// ---- What crosses to the view layer ----

test('only rendered fields reach the view, and later renders send only what changed', () => {
  const e = page(stateWith(starts('2025-01-05', Array(20).fill(29)).map(start => record(start))));
  const first = e.calls.find(call => 'calendarGrid' in call);
  for (const key of [
    'predictedDates',
    'fertileDates',
    'ovulationDates',
    'cycleLengths',
    'recordedIntervals',
    'quality',
    'effectiveCycleLength',
  ]) {
    assert(!(key in first), `${key} is not rendered`);
  }
  const size = JSON.stringify(first).length;
  assert(size < 10000, `first render sends ${size} bytes`);

  const before = e.calls.length;
  e.p.goToToday();
  assert.deepEqual(
    e.calls.slice(before).map(call => Object.keys(call)),
    [['year', 'month']],
    'an unchanged calendar sends nothing',
  );

  const index = e.p._grid.findIndex(c => c.date === '2026-10-01');
  e.tap('2026-10-01');
  assert.deepEqual(Object.keys(e.calls.at(-1)).sort(), [`calendarGrid[${index}]`, 'pendingStart']);
  assert(e.p.data.calendarGrid[index].cls.split(' ').includes('pending'));
});

test('returning to the foreground re-renders only after the date or time zone changed', () => {
  const e = page(stateWith([record('2026-09-01')]));
  const before = e.calls.length;
  e.p.onShow();
  e.p.onHide();
  assert.equal(e.calls.length, before);
  e.setNow('2026-10-04T08:00:00');
  e.p.onShow();
  e.p.onHide();
  assert.equal(e.p.data.todayDateStr, '10-04');
});

// ---- Pickers ----

test('picking manual values writes once and keeps the period shorter than the cycle', () => {
  const e = page(stateWith([record('2026-09-01')]));
  const writes = e.wx.writes.length;
  e.p.onCyclePick(pickCycle(32));
  assert.equal(e.wx.writes.length, writes + 1);
  assert.deepEqual(manualPrefs(e), ['manual', 32, 5]);
  e.p.onPeriodPick(pickPeriod(7));
  assert.deepEqual(
    [e.p.data.settingCycleLength, e.p.data.settingPeriodLength, e.p.data.cycleIndex, e.p.data.periodIndex],
    [32, 7, 17, 6],
  );
  e.p.onPeriodPick(pickPeriod(15));
  e.p.onCyclePick(pickCycle(15));
  assert.deepEqual(manualPrefs(e), ['manual', 15, 14], 'a shorter cycle pulls the period below it');
  const count = e.wx.writes.length;
  e.p.onPeriodPick(pickPeriod(15));
  assert.equal(e.wx.toasts.at(-1).title, '经期参考须小于周期参考');
  e.p.onCyclePick({ detail: { value: 'x' } });
  assert.equal(e.wx.writes.length, count);
});

test('setup pickers keep the period shorter than the cycle', () => {
  const e = page(undefined, { storage: storage() });
  e.p.onSetupPeriodPick(pickPeriod(15));
  e.p.onSetupCyclePick(pickCycle(15));
  assert.deepEqual(
    [e.p.data.setupCycleLength, e.p.data.setupPeriodLength, e.p.data.setupCycleIndex, e.p.data.setupPeriodIndex],
    [15, 14, 0, 13],
  );
  e.p.onSetupPeriodPick(pickPeriod(15));
  assert.equal(e.wx.toasts.at(-1).title, '经期参考须小于周期参考');
  e.p.confirmSetup();
  assert.deepEqual([e.p._state.preferences.initialCycleLength, e.p._state.preferences.initialPeriodLength], [15, 14]);
});

// ---- Status card ----

test('the status card tells the user where they are in the cycle', () => {
  const status = (state, today) => V.describeStatus(C.computePredictions(state, today), today);
  const regular = stateWith(['2026-06-10', '2026-07-08', '2026-08-05', '2026-09-02'].map(start => record(start)));
  assert.equal(status(stateWith(), '2026-10-03').title, '还没有经期记录');
  assert.deepEqual(status(regular, '2026-09-20'), {
    tone: 'normal',
    title: '距下次经期约 10 天',
    detail: '预计 2026-09-30 开始。',
  });
  assert.deepEqual(
    [status(regular, '2026-09-30').tone, status(regular, '2026-09-30').title],
    ['alert', '预计今天开始'],
  );
  assert.deepEqual(
    [status(regular, '2026-10-03').tone, status(regular, '2026-10-03').title],
    ['alert', '比预计晚了 3 天'],
  );
  assert.match(status(stateWith([record('2026-09-20')]), '2026-10-03').detail, /仅作粗略参考/);
  const irregular = stateWith(starts('2026-04-01', [18, 45, 18, 45]).map(start => record(start)));
  assert.equal(status(irregular, '2026-08-12').title, '下次经期约在 11～38 天后');
  assert.equal(status(irregular, '2026-08-30').title, '下次经期可能在 20 天内开始');
  const ongoing = status(stateWith([record('2026-09-30', 1, { end: null, status: 'ongoing' })]), '2026-10-03');
  assert.deepEqual([ongoing.tone, ongoing.title], ['period', '经期第 4 天']);
  assert.equal(status(stateWith([record('2026-10-05')]), '2026-10-03').title, '请核对既有记录日期');
  assert.equal(status(stateWith([record('2026-08-01', 30)]), '2026-10-03').title, '暂不提供日期预测');
});

// ---- Calendar taps ----

test('tapping the chosen start again asks before recording a one-day period', () => {
  const e = page();
  e.tap('2026-10-01');
  e.wx.options.sheetIndex = 1;
  e.tap('2026-10-01');
  assert.deepEqual(e.wx.sheets.at(-1).itemList, ['记录为 1 天经期', '取消选择这一天']);
  assert.equal(e.p._state.draft, null);
  assert.equal(e.p._state.periods.length, 0);
  e.tap('2026-10-01');
  e.wx.options.sheetIndex = 0;
  e.tap('2026-10-01');
  assert.deepEqual(
    e.p._state.periods.map(p => [p.start, p.end]),
    [['2026-10-01', '2026-10-01']],
  );
});

test('tapping a greyed date from a neighbouring month switches to that month and keeps the tap', () => {
  const e = page();
  assert.equal(e.p._grid.find(c => c.date === '2026-09-30').isCurrentMonth, false);
  e.tap('2026-09-30');
  assert.deepEqual([e.p.data.year, e.p.data.month], [2026, 9]);
  assert.equal(e.p._state.draft.start, '2026-09-30');
  assert(
    e.p.data.calendarGrid
      .find(c => c.date === '2026-09-30')
      .cls.split(' ')
      .includes('pending'),
  );
});

test('the week can start on Monday, and data saved before the option keeps Sunday', () => {
  const old = stateWith([record('2026-09-01')]);
  delete old.preferences.weekStartsOn;
  const e = page(old);
  assert.equal(e.p.data.weekdays[0].label, '日');
  assert.equal(C.parseDate(e.p._grid[0].date).getUTCDay(), 0);
  e.p.onWeekStartChange({ detail: { value: true } });
  assert.equal(e.snapshot().preferences.weekStartsOn, 1);
  assert.deepEqual(
    e.p.data.weekdays.map(d => d.label),
    ['一', '二', '三', '四', '五', '六', '日'],
  );
  assert.deepEqual(
    e.p.data.weekdays.map(d => d.weekend),
    [false, false, false, false, false, true, true],
  );
  assert.equal(C.parseDate(e.p._grid[0].date).getUTCDay(), 1);
  assert.equal(page(undefined, { storage: e.wx }).p.data.weekStartsOn, 1);
  const invalid = stateWith();
  invalid.preferences.weekStartsOn = 3;
  assert.throws(() => S.validateState(invalid, '2026-10-03'));
});

// ---- Template and styles ----

test('the template locks page scrolling under dialogs and the pending start outranks today', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(root, 'pages/index/index.wxss'), 'utf8');
  assert(wxml.trimStart().startsWith('<page-meta'), 'page-meta must be the first node');
  assert(wxml.includes(`page-style="{{showSetup || editorVisible ? 'overflow: hidden;' : ''}}"`));
  assert(!wxml.includes('data-iscurrentmonth'));
  assert(!wxml.includes('header-title'), 'the title appears once, in the navigation bar');
  assert(/class="status-card[^"]*" wx:if="\{\{!loadError\}\}"/.test(wxml));
  // Later rules win at equal specificity, so the draft start must come after today.
  assert(wxss.lastIndexOf('.day-cell.pending .day-num') > wxss.lastIndexOf('.day-cell.today .day-num'));
  assert.equal(wxss.split('.day-cell.today .day-num').length - 1, 1, 'today is styled in one place');
  for (const unused of ['.tips-', '.day-cell.weekend', '.day-cell.ovulation', '.stepper-btn', '.header-title'])
    assert(!wxss.includes(unused), unused);
  const classes = new Set(
    V.cellClass({
      isCurrentMonth: false,
      isToday: true,
      isMarked: true,
      isPeriodStart: true,
      isPeriodEnd: true,
      isPredicted: true,
      isUnreviewed: true,
      isFertile: true,
      isPending: true,
    })
      .split(' ')
      .concat(['period-mid']),
  );
  for (const name of classes) assert(wxss.includes(`.${name}`), `.${name} has a style`);
});

// ---- Accessibility ----

test('calendar days carry screen-reader text, and fertile days a mark that is not just colour', () => {
  const state = stateWith(['2026-06-10', '2026-07-08', '2026-08-05', '2026-09-02'].map(start => record(start)));
  const e = page(state, { today: '2026-09-10T12:00:00' });
  const cell = date => e.p.data.calendarGrid.find(c => c.date === date);
  assert.equal(cell('2026-09-02').label, '9月2日 星期三，经期开始');
  assert.equal(cell('2026-09-04').label, '9月4日 星期五，经期中');
  assert.equal(cell('2026-09-06').label, '9月6日 星期日，经期结束');
  assert.equal(cell('2026-09-10').label, '9月10日 星期四，今天，估计易孕窗口');
  assert.equal(cell('2026-09-15').label, '9月15日 星期二，估计排卵窗口');
  assert.equal(cell('2026-09-30').label, '9月30日 星期三，预计经期');
  assert.equal(cell('2026-10-01').label, '10月1日 星期四，其他月份，预计经期');
  assert.deepEqual([cell('2026-09-11').fertile, cell('2026-09-11').ovulation], [true, undefined]);
  assert.deepEqual([cell('2026-09-15').fertile, cell('2026-09-15').ovulation], [undefined, true]);
  const wxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');
  assert(wxml.includes('aria-label="{{item.label}}"'));
  assert(wxml.includes('aria-label="上个月"') && wxml.includes('aria-label="下个月"'));
  assert(wxml.includes('<view class="fertile-bar" wx:if="{{item.fertile}}"></view>'));
  assert(
    wxml.includes('swatch-fertile"><view class="fertile-bar"></view>') &&
      wxml.includes('swatch-ovulation"><view class="ovu-dot"></view>'),
  );
});
