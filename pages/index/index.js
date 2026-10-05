const C = require('../../utils/cycle');
const S = require('../../utils/store');

Page({
  data: {
    year: 2026, month: 1, today: '', todayDateStr: '', calendarGrid: [],
    weekdays: ['日', '一', '二', '三', '四', '五', '六'], showLegend: true,
    loadError: '', migrationMessage: '', pendingStart: '', periodRows: [], hasMoreRecords: false,
    avgCycleLength: null, avgPeriodLength: null, lastPeriodStart: '', periodCount: 0, reviewCount: 0,
    cycleSampleCount: 0, periodSampleCount: 0, recordedIntervalText: '',
    nextPeriodStart: '', expectedWindowStart: '', expectedWindowEnd: '', predictionStatusText: '',
    predictionMessage: '', modelSource: '', upcomingPeriods: [], ovulationWindow: '', fertileWindow: '',
    predictionMode: 'auto', settingCycleLength: 28, settingPeriodLength: 5,
    showSetup: false, setupCycleLength: 28, setupPeriodLength: 5,
    editorVisible: false, editorId: '', editorStart: '', editorEnd: '', editorOngoing: false, editorExcludeGap: false,
  },

  onLoad() {
    this._state = null;
    this._loadReady = false;
    this._idCounter = 0;
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 });
    this.loadData();
  },

  onShow() {
    if (!this._loadReady) this.loadData();
    else this.renderCalendar();
    this.startTodayWatcher();
  },

  onHide() { this.stopTodayWatcher(); },
  onUnload() { this.stopTodayWatcher(); },

  loadData() {
    const result = S.load(wx, C.formatDate(new Date()));
    if (!result.ok) {
      this._loadReady = false;
      this.setData({ loadError: result.message, showSetup: false });
      this.renderCalendar();
      return false;
    }
    this._state = result.state;
    this._loadReady = true;
    this.setData({ loadError: '', migrationMessage: result.warnings.join(' '),
      showSetup: !result.state.setupCompleted && result.state.periods.length === 0,
      setupCycleLength: result.state.preferences.initialCycleLength,
      setupPeriodLength: result.state.preferences.initialPeriodLength });
    this.renderCalendar();
    return true;
  },

  retryLoad() { this.loadData(); },

  notify(message) { wx.showToast({ title: message, icon: 'none', duration: 3000 }); },

  canWrite() {
    if (this._loadReady) return true;
    this.notify('请先重试读取记录');
    return false;
  },

  commit(candidate, message) {
    if (!this.canWrite()) return false;
    const result = S.save(wx, candidate, C.formatDate(new Date()), this._state);
    if (!result.ok) { this.notify(result.message); return false; }
    this._state = result.state;
    this.renderCalendar();
    if (message) this.notify(message);
    return true;
  },

  renderCalendar() {
    const today = C.formatDate(new Date());
    const state = this._loadReady ? this._state : S.createState();
    const model = C.computePredictions(state, today);
    const grid = C.generateCalendarGrid(this.data.year, this.data.month, state.periods, model, state.draft, today);
    const rows = state.periods.slice().reverse().slice(0, 100).map(p => ({ ...p,
      statusText: p.start > today || (p.end && p.end > today) ? '日期待核对' : (p.status === 'needsReview' ? '待核对' : (p.status === 'ongoing' ? '进行中' : '已确认')),
      durationText: p.end ? `${C.daysBetween(p.start, p.end) + 1} 天` : '结束日未确认',
    }));
    this.setData({
      ...model, today, todayDateStr: today.slice(5), calendarGrid: grid,
      periodRows: rows, hasMoreRecords: state.periods.length > 100, pendingStart: state.draft ? state.draft.start : '',
      predictionMode: state.preferences.predictionMode,
      settingCycleLength: state.preferences.manualCycleLength || state.preferences.initialCycleLength,
      settingPeriodLength: state.preferences.manualPeriodLength || state.preferences.initialPeriodLength,
      recordedIntervalText: `共 ${model.recordedIntervals.length} 个开始日间隔；${model.excludedIntervals.length} 个已标记漏录，不参与周期平均。`,
    });
    this._todayKey = `${today}/${new Date().getTimezoneOffset()}`;
  },

  startTodayWatcher() {
    this.stopTodayWatcher();
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const delay = Math.max(50, Math.min(30000, midnight.getTime() - now.getTime() + 50));
    this._todayTimer = setTimeout(() => {
      const current = new Date();
      const key = `${C.formatDate(current)}/${current.getTimezoneOffset()}`;
      if (key !== this._todayKey) this.renderCalendar();
      this.startTodayWatcher();
    }, delay);
  },

  stopTodayWatcher() {
    if (this._todayTimer !== undefined && this._todayTimer !== null) clearTimeout(this._todayTimer);
    this._todayTimer = null;
  },

  prevMonth() {
    const { year, month } = this.data;
    if (year <= 1900 && month === 1) return;
    this.setData(month === 1 ? { year: year - 1, month: 12 } : { month: month - 1 });
    this.renderCalendar();
  },

  nextMonth() {
    const { year, month } = this.data;
    if (year >= 9998 && month === 12) return;
    this.setData(month === 12 ? { year: year + 1, month: 1 } : { month: month + 1 });
    this.renderCalendar();
  },

  goToToday() {
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 });
    this.renderCalendar();
  },

  onDayTap(event) {
    if (!this.canWrite()) return;
    const { date, iscurrentmonth } = event.currentTarget.dataset;
    if (!iscurrentmonth || !C.isDate(date)) return;
    const today = C.formatDate(new Date());
    const draft = this._state.draft;
    // A second click belongs to the draft, even if it hits an existing record.
    if (draft) {
      if (date > today) { this.notify('未来日期不能保存为实际记录'); return; }
      this.saveEvent({ id: '', start: draft.start < date ? draft.start : date,
        end: draft.start < date ? date : draft.start, ongoing: false, excludeGap: false, fromDraft: true });
      return;
    }
    const hit = this._state.periods.find(p => date >= p.start && date <= (p.end || p.start));
    if (hit) { this.openEditor(hit.id); return; }
    if (date > today) { this.notify('未来日期仅用于预测，不能录为已发生经期'); return; }
    const next = S.clone(this._state);
    next.draft = { start: date, end: null };
    this.commit(next);
  },

  cancelDraft() {
    if (!this.canWrite()) return;
    const next = S.clone(this._state);
    next.draft = null;
    this.commit(next, '已取消录入');
  },

  markOngoing() {
    if (!this.canWrite() || !this._state.draft) return;
    this.saveEvent({ id: '', start: this._state.draft.start, end: null, ongoing: true, excludeGap: false, fromDraft: true });
  },

  nextId() {
    let id;
    do { id = `period-${Date.now()}-${++this._idCounter}`; } while (this._state.periods.some(p => p.id === id));
    return id;
  },

  saveEvent(input) {
    if (!this.canWrite()) return;
    const today = C.formatDate(new Date());
    if (!C.isDate(input.start) || input.start > today || (!input.ongoing && (!C.isDate(input.end) || input.end > today || input.end < input.start))) {
      this.notify('请填写有效的实际日期，结束日不能早于开始日或晚于今天'); return;
    }
    const end = input.ongoing ? null : input.end;
    const collision = this._state.periods.some(p => p.id !== input.id && input.start <= (p.end || today) && (end || today) >= p.start);
    if (collision) { this.notify('与已有记录重叠，请先编辑或核对原记录'); return; }
    const apply = () => {
      if (input.id && !this._state.periods.some(p => p.id === input.id)) { this.notify('该记录已不存在，请重新选择'); return; }
      const next = S.clone(this._state);
      const record = { id: input.id || this.nextId(), start: input.start, end,
        status: input.ongoing ? 'ongoing' : 'completed', source: 'user', excludeGap: input.excludeGap === true };
      if (input.id) next.periods = next.periods.map(p => p.id === input.id ? record : p);
      else next.periods.push(record);
      if (input.fromDraft) next.draft = null;
      if (this.commit(next, '记录已保存')) this.setData({ editorVisible: false });
    };
    if (end && C.daysBetween(input.start, end) + 1 > 30) {
      wx.showModal({ title: '核对较长的记录范围', content: `此次共 ${C.daysBetween(input.start, end) + 1} 天。请确认确为一次实际出血记录；保存后保留原长度，不强行缩短。`, success: res => { if (res.confirm) apply(); } });
    } else apply();
  },

  openEditor(id) {
    if (!this.canWrite()) return;
    const hit = id ? this._state.periods.find(p => p.id === id) : null;
    if (id && !hit) return;
    const today = C.formatDate(new Date());
    const start = hit ? hit.start : (this._state.draft ? this._state.draft.start : today);
    this._editorFromDraft = !hit && !!this._state.draft;
    this.setData({ editorVisible: true, editorId: hit ? hit.id : '', editorStart: start,
      editorEnd: hit ? (hit.end || today) : start, editorOngoing: !!hit && hit.status === 'ongoing', editorExcludeGap: !!hit && hit.excludeGap });
  },

  addRecord() { this.openEditor(''); },
  onRecordTap(event) { this.openEditor(event.currentTarget.dataset.id); },
  closeEditor() { this.setData({ editorVisible: false }); },
  stopTap() {},
  onEditorStartChange(event) { this.setData({ editorStart: event.detail.value }); },
  onEditorEndChange(event) { this.setData({ editorEnd: event.detail.value }); },
  onEditorOngoingChange(event) { this.setData({ editorOngoing: event.detail.value }); },
  onEditorGapChange(event) { this.setData({ editorExcludeGap: event.detail.value }); },
  saveEditor() {
    this.saveEvent({ id: this.data.editorId, start: this.data.editorStart, end: this.data.editorEnd,
      ongoing: this.data.editorOngoing, excludeGap: this.data.editorExcludeGap, fromDraft: this._editorFromDraft });
  },

  deleteEditorRecord() {
    if (!this.canWrite() || !this.data.editorId) return;
    const id = this.data.editorId;
    const record = this._state.periods.find(p => p.id === id);
    if (!record) return;
    wx.showModal({ title: '删除这条记录', content: `确认删除 ${record.start} ~ ${record.end || '未结束'}？其他记录与当前录入草稿会保留。`, success: res => {
      if (!res.confirm) return;
      const next = S.clone(this._state);
      next.periods = next.periods.filter(p => p.id !== id);
      if (this.commit(next, '已删除这条记录')) this.setData({ editorVisible: false });
    } });
  },

  resetAll() {
    wx.showModal({ title: '备份并重置', content: '确定清除当前记录和设置吗？重置前会在本地保留一份备份，备份失败则停止重置。', success: res => {
      if (!res.confirm) return;
      const result = S.reset(wx, C.formatDate(new Date()));
      if (!result.ok) { this.notify(result.message); return; }
      this._state = result.state;
      this._loadReady = true;
      this.setData({ loadError: '', migrationMessage: '', editorVisible: false, showSetup: true, setupCycleLength: 28, setupPeriodLength: 5 });
      this.renderCalendar();
      this.notify('已备份并重置');
    } });
  },

  toggleLegend() { this.setData({ showLegend: !this.data.showLegend }); },

  restoreAutoMode() {
    if (!this.canWrite()) return;
    const next = S.clone(this._state);
    Object.assign(next.preferences, { predictionMode: 'auto', manualCycleLength: null, manualPeriodLength: null });
    this.commit(next, '已恢复自动预测，历史记录保留');
  },

  changeCycleLength(event) { this.changeManualParameter('cycle', event.currentTarget.dataset.delta); },
  changePeriodLength(event) { this.changeManualParameter('period', event.currentTarget.dataset.delta); },
  changeManualParameter(field, deltaValue) {
    if (!this.canWrite()) return;
    const delta = Number(deltaValue);
    if (delta !== 1 && delta !== -1) return;
    const next = S.clone(this._state);
    const prefs = next.preferences;
    let cycle = prefs.manualCycleLength || prefs.initialCycleLength;
    let period = prefs.manualPeriodLength || prefs.initialPeriodLength;
    if (field === 'cycle') cycle = Math.max(C.CYCLE_MIN, Math.min(C.CYCLE_MAX, cycle + delta));
    else period = Math.max(1, Math.min(C.PERIOD_MAX, period + delta));
    Object.assign(prefs, { predictionMode: 'manual', manualCycleLength: cycle, manualPeriodLength: period });
    this.commit(next);
  },

  onSetupCycleChange(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    if (delta === 1 || delta === -1) this.setData({ setupCycleLength: Math.max(C.CYCLE_MIN, Math.min(C.CYCLE_MAX, this.data.setupCycleLength + delta)) });
  },
  onSetupPeriodChange(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    if (delta === 1 || delta === -1) this.setData({ setupPeriodLength: Math.max(1, Math.min(C.PERIOD_MAX, this.data.setupPeriodLength + delta)) });
  },

  confirmSetup() {
    if (!this.canWrite()) return;
    const next = S.clone(this._state);
    next.setupCompleted = true;
    Object.assign(next.preferences, { predictionMode: 'auto', initialCycleLength: this.data.setupCycleLength,
      initialPeriodLength: this.data.setupPeriodLength, manualCycleLength: null, manualPeriodLength: null });
    if (this.commit(next, '初始参考已保存，后续按记录自动估计')) this.setData({ showSetup: false });
  },

  skipSetup() {
    if (!this.canWrite()) return;
    const next = S.clone(this._state);
    next.setupCompleted = true;
    if (this.commit(next)) this.setData({ showSetup: false });
  },
});
