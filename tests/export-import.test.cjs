// Regressions for taking records off the phone and bringing them back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { S, root, record, stateWith, storage, page } = require('./helpers.cjs');

const two = () => stateWith([record('2026-08-01'), record('2026-08-29')]);

// Exports from a separate simulated phone and returns the text of the shared file.
function exportedText(state = two()) {
  const source = page(state);
  source.p.exportToChat();
  return source.wx.files.get(source.wx.shared[0].filePath);
}

function chooseFile(e, text) {
  e.wx.files.set('wxfile://tmp/chat.json', text);
  e.wx.options.chosenFile = { path: 'wxfile://tmp/chat.json', size: text.length, name: '经期记录备份-2026-10-03.json', type: 'file' };
  e.wx.options.sheetIndex = 0;
}

// ---- Export ----

test('sending a backup writes every record to a file and shares it to a chat', () => {
  const e = page(two());
  e.p.exportToChat();
  assert.deepEqual(e.wx.shared, [{ filePath: 'wxfile://usr/cycle-backup.json', fileName: '经期记录备份-2026-10-03.json' }]);
  const file = JSON.parse(e.wx.files.get('wxfile://usr/cycle-backup.json'));
  assert.deepEqual([file.app, file.format, file.exportedAt], ['menstrual-cycle-miniapp', 1, '2026-10-03']);
  assert.deepEqual(file.data, two());
  assert.equal(e.wx.toasts.at(-1).title, '已发送 2 条记录的备份');
  assert.equal(e.wx.writes.length, 0);
});

test('copying the backup puts the same export on the clipboard', () => {
  const e = page(two());
  e.p.copyBackupText();
  assert.deepEqual(JSON.parse(e.wx.clip.text).data, two());
  assert.equal(e.wx.toasts.length, 0, 'WeChat shows its own copied toast');
});

test('nothing is exported before any record exists or while stored data cannot be read', () => {
  const empty = page(stateWith());
  empty.p.exportToChat();
  empty.p.copyBackupText();
  assert.equal(empty.wx.shared.length, 0);
  assert.equal(empty.wx.clip.text, '');
  assert.equal(empty.wx.toasts.at(-1).title, '还没有可导出的记录。');
  const broken = page(undefined, { storage: storage({ bad: true }) });
  broken.p.exportToChat();
  assert.equal(broken.wx.shared.length, 0);
  assert.equal(broken.wx.toasts.at(-1).title, '请先重试读取记录');
});

test('a failed file write or a WeChat version without file sharing ends with a clear message', () => {
  const e = page(two());
  e.wx.options.fileWriteFailure = true;
  e.p.exportToChat();
  assert.equal(e.wx.shared.length, 0);
  assert.match(e.wx.toasts.at(-1).title, /写入失败/);
  e.wx.shareFileMessage = undefined;
  e.p.exportToChat();
  assert.match(e.wx.toasts.at(-1).title, /不能发送文件/);
});

// ---- Import ----

test('an exported file imports on another phone, and the replaced records stay restorable', () => {
  const text = exportedText();
  const previous = stateWith([record('2026-09-10')]);
  const e = page(previous);
  chooseFile(e, text);
  e.p.importBackup();
  assert.deepEqual(e.wx.sheets.at(-1).itemList, ['从聊天中的备份文件导入', '从剪贴板导入']);
  assert.match(e.wx.modals.at(-1).content, /备份中有 2 条记录（2026-08-01 ~ 2026-08-29），将替换当前的 1 条记录/);
  assert.deepEqual(e.snapshot(), two());
  assert.deepEqual(e.wx.values.get(S.RESTORE_BACKUP), previous);
  assert.equal(e.p.data.periodCount, 2);
  assert.equal(e.wx.toasts.at(-1).title, '已导入 2 条记录');
  assert.deepEqual(S.listBackups(e.wx, '2026-10-03').map(item => item.label), ['最近一次恢复或导入前']);
});

test('the backup text can be pasted back from the clipboard', () => {
  const source = page(two());
  source.p.copyBackupText();
  const e = page(stateWith());
  e.wx.clip.text = source.wx.clip.text;
  e.wx.options.sheetIndex = 1;
  e.p.importBackup();
  assert.match(e.wx.modals.at(-1).content, /导入后将作为当前记录/);
  assert.deepEqual(e.snapshot(), two());
});

