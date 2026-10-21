import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildActions } from '../scripts/build';

function createProject(context: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), 'salesforce-actions-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'actions'));
  return root;
}

test('build accepts a project with no actions yet', (context) => {
  const root = createProject(context);
  assert.doesNotThrow(() => buildActions(root));
});

test('build rejects an action without a manifest', (context) => {
  const root = createProject(context);
  const source = path.join(root, 'actions', 'incomplete', 'src');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.ts'), 'export {};\n');

  assert.throws(() => buildActions(root), /incomplete.*action\.yml/);
});

test('build rejects an action without an entry point', (context) => {
  const root = createProject(context);
  const directory = path.join(root, 'actions', 'incomplete');
  mkdirSync(directory);
  writeFileSync(
    path.join(directory, 'action.yml'),
    'name: Fixture\ndescription: Test\nruns:\n  using: node24\n  main: dist/index.js\n'
  );

  assert.throws(() => buildActions(root), /incomplete.*src\/index\.ts/);
});

test('build bundles multiple TypeScript actions with toolkit and shared dependencies', (context) => {
  const root = createProject(context);
  const dependencies = path.join(root, 'node_modules');
  symlinkSync(
    path.resolve(__dirname, '..', 'node_modules'),
    dependencies,
    'junction'
  );
  copyFileSync(
    path.resolve(__dirname, '..', 'tsconfig.json'),
    path.join(root, 'tsconfig.json')
  );
  const shared = path.join(root, 'shared');
  mkdirSync(shared);
  writeFileSync(
    path.join(shared, 'message.ts'),
    "export const message: string = 'fixture: ';\n"
  );

  for (const name of ['first', 'second']) {
    const directory = path.join(root, 'actions', name);
    mkdirSync(path.join(directory, 'src'), { recursive: true });
    writeFileSync(
      path.join(directory, 'action.yml'),
      `name: ${name}\ndescription: Test\nruns:\n  using: node24\n  main: dist/index.js\n`
    );
    writeFileSync(
      path.join(directory, 'src', 'index.ts'),
      [
        "import * as core from '@actions/core';",
        "import { message } from '../../../shared/message';",
        `const name: string = ${JSON.stringify(name)};`,
        'core.info(message + name);'
      ].join('\n')
    );
  }

  buildActions(root);
  rmSync(shared, { recursive: true });
  rmSync(dependencies);

  for (const name of ['first', 'second']) {
    const directory = path.join(root, 'actions', name);
    rmSync(path.join(directory, 'src'), { recursive: true });
    const bundle = path.join(directory, 'dist', 'index.js');
    assert.ok(existsSync(bundle));
    assert.ok(existsSync(path.join(directory, 'dist', 'licenses.txt')));
    assert.equal(
      execFileSync(process.execPath, [bundle], { encoding: 'utf8' }).trim(),
      `fixture: ${name}`
    );
  }
});
