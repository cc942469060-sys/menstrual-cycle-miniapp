const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const C = require('../utils/cycle');
const S = require('../utils/store');
const root = path.resolve(__dirname, '..');
const pageSource = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
const copy = S.clone;
const record = (start, length = 5, extra = {}) => ({ id: `p-${start}`, start, end: C.addDays(start, length - 1), status: 'completed', source: 'user', excludeGap: false, ...extra });
function stateWith(periods = [], preferences = {}) {
  const state = S.createState(); state.setupCompleted = true; state.periods = periods;
  Object.assign(state.preferences, preferences); return state;
}
function storage(initial) {
  const values = new Map(); if (initial !== undefined) values.set(S.KEY, copy(initial));
  const writes = [], reads = [], toasts = [], modals = [], timers = new Map();
  let timerId = 0;
  const options = { readFailure: null, writeFailure: null, confirm: true };
  return { values, writes, reads, toasts, modals, timers, options,
    getStorageSync(key) { reads.push(key); if (options.readFailure && options.readFailure(key)) throw new Error('read failed'); return values.has(key) ? copy(values.get(key)) : ''; },
    setStorageSync(key, value) { if (options.writeFailure && options.writeFailure(key)) throw new Error('write failed'); writes.push({ key, value: copy(value) }); values.set(key, copy(value)); },
    showToast(value) { toasts.push(copy(value)); },
    showModal(value) { modals.push({title:value.title,content:value.content}); value.success({confirm:options.confirm}); },
    setTimeout(fn, delay) { const id=++timerId;timers.set(id,{fn,delay});return id; },
    clearTimeout(id) { timers.delete(id); },
  };
}
function page(initial = stateWith(), options = {}) {
  const wx = options.storage || storage(initial);
  let instant = options.today || '2026-10-03T12:00:00';
  class ClockDate extends Date { constructor(...args) {super(...(args.length?args:[instant]));} static now(){return new Date(instant).getTime();} }
  let def;
  vm.runInNewContext(pageSource, { Page:value=>{def=value;}, wx, Date:ClockDate,
    require:name=>name.includes('store')?S:C, setTimeout:(fn,ms)=>wx.setTimeout(fn,ms), clearTimeout:id=>wx.clearTimeout(id) }, {filename:path.join(root,'pages/index/index.js')});
  const p={...def,data:copy(def.data),setData(value){Object.assign(this.data,value);}};
  p.onLoad();
  return {p,wx,tap:date=>p.onDayTap({currentTarget:{dataset:{date,iscurrentmonth:true}}}),
    setNow:value=>{instant=value;}, snapshot:()=>copy(wx.values.get(S.KEY)), def};
}

