// Turns the prediction model into the smaller data the index page renders. The page keeps the
// full model for its own logic; only these fields cross to the view layer through setData.
const C = require('./cycle');

// Picker ranges cover what people realistically need; stored values outside them are still shown.
const CYCLE_PICK_MIN = 15;
const CYCLE_PICK_MAX = 90;
const PERIOD_PICK_MAX = 15;
const ROW_LIMIT = 100;
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const CYCLE_OPTIONS = range(CYCLE_PICK_MIN, CYCLE_PICK_MAX).map(n => `${n} 天`);
const PERIOD_OPTIONS = range(1, PERIOD_PICK_MAX).map(n => `${n} 天`);

// Manual adjustments start from the values the prediction currently uses, kept within valid bounds.
function manualBase(model) {
  const cycle = clamp(model.effectiveCycleLength, C.CYCLE_MIN, C.CYCLE_MAX);
  return { cycle, period: clamp(model.effectivePeriodLength, 1, Math.min(C.PERIOD_MAX, cycle - 1)) };
}

function pickerIndexes(cycle, period) {
  return {
    cycleIndex: clamp(cycle, CYCLE_PICK_MIN, CYCLE_PICK_MAX) - CYCLE_PICK_MIN,
    periodIndex: clamp(period, 1, PERIOD_PICK_MAX) - 1,
  };
}

function cellClass(cell) {
  const classes = ['day-cell'];
  if (!cell.isCurrentMonth) classes.push('dimmed');
  if (cell.isToday) classes.push('today');
  if (cell.isMarked && !cell.isPeriodStart && !cell.isPeriodEnd) classes.push('period-mid');
  if (cell.isPeriodStart) classes.push('period-start');
  if (cell.isPeriodEnd) classes.push('period-end');
  if (cell.isPredicted) classes.push('predicted');
  if (cell.isUnreviewed) classes.push('unreviewed');
  if (cell.isFertile) classes.push('fertile');
  if (cell.isPending) classes.push('pending');
  return classes.join(' ');
}

// What a screen reader announces for a day, since colours and small marks carry the meaning.
function cellLabel(cell) {
  const [, month, day] = cell.date.split('-').map(Number);
  const parts = [`${month}月${day}日 星期${WEEKDAY_LABELS[C.parseDate(cell.date).getUTCDay()]}`];
  if (cell.isToday) parts.push('今天');
  if (!cell.isCurrentMonth) parts.push('其他月份');
  if (cell.isPeriodStart) parts.push('经期开始');
  if (cell.isPeriodEnd) parts.push('经期结束');
  if (cell.isMarked && !cell.isPeriodStart && !cell.isPeriodEnd) parts.push('经期中');
  if (cell.isUnreviewed) parts.push('旧记录待核对');
  if (cell.isPending) parts.push('已选为开始日');
  if (cell.isPredicted) parts.push('预计经期');
  if (cell.isOvulation) parts.push('估计排卵窗口');
  else if (cell.isFertile) parts.push('估计易孕窗口');
  return parts.join('，');
}

// Template cells carry only what WXML reads; flags that are false are left out.
function viewCell(cell) {
  const view = { date: cell.date, day: cell.day, cls: cellClass(cell), label: cellLabel(cell) };
  // Ovulation days show a dot; other fertile days a bar, so neither depends on colour alone.
  if (cell.isOvulation) view.ovulation = true;
  else if (cell.isFertile) view.fertile = true;
  if (cell.isPeriodStart) view.start = true;
  if (cell.isPeriodEnd) view.end = true;
  if (cell.isUnreviewed) view.review = true;
  return view;
}

function weekdays(weekStartsOn) {
  return range(0, 6).map(i => {
    const day = (i + weekStartsOn) % 7;
    return { label: WEEKDAY_LABELS[day], weekend: day === 0 || day === 6 };
  });
}

function intervalText(model) {
  const gapCount = model.excludedIntervals.filter(item => item.reason === 'gap').length;
  const spanCount = model.excludedIntervals.length - gapCount;
  const excluded = [gapCount ? `${gapCount} 个已标记漏录` : '', spanCount ? `${spanCount} 个跨越待核对记录` : '']
    .filter(Boolean)
    .join('、');
  const window = model.cycleLengths.length > C.MODEL_WINDOW ? `；平均只取最近 ${C.MODEL_WINDOW} 个` : '';
  return `共 ${model.recordedIntervals.length} 个开始日间隔${excluded ? `；${excluded}，不参与周期平均` : ''}${window}。`;
}

