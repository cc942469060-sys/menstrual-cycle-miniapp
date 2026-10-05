const DAY_MS = 86400000;
const CYCLE_MIN = 10;
const CYCLE_MAX = 180;
const PERIOD_MAX = 180;

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

function calculateStats(periods) {
  if (!Array.isArray(periods)) throw new Error('经期记录必须是数组');
  const sorted = periods.filter(p => p.status !== 'needsReview').slice().sort((a, b) => a.start.localeCompare(b.start));
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
  for (let i = 1; i < sorted.length; i++) {
    const length = daysBetween(sorted[i - 1].start, sorted[i].start);
    if (length <= 0) throw new Error('经期开始日期不能重复');
    recordedIntervals.push(length);
    if (sorted[i].excludeGap) excludedIntervals.push({ start: sorted[i - 1].start, end: sorted[i].start, length, reason: '用户标记漏录' });
    else cycleLengths.push(length);
  }
  const last = sorted[sorted.length - 1];
  return {
    avgCycleLength: mean(cycleLengths), avgPeriodLength: mean(periodLengths),
    avgRecordedInterval: mean(recordedIntervals), cycleLengths, recordedIntervals, excludedIntervals,
    cycleSampleCount: cycleLengths.length, periodSampleCount: periodLengths.length,
    minCycleLength: cycleLengths.length ? Math.min(...cycleLengths) : null,
    maxCycleLength: cycleLengths.length ? Math.max(...cycleLengths) : null,
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

function predictWithMovingAverage(periods, minSamples = 3, maxSamples = 12) {
  if (!Number.isInteger(minSamples) || minSamples < 1 || !Number.isInteger(maxSamples) || maxSamples < minSamples || maxSamples > 120) throw new Error('样本数量无效');
  const stats = calculateStats(periods);
  const samples = stats.cycleLengths.slice(-maxSamples);
  if (samples.length < minSamples) return null;
  const avgCycleLength = mean(samples);
  return { avgCycleLength, nextStart: addDays(stats.lastPeriodStart, avgCycleLength), sampleCount: samples.length, min: Math.min(...samples), max: Math.max(...samples) };
}

function getOvulationDay(nextStart) { return nextStart ? addDays(nextStart, -14) : ''; }

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
  const samples = stats.cycleLengths.slice(-12);
  const min = samples.length ? Math.min(...samples) : prefs.initialCycleLength;
  const max = samples.length ? Math.max(...samples) : prefs.initialCycleLength;
  const spread = max - min;
  const manual = prefs.predictionMode === 'manual';
  const cycleLength = manual ? prefs.manualCycleLength : (mean(samples) || prefs.initialCycleLength);
  const periodLength = manual ? prefs.manualPeriodLength : (stats.avgPeriodLength || prefs.initialPeriodLength);
  const hasOngoing = state.periods.some(p => p.status === 'ongoing');
  const recentGapExcluded = state.periods.filter(p => p.status !== 'needsReview').sort((a, b) => a.start.localeCompare(b.start)).slice(-1).some(p => p.excludeGap);
  // Model gates are product heuristics, not diagnostic definitions of regularity.
  let quality = samples.length >= 3 && spread <= 7 && min >= 18 && max <= 45 && !recentGapExcluded ? 'regular' : 'limited';
  let message = quality === 'regular' ? '按最近记录估计，远期日期的不确定性会增大。' : '样本不足或超出模型适用范围，日期仅作粗略参考，不推算易孕期。';
  if (spread > 7) { quality = 'irregular'; message = '记录间隔波动较大，请核对漏录；仅显示可能日期范围，不推算易孕期。'; }
  if (manual && (cycleLength < min || cycleLength > max)) { quality = 'limited'; message = '使用手动参数，与已记录间隔不同；不推算易孕期。'; }
  if (recentGapExcluded) message = '最近间隔已标记漏录；使用其他记录作粗略参考，不推算易孕期。';
  if (!Number.isInteger(cycleLength) || cycleLength < CYCLE_MIN || cycleLength > CYCLE_MAX || !Number.isInteger(periodLength) || periodLength < 1 || periodLength >= cycleLength) {
    quality = 'unavailable'; message = '当前经期长度或间隔不适合固定周期模型，真实记录已保留。';
  }
  const result = {
    ...stats, effectiveCycleLength: cycleLength, effectivePeriodLength: periodLength,
    modelSource: manual ? '手动参数' : (samples.length ? `最近 ${samples.length} 个已记录间隔` : '初始参考参数'),
    quality, predictionMessage: message, nextPeriodStart: '', nextPeriodEnd: '', predictionStatus: 'empty',
    predictionStatusText: '尚无确认的开始记录', overdueDays: 0, expectedWindowStart: '', expectedWindowEnd: '',
    predictedDates: [], upcomingPeriods: [], ovulationDates: [], fertileDates: [], ovulationWindow: '', fertileWindow: '',
  };
  if (futureRecords.length) return { ...result, quality: 'unavailable', predictionStatus: 'review', predictionStatusText: '请核对既有记录日期', predictionMessage: '既有记录晚于当前所在地的今天。原日期已保留，请核对设备日期或编辑记录，暂不预测。' };
  if (!stats.lastPeriodStart) return result;
  if (hasOngoing) return { ...result, predictionStatus: 'ongoing', predictionStatusText: '本次经期进行中', predictionMessage: '结束日期尚未确认，确认结束后再推算下一次。' };
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
  const maxIterations = Math.ceil(365 / cycleLength) + 2;
  // Retain the first expected date; never silently advance over missing records.
  for (let i = 1; i <= maxIterations; i++) {
    const start = addDays(stats.lastPeriodStart, i * cycleLength);
    if (start > endLimit || (i > 1 && (quality !== 'regular' || result.predictionStatus === 'overdue'))) break;
    const end = addDays(start, periodLength - 1);
    for (let day = 0; day < periodLength; day++) {
      const date = addDays(start, day);
      if (date <= endLimit && !covered(date)) predicted.add(date);
    }
    const entry = { start, end, ovulationStart: '', ovulationEnd: '', fertileStart: '', fertileEnd: '' };
    if (quality === 'regular' && result.predictionStatus !== 'overdue') {
      const window = getFertileWindow(addDays(stats.lastPeriodStart, i * rangeMin), addDays(stats.lastPeriodStart, i * rangeMax));
      Object.assign(entry, window);
      for (let n = 0, length = daysBetween(window.ovulationStart, window.ovulationEnd); n <= length; n++) {
        const date = addDays(window.ovulationStart, n);
        if (date <= endLimit && !covered(date)) ovu.add(date);
      }
      for (let n = 0, length = daysBetween(window.fertileStart, window.fertileEnd); n <= length; n++) {
        const date = addDays(window.fertileStart, n);
        if (date <= endLimit && !covered(date)) fertile.add(date);
      }
      if (i === 1) {
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

function generateCalendarGrid(year, month, periods, predictions, draft, today) {
  const first = monthStart(year, month);
  const start = addDays(first, -getFirstDayOfWeek(year, month));
  const predicted = new Set(predictions.predictedDates);
  const ovulation = new Set(predictions.ovulationDates);
  const fertile = new Set(predictions.fertileDates);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    const parsed = parseDate(date);
    const hit = periods.find(p => date >= p.start && date <= (p.end || p.start));
    const unreviewed = hit && (hit.status === 'needsReview' || hit.start > today || (hit.end && hit.end > today));
    const confirmed = hit && !unreviewed;
    return {
      date, day: parsed.getUTCDate(), isCurrentMonth: parsed.getUTCMonth() + 1 === month && parsed.getUTCFullYear() === year,
      isToday: date === today, isFuture: date > today, isWeekend: [0, 6].includes(parsed.getUTCDay()),
      periodId: hit ? hit.id : '', isMarked: !!confirmed, isUnreviewed: !!unreviewed,
      isPeriodStart: !!confirmed && date === hit.start, isPeriodEnd: !!confirmed && date === hit.end,
      isPending: !!draft && date === draft.start, isPredicted: !hit && predicted.has(date),
      isOvulation: !hit && ovulation.has(date), isFertile: !hit && fertile.has(date),
    };
  });
}

function getPeriodBoundaries(periods) {
  return { startSet: new Set(periods.map(p => p.start)), endSet: new Set(periods.filter(p => p.end).map(p => p.end)) };
}

module.exports = { DAY_MS, CYCLE_MIN, CYCLE_MAX, PERIOD_MAX, parseDate, formatDate, formatUTC, isDate, dateNumber, daysBetween, addDays,
  getDaysInMonth, getFirstDayOfWeek, extractPeriods, calculateStats, predictNextPeriod, predictWithMovingAverage, getOvulationDay,
  getFertileWindow, computePredictions, generateCalendarGrid, getPeriodBoundaries };