test('a new phone can import straight from the first-run setup dialog', () => {
  const e = page(undefined, { storage: storage() });
  assert.equal(e.p.data.showSetup, true);
  chooseFile(e, exportedText());
  e.p.importBackup();
  assert.equal(e.p.data.showSetup, false);
  assert.equal(e.p._state.periods.length, 2);
  assert.equal(e.wx.values.has(S.RESTORE_BACKUP), false);
  const wxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');
  const setupFooter = wxml.slice(wxml.indexOf('class="setup-footer"'), wxml.indexOf('wx:if="{{editorVisible}}"'));
  assert(setupFooter.length > 0);
  assert(setupFooter.includes('bindtap="importBackup"'));
});

test('damaged, foreign, empty, or oversized content is rejected without changing anything', () => {
  const e = page(stateWith([record('2026-09-01')]));
  const before = e.snapshot();
  const envelope = JSON.parse(exportedText());
  const samples = ['', 'not json', '"text"', '[]', JSON.stringify({ other: true }),
    JSON.stringify({ ...envelope, format: 99 }),
    JSON.stringify({ ...envelope, data: stateWith([record('2026-09-01'), record('2026-09-03')]) }),
    JSON.stringify(stateWith())];
  e.wx.options.sheetIndex = 1;
  for (const text of samples) {
    e.wx.clip.text = text;
    e.p.importBackup();
    assert.match(e.wx.toasts.at(-1).title, /当前记录未改动/, text.slice(0, 60));
  }
  assert.equal(e.wx.toasts.at(-1).title, '备份中没有经期记录，当前记录未改动。');
  chooseFile(e, 'x'.repeat(10));
  e.wx.options.chosenFile.size = S.IMPORT_MAX_LENGTH + 1;
  e.p.importBackup();
  assert.match(e.wx.toasts.at(-1).title, /文件过大/);
  assert.deepEqual(e.snapshot(), before);
  assert.equal(e.wx.writes.length, 0);
  assert.equal(e.wx.modals.length, 0);
});

test('cancelling at any step leaves the current records alone', () => {
  const e = page(stateWith([record('2026-09-01')]));
  e.wx.options.confirm = false;
  chooseFile(e, exportedText());
  e.p.importBackup();
  assert.equal(e.p._state.periods.length, 1);
  e.wx.options.chooseFailure = { errMsg: 'chooseMessageFile:fail cancel' };
  e.p.importBackup();
  e.wx.options.sheetIndex = null;
  e.p.importBackup();
  assert.equal(e.wx.toasts.length, 0);
  assert.equal(e.wx.writes.length, 0);
});

test('privacy errors explain what is missing, while a cancelled share stays silent', () => {
  const e = page(two());
  e.wx.options.sheetIndex = 0;
  e.wx.options.chooseFailure = { errMsg: 'chooseMessageFile:fail api scope is not declared in the privacy agreement', errno: 112 };
  e.p.importBackup();
  assert.equal(e.wx.modals.at(-1).title, '功能未开通');
  assert.match(e.wx.modals.at(-1).content, /用户隐私保护指引/);
  e.wx.options.clipboardFailure = { errMsg: 'setClipboardData:fail privacy permission is not authorized', errno: 104 };
  e.p.copyBackupText();
  assert.equal(e.wx.toasts.at(-1).title, '同意隐私保护指引后才能复制备份文本');
  const count = e.wx.toasts.length;
  e.wx.options.shareFailure = { errMsg: 'shareFileMessage:fail cancel' };
  e.p.exportToChat();
  assert.equal(e.wx.toasts.length, count);
});

test('imports accept the export file, a bare stored record, and the legacy format', () => {
  const today = '2026-10-03';
  assert.equal(S.previewImport(exportedText(), today).count, 2);
  assert.equal(S.previewImport(String.fromCharCode(0xFEFF) + exportedText(), today).count, 2);
  assert.equal(S.previewImport(JSON.stringify(two()), today).count, 2);
  const legacy = S.importText(storage(two()), JSON.stringify({ markedDates: ['2026-08-01', '2026-08-02'] }), today);
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.state.periods.map(p => p.status), ['needsReview']);
  assert(legacy.warnings.length > 0);
});

test('an import that cannot set the current records aside changes nothing', () => {
  const wx = storage(stateWith([record('2026-09-01')]));
  wx.options.writeFailure = key => key === S.RESTORE_BACKUP;
  const result = S.importText(wx, exportedText(), '2026-10-03');
  assert.equal(result.ok, false);
  assert.match(result.message, /已停止导入/);
  assert.equal(wx.values.get(S.KEY).periods.length, 1);
});
