import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function buildActions(
  projectRoot = path.resolve(__dirname, '..')
): void {
  const actionsDirectory = path.join(projectRoot, 'actions');
  const actions = readdirSync(actionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of actions) {
    const directory = path.join(actionsDirectory, name);
    const entryPoint = path.join(directory, 'src', 'index.ts');
    const hasManifest = ['action.yml', 'action.yaml'].some((manifest) =>
      existsSync(path.join(directory, manifest))
    );

    if (!hasManifest || !existsSync(entryPoint)) {
      throw new Error(
        `Action "${name}" needs an action.yml (or action.yaml) and src/index.ts.`
      );
    }

    execFileSync(
      process.execPath,
      [
        require.resolve('@vercel/ncc/dist/ncc/cli.js'),
        'build',
        entryPoint,
        '--out',
        path.join(directory, 'dist'),
        '--license',
        'licenses.txt'
      ],
      { cwd: projectRoot, stdio: 'inherit' }
    );
  }

  if (actions.length === 0) {
    console.log('No action entry points yet. The build tooling is ready.');
  }
}

if (require.main === module) {
  buildActions();
}
