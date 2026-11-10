const DAY_MS = 86400000;
const CYCLE_MIN = 10;
const CYCLE_MAX = 180;
const PERIOD_MAX = 180;
// Statistics and the prediction model share the same recent sample window.
const MODEL_WINDOW = 12;
// Estimated fertile windows are only projected this many cycles ahead.
const FERTILE_CYCLES = 2;
// An unfinished event lasting longer than this asks the user to confirm its end.
const ONGOING_PROMPT_DAYS = 10;

// Date-only values use UTC components; device time zones only determine today.
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期格式应为 YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('日期不存在');
  }
  return date;
}

function formatUTC(date) {
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new Error('日期超出支持范围');
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatDate(date) {
  if (!date || !Number.isFinite(date.getTime())) throw new Error('日期无效');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateNumber(value) {
  return parseDate(typeof value === 'string' ? value : formatDate(value)).getTime() / DAY_MS;
}

function daysBetween(start, end) { return dateNumber(end) - dateNumber(start); }

function addDays(value, days) {
  if (!Number.isSafeInteger(days)) throw new Error('天数必须是整数');
  return formatUTC(new Date((dateNumber(value) + days) * DAY_MS));
}

function isDate(value) { try { parseDate(value); return true; } catch (e) { return false; } }

function getDaysInMonth(year, month) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('年月无效');
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : ([4, 6, 9, 11].includes(month) ? 30 : 31);
}

function monthStart(year, month) { getDaysInMonth(year, month); return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`; }
function getFirstDayOfWeek(year, month) { return parseDate(monthStart(year, month)).getUTCDay(); }

function extractPeriods(markedDates) {
  if (!Array.isArray(markedDates)) throw new Error('日期记录必须是数组');
  const sorted = [...new Set(markedDates)].sort();
  sorted.forEach(parseDate);
  const periods = [];
  sorted.forEach(date => {
    const last = periods[periods.length - 1];
    if (last && daysBetween(last.end, date) === 1) last.end = date;
    else periods.push({ start: date, end: date });
  });
  return periods;
}

function mean(values) { return values.length ? Math.round(values.reduce((sum, n) => sum + n, 0) / values.length) : null; }

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// An unfinished event covers its start through today, never into the future.
function effectiveEnd(period, today) {
  if (period.end) return period.end;
  return period.status === 'ongoing' && today > period.start ? today : period.start;
}

function calculateStats(periods) {
  if (!Array.isArray(periods)) throw new Error('经期记录必须是数组');
  const all = periods.slice().sort((a, b) => a.start.localeCompare(b.start));
  const sorted = all.filter(p => p.status !== 'needsReview');
  const periodLengths = [];
  sorted.forEach(p => {
    parseDate(p.start);
    if (p.end !== null && p.end !== undefined) {
      const duration = daysBetween(p.start, p.end) + 1;
      if (duration < 1) throw new Error('结束日期不能早于开始日期');
      periodLengths.push(duration);
    }
  });
  const recordedIntervals = [];
  const cycleLengths = [];
  const excludedIntervals = [];
  let lastIntervalExclusion = '';
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    const length = daysBetween(previous.start, current.start);
    if (length <= 0) throw new Error('经期开始日期不能重复');
    recordedIntervals.push(length);
    // An unreviewed start inside the interval leaves its true cycle boundaries unknown.
    const spansReview = all.some(p => p.status === 'needsReview' && p.start > previous.start && p.start < current.start);
    const reason = current.excludeGap ? 'gap' : (spansReview ? 'review' : '');
    if (reason) excludedIntervals.push({ start: previous.start, end: current.start, length, reason });
    else cycleLengths.push(length);
    lastIntervalExclusion = reason;
  }
  const cycleSamples = cycleLengths.slice(-MODEL_WINDOW);
  // The median keeps a single unusually long bleed from stretching every later prediction.
  const periodSamples = periodLengths.slice(-MODEL_WINDOW);
  const last = sorted[sorted.length - 1];
  return {
    avgCycleLength: mean(cycleSamples), typicalPeriodLength: median(periodSamples),
    avgRecordedInterval: mean(recordedIntervals), cycleLengths, cycleSamples, recordedIntervals, excludedIntervals, lastIntervalExclusion,
    cycleSampleCount: cycleSamples.length, periodSampleCount: periodSamples.length,
    minCycleLength: cycleSamples.length ? Math.min(...cycleSamples) : null,
    maxCycleLength: cycleSamples.length ? Math.max(...cycleSamples) : null,
    lastPeriodStart: last ? last.start : '', lastPeriodEnd: last ? (last.end || '') : '',
    periodCount: sorted.length, reviewCount: periods.length - sorted.length,
  };
}

function predictNextPeriod(lastStart, cycleLength, periodLength = 5) {
  if (!lastStart) return null;
  if (!Number.isInteger(cycleLength) || cycleLength < CYCLE_MIN || cycleLength > CYCLE_MAX || !Number.isInteger(periodLength) || periodLength < 1 || periodLength >= cycleLength) throw new Error('预测天数不适用于固定周期模型');
  const start = addDays(lastStart, cycleLength);
  return { start, end: addDays(start, periodLength - 1) };
}

function getFertileWindow(earliestNextStart, latestNextStart = earliestNextStart) {
  const ovulationStart = addDays(earliestNextStart, -16);
  const ovulationEnd = addDays(latestNextStart, -10);
  return { ovulationStart, ovulationEnd, fertileStart: addDays(ovulationStart, -5), fertileEnd: ovulationEnd };
}

function computePredictions(state, today) {
  parseDate(today);
  const futureRecords = state.periods.filter(p => p.status !== 'needsReview' && (p.start > today || (p.end && p.end > today)));
  const stats = calculateStats(state.periods.filter(p => !futureRecords.includes(p)));
  stats.reviewCount += futureRecords.length;
  const prefs = state.preferences;
  const samples = stats.cycleSamples;
  const min = samples.length ? Math.min(...samples) : prefs.initialCycleLength;
  const max = samples.length ? Math.max(...samples) : prefs.initialCycleLength;
  const spread = max - min;
  const manual = prefs.predictionMode === 'manual';
  const cycleLength = manual ? prefs.manualCycleLength : (stats.avgCycleLength || prefs.initialCycleLength);
  const periodLength = manual ? prefs.manualPeriodLength : (stats.typicalPeriodLength || prefs.initialPeriodLength);
  const ongoing = state.periods.find(p => p.status === 'ongoing');
  const recentExclusion = stats.lastIntervalExclusion;
  // Model gates are product heuristics, not diagnostic definitions of regularity.
  let quality = 'limited';
  let message = '样本不足或超出模型适用范围，日期仅作粗略参考，不推算易孕期。';
  if (spread > 7) { quality = 'irregular'; message = '记录间隔波动较大，请核对漏录；仅显示可能日期范围，不推算易孕期。'; }
  else if (samples.length >= 3 && min >= 18 && max <= 45 && !recentExclusion) { quality = 'regular'; message = '按最近记录估计，远期日期的不确定性会增大。'; }
  if (manual && !samples.length) { quality = 'limited'; message = '使用手动参数，尚无可比较的记录间隔；日期仅作粗略参考，不推算易孕期。'; }
  else if (manual && (cycleLength < min || cycleLength > max)) { quality = 'limited'; message = '使用手动参数，与已记录间隔不同；不推算易孕期。'; }
  if (recentExclusion === 'gap') message = '最近间隔已标记漏录；使用其他记录作粗略参考，不推算易孕期。';
  if (recentExclusion === 'review') message = '最近间隔中有待核对的旧记录；使用其他记录作粗略参考，不推算易孕期。';
  if (!Number.isInteger(cycleLength) || cycleLength < CYCLE_MIN || cycleLength > CYCLE_MAX || !Number.isInteger(periodLength) || periodLength < 1 || periodLength >= cycleLength) {
    quality = 'unavailable'; message = '当前经期长度或间隔不适合固定周期模型，真实记录已保留。';
  }
  const result = {
    ...stats, effectiveCycleLength: cycleLength, effectivePeriodLength: periodLength,
    modelSource: manual ? '手动参数' : (samples.length ? `最近 ${samples.length} 个已记录间隔` : '初始参考参数'),
    quality, predictionMessage: message, nextPeriodStart: '', nextPeriodEnd: '', predictionStatus: 'empty',
    predictionStatusText: '尚无确认的开始记录', overdueDays: 0, expectedWindowStart: '', expectedWindowEnd: '',
    predictedDates: [], upcomingPeriods: [], ovulationDates: [], fertileDates: [], ovulationWindow: '', fertileWindow: '',
    ongoingId: '', ongoingStart: '', ongoingDay: 0, ongoingLong: false,
  };
  if (futureRecords.length) return { ...result, quality: 'unavailable', predictionStatus: 'review', predictionStatusText: '请核对既有记录日期', predictionMessage: '既有记录晚于当前所在地的今天。原日期已保留，请核对设备日期或编辑记录，暂不预测。' };
  if (!stats.lastPeriodStart) return result;
  if (ongoing) {
    const day = daysBetween(ongoing.start, today) + 1;
    const long = day > ONGOING_PROMPT_DAYS;
    return { ...result, ongoingId: ongoing.id, ongoingStart: ongoing.start, ongoingDay: day, ongoingLong: long,
      predictionStatus: 'ongoing', predictionStatusText: `经期第 ${day} 天（进行中）`,
      predictionMessage: long ? `已持续 ${day} 天。如果已经结束，请选择实际结束日；确认结束后再推算下一次。` : '结束日期尚未确认，确认结束后再推算下一次。' };
  }
  // A newer unreviewed legacy start would make the latest confirmed start misleading.
  if (state.periods.some(p => p.status === 'needsReview' && p.start > stats.lastPeriodStart)) {
    return { ...result, quality: 'unavailable', predictionStatus: 'review', predictionStatusText: '请先核对较新的旧记录', predictionMessage: '最近确认的开始日之后还有待核对的旧记录，核对实际日期后再推算。' };
  }
  if (quality === 'unavailable') return { ...result, predictionStatus: 'unavailable', predictionStatusText: '暂不提供固定日期预测' };
  const rangeMin = manual ? cycleLength : min;
  const rangeMax = manual ? cycleLength : max;
  result.expectedWindowStart = addDays(stats.lastPeriodStart, rangeMin);
  result.expectedWindowEnd = addDays(stats.lastPeriodStart, rangeMax);
  const next = predictNextPeriod(stats.lastPeriodStart, cycleLength, periodLength);
  if (quality !== 'irregular' || manual) {
    result.nextPeriodStart = next.start;
    result.nextPeriodEnd = next.end;
  }
  const due = result.nextPeriodStart || result.expectedWindowEnd;
  result.overdueDays = Math.max(0, daysBetween(due, today));
  result.predictionStatus = due < today ? 'overdue' : (due === today ? 'due' : 'upcoming');
  result.predictionStatusText = result.predictionStatus === 'overdue' ? `预计日期已过 ${result.overdueDays} 天，尚未确认` : (result.predictionStatus === 'due' ? '预计今天开始，尚未确认' : '预计日期尚未到');
  if (!result.nextPeriodStart) return result;
  const endLimit = addDays(today, 365);
  const predicted = new Set();
  const ovu = new Set();
  const fertile = new Set();
  const covered = date => state.periods.some(p => p.status === 'completed' && date >= p.start && date <= p.end);
  const addRange = (set, first, last) => {
    for (let n = 0, length = daysBetween(first, last); n <= length; n++) {
      const date = addDays(first, n);
      if (date <= endLimit && !covered(date)) set.add(date);
    }
  };
  const showWindows = quality === 'regular' && result.predictionStatus !== 'overdue';
  const maxIterations = Math.ceil(365 / cycleLength) + 2;
  // Retain the first expected date; never silently advance over missing records.
  for (let i = 1; i <= maxIterations; i++) {
    const start = addDays(stats.lastPeriodStart, i * cycleLength);
    if (start > endLimit || (i > 1 && (quality !== 'regular' || result.predictionStatus === 'overdue'))) break;
    const end = addDays(start, periodLength - 1);
    addRange(predicted, start, end);
    const entry = { start, end, ovulationStart: '', ovulationEnd: '', fertileStart: '', fertileEnd: '' };
    // The observed range widens with the square root of the cycles ahead (exactly min–max for
    // the next cycle). Further out, windows would merge with each other and with predicted
    // periods, so they are not projected at all.
    if (showWindows && i <= FERTILE_CYCLES) {
      const scale = Math.sqrt(i);
      const earliest = i * cycleLength - Math.ceil((cycleLength - rangeMin) * scale);
      const latest = i * cycleLength + Math.ceil((rangeMax - cycleLength) * scale);
      const window = getFertileWindow(addDays(stats.lastPeriodStart, earliest), addDays(stats.lastPeriodStart, latest));
      Object.assign(entry, window);
      addRange(ovu, window.ovulationStart, window.ovulationEnd);
      addRange(fertile, window.fertileStart, window.fertileEnd);
      // The summary names the first window that has not ended yet.
      if (!result.fertileWindow && window.fertileEnd >= today) {
        result.ovulationWindow = `${window.ovulationStart} ~ ${window.ovulationEnd}`;
        result.fertileWindow = `${window.fertileStart} ~ ${window.fertileEnd}`;
      }
    }
    if (start >= today) result.upcomingPeriods.push(entry);
  }
  result.predictedDates = [...predicted].sort();
  result.ovulationDates = [...ovu].sort();
  result.fertileDates = [...fertile].sort();
  if (result.predictionStatus === 'overdue') result.predictionMessage += ' 请确认实际开始日或补录；未继续外推后续周期。';
  return result;
}

// weekStartsOn: 0 puts Sunday in the first column, 1 puts Monday there.
function generateCalendarGrid(year, month, periods, predictions, draft, today, weekStartsOn = 0) {
  const first = monthStart(year, month);
  const start = addDays(first, -((getFirstDayOfWeek(year, month) - weekStartsOn + 7) % 7));
  const predicted = new Set(predictions.predictedDates);
  const ovulation = new Set(predictions.ovulationDates);
  const fertile = new Set(predictions.fertileDates);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    const parsed = parseDate(date);
    const hit = periods.find(p => date >= p.start && date <= effectiveEnd(p, today));
    const unreviewed = hit && (hit.status === 'needsReview' || hit.start > today || (hit.end && hit.end > today));
    const confirmed = hit && !unreviewed;
    const isPredicted = !hit && predicted.has(date);
    return {
      date, day: parsed.getUTCDate(), isCurrentMonth: parsed.getUTCMonth() + 1 === month && parsed.getUTCFullYear() === year,
      isToday: date === today, isMarked: !!confirmed, isUnreviewed: !!unreviewed,
      isPeriodStart: !!confirmed && date === hit.start, isPeriodEnd: !!confirmed && date === hit.end,
      isPending: !!draft && date === draft.start, isPredicted,
      // Actual records take precedence over predicted periods, which take precedence over estimated windows.
      isOvulation: !hit && !isPredicted && ovulation.has(date), isFertile: !hit && !isPredicted && fertile.has(date),
    };
  });
}

// Returns the gap-flagged interval that a newly placed confirmed event splits, if any.
function findSplitGap(previousPeriods, nextPeriods, id) {
  const confirmed = list => list.filter(p => p.status !== 'needsReview').sort((a, b) => a.start.localeCompare(b.start));
  const after = confirmed(nextPeriods);
  const index = after.findIndex(p => p.id === id);
  if (index < 1 || index > after.length - 2 || !after[index + 1].excludeGap) return null;
  const following = after[index + 1];
  const before = confirmed(previousPeriods);
  const followingIndex = before.findIndex(p => p.id === following.id);
  // The flag already described this exact interval if the event was the predecessor before.
  if (followingIndex > 0 && before[followingIndex - 1].id === id) return null;
  return { previous: after[index - 1], record: after[index], following };
}

module.exports = { DAY_MS, CYCLE_MIN, CYCLE_MAX, PERIOD_MAX, MODEL_WINDOW, FERTILE_CYCLES, ONGOING_PROMPT_DAYS, parseDate, formatDate, formatUTC,
  isDate, dateNumber, daysBetween, addDays, getDaysInMonth, getFirstDayOfWeek, extractPeriods, median, effectiveEnd, calculateStats,
  predictNextPeriod, getFertileWindow, computePredictions, generateCalendarGrid, findSplitGap };
