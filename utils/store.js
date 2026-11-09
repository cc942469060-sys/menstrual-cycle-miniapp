const C = require('./cycle');
const KEY = 'cycle_data';
const LEGACY_BACKUP = 'cycle_data_backup_v1';
const RESET_BACKUP = 'cycle_data_backup_before_reset';
const LEGACY_LATEST_BACKUP = 'cycle_data_backup_v1_latest';
const RESET_LATEST_BACKUP = 'cycle_data_backup_before_reset_latest';
const RESTORE_BACKUP = 'cycle_data_backup_before_restore';
// Offered most recent first; labels are shown when the user chooses a backup.
const BACKUP_SLOTS = [
  { key: RESET_LATEST_BACKUP, label: '最近一次重置前' },
  { key: RESET_BACKUP, label: '首次重置前' },
  { key: RESTORE_BACKUP, label: '最近一次恢复或导入前' },
  { key: LEGACY_LATEST_BACKUP, label: '旧版数据（最近）' },
  { key: LEGACY_BACKUP, label: '旧版数据（首次）' },
];
// Export files wrap the stored record so an import can recognise them and their format version.
const EXPORT_APP = 'menstrual-cycle-miniapp';
const EXPORT_FORMAT = 1;
// One storage key holds at most 1 MB, so anything larger cannot be an export of it.
const IMPORT_MAX_LENGTH = 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));

