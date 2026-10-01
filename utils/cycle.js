/**
 * 获取指定年月的天数（month 为 1-12）
 */
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * 获取指定年月第一天是星期几（0=周日，month 为 1-12）
 */
function getFirstDayOfWeek(year, month) {
  return new Date(year, month - 1, 1).getDay();
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 解析 YYYY-MM-DD 字符串为 Date
 */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 两个日期相隔的天数（date1/date2 可以是字符串或 Date）
 */
function daysBetween(d1, d2) {
  const a = typeof d1 === 'string' ? parseDate(d1) : d1;
  const b = typeof d2 === 'string' ? parseDate(d2) : d2;
  return Math.round((b - a) / 86400000);
}

/**
 * 在指定日期上加 N 天，返回 YYYY-MM-DD 字符串
 */
function addDays(dateStr, n) {
  const d = typeof dateStr === 'string' ? parseDate(dateStr) : new Date(dateStr);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

/**
 * 根据已记录的经期列表计算统计数据
 * periods: [{ start, end }]
 */
function calculateStats(periods) {
  if (!periods || periods.length === 0) {
    return { avgCycleLength: 28, avgPeriodLength: 5, lastPeriodStart: '', lastPeriodEnd: '' };
  }

  const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));

  // 经期长度
  const periodLengths = sorted.map(p => daysBetween(p.start, p.end) + 1);
  const avgPeriodLength = Math.round(periodLengths.reduce((s, v) => s + v, 0) / periodLengths.length);

  // 周期长度（相邻两次经期开始日之差）
  const cycleLengths = [];
  for (let i = 1; i < sorted.length; i++) {
    const len = daysBetween(sorted[i - 1].start, sorted[i].start);
    if (len >= 18 && len <= 45) cycleLengths.push(len); // 过滤异常值
  }

  const avgCycleLength = cycleLengths.length > 0
    ? Math.round(cycleLengths.reduce((s, v) => s + v, 0) / cycleLengths.length)
    : 28;

  const last = sorted[sorted.length - 1];

  return {
    avgCycleLength,
    avgPeriodLength,
    lastPeriodStart: last.start,
    lastPeriodEnd: last.end,
  };
}

/**
 * 预测下一次经期（简单版，使用固定周期长度）
 */
function predictNextPeriod(lastStart, cycleLength) {
  if (!lastStart) return null;
  return {
    start: addDays(lastStart, cycleLength),
    end: addDays(lastStart, cycleLength + 4),
  };
}

/**
 * 移动平均法预测下一次经期
 * 取最近 3~12 个历史周期的平均长度来推算
 * @param {Array} periods - 已排序的经期段落 [{ start, end }]
 * @param {number} minSamples - 最少需要的历史周期数，默认 3
 * @param {number} maxSamples - 最多取多少个历史周期，默认 12
 * @returns {Object|null} { avgCycleLength, nextStart }
 */
function predictWithMovingAverage(periods, minSamples, maxSamples) {
  if (!periods || periods.length < 2) return null;
  if (minSamples === undefined) minSamples = 3;
  if (maxSamples === undefined) maxSamples = 12;

  const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));

  // 计算所有相邻经期开始日之间的周期长度
  const cycleLengths = [];
  for (let i = 1; i < sorted.length; i++) {
    const len = daysBetween(sorted[i - 1].start, sorted[i].start);
    // 过滤异常值：正常月经周期范围 18~45 天
    if (len >= 18 && len <= 45) {
      cycleLengths.push(len);
    }
  }

  // 需要至少 minSamples 个有效周期才能应用移动平均法
  if (cycleLengths.length < minSamples) return null;

  // 取最近 N 个周期（最多 maxSamples 个）
  const samples = cycleLengths.slice(-Math.min(maxSamples, cycleLengths.length));

  // 简单移动平均（SMA）
  const sum = samples.reduce((s, v) => s + v, 0);
  const avgCycle = Math.round(sum / samples.length);

  const lastPeriod = sorted[sorted.length - 1];

  return {
    avgCycleLength: avgCycle,
    nextStart: addDays(lastPeriod.start, avgCycle),
  };
}

/**
 * 预测排卵日（标准公式：下次经期第 1 天 − 14 天）
 */
function getOvulationDay(nextPeriodStart) {
  if (!nextPeriodStart) return '';
  return addDays(nextPeriodStart, -14);
}

/**
 * 生成日历网格（固定 42 格）
 * markedSet / predictedSet / ovulationDay 用于渲染高亮
 */
function generateCalendarGrid(year, month, markedSet, predictedSet, ovulationDay, pendingStart) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDow = getFirstDayOfWeek(year, month);
  const today = formatDate(new Date());

  const grid = [];

  // ---- 上月填充 ----
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevDays = getDaysInMonth(prevYear, prevMonth);
  for (let i = firstDow - 1; i >= 0; i--) {
    const day = prevDays - i;
    const dateStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    grid.push(buildCell(dateStr, day, false, today, markedSet, predictedSet, ovulationDay, pendingStart, prevYear, prevMonth));
  }

  // ---- 当月 ----
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    grid.push(buildCell(dateStr, day, true, today, markedSet, predictedSet, ovulationDay, pendingStart, year, month));
  }

  // ---- 下月填充 ----
  const remaining = 42 - grid.length;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  for (let day = 1; day <= remaining; day++) {
    const dateStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    grid.push(buildCell(dateStr, day, false, today, markedSet, predictedSet, ovulationDay, pendingStart, nextYear, nextMonth));
  }

  return grid;
}

function buildCell(dateStr, day, isCurrentMonth, today, markedSet, predictedSet, ovulationDay, pendingStart, year, month) {
  const isToday = dateStr === today;
  const isMarked = markedSet.has(dateStr);
  const isPredicted = predictedSet.has(dateStr);
  const isOvulation = ovulationDay === dateStr;
  const isPending = pendingStart === dateStr;
  const d = new Date(year, month - 1, day);
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;

  return {
    date: dateStr,
    day,
    isCurrentMonth,
    isToday,
    isMarked,
    isPredicted,
    isOvulation,
    isPending,
    isWeekend,
  };
}

/**
 * 从已标记日期中提取连续经期段落
 */
function extractPeriods(markedDates) {
  if (!markedDates || markedDates.length === 0) return [];
  const sorted = [...markedDates].sort();
  const periods = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== addDays(prev, 1)) {
      periods.push({ start, end: prev });
      start = sorted[i];
    }
    prev = sorted[i];
  }
  periods.push({ start, end: prev });
  return periods;
}

/**
 * 从经期段落中标记首位日期，返回 { startSet, endSet }
 */
function getPeriodBoundaries(periods) {
  const startSet = new Set();
  const endSet = new Set();
  periods.forEach(p => {
    startSet.add(p.start);
    endSet.add(p.end);
  });
  return { startSet, endSet };
}

module.exports = {
  getDaysInMonth,
  getFirstDayOfWeek,
  formatDate,
  parseDate,
  daysBetween,
  addDays,
  calculateStats,
  predictNextPeriod,
  predictWithMovingAverage,
  getOvulationDay,
  generateCalendarGrid,
  extractPeriods,
  getPeriodBoundaries,
};