test('P1-1 start selection is a persisted draft, not five actual days',()=>{
  const e=page();e.tap('2026-10-01');assert.equal(e.p._state.periods.length,0);assert.equal(e.p.data.periodCount,0);
  assert.deepEqual(e.snapshot().draft,{start:'2026-10-01',end:null});assert.equal(e.p.data.avgPeriodLength,null);
});
test('P1-1/2 second click saves the chosen short actual interval without deletion',()=>{
  const e=page();e.tap('2026-10-01');e.tap('2026-10-03');assert.equal(e.p._state.periods.length,1);
  assert.equal(e.p._state.periods[0].end,'2026-10-03');assert.equal(e.p.data.avgPeriodLength,3);assert.equal(e.wx.modals.length,0);assert.equal(e.p._state.draft,null);
});
test('P1-1 past records are not automatically completed',()=>{
  const e=page();e.tap('2026-09-10');assert.equal(e.p.data.pendingStart,'2026-09-10');e.tap('2026-09-16');
  assert.equal(e.p._state.periods.length,1);assert.equal(e.p._state.periods[0].end,'2026-09-16');assert.equal(e.p.data.avgPeriodLength,7);
});
test('P1-1 cross-year manual range retains its actual end',()=>{
  const e=page();e.tap('2025-12-30');e.p.prevMonth();e.tap('2026-01-02');assert.equal(e.p._state.periods[0].end,'2026-01-02');assert.equal(e.p.data.avgPeriodLength,4);
});
test('P1-2 a one-day period is supported by clicking the same date twice',()=>{
  const e=page();e.tap('2026-10-01');e.tap('2026-10-01');assert.equal(e.p.data.avgPeriodLength,1);assert.equal(e.p._state.periods[0].start,e.p._state.periods[0].end);
});
test('P1-2 reverse order clicks create the same explicit range',()=>{
  const e=page();e.tap('2026-09-15');e.tap('2026-09-10');assert.equal(e.p._state.periods[0].start,'2026-09-10');assert.equal(e.p._state.periods[0].end,'2026-09-15');
});
test('P1-3 rendering and month navigation never save or rewrite facts',()=>{
  const e=page(stateWith([record('2026-09-01',7)]));const before=e.snapshot();e.tap('2026-10-01');const draft=e.snapshot();const writes=e.wx.writes.length;
  e.p.prevMonth();e.p.nextMonth();e.p.goToToday();e.p.onShow();assert.deepEqual(e.snapshot(),draft);assert.equal(e.wx.writes.length,writes);assert.deepEqual(e.p._state.periods,before.periods);e.p.onHide();
});
test('P1-3 manual settings only change preferences',()=>{
  const e=page(stateWith([record('2026-09-01',7)]));const periods=copy(e.p._state.periods);
  e.p.changePeriodLength({currentTarget:{dataset:{delta:-1}}});assert.deepEqual(e.p._state.periods,periods);assert.equal(e.p.data.avgPeriodLength,7);
});
test('P1-4 failed read cannot trigger an empty overwrite',()=>{
  const wx=storage(stateWith([record('2026-09-01')]));wx.options.readFailure=()=>true;
  const e=page(undefined,{storage:wx});assert(e.p.data.loadError);assert.equal(wx.writes.length,0);assert.equal(wx.values.get(S.KEY).periods.length,1);
  e.tap('2026-10-01');assert.equal(wx.writes.length,0);
});
test('P1-4 retry recovers stored history without writing',()=>{
  const wx=storage(stateWith([record('2026-09-01')]));wx.options.readFailure=()=>true;const e=page(undefined,{storage:wx});
  wx.options.readFailure=null;e.p.retryLoad();assert.equal(e.p.data.loadError,'');assert.equal(e.p.data.periodCount,1);assert.equal(wx.writes.length,0);
});
test('P1-4 startup does not access or overwrite storage',()=>{
  let app;vm.runInNewContext(fs.readFileSync(path.join(root,'app.js'),'utf8'),{App:x=>{app=x;},wx:{getStorageSync(){throw new Error('must not be called');},setStorageSync(){throw new Error('must not be called');}}});
  assert(app);if(app.onLaunch)app.onLaunch();
});
test('P1-4 fresh loading does not save defaults',()=>{
  const wx=storage();const e=page(undefined,{storage:wx});assert.equal(e.p.data.showSetup,true);assert.equal(wx.writes.length,0);
});
test('P1-5 failed draft save leaves confirmed state unchanged',()=>{
  const e=page();const before=e.snapshot();e.wx.options.writeFailure=key=>key===S.KEY;e.tap('2026-10-01');assert.deepEqual(e.snapshot(),before);assert.equal(e.p._state.draft,null);assert.match(e.wx.toasts.at(-1).title,/保存失败/);
});
test('P1-5 failed completed save retains the draft for retry',()=>{
  const e=page();e.tap('2026-10-01');e.wx.options.writeFailure=key=>key===S.KEY;e.tap('2026-10-03');
  assert.equal(e.p._state.periods.length,0);assert.equal(e.p.data.pendingStart,'2026-10-01');assert(!e.wx.toasts.some(t=>t.title==='记录已保存'));
  e.wx.options.writeFailure=null;e.tap('2026-10-03');assert.equal(e.p._state.periods.length,1);
});
test('P1-5 failed settings save leaves the previous mode and values',()=>{
  const e=page();e.wx.options.writeFailure=()=>true;e.p.changeCycleLength({currentTarget:{dataset:{delta:1}}});assert.equal(e.p._state.preferences.predictionMode,'auto');assert.equal(e.p.data.settingCycleLength,28);
});
test('P1-5 failed deletion keeps the selected event and editor open',()=>{
  const e=page(stateWith([record('2026-09-01')]));e.p.openEditor('p-2026-09-01');e.wx.options.writeFailure=()=>true;e.p.deleteEditorRecord();assert.equal(e.p._state.periods.length,1);assert.equal(e.p.data.editorVisible,true);
});
test('P1-6 expected start today is retained and classified due',()=>{
  const r=C.computePredictions(stateWith([record('2026-09-03')]),'2026-10-01');assert.equal(r.nextPeriodStart,'2026-10-01');assert.equal(r.predictionStatus,'due');assert(r.predictedDates.includes('2026-10-01'));
});
test('P1-6 overdue keeps first expectation instead of simulating missed cycles',()=>{
  const r=C.computePredictions(stateWith([record('2026-08-01')]),'2026-10-01');assert.equal(r.nextPeriodStart,'2026-08-29');assert.equal(r.predictionStatus,'overdue');assert.equal(r.overdueDays,33);assert.equal(r.upcomingPeriods.length,0);assert.equal(r.fertileDates.length,0);
});
test('P1-6 period predicted before today still shows its remaining days',()=>{
  const r=C.computePredictions(stateWith([record('2026-09-03')]),'2026-10-03');assert(r.predictedDates.includes('2026-10-03'));assert(r.predictedDates.includes('2026-10-05'));assert.equal(r.nextPeriodStart,'2026-10-01');
});
test('P1-7 long observed intervals remain actual statistics',()=>{
  const periods=['2026-04-01','2026-05-31','2026-07-30'].map(start=>record(start));const r=C.calculateStats(periods);assert.equal(r.avgCycleLength,60);assert.deepEqual(r.cycleLengths,[60,60]);
});
test('P1-7 recent long interval is not silently dropped',()=>{
  const starts=['2026-03-01'];for(const n of [28,28,28,60])starts.push(C.addDays(starts.at(-1),n));const state=stateWith(starts.map(start=>record(start)));
  const ma=C.predictWithMovingAverage(state.periods);assert.equal(ma.avgCycleLength,36);const r=C.computePredictions(state,'2026-08-01');assert.equal(r.quality,'irregular');assert.equal(r.nextPeriodStart,'');assert.equal(r.fertileDates.length,0);
});
test('P1-7 alternating irregular intervals expose a range instead of a precise mean prediction',()=>{
  const starts=['2026-04-01'];for(const n of [18,45,18,45])starts.push(C.addDays(starts.at(-1),n));const r=C.computePredictions(stateWith(starts.map(start=>record(start))),'2026-08-10');
  assert.equal(r.avgCycleLength,32);assert.equal(r.quality,'irregular');assert.equal(r.nextPeriodStart,'');assert.equal(C.daysBetween(r.expectedWindowStart,r.expectedWindowEnd),27);
});
test('P1-7 no samples show unknown observed means, not default 28/5',()=>{
  const stats=C.calculateStats([]);assert.equal(stats.avgCycleLength,null);assert.equal(stats.avgPeriodLength,null);assert.equal(stats.cycleSampleCount,0);
});
test('P1-7 a marked missing interval is retained in raw evidence but excluded from modelling',()=>{
  const r=C.calculateStats([record('2026-04-01'),record('2026-05-31',5,{excludeGap:true})]);assert.deepEqual(r.recordedIntervals,[60]);assert.deepEqual(r.cycleLengths,[]);assert.equal(r.avgCycleLength,null);assert.equal(r.excludedIntervals[0].length,60);
});
test('P2-8 draft survives a cold reload',()=>{
  const e=page();e.tap('2026-10-01');const reload=page(undefined,{storage:e.wx});assert.equal(reload.p.data.pendingStart,'2026-10-01');reload.tap('2026-10-03');assert.equal(reload.p._state.periods[0].end,'2026-10-03');
});
test('P2-8 deleting an unrelated event preserves current draft',()=>{
  const e=page(stateWith([record('2026-09-01')]));e.tap('2026-10-01');e.p.openEditor('p-2026-09-01');e.p.deleteEditorRecord();assert.equal(e.p._state.periods.length,0);assert.equal(e.p.data.pendingStart,'2026-10-01');
});
test('P2-8 cancelling draft never deletes historical dates',()=>{
  const e=page(stateWith([record('2026-09-01')]));e.tap('2026-10-01');e.p.cancelDraft();assert.equal(e.p._state.draft,null);assert.equal(e.p._state.periods.length,1);
});
test('P2-9 adjacent entered events remain independent',()=>{
  const e=page();e.tap('2026-09-10');e.tap('2026-09-12');e.tap('2026-09-13');e.tap('2026-09-15');assert.equal(e.p._state.periods.length,2);assert.notEqual(e.p._state.periods[0].id,e.p._state.periods[1].id);
  const second=e.p._state.periods[1].id;e.p.openEditor(second);e.p.deleteEditorRecord();assert.equal(e.p._state.periods.length,1);assert.equal(e.p._state.periods[0].end,'2026-09-12');
});
test('P2-9 editing changes exactly one event and recalculates statistics',()=>{
  const e=page(stateWith([record('2026-07-01'),record('2026-07-29'),record('2026-09-02')]));e.p.openEditor('p-2026-07-29');e.p.onEditorStartChange({detail:{value:'2026-07-31'}});e.p.onEditorEndChange({detail:{value:'2026-08-06'}});e.p.saveEditor();
  assert.equal(e.p._state.periods[1].start,'2026-07-31');assert.equal(e.p._state.periods[1].end,'2026-08-06');assert.equal(e.p._state.periods[0].start,'2026-07-01');assert.equal(e.p._state.periods[2].start,'2026-09-02');assert.equal(e.p.data.avgPeriodLength,6);
});
test('P2-9 overlapping new range is rejected without deleting either record or draft',()=>{
  const e=page(stateWith([record('2026-09-10')]));e.tap('2026-09-08');e.tap('2026-09-12');assert.equal(e.p._state.periods.length,1);assert.equal(e.p.data.pendingStart,'2026-09-08');assert.match(e.wx.toasts.at(-1).title,/重叠/);
});
test('P2-9 legacy duplicates are deduplicated without creating extra periods',()=>{
  const r=S.migrateLegacy({markedDates:['2026-09-01','2026-09-01','2026-09-02']},'2026-10-03');assert.equal(r.state.periods.length,1);assert.equal(r.state.periods[0].end,'2026-09-02');
});
test('P2-9 legacy gaps remain separate until user reviews them',()=>{
  const r=S.migrateLegacy({markedDates:['2026-09-01','2026-09-02','2026-09-04','2026-09-05']},'2026-10-03');assert.equal(r.state.periods.length,2);assert(r.state.periods.every(p=>p.status==='needsReview'));
});
test('P2-10 first setup remains automatic and observations take over initial values',()=>{
  const e=page(S.createState());e.p.confirmSetup();assert.equal(e.p._state.preferences.predictionMode,'auto');assert.equal(e.p._state.preferences.manualCycleLength,null);
  const candidate=copy(e.p._state);candidate.periods=['2026-06-01','2026-07-01','2026-07-31','2026-08-30'].map(start=>record(start));e.p.commit(candidate);
  assert.equal(e.p.data.effectiveCycleLength,30);assert.equal(e.p.data.avgCycleLength,30);assert.match(e.p.data.modelSource,/最近 3/);
});
test('P2-10 restoring auto clears overrides while retaining all history',()=>{
  const e=page(stateWith([record('2026-09-01')],{predictionMode:'manual',manualCycleLength:35,manualPeriodLength:5}));e.p.restoreAutoMode();assert.equal(e.p._state.preferences.predictionMode,'auto');assert.equal(e.p._state.preferences.manualCycleLength,null);assert.equal(e.p._state.periods.length,1);
});
test('P2-10 invalid setup relationship is not persisted or dismissed',()=>{
  const e=page(S.createState());e.p.setData({setupCycleLength:18,setupPeriodLength:30});e.p.confirmSetup();assert.equal(e.p.data.showSetup,true);assert.equal(e.p._state.setupCompleted,false);assert.equal(e.wx.writes.length,0);
});
test('P2-11 future start tap cannot create a draft or a confirmed event',()=>{
  const e=page();e.tap('2026-10-10');assert.equal(e.p._state.draft,null);assert.equal(e.p._state.periods.length,0);assert.equal(e.wx.writes.length,0);
});
test('P2-11 future end is rejected and existing draft is retained',()=>{
  const e=page();e.tap('2026-10-01');e.tap('2026-10-05');assert.equal(e.p._state.periods.length,0);assert.equal(e.p.data.pendingStart,'2026-10-01');
});
test('P2-11 long confirmed bleeding is preserved with explicit confirmation and model suppression',()=>{
  const e=page();e.p.saveEvent({id:'',start:'2026-05-01',end:'2026-07-01',ongoing:false,excludeGap:false});assert.equal(e.p.data.avgPeriodLength,62);assert.equal(e.wx.modals.length,1);assert.equal(e.p.data.quality,'unavailable');assert.equal(e.p.data.predictedDates.length,0);
});
test('P2-11 cancelling long-range confirmation saves nothing',()=>{
  const e=page();e.wx.options.confirm=false;e.p.saveEvent({id:'',start:'2026-05-01',end:'2026-07-01',ongoing:false,excludeGap:false});assert.equal(e.p._state.periods.length,0);assert.equal(e.wx.writes.length,0);
});
test('P2-11 duration >= cycle is rejected for parameters, not by shortening facts',()=>{
  const candidate=stateWith([record('2026-06-01',30)],{predictionMode:'manual',manualCycleLength:18,manualPeriodLength:30});const wx=storage();const r=S.save(wx,candidate,'2026-10-03');assert.equal(r.ok,false);assert.equal(wx.writes.length,0);
  const model=C.computePredictions(stateWith([record('2026-06-01',30)]),'2026-10-03');assert.equal(model.avgPeriodLength,30);assert.equal(model.quality,'unavailable');
});
test('P2-12 unsupported schema and malformed records remain untouched',()=>{
  for(const raw of [{schemaVersion:3,periods:[]},{markedDates:{bad:true}},{markedDates:['2026-02-30']},'not an object']){
    const wx=storage(raw);const result=S.load(wx,'2026-10-03');assert.equal(result.ok,false);assert.deepEqual(wx.values.get(S.KEY),raw);assert.equal(wx.writes.length,0);
  }
});
test('P2-12 negative, string, nonfinite cycles cannot enter storage',()=>{
  for(const bad of [-1,0,'28',NaN,Infinity]){const candidate=stateWith([],{predictionMode:'manual',manualCycleLength:bad,manualPeriodLength:5});const wx=storage();assert.equal(S.save(wx,candidate,'2026-10-03').ok,false);assert.equal(wx.writes.length,0);}
});
test('P2-12 invalid direct predictor parameters terminate rather than loop',()=>{
  for(const value of [-1,0,'28',Infinity]){assert.throws(()=>C.predictNextPeriod('2026-10-01',value));const model=C.computePredictions(stateWith([record('2026-09-01')],{predictionMode:'manual',manualCycleLength:value,manualPeriodLength:5}),'2026-10-03');assert.equal(model.quality,'unavailable');}
});
test('P2-12 invalid calendar dates are rejected instead of normalized',()=>{
  for(const value of ['2026-02-30','2025-02-29','2026-13-01','2026-1-01','2026-01-00','0000-01-01'])assert.throws(()=>C.parseDate(value));assert.throws(()=>C.addDays('2026-10-01','28'));
});
test('P2-12 duplicate IDs, wrong status, and overlapping stored actual events are rejected',()=>{
  const inputs=[stateWith([record('2026-09-01'),record('2026-09-10',5,{id:'p-2026-09-01'})]),stateWith([record('2026-09-01',5,{status:'bad'})]),stateWith([record('2026-09-01'),record('2026-09-03')])];
  for(const candidate of inputs)assert.throws(()=>S.validateState(candidate,'2026-10-03'));
});
test('P2-13 regular observations produce windows for every projected future cycle',()=>{
  const state=stateWith(['2026-06-10','2026-07-08','2026-08-05','2026-09-02'].map(start=>record(start)));
  const r=C.computePredictions(state,'2026-09-10');assert.equal(r.quality,'regular');assert(r.upcomingPeriods.length>10);assert(r.upcomingPeriods.every(p=>p.ovulationStart&&p.fertileStart));
  const november=C.generateCalendarGrid(2026,11,state.periods,r,null,'2026-09-10');assert(november.some(c=>c.isOvulation));assert(november.some(c=>c.isFertile));
  assert.equal(new Set(r.predictedDates).size,r.predictedDates.length);assert.equal(new Set(r.fertileDates).size,r.fertileDates.length);
});
test('P2-13 fertility bounds include ovulation variability and five preceding days',()=>{
  assert.deepEqual(C.getFertileWindow('2026-10-01'),{ovulationStart:'2026-09-15',ovulationEnd:'2026-09-21',fertileStart:'2026-09-10',fertileEnd:'2026-09-21'});
});
test('P2-13 insufficient data does not claim a fertility window',()=>{
  const r=C.computePredictions(stateWith([record('2026-09-01')]),'2026-09-10');assert.equal(r.quality,'limited');assert.equal(r.fertileDates.length,0);assert.equal(r.ovulationWindow,'');
});
test('P3-14 ordinary cross-month, year, and leap dates are correct',()=>{
  assert.equal(C.addDays('2024-02-28',1),'2024-02-29');assert.equal(C.addDays('2025-12-30',4),'2026-01-03');assert.equal(C.daysBetween('2024-02-28','2024-03-01'),2);assert.equal(C.getDaysInMonth(1900,2),28);assert.equal(C.getDaysInMonth(2000,2),29);
});
for(const zone of ['Asia/Shanghai','America/New_York','Europe/Berlin','Pacific/Apia'])test(`P3-14 pure dates and historical skipped day are independent of ${zone}`,()=>{
  const source=`const C=require(${JSON.stringify(path.join(root,'utils/cycle.js'))});console.log(JSON.stringify([C.addDays('2011-12-29',1),C.daysBetween('2011-12-29','2011-12-31'),C.formatUTC(C.parseDate('2011-12-30')),C.daysBetween('2026-03-07','2026-03-09'),C.daysBetween('2026-03-28','2026-03-30'),C.daysBetween('2026-10-24','2026-10-26'),C.daysBetween('2026-10-31','2026-11-02')]));`;
  const r=cp.spawnSync(process.execPath,['-e',source],{env:{...process.env,TZ:zone},encoding:'utf8',timeout:5000,windowsHide:true});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),['2011-12-30',2,'2011-12-30',2,2,2,2]);
});
test('P3-15 goToToday updates header and grid from the same date',()=>{
  const e=page();e.setNow('2026-10-04T00:01:00');e.p.goToToday();assert.equal(e.p.data.todayDateStr,'10-04');assert.equal(e.p.data.calendarGrid.find(c=>c.isToday).date,'2026-10-04');assert.equal(e.wx.writes.length,0);
});
test('P3-15 foreground watcher refreshes at midnight without saving facts',()=>{
  const e=page();e.p.onShow();e.setNow('2026-10-04T00:01:00');const timer=[...e.wx.timers.values()][0];timer.fn();assert.equal(e.p.data.todayDateStr,'10-04');assert.equal(e.wx.timers.size,1);assert.equal(e.wx.writes.length,0);e.p.onHide();assert.equal(e.wx.timers.size,0);
});
test('P3-15 watcher is removed on unload and never duplicated on show',()=>{
  const e=page();e.p.onShow();e.p.onShow();assert.equal(e.wx.timers.size,1);e.p.onUnload();assert.equal(e.wx.timers.size,0);
});
test('migration backs up exact legacy input before updating schema',()=>{
  const raw={markedDates:['2026-09-01','2026-09-02','2026-10-10'],avgCycleLength:28,customCycleLength:28,customPeriodLength:5,setupCompleted:true};const wx=storage(raw);const r=S.load(wx,'2026-10-03');
  assert.equal(r.ok,true);assert.deepEqual(wx.values.get(S.LEGACY_BACKUP),raw);assert.equal(wx.writes[0].key,S.LEGACY_BACKUP);assert.equal(wx.writes[1].key,S.KEY);assert.equal(r.state.periods.length,2);assert(r.state.periods.every(p=>p.status==='needsReview'));assert.equal(C.calculateStats(r.state.periods).periodCount,0);
});
test('migration backup failure leaves original key and all records intact',()=>{
  const raw={markedDates:['2026-09-01']};const wx=storage(raw);wx.options.writeFailure=key=>key===S.LEGACY_BACKUP;const r=S.load(wx,'2026-10-03');assert.equal(r.ok,false);assert.deepEqual(wx.values.get(S.KEY),raw);assert.equal(wx.writes.length,0);
});
test('migration primary-save failure can retry without replacing the first backup',()=>{
  const raw={markedDates:['2026-09-01']};const wx=storage(raw);wx.options.writeFailure=key=>key===S.KEY;assert.equal(S.load(wx,'2026-10-03').ok,false);assert.deepEqual(wx.values.get(S.KEY),raw);assert.deepEqual(wx.values.get(S.LEGACY_BACKUP),raw);
  wx.options.writeFailure=null;assert.equal(S.load(wx,'2026-10-03').ok,true);assert.equal(wx.writes.filter(w=>w.key===S.LEGACY_BACKUP).length,1);
});
test('a later legacy import gets its own latest backup without replacing the original',()=>{
  const first={markedDates:['2026-09-01']};const second={markedDates:['2026-09-02','2026-09-03']};const wx=storage(second);wx.values.set(S.LEGACY_BACKUP,first);
  assert.equal(S.load(wx,'2026-10-03').ok,true);assert.deepEqual(wx.values.get(S.LEGACY_BACKUP),first);assert.deepEqual(wx.values.get(S.LEGACY_LATEST_BACKUP),second);
});
test('migration ignores derived legacy means and safely replaces invalid prediction settings',()=>{
  const r=S.migrateLegacy({markedDates:['2026-09-01'],avgPeriodLength:999,customCycleLength:-1,customPeriodLength:'30'},'2026-10-03');assert.equal(r.state.preferences.predictionMode,'auto');assert.equal(r.state.preferences.initialPeriodLength,5);assert(r.warnings.length>0);
});
test('confirming a legacy record supplies actual dates before statistical inclusion',()=>{
  const e=page({markedDates:['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05']});assert.equal(e.p.data.periodCount,0);assert.equal(e.p.data.reviewCount,1);const id=e.p._state.periods[0].id;e.p.openEditor(id);e.p.onEditorEndChange({detail:{value:'2026-09-03'}});e.p.saveEditor();assert.equal(e.p.data.periodCount,1);assert.equal(e.p.data.avgPeriodLength,3);assert.equal(e.p.data.reviewCount,0);
});
test('future legacy dates are retained but editable to actual history',()=>{
  const e=page({markedDates:['2026-10-10','2026-10-11']});assert.equal(e.p.data.periodCount,0);e.tap('2026-10-10');assert.equal(e.p.data.editorVisible,true);e.p.onEditorStartChange({detail:{value:'2026-09-10'}});e.p.onEditorEndChange({detail:{value:'2026-09-11'}});e.p.saveEditor();assert.equal(e.p.data.periodCount,1);assert.equal(e.p._state.periods[0].start,'2026-09-10');
});
test('ongoing record stores only a confirmed start and no inferred end',()=>{
  const e=page();e.tap('2026-10-01');e.p.markOngoing();assert.equal(e.p._state.periods[0].end,null);assert.equal(e.p._state.periods[0].status,'ongoing');assert.equal(e.p.data.avgPeriodLength,null);assert.equal(e.p.data.nextPeriodStart,'');const reload=page(undefined,{storage:e.wx});assert.equal(reload.p._state.periods[0].status,'ongoing');
});
test('an ongoing record can be explicitly completed without replacing its ID',()=>{
  const e=page();e.tap('2026-10-01');e.p.markOngoing();const id=e.p._state.periods[0].id;e.p.openEditor(id);e.p.onEditorOngoingChange({detail:{value:false}});e.p.onEditorEndChange({detail:{value:'2026-10-03'}});e.p.saveEditor();assert.equal(e.p._state.periods[0].id,id);assert.equal(e.p._state.periods[0].status,'completed');assert.equal(e.p.data.avgPeriodLength,3);
});
test('another event cannot be added inside an unfinished event',()=>{
  const e=page(stateWith([record('2026-09-29',5,{end:null,status:'ongoing'})]));e.p.saveEvent({id:'',start:'2026-10-01',end:'2026-10-02',ongoing:false,excludeGap:false});assert.equal(e.p._state.periods.length,1);
});
test('reset is backed up and cancelled if backup fails',()=>{
  const wx=storage(stateWith([record('2026-09-01')]));const before=copy(wx.values.get(S.KEY));wx.options.writeFailure=key=>key===S.RESET_BACKUP;assert.equal(S.reset(wx,'2026-10-03').ok,false);assert.deepEqual(wx.values.get(S.KEY),before);
});
test('explicit reset can back up malformed data without deleting it on read failure',()=>{
  const raw={bad:true};const wx=storage(raw);assert.equal(S.reset(wx,'2026-10-03').ok,true);assert.deepEqual(wx.values.get(S.RESET_BACKUP),raw);assert.equal(wx.values.get(S.KEY).schemaVersion,2);
  const wx2=storage(raw);wx2.options.readFailure=()=>true;assert.equal(S.reset(wx2,'2026-10-03').ok,false);assert.deepEqual(wx2.values.get(S.KEY),raw);
});
test('repeated resets preserve the original backup',()=>{
  const original=stateWith([record('2026-09-01')]);const wx=storage(original);assert.equal(S.reset(wx,'2026-10-03').ok,true);assert.equal(S.reset(wx,'2026-10-03').ok,true);
  assert.deepEqual(wx.values.get(S.RESET_BACKUP),original);assert.equal(wx.values.get(S.RESET_LATEST_BACKUP).periods.length,0);
});
test('clock or time-zone date rollback preserves existing records without pretending they are past',()=>{
  const original=stateWith([record('2026-10-03',1)]);const wx=storage(original);const e=page(undefined,{storage:wx,today:'2026-10-02T23:00:00'});
  assert.equal(e.p.data.loadError,'');assert.deepEqual(e.snapshot(),original);assert.equal(e.p.data.predictionStatus,'review');assert.equal(e.p.data.nextPeriodStart,'');assert.equal(wx.writes.length,0);
  e.p.changeCycleLength({currentTarget:{dataset:{delta:1}}});assert.equal(e.p._state.periods[0].end,'2026-10-03');assert.equal(e.p.data.predictionStatus,'review');
});
test('new future records are rejected even when existing-date rollback tolerance is enabled',()=>{
  const wx=storage(stateWith());const candidate=stateWith([record('2026-10-10')]);assert.equal(S.save(wx,candidate,'2026-10-03',stateWith()).ok,false);assert.equal(wx.writes.length,0);
});
test('clock rollback preserves an existing draft and still permits explicit cancellation',()=>{
  const original=stateWith();original.draft={start:'2026-10-03',end:null};const wx=storage(original);const e=page(undefined,{storage:wx,today:'2026-10-02T23:00:00'});
  assert.equal(e.p.data.pendingStart,'2026-10-03');e.p.cancelDraft();assert.equal(e.p._state.draft,null);assert.equal(e.p.data.loadError,'');
});
test('normal stats keep inclusive end and actual consecutive start differences',()=>{
  const r=C.calculateStats([record('2026-08-01'),record('2026-08-29')]);assert.equal(r.avgCycleLength,28);assert.equal(r.avgPeriodLength,5);
});
test('period predictor uses the supplied duration, not a fixed five days',()=>{
  const r=C.predictNextPeriod('2026-09-01',28,7);assert.equal(r.start,'2026-09-29');assert.equal(r.end,'2026-10-05');
});
test('moving average requires four starts and uses the latest twelve unfiltered intervals',()=>{
  const starts=['2025-05-01'];for(const n of [20,...Array(12).fill(30)])starts.push(C.addDays(starts.at(-1),n));const periods=starts.map(start=>record(start));assert.equal(C.predictWithMovingAverage(periods.slice(0,3)),null);assert.equal(C.predictWithMovingAverage(periods).avgCycleLength,30);
});
test('calendar has 42 unique consecutive dates and highlights a one-day event as start and end',()=>{
  const state=stateWith([record('2026-10-01',1)]);const model=C.computePredictions(state,'2026-10-03');for(const [year,month]of [[2024,2],[2025,12],[2026,1],[2026,10]]){
    const grid=C.generateCalendarGrid(year,month,state.periods,model,null,'2026-10-03');assert.equal(grid.length,42);assert.equal(new Set(grid.map(c=>c.date)).size,42);assert.equal(grid.filter(c=>c.isCurrentMonth).length,C.getDaysInMonth(year,month));for(let i=1;i<grid.length;i++)assert.equal(C.daysBetween(grid[i-1].date,grid[i].date),1);
  }const cell=C.generateCalendarGrid(2026,10,state.periods,model,null,'2026-10-03').find(c=>c.date==='2026-10-01');assert(cell.isPeriodStart&&cell.isPeriodEnd);
});
test('WXML tags are balanced and all declared handlers exist',()=>{
  const wxml=fs.readFileSync(path.join(root,'pages/index/index.wxml'),'utf8');const stack=[];const tokens=wxml.match(/<\/?[\w:-]+\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)||[];
  for(const token of tokens){const tag=token.match(/^<\/?([\w:-]+)/)[1];if(token.startsWith('</'))assert.equal(stack.pop(),tag,token);else if(!token.endsWith('/>'))stack.push(tag);}assert.equal(stack.length,0);
  const e=page();for(const match of wxml.matchAll(/(?:bind|catch)(?:tap|change)="([^"]+)"/g))assert.equal(typeof e.def[match[1]],'function',match[1]);
  assert(!wxml.includes('准确预测'));assert(wxml.includes('估计易孕窗口'));assert(wxml.includes('恢复自动预测'));assert(wxml.includes('editorExcludeGap'));
});
