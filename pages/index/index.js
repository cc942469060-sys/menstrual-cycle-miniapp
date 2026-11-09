const C = require('../../utils/cycle');
const S = require('../../utils/store');

// Manual adjustments start from the values the prediction currently uses, kept within valid bounds.
function manualBase(model) {
  const cycle = Math.max(C.CYCLE_MIN, Math.min(C.CYCLE_MAX, model.effectiveCycleLength));
  return { cycle, period: Math.max(1, Math.min(C.PERIOD_MAX, cycle - 1, model.effectivePeriodLength)) };
}

Page({
  data: {
    year: 2026, month: 1, today: '', todayDateStr: '', calendarGrid: [],
    weekdays: ['日', '一', '二', '三', '四', '五', '六'], showLegend: true,
    loadError: '', migrationMessage: '', pendingStart: '', periodRows: [], hasMoreRecords: false,
    avgCycleLength: null, typicalPeriodLength: null, lastPeriodStart: '', periodCount: 0, reviewCount: 0,
    ongoingStart: '', ongoingDay: 0, ongoingLong: false,
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
      durationText: p.end ? `${C.daysBetween(p.start, p.end) + 1} 天`
        : (p.status === 'ongoing' && p.start <= today ? `进行中 · 第 ${C.daysBetween(p.start, today) + 1} 天` : '结束日未确认'),
    }));
    const base = manualBase(model);
    const gapCount = model.excludedIntervals.filter(item => item.reason === 'gap').length;
    const spanCount = model.excludedIntervals.length - gapCount;
    const excludedText = [gapCount ? `${gapCount} 个已标记漏录` : '', spanCount ? `${spanCount} 个跨越待核对记录` : ''].filter(Boolean).join('、');
    const windowText = model.cycleLengths.length > C.MODEL_WINDOW ? `；平均只取最近 ${C.MODEL_WINDOW} 个` : '';
    this.setData({
      ...model, today, todayDateStr: today.slice(5), calendarGrid: grid,
      periodRows: rows, hasMoreRecords: state.periods.length > 100, pendingStart: state.draft ? state.draft.start : '',
      predictionMode: state.preferences.predictionMode, settingCycleLength: base.cycle, settingPeriodLength: base.period,
      recordedIntervalText: `共 ${model.recordedIntervals.length} 个开始日间隔${excludedText ? `；${excludedText}，不参与周期平均` : ''}${windowText}。`,
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
    const hit = this._state.periods.find(p => date >= p.start && date <= C.effectiveEnd(p, today));
    if (hit && hit.status === 'ongoing' && hit.start <= today) { this.offerOngoingEnd(hit, date); return; }
    if (hit) { this.openEditor(hit.id); return; }
    if (date > today) { this.notify('未来日期仅用于预测，不能录为已发生经期'); return; }
    const next = S.clone(this._state);
    next.draft = { start: date, end: null };
    this.commit(next);
  },

  // A tap inside an unfinished event most often means it ended on that day.
  offerOngoingEnd(record, date) {
    const days = C.daysBetween(record.start, date) + 1;
    wx.showActionSheet({ itemList: [`设为结束日：${date.slice(5)}（共 ${days} 天）`, '编辑这条记录'], success: res => {
      if (res.tapIndex === 0) this.saveEvent({ id: record.id, start: record.start, end: date, ongoing: false, excludeGap: record.excludeGap });
      if (res.tapIndex === 1) this.openEditor(record.id);
    } });
  },

  endOngoingToday() {
    if (!this.canWrite()) return;
    const record = this._state.periods.find(p => p.status === 'ongoing');
    if (record) this.saveEvent({ id: record.id, start: record.start, end: C.formatDate(new Date()), ongoing: false, excludeGap: record.excludeGap });
  },

  editOngoing() {
    const record = this._loadReady && this._state.periods.find(p => p.status === 'ongoing');
    if (!record) return;
    this.openEditor(record.id);
    this.setData({ editorOngoing: false });
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
    const collision = this._state.periods.some(p => p.id !== input.id && input.start <= C.effectiveEnd(p, today) && (end || today) >= p.start);
    if (collision) { this.notify('与已有记录重叠，请先编辑或核对原记录'); return; }
    const apply = () => {
      if (input.id && !this._state.periods.some(p => p.id === input.id)) { this.notify('该记录已不存在，请重新选择'); return; }
      const next = S.clone(this._state);
      const record = { id: input.id || this.nextId(), start: input.start, end,
        status: input.ongoing ? 'ongoing' : 'completed', source: 'user', excludeGap: input.excludeGap === true };
      if (input.id) next.periods = next.periods.map(p => p.id === input.id ? record : p);
      else next.periods.push(record);
      if (input.fromDraft) next.draft = null;
      const finish = () => { if (this.commit(next, '记录已保存')) this.setData({ editorVisible: false }); };
      const split = C.findSplitGap(this._state.periods, next.periods, record.id);
      if (!split) { finish(); return; }
      this.askSplitGap(split, (before, after) => {
        record.excludeGap = before;
        next.periods.forEach(p => { if (p.id === split.following.id) p.excludeGap = after; });
        finish();
      });
    };
    if (end && C.daysBetween(input.start, end) + 1 > 30) {
      wx.showModal({ title: '核对较长的记录范围', content: `此次共 ${C.daysBetween(input.start, end) + 1} 天。请确认确为一次实际出血记录；保存后保留原长度，不强行缩短。`, success: res => { if (res.confirm) apply(); } });
    } else apply();
  },

  // Back-filling inside a flagged gap splits it; only the user knows which part is still missing.
  askSplitGap(split, done) {
    const day = date => date.slice(5);
    wx.showActionSheet({
      alertText: `${split.following.start} 之前的间隔标记过有漏录，补录后哪段仍有漏录？`,
      itemList: ['已补齐，都没有漏录', `${day(split.previous.start)} ~ ${day(split.record.start)} 仍有漏录`,
        `${day(split.record.start)} ~ ${day(split.following.start)} 仍有漏录`, '两段都仍有漏录'],
      success: res => {
        if (res.tapIndex < 0 || res.tapIndex > 3) return;
        done(res.tapIndex === 1 || res.tapIndex === 3, res.tapIndex === 2 || res.tapIndex === 3);
      },
    });
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
    // Deleting merges this event's interval into the next one, so a known gap stays known.
    const others = this._state.periods.filter(p => p.status !== 'needsReview' && p.id !== id);
    const following = others.filter(p => p.start > record.start).sort((a, b) => a.start.localeCompare(b.start))[0];
    const moveGap = record.status !== 'needsReview' && record.excludeGap && !!following && !following.excludeGap && others.some(p => p.start < record.start);
    const gapText = moveGap ? `这条记录上的漏录标记会转到 ${following.start}。` : '';
    wx.showModal({ title: '删除这条记录', content: `确认删除 ${record.start} ~ ${record.end || '未结束'}？其他记录与当前录入草稿会保留。${gapText}`, success: res => {
      if (!res.confirm) return;
      const next = S.clone(this._state);
      next.periods = next.periods.filter(p => p.id !== id);
      if (moveGap) next.periods.forEach(p => { if (p.id === following.id) p.excludeGap = true; });
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

  // Like reset, restore stays available when the stored data cannot be read.
  restoreFromBackup() {
    const backups = S.listBackups(wx, C.formatDate(new Date()));
    if (!backups.length) { this.notify('暂无可恢复的备份'); return; }
    wx.showActionSheet({ itemList: backups.map(item => `${item.label} · ${item.count} 条记录`), success: res => {
      const backup = backups[res.tapIndex];
      if (!backup) return;
      const range = backup.first === backup.last ? backup.first : `${backup.first} ~ ${backup.last}`;
      wx.showModal({ title: '从备份恢复', content: `用「${backup.label}」的 ${backup.count} 条记录（${range}）替换当前数据？当前数据会先另存为「最近一次恢复或导入前」，之后仍可恢复回来。`, success: answer => {
        if (!answer.confirm) return;
        const result = S.restore(wx, backup.key, C.formatDate(new Date()));
        if (result.ok) this.applyReplacedState(result, '已从备份恢复');
        else this.notify(result.message);
      } });
    } });
  },

  applyReplacedState(result, message) {
    this._state = result.state;
    this._loadReady = true;
    this.setData({ loadError: '', migrationMessage: result.warnings.join(' '), editorVisible: false,
      showSetup: !result.state.setupCompleted && result.state.periods.length === 0 });
    this.renderCalendar();
    this.notify(message);
  },

  // wx.shareFileMessage only works while handling the tap itself, so everything before it is synchronous.
  exportToChat() {
    if (!this.canWrite()) return;
    const result = S.buildExport(this._state, C.formatDate(new Date()));
    if (!result.ok) { this.notify(result.message); return; }
    if (typeof wx.shareFileMessage !== 'function') { this.notify('当前微信版本不能发送文件，请改用复制备份文本'); return; }
    // A fixed name is overwritten by each export, so copies of the records do not pile up.
    const filePath = `${wx.env.USER_DATA_PATH}/cycle-backup.json`;
    try { wx.getFileSystemManager().writeFileSync(filePath, result.text, 'utf8'); }
    catch (error) { this.notify('备份文件写入失败，请重试或改用复制备份文本'); return; }
    wx.shareFileMessage({ filePath, fileName: result.fileName,
      success: () => this.notify(`已发送 ${result.count} 条记录的备份`), fail: error => this.reportFailure(error, '发送备份文件') });
  },

  copyBackupText() {
    if (!this.canWrite()) return;
    const result = S.buildExport(this._state, C.formatDate(new Date()));
    if (!result.ok) { this.notify(result.message); return; }
    // On success WeChat shows its own "内容已复制" toast.
    wx.setClipboardData({ data: result.text, fail: error => this.reportFailure(error, '复制备份文本') });
  },

  // Like restore, import stays available when the stored data cannot be read.
  importBackup() {
    wx.showActionSheet({ itemList: ['从聊天中的备份文件导入', '从剪贴板导入'], success: res => {
      if (res.tapIndex === 0) this.importFromChatFile();
      if (res.tapIndex === 1) this.importFromClipboard();
    } });
  },

  importFromChatFile() {
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['json'], success: res => {
      const file = res.tempFiles && res.tempFiles[0];
      if (!file) return;
      if (file.size > S.IMPORT_MAX_LENGTH) { this.notify('文件过大，不是本小程序导出的备份'); return; }
      let text;
      try { text = wx.getFileSystemManager().readFileSync(file.path, 'utf8'); }
      catch (error) { this.notify('无法读取这个文件，请重新选择'); return; }
      this.confirmImport(text);
    }, fail: error => this.reportFailure(error, '选择备份文件') });
  },

  importFromClipboard() {
    wx.getClipboardData({ success: res => this.confirmImport(res.data), fail: error => this.reportFailure(error, '读取剪贴板') });
  },

  confirmImport(text) {
    const preview = S.previewImport(text, C.formatDate(new Date()));
    if (!preview.ok) { this.notify(preview.message); return; }
    const range = preview.first === preview.last ? preview.first : `${preview.first} ~ ${preview.last}`;
    const kept = '替换前会自动另存一份，之后可在“从本机备份恢复”中找回。';
    let replaced = `将替换当前无法读取的数据。${kept}`;
    if (this._loadReady) replaced = this._state.periods.length ? `将替换当前的 ${this._state.periods.length} 条记录。${kept}` : '导入后将作为当前记录。';
    wx.showModal({ title: '导入备份', content: `备份中有 ${preview.count} 条记录（${range}），${replaced}`, success: answer => {
      if (!answer.confirm) return;
      const result = S.importText(wx, text, C.formatDate(new Date()));
      if (result.ok) this.applyReplacedState(result, `已导入 ${preview.count} 条记录`);
      else this.notify(result.message);
    } });
  },

  // Privacy-guarded APIs fail until they are declared in the admin console; cancelling stays silent.
  reportFailure(error, action) {
    const errMsg = (error && error.errMsg) || '';
    if (/fail cancel/.test(errMsg)) return;
    if ((error && error.errno === 112) || /privacy api banned|not declared in the privacy/.test(errMsg)) {
      wx.showModal({ title: '功能未开通', content: `${action}需要小程序在后台的用户隐私保护指引中声明对应用途，暂时无法使用。`, showCancel: false });
      return;
    }
    if (error && (error.errno === 103 || error.errno === 104)) { this.notify(`同意隐私保护指引后才能${action}`); return; }
    this.notify(`${action}失败，请重试`);
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
    let { cycle, period } = manualBase(C.computePredictions(this._state, C.formatDate(new Date())));
    if (field === 'cycle') cycle = Math.max(C.CYCLE_MIN, Math.min(C.CYCLE_MAX, cycle + delta));
    else period = Math.max(1, Math.min(C.PERIOD_MAX, period + delta));
    Object.assign(next.preferences, { predictionMode: 'manual', manualCycleLength: cycle, manualPeriodLength: period });
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
