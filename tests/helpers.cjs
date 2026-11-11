// Shared in-memory fakes for WeChat storage, dialogs, and the index page.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../utils/cycle');
const S = require('../utils/store');
const V = require('../utils/view');

const root = path.resolve(__dirname, '..');
const pageSource = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
const copy = S.clone;

const record = (start, length = 5, extra = {}) => ({
  id: `p-${start}`,
  start,
  end: C.addDays(start, length - 1),
  status: 'completed',
  source: 'user',
  excludeGap: false,
  ...extra,
});

function stateWith(periods = [], preferences = {}) {
  const state = S.createState();
  state.setupCompleted = true;
  state.periods = periods;
  Object.assign(state.preferences, preferences);
  return state;
}

function storage(initial) {
  const values = new Map();
  if (initial !== undefined) values.set(S.KEY, copy(initial));
  const writes = [],
    reads = [],
    toasts = [],
    modals = [],
    sheets = [],
    shared = [],
    files = new Map(),
    timers = new Map();
  const clip = { text: '' };
  let timerId = 0;
  // sheetIndex null simulates dismissing an action sheet; the *Failure objects reach the API's fail callback.
  const options = {
    readFailure: null,
    writeFailure: null,
    confirm: true,
    sheetIndex: 0,
    fileWriteFailure: false,
    shareFailure: null,
    clipboardFailure: null,
    chooseFailure: null,
    chosenFile: null,
  };
  const fail = (value, error) => {
    if (value.fail) value.fail(copy(error));
  };
  return {
    values,
    writes,
    reads,
    toasts,
    modals,
    sheets,
    shared,
    files,
    clip,
    timers,
    options,
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager() {
      return {
        writeFileSync(filePath, data) {
          if (options.fileWriteFailure) throw new Error('write file failed');
          files.set(filePath, String(data));
        },
        readFileSync(filePath) {
          if (!files.has(filePath)) throw new Error('no such file');
          return files.get(filePath);
        },
      };
    },
    shareFileMessage(value) {
      shared.push({ filePath: value.filePath, fileName: value.fileName });
      if (options.shareFailure) fail(value, options.shareFailure);
      else if (value.success) value.success({});
    },
    setClipboardData(value) {
      if (options.clipboardFailure) {
        fail(value, options.clipboardFailure);
        return;
      }
      clip.text = value.data;
      if (value.success) value.success({});
    },
    getClipboardData(value) {
      if (options.clipboardFailure) fail(value, options.clipboardFailure);
      else value.success({ data: clip.text });
    },
    chooseMessageFile(value) {
      if (options.chooseFailure) {
        fail(value, options.chooseFailure);
        return;
      }
      value.success({ tempFiles: options.chosenFile ? [copy(options.chosenFile)] : [] });
    },
    getStorageSync(key) {
      reads.push(key);
      if (options.readFailure && options.readFailure(key)) throw new Error('read failed');
      return values.has(key) ? copy(values.get(key)) : '';
    },
    setStorageSync(key, value) {
      if (options.writeFailure && options.writeFailure(key)) throw new Error('write failed');
      writes.push({ key, value: copy(value) });
      values.set(key, copy(value));
    },
    showToast(value) {
      toasts.push(copy(value));
    },
    showModal(value) {
      modals.push({ title: value.title, content: value.content });
      if (value.success) value.success({ confirm: options.confirm });
    },
    showActionSheet(value) {
      sheets.push({ alertText: value.alertText || '', itemList: copy(value.itemList) });
      if (options.sheetIndex === null) {
        if (value.fail) value.fail({ errMsg: 'showActionSheet:fail cancel' });
        return;
      }
      value.success({ tapIndex: options.sheetIndex });
    },
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
}

function page(initial = stateWith(), options = {}) {
  const wx = options.storage || storage(initial);
  let instant = options.today || '2026-10-03T12:00:00';
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [instant]));
    }
    static now() {
      return new Date(instant).getTime();
    }
  }
  let def;
  const modules = { store: S, view: V, cycle: C };
  vm.runInNewContext(
    pageSource,
    {
      Page: value => {
        def = value;
      },
      wx,
      Date: ClockDate,
      require: name => modules[name.split('/').pop()],
      setTimeout: (fn, ms) => wx.setTimeout(fn, ms),
      clearTimeout: id => wx.clearTimeout(id),
    },
    { filename: path.join(root, 'pages/index/index.js') },
  );
  // Every setData payload is kept so tests can check what crosses to the view layer.
  const calls = [];
  const p = {
    ...def,
    data: copy(def.data),
    setData(value) {
      calls.push(copy(value));
      // Like WeChat, "key[index]" paths update one item of an existing array.
      Object.keys(value).forEach(key => {
        const item = /^(\w+)\[(\d+)\]$/.exec(key);
        if (item) this.data[item[1]][Number(item[2])] = value[key];
        else this.data[key] = value[key];
      });
    },
  };
  p.onLoad();
  return {
    p,
    wx,
    def,
    calls,
    tap: date => p.onDayTap({ currentTarget: { dataset: { date } } }),
    setNow: value => {
      instant = value;
    },
    snapshot: () => copy(wx.values.get(S.KEY)),
  };
}

module.exports = { C, S, V, root, copy, record, stateWith, storage, page };
