// Checks on project files: continuous integration, packaging, formatting, and message lengths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root } = require('./helpers.cjs');

const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('CI installs the locked tools, runs the regression tests, and checks formatting', () => {
  const workflow = read('.github/workflows/test.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run format:check/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['format:check'], 'prettier --check .');
  assert.match(pkg.devDependencies.prettier, /^\d+\.\d+\.\d+$/, 'the formatter version is pinned');
  assert.equal(pkg.dependencies, undefined, 'the mini program has no runtime dependencies');
});

test('project-only files stay out of the mini program package', () => {
  const ignored = JSON.parse(read('project.config.json')).packOptions.ignore.map(item => item.value);
  const projectOnly = ['tests', '.github', 'node_modules', 'package.json', 'package-lock.json', 'README.md'];
  for (const value of [...projectOnly, '.prettierrc.json', '.prettierignore']) assert(ignored.includes(value), value);
});

// A toast without an icon shows at most two lines; 20 characters is a conservative limit.
test('fixed toast and error messages fit in two lines', () => {
  const pattern = /notify\(\s*'([^']+)'|message:\s*'([^']+)'|new Error\(\s*'([^']+)'|problem\s*=\s*'([^']+)'/g;
  const messages = ['pages/index/index.js', 'utils/store.js', 'utils/cycle.js'].flatMap(file =>
    [...read(file).matchAll(pattern)].map(match => match.slice(1).find(Boolean)),
  );
  assert(messages.length > 30, `found ${messages.length} messages`);
  for (const message of messages) assert(message.length <= 20, message);
});
