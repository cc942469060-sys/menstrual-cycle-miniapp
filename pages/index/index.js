const C = require('../../utils/cycle');

Page({
  data: {
    year: 2024,
    month: 1,
    calendarGrid: [],
    weekdays: ['日', '一', '二', '三', '四', '五', '六'],

    avgCycleLength: 28,
    avgPeriodLength: 5,
    customCycleLength: null,
    customPeriodLength: null,
    lastPeriodStart: '',
    nextPeriodStart: '',
    ovulationDay: '',
    upcomingPeriods: [],
    periodCount: 0,

    markedDates: [],
    predictedDates: [],
    pendingStart: '',

    showLegend: true,

    // 今天的 MM-dd 格式日期
    todayDateStr: '',

    // 首次使用设置
    setupCompleted: false,
    showSetup: false,
    setupCycleLength: 28,
    setupPeriodLength: 5,
  },

  onLoad() {
    this.loadData();
    const now = new Date();
    this.setData({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      todayDateStr: this.formatToday(now),
    });
    this.renderCalendar();

    // 首次使用：无记录且未完成过设置 → 弹出设置引导
    if (!this.data.setupCompleted && this.data.markedDates.length === 0) {
      this.setData({ showSetup: true });
    }
  },

  onShow() {
    // 每次打开小程序时重新渲染，确保自动续期逻辑生效
    const now = new Date();
    this.setData({ todayDateStr: this.formatToday(now) });
    this.renderCalendar();
  },

  formatToday(date) {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return m + '-' + d;
  },

  /* ==================== 数据持久化 ==================== */

  loadData() {
    try {
      const raw = wx.getStorageSync('cycle_data');
      if (raw) {
        this.setData({
          markedDates: raw.markedDates || [],
          avgCycleLength: raw.avgCycleLength || 28,
          avgPeriodLength: raw.avgPeriodLength || 5,
          customCycleLength: raw.customCycleLength || null,
          customPeriodLength: raw.customPeriodLength || null,
          setupCompleted: raw.setupCompleted || false,
        });
      }
    } catch (e) { /* ignore */ }
  },

  saveData() {
    try {
      wx.setStorageSync('cycle_data', {
        markedDates: this.data.markedDates,
        avgCycleLength: this.data.avgCycleLength,
        avgPeriodLength: this.data.avgPeriodLength,
        customCycleLength: this.data.customCycleLength,
        customPeriodLength: this.data.customPeriodLength,
        setupCompleted: this.data.setupCompleted,
      });
    } catch (e) { /* ignore */ }
  },

  /* ==================== 自动续期（纯函数） ==================== */

  /**
   * 根据 pendingStart 自动填充经期日期
   * 填充从 start 到 start+periodLength-1 的全部日期
   * 如果今天已超过 autoEnd，清除 pendingStart
   * 支持经期天数增减时的自动修正（先找到旧填充块的末尾，再重建）
   */
  applyAutoComplete(markedDates, pendingStart) {
    if (!pendingStart) return { markedDates, pendingStart };

    const periodLength = this.data.customPeriodLength || this.data.avgPeriodLength;
    const autoEnd = C.addDays(pendingStart, periodLength - 1);
    const today = C.formatDate(new Date());

    // 未来的开始日期，暂不填充
    if (today < pendingStart) return { markedDates, pendingStart };

    // 找到从 pendingStart 开始的连续已标记日期块的末尾
    // 这是上一次自动填充（或手动选择）的范围，需要完整清理后重建
    const markedSet = new Set(markedDates);
    let oldBlockEnd = pendingStart;
    while (markedSet.has(C.addDays(oldBlockEnd, 1))) {
      oldBlockEnd = C.addDays(oldBlockEnd, 1);
    }
    // 清理范围要覆盖整个旧块以及新的 autoEnd
    const clearEnd = autoEnd > oldBlockEnd ? autoEnd : oldBlockEnd;

    // 清理旧的填充范围 [pendingStart, clearEnd]
    const cleaned = markedDates.filter(d => d < pendingStart || d > clearEnd);

    // 重新填充从 start 到 autoEnd 的全部日期
    const cleanedSet = new Set(cleaned);
    const newMarked = [...cleaned];
    let current = pendingStart;
    while (current <= autoEnd) {
      if (!cleanedSet.has(current)) newMarked.push(current);
      current = C.addDays(current, 1);
    }

    // 今天已超过周期结束日期 → 自动完成，清除待定状态
    const newPending = today > autoEnd ? '' : pendingStart;
    return { markedDates: newMarked, pendingStart: newPending };
  },

  /* ==================== 预测计算（纯函数） ==================== */

  computePredictions(markedDates) {
    const periods = C.extractPeriods(markedDates);
    const stats = C.calculateStats(periods);

    let nextPeriodStart = '';
    let ovulationDay = '';
    const predictedDates = [];
    const upcomingPeriods = [];

    // 周期长度优先级：用户自定义 > 移动平均法（≥3 周期时） > 整体平均
    let effectiveCycleLength;
    if (this.data.customCycleLength) {
      effectiveCycleLength = this.data.customCycleLength;
    } else {
      // 尝试移动平均法：取最近 3~12 个周期的平均值
      const ma = C.predictWithMovingAverage(periods, 3, 12);
      if (ma) {
        effectiveCycleLength = ma.avgCycleLength;
      } else {
        effectiveCycleLength = stats.avgCycleLength;
      }
    }

    const effectivePeriodLength = this.data.customPeriodLength || stats.avgPeriodLength;

    if (stats.lastPeriodStart) {
      const today = C.formatDate(new Date());
      const oneYearLater = C.addDays(today, 365);
      let cursor = stats.lastPeriodStart;

      while (true) {
        const next = C.predictNextPeriod(cursor, effectiveCycleLength);
        if (!next || next.start > oneYearLater) break;

        if (next.start > today) {
          if (!nextPeriodStart) {
            nextPeriodStart = next.start;
            ovulationDay = C.getOvulationDay(next.start);
          }
          upcomingPeriods.push(next.start);
          for (let i = 0; i < effectivePeriodLength; i++) {
            predictedDates.push(C.addDays(next.start, i));
          }
        }

        cursor = next.start;
      }
    }

    return {
      avgCycleLength: stats.avgCycleLength,
      avgPeriodLength: stats.avgPeriodLength,
      lastPeriodStart: stats.lastPeriodStart,
      nextPeriodStart,
      ovulationDay,
      predictedDates,
      upcomingPeriods,
      periodCount: periods.length,
    };
  },

  /* ==================== 日历渲染 ==================== */

  /**
   * @param {string[]} [markedDates] - 可选，不传则使用 this.data.markedDates
   * @param {string}   [pendingStart] - 可选，不传则使用 this.data.pendingStart
   */
  renderCalendar(markedDates, pendingStart) {
    if (markedDates === undefined) markedDates = this.data.markedDates;
    if (pendingStart === undefined) pendingStart = this.data.pendingStart;

    // 自动续期
    const auto = this.applyAutoComplete(markedDates, pendingStart);
    markedDates = auto.markedDates;
    pendingStart = auto.pendingStart;

    // 计算预测
    const predictions = this.computePredictions(markedDates);

    // 生成日历网格
    const { year, month } = this.data;
    const markedSet = new Set(markedDates);
    const predictedSet = new Set(predictions.predictedDates);
    const grid = C.generateCalendarGrid(year, month, markedSet, predictedSet, predictions.ovulationDay, pendingStart);

    // 标记经期首尾
    const periods = C.extractPeriods(markedDates);
    const { startSet, endSet } = C.getPeriodBoundaries(periods);
    grid.forEach(cell => {
      cell.isPeriodStart = startSet.has(cell.date);
      cell.isPeriodEnd = endSet.has(cell.date);
    });

    // 唯一一次 setData，确保视图正确更新
    this.setData({
      calendarGrid: grid,
      markedDates,
      pendingStart,
      ...predictions,
    });

    this.saveData();
  },

  /* ==================== 月份导航 ==================== */

  prevMonth() {
    let { year, month } = this.data;
    if (month === 1) this.setData({ year: year - 1, month: 12 });
    else this.setData({ month: month - 1 });
    this.renderCalendar();
  },

  nextMonth() {
    let { year, month } = this.data;
    if (month === 12) this.setData({ year: year + 1, month: 1 });
    else this.setData({ month: month + 1 });
    this.renderCalendar();
  },

  goToToday() {
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 });
    this.renderCalendar();
  },

  /* ==================== 日期点击 ==================== */

  onDayTap(e) {
    const { date, iscurrentmonth } = e.currentTarget.dataset;
    if (!iscurrentmonth) return;

    const markedSet = new Set(this.data.markedDates);

    // --- 情况 1：点击已标记日期 → 清除该日期所在的整段经期 ---
    if (markedSet.has(date)) {
      const periods = C.extractPeriods(this.data.markedDates);
      const hit = periods.find(p => date >= p.start && date <= p.end);
      if (!hit) return;

      wx.showModal({
        title: '清除经期记录',
        content: `确定要清除 ${hit.start} ~ ${hit.end} 的经期记录吗？`,
        success: (res) => {
          if (res.confirm) {
            const keep = this.data.markedDates.filter(d => d < hit.start || d > hit.end);
            this.renderCalendar(keep, '');
          }
        },
      });
      return;
    }

    // --- 情况 2：没有待定的开始日期 → 设为经期开始 ---
    const pending = this.data.pendingStart;
    if (!pending) {
      this.renderCalendar(this.data.markedDates, date);
      return;
    }

    // --- 情况 3：点了同一个日期 → 取消 ---
    if (date === pending) {
      const periodLength = this.data.customPeriodLength || this.data.avgPeriodLength;
      const autoEnd = C.addDays(pending, periodLength - 1);
      // 移除从 pending 到 autoEnd 范围内的所有自动填充日期
      const filtered = this.data.markedDates.filter(d => d < pending || d > autoEnd);
      this.renderCalendar(filtered, '');
      wx.showToast({ title: '已取消', icon: 'none', duration: 1500 });
      return;
    }

    // --- 情况 4：有开始日期，点击结束日期 → 手动填充区间 ---
    // 先清除自动续期可能填充的日期
    const periodLength = this.data.customPeriodLength || this.data.avgPeriodLength;
    const autoEnd = C.addDays(pending, periodLength - 1);
    const cleanedDates = this.data.markedDates.filter(d => d < pending || d > autoEnd);

    const startDate = pending < date ? pending : date;
    const endDate = pending < date ? date : pending;

    const cleanedSet = new Set(cleanedDates);
    const newMarked = [...cleanedDates];
    let current = startDate;
    while (current <= endDate) {
      if (!cleanedSet.has(current)) newMarked.push(current);
      current = C.addDays(current, 1);
    }

    this.renderCalendar(newMarked, '');
    wx.showToast({ title: '已记录', icon: 'success', duration: 1500 });
  },

  /* ==================== 重置 ==================== */

  resetAll() {
    wx.showModal({
      title: '重置所有数据',
      content: '确定要清除全部经期记录吗？此操作不可撤销。',
      success: (res) => {
        if (res.confirm) {
          this.setData({
            markedDates: [],
            predictedDates: [],
            ovulationDay: '',
            nextPeriodStart: '',
            upcomingPeriods: [],
            lastPeriodStart: '',
            pendingStart: '',
            periodCount: 0,
            customCycleLength: null,
            customPeriodLength: null,
            setupCompleted: false,
          });
          this.saveData();
          this.renderCalendar([], '');
        }
      },
    });
  },

  /* ==================== UI ==================== */

  toggleLegend() {
    this.setData({ showLegend: !this.data.showLegend });
  },

  /* ==================== 设置 ==================== */

  changeCycleLength(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const cur = this.data.customCycleLength || this.data.avgCycleLength;
    const next = Math.max(18, Math.min(45, cur + delta));
    this.setData({ customCycleLength: next });
    this.renderCalendar();
  },

  changePeriodLength(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const cur = this.data.customPeriodLength || this.data.avgPeriodLength;
    const next = Math.max(2, Math.min(30,cur + delta));
    this.setData({ customPeriodLength: next });
    this.renderCalendar();
  },

  /* ==================== 首次使用设置弹窗 ==================== */

  onSetupCycleChange(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(18, Math.min(45, this.data.setupCycleLength + delta));
    this.setData({ setupCycleLength: next });
  },

  onSetupPeriodChange(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(2, Math.min(30,this.data.setupPeriodLength + delta));
    this.setData({ setupPeriodLength: next });
  },

  confirmSetup() {
    const { setupCycleLength, setupPeriodLength } = this.data;
    this.setData({
      customCycleLength: setupCycleLength,
      customPeriodLength: setupPeriodLength,
      showSetup: false,
      setupCompleted: true,
    });
    this.saveData();
    this.renderCalendar();
    wx.showToast({ title: '设置已保存', icon: 'success', duration: 1500 });
  },

  skipSetup() {
    this.setData({ showSetup: false, setupCompleted: true });
    this.saveData();
  },
});