// One headline for the top of the page: where the user is in the cycle right now.
function describeStatus(model, today) {
  const until = date => C.daysBetween(today, date);
  const rough = model.quality === 'regular' ? '' : '，仅作粗略参考';
  const range = `${model.expectedWindowStart} ~ ${model.expectedWindowEnd}`;
  switch (model.predictionStatus) {
    case 'ongoing':
      return {
        tone: 'period',
        title: `经期第 ${model.ongoingDay} 天`,
        detail: model.ongoingLong
          ? `从 ${model.ongoingStart} 开始，持续时间较长；如果已经结束，请确认结束日。`
          : `从 ${model.ongoingStart} 开始，结束后点日历上的结束日即可。`,
      };
    case 'due':
      return { tone: 'alert', title: '预计今天开始', detail: `如果已经开始，点日历上的今天记录${rough}。` };
    case 'overdue':
      return {
        tone: 'alert',
        title: `比预计晚了 ${model.overdueDays} 天`,
        detail: `预计 ${model.nextPeriodStart || model.expectedWindowEnd}，还没有记录开始；如果已经开始，请补录。`,
      };
    case 'upcoming':
      if (model.nextPeriodStart)
        return {
          tone: 'normal',
          title: `距下次经期约 ${until(model.nextPeriodStart)} 天`,
          detail: `预计 ${model.nextPeriodStart} 开始${rough}。`,
        };
      if (model.expectedWindowStart > today) {
        return {
          tone: 'normal',
          title: `下次经期约在 ${until(model.expectedWindowStart)}～${until(model.expectedWindowEnd)} 天后`,
          detail: `记录间隔波动较大，可能范围 ${range}。`,
        };
      }
      return {
        tone: 'normal',
        title: `下次经期可能在 ${until(model.expectedWindowEnd)} 天内开始`,
        detail: `记录间隔波动较大，可能范围 ${range}。`,
      };
    case 'review':
      return {
        tone: 'alert',
        title: model.predictionStatusText,
        detail: '点日历上标着“核对”的日期或记录列表中的记录，确认实际日期后再预测。',
      };
    case 'unavailable':
      return { tone: 'normal', title: '暂不提供日期预测', detail: '当前记录不适合固定周期模型，真实记录已保留。' };
    default:
      return {
        tone: 'normal',
        title: '还没有经期记录',
        detail: '点日历选择实际开始日和结束日，或使用下方的“添加 / 补录”。',
      };
  }
}

function buildRows(periods, today) {
  const periodRows = periods
    .slice()
    .reverse()
    .slice(0, ROW_LIMIT)
    .map(p => {
      const datesAhead = p.start > today || (p.end && p.end > today);
      const statusText = datesAhead ? '日期待核对' : { needsReview: '待核对', ongoing: '进行中' }[p.status] || '已确认';
      let durationText = '结束日未确认';
      if (p.end) durationText = `${C.daysBetween(p.start, p.end) + 1} 天`;
      else if (p.status === 'ongoing' && p.start <= today)
        durationText = `进行中 · 第 ${C.daysBetween(p.start, today) + 1} 天`;
      return {
        id: p.id,
        start: p.start,
        end: p.end,
        status: p.status,
        excludeGap: p.excludeGap,
        statusText,
        durationText,
      };
    });
  return { periodRows, hasMoreRecords: periods.length > ROW_LIMIT };
}

// Everything the template renders, derived from the state and the full model.
function buildView(state, model, grid, today) {
  const status = describeStatus(model, today);
  const base = manualBase(model);
  const weekStartsOn = state.preferences.weekStartsOn || 0;
  return {
    today,
    todayDateStr: today.slice(5),
    weekStartsOn,
    weekdays: weekdays(weekStartsOn),
    calendarGrid: grid.map(viewCell),
    ...buildRows(state.periods, today),
    pendingStart: state.draft ? state.draft.start : '',
    statusTitle: status.title,
    statusDetail: status.detail,
    statusTone: status.tone,
    ongoingStart: model.ongoingStart,
    avgCycleLength: model.avgCycleLength,
    typicalPeriodLength: model.typicalPeriodLength,
    cycleSampleCount: model.cycleSampleCount,
    periodSampleCount: model.periodSampleCount,
    periodCount: model.periodCount,
    reviewCount: model.reviewCount,
    lastPeriodStart: model.lastPeriodStart,
    nextPeriodStart: model.nextPeriodStart,
    expectedWindowStart: model.expectedWindowStart,
    expectedWindowEnd: model.expectedWindowEnd,
    modelSource: model.modelSource,
    predictionMessage: model.predictionMessage,
    ovulationWindow: model.ovulationWindow,
    fertileWindow: model.fertileWindow,
    upcomingPeriods: model.upcomingPeriods.map(p => ({
      start: p.start,
      end: p.end,
      range: p.earliestStart !== p.latestStart ? `${p.earliestStart} ~ ${p.latestStart}` : '',
    })),
    recordedIntervalText: intervalText(model),
    predictionMode: state.preferences.predictionMode,
    settingCycleLength: base.cycle,
    settingPeriodLength: base.period,
    ...pickerIndexes(base.cycle, base.period),
  };
}

// Returns only what changed since the previous render. Object arrays of unchanged length (such as
// the calendar grid) are patched per item, since setData accepts "key[index]" paths.
function diffData(previous, next) {
  const patch = {};
  Object.keys(next).forEach(key => {
    const before = previous ? previous[key] : undefined;
    const after = next[key];
    if (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      after.length &&
      typeof after[0] === 'object'
    ) {
      after.forEach((item, index) => {
        if (JSON.stringify(item) !== JSON.stringify(before[index])) patch[`${key}[${index}]`] = item;
      });
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      patch[key] = after;
    }
  });
  return patch;
}

function repairText(repair) {
  const parts = [];
  if (repair.removedCount) parts.push(`隔离 ${repair.removedCount} 条格式异常的记录`);
  if (repair.resetPreferences) parts.push('把预测设置恢复为默认');
  if (repair.droppedDraft) parts.push('丢弃未完成的录入');
  return `可以${parts.length ? parts.join('、') : '修正格式问题'}后继续使用其余记录；修复前会完整备份原数据。`;
}

module.exports = {
  CYCLE_PICK_MIN,
  CYCLE_PICK_MAX,
  PERIOD_PICK_MAX,
  CYCLE_OPTIONS,
  PERIOD_OPTIONS,
  manualBase,
  pickerIndexes,
  cellClass,
  cellLabel,
  viewCell,
  weekdays,
  intervalText,
  describeStatus,
  buildRows,
  buildView,
  diffData,
  repairText,
};