function createState() {
  return { schemaVersion: 2, periods: [], draft: null, setupCompleted: false,
    preferences: { predictionMode: 'auto', initialCycleLength: 28, initialPeriodLength: 5, manualCycleLength: null, manualPeriodLength: null } };
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}无效`);
}

function validateState(input, today, allowHistoricalFuture = false) {
  C.parseDate(today);
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 2 || !Array.isArray(input.periods)) throw new Error('记录格式异常，原数据已保留');
  const state = clone(input);
  if (typeof state.setupCompleted !== 'boolean') throw new Error('设置状态异常');
  const prefs = state.preferences;
  if (!prefs || !['auto', 'manual'].includes(prefs.predictionMode)) throw new Error('预测设置异常');
  integer(prefs.initialCycleLength, C.CYCLE_MIN, C.CYCLE_MAX, '初始周期');
  integer(prefs.initialPeriodLength, 1, C.PERIOD_MAX, '初始经期');
  if (prefs.initialPeriodLength >= prefs.initialCycleLength) throw new Error('预测经期天数必须小于周期天数');
  if (prefs.manualCycleLength !== null) integer(prefs.manualCycleLength, C.CYCLE_MIN, C.CYCLE_MAX, '手动周期');
  if (prefs.manualPeriodLength !== null) integer(prefs.manualPeriodLength, 1, C.PERIOD_MAX, '手动经期');
  if (prefs.predictionMode === 'manual') {
    integer(prefs.manualCycleLength, C.CYCLE_MIN, C.CYCLE_MAX, '手动周期');
    integer(prefs.manualPeriodLength, 1, C.PERIOD_MAX, '手动经期');
    if (prefs.manualPeriodLength >= prefs.manualCycleLength) throw new Error('预测经期天数必须小于周期天数');
  }
  const ids = new Set();
  let ongoingCount = 0;
  state.periods.forEach(p => {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 128 || ids.has(p.id)) throw new Error('记录编号异常');
    ids.add(p.id);
    if (!['completed', 'ongoing', 'needsReview'].includes(p.status) || !['user', 'legacy'].includes(p.source) || typeof p.excludeGap !== 'boolean') throw new Error('记录状态异常');
    C.parseDate(p.start);
    if (p.end !== null) { C.parseDate(p.end); if (p.end < p.start) throw new Error('结束日期不能早于开始日期'); }
    if (p.status === 'completed' && p.end === null) throw new Error('请确认结束日期');
    if (p.status === 'ongoing' && p.end !== null) throw new Error('进行中记录不能有结束日期');
    if (!allowHistoricalFuture && p.status !== 'needsReview' && (p.start > today || (p.end && p.end > today))) throw new Error('未来日期不能保存为实际记录');
    if (p.status === 'ongoing') ongoingCount++;
  });
  if (ongoingCount > 1) throw new Error('请先结束已有的进行中记录');
  const confirmed = state.periods.filter(p => p.status !== 'needsReview').sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < confirmed.length; i++) {
    if (confirmed[i].start <= (confirmed[i - 1].end || today)) throw new Error('与已有记录重叠，请先编辑原记录');
  }
  if (state.draft !== null) {
    if (!state.draft || typeof state.draft !== 'object' || state.draft.end !== null) throw new Error('录入草稿异常');
    C.parseDate(state.draft.start);
    if (!allowHistoricalFuture && state.draft.start > today) throw new Error('未来日期不能作为实际开始日期');
  }
  state.periods.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return state;
}

function migrateLegacy(raw, today) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== undefined || !Array.isArray(raw.markedDates)) throw new Error('旧记录格式异常，原数据已保留');
  const state = createState();
  state.periods = C.extractPeriods(raw.markedDates).map((p, index) => ({ ...p, id: `legacy-${index}-${p.start}`, status: 'needsReview', source: 'legacy', excludeGap: false }));
  state.setupCompleted = raw.setupCompleted === true;
  const warnings = [];
  const cycle = raw.customCycleLength;
  const period = raw.customPeriodLength;
  if (cycle != null || period != null) {
    const chosenCycle = cycle == null ? 28 : cycle;
    const chosenPeriod = period == null ? 5 : period;
    if (Number.isInteger(chosenCycle) && chosenCycle >= C.CYCLE_MIN && chosenCycle <= C.CYCLE_MAX && Number.isInteger(chosenPeriod) && chosenPeriod >= 1 && chosenPeriod < chosenCycle) {
      Object.assign(state.preferences, { predictionMode: 'manual', manualCycleLength: chosenCycle, manualPeriodLength: chosenPeriod });
    } else warnings.push('旧预测参数不适用，已恢复自动模式；原设置已备份。');
  }
  if (raw.pendingStart != null && raw.pendingStart !== '') {
    if (!C.isDate(raw.pendingStart) || raw.pendingStart > today) throw new Error('旧草稿日期异常，原数据已保留');
    state.draft = { start: raw.pendingStart, end: null };
  }
  if (state.periods.length) warnings.push('旧记录已备份。请逐条核对开始和结束日期，确认后才参与统计与预测。');
  return { state: validateState(state, today), warnings };
}

function isMissing(raw) { return raw === '' || raw === undefined || raw === null; }

function backup(storage, firstKey, latestKey, raw) {
  const first = storage.getStorageSync(firstKey);
  if (isMissing(first)) storage.setStorageSync(firstKey, clone(raw));
  else if (JSON.stringify(first) !== JSON.stringify(raw)) storage.setStorageSync(latestKey, clone(raw));
}

function load(storage, today) {
  try {
    const raw = storage.getStorageSync(KEY);
    if (isMissing(raw)) return { ok: true, state: createState(), warnings: [] };
    // Travel or a clock change must not invalidate or rewrite previously saved dates.
    if (raw.schemaVersion === 2) return { ok: true, state: validateState(raw, today, true), warnings: [] };
    const migration = migrateLegacy(raw, today);
    // A failed backup must never be followed by overwriting the source record.
    backup(storage, LEGACY_BACKUP, LEGACY_LATEST_BACKUP, raw);
    storage.setStorageSync(KEY, migration.state);
    return { ok: true, ...migration, migrated: true };
  } catch (error) { return { ok: false, message: '记录未能安全读取，原数据未改动。请重试。', detail: error.message }; }
}

function save(storage, candidate, today, previous = null) {
  let state;
  try {
    state = validateState(candidate, today, true);
    state.periods.forEach(p => {
      const old = previous && previous.periods.find(item => item.id === p.id);
      const changed = !old || old.start !== p.start || old.end !== p.end || old.status !== p.status;
      if (changed && p.status !== 'needsReview' && (p.start > today || (p.end && p.end > today))) throw new Error('未来日期不能保存为实际记录');
    });
    if (state.draft && state.draft.start > today && (!previous || !previous.draft || previous.draft.start !== state.draft.start)) throw new Error('未来日期不能作为实际开始日期');
  }
  catch (error) { return { ok: false, message: error.message }; }
  try { storage.setStorageSync(KEY, clone(state)); return { ok: true, state }; }
  catch (error) { return { ok: false, message: '保存失败，已确认记录未改变，请重试。' }; }
}

function reset(storage, today) {
  try {
    const raw = storage.getStorageSync(KEY);
    if (!isMissing(raw)) backup(storage, RESET_BACKUP, RESET_LATEST_BACKUP, raw);
  } catch (error) { return { ok: false, message: '无法备份原记录，已停止重置。' }; }
  return save(storage, createState(), today);
}

function parseBackup(raw, today) {
  if (raw && typeof raw === 'object' && raw.schemaVersion === 2) return { state: validateState(raw, today, true), warnings: [] };
  return migrateLegacy(raw, today);
}

// Lists restorable backups; empty, unreadable, duplicate, or already-current copies are not offered.
function listBackups(storage, today) {
  const seen = new Set();
  try { seen.add(JSON.stringify(storage.getStorageSync(KEY))); } catch (error) { /* unreadable current data matches nothing */ }
  const items = [];
  BACKUP_SLOTS.forEach(slot => {
    try {
      const raw = storage.getStorageSync(slot.key);
      const text = JSON.stringify(raw);
      if (isMissing(raw) || seen.has(text)) return;
      const { state } = parseBackup(raw, today);
      if (!state.periods.length) return;
      seen.add(text);
      items.push({ key: slot.key, label: slot.label, count: state.periods.length,
        first: state.periods[0].start, last: state.periods[state.periods.length - 1].start });
    } catch (error) { /* invalid backups are left untouched and not offered */ }
  });
  return items;
}

// Replaces the stored data; the current copy stays restorable, so the change can be undone.
function replaceCurrent(storage, parsed, raw, action) {
  try {
    const current = storage.getStorageSync(KEY);
    if (!isMissing(current) && JSON.stringify(current) !== JSON.stringify(raw)) storage.setStorageSync(RESTORE_BACKUP, clone(current));
  } catch (error) { return { ok: false, message: `无法备份当前记录，已停止${action}。` }; }
  try { storage.setStorageSync(KEY, clone(parsed.state)); }
  catch (error) { return { ok: false, message: `${action}失败，当前记录未改变，请重试。` }; }
  return { ok: true, state: parsed.state, warnings: parsed.warnings };
}

function restore(storage, key, today) {
  if (!BACKUP_SLOTS.some(slot => slot.key === key)) return { ok: false, message: '找不到这份备份。' };
  let raw;
  let parsed;
  try {
    raw = storage.getStorageSync(key);
    if (isMissing(raw)) throw new Error('备份为空');
    parsed = parseBackup(raw, today);
  } catch (error) { return { ok: false, message: '备份无法读取，当前记录未改动。' }; }
  return replaceCurrent(storage, parsed, raw, '恢复');
}

// Builds the text of an export file from the current state.
function buildExport(state, today) {
  let valid;
  try { valid = validateState(state, today, true); } catch (error) { return { ok: false, message: '记录格式异常，暂时无法导出。' }; }
  if (!valid.periods.length) return { ok: false, message: '还没有可导出的记录。' };
  const text = JSON.stringify({ app: EXPORT_APP, format: EXPORT_FORMAT, exportedAt: today, data: valid }, null, 2);
  return { ok: true, text, count: valid.periods.length, fileName: `经期记录备份-${today}.json` };
}

// Accepts an export file, a bare stored record, or the legacy format, validated like a restore.
function parseImport(text, today) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('内容为空');
  if (text.length > IMPORT_MAX_LENGTH) throw new Error('内容过大');
  // Files saved by some desktop editors start with a byte-order mark.
  const raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  const wrapped = !!raw && typeof raw === 'object' && !Array.isArray(raw) && raw.app === EXPORT_APP;
  if (wrapped && raw.format !== EXPORT_FORMAT) throw new Error('备份格式版本不受支持');
  const data = wrapped ? raw.data : raw;
  const parsed = parseBackup(data, today);
  if (!parsed.state.periods.length) throw Object.assign(new Error('备份中没有记录'), { empty: true });
  return { ...parsed, data };
}

const importFailure = error => ({ ok: false, message: error.empty ? '备份中没有经期记录，当前记录未改动。' : '无法识别的备份内容，当前记录未改动。' });

// Checks an import without touching storage, for the confirmation dialog.
function previewImport(text, today) {
  try {
    const { state } = parseImport(text, today);
    return { ok: true, count: state.periods.length, first: state.periods[0].start, last: state.periods[state.periods.length - 1].start };
  } catch (error) { return importFailure(error); }
}

function importText(storage, text, today) {
  let parsed;
  try { parsed = parseImport(text, today); } catch (error) { return importFailure(error); }
  return replaceCurrent(storage, parsed, parsed.data, '导入');
}

module.exports = { KEY, LEGACY_BACKUP, LEGACY_LATEST_BACKUP, RESET_BACKUP, RESET_LATEST_BACKUP, RESTORE_BACKUP, BACKUP_SLOTS, EXPORT_APP,
  EXPORT_FORMAT, IMPORT_MAX_LENGTH, clone, createState, validateState, migrateLegacy, load, save, reset, listBackups, restore,
  buildExport, previewImport, importText };
