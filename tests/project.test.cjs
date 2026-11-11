// Checks on project files: continuous integration, packaging, and message lengths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root } = require('./helpers.cjs');

const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('CI runs the regression tests, and project-only files stay out of the mini program package', () => {
  const workflow = read('.github/workflows/test.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /run: npm test/);
  const ignored = JSON.parse(read('project.config.json')).packOptions.ignore.map(item => item.value);
  for (const value of ['tests', '.github', 'package.json', 'README.md']) assert(ignored.includes(value), value);
});

// A toast without an icon shows at most two lines; 20 characters is a conservative limit.
test('fixed toast and error messages fit in two lines', () => {
  const pattern = /notify\('([^']+)'\)|message: '([^']+)'|new Error\('([^']+)'\)|problem = '([^']+)'/g;
  const messages = ['pages/index/index.js', 'utils/store.js', 'utils/cycle.js']
    .flatMap(file => [...read(file).matchAll(pattern)].map(match => match.slice(1).find(Boolean)));
  assert(messages.length > 30, `found ${messages.length} messages`);
  for (const message of messages) assert(message.length <= 20, message);
});
