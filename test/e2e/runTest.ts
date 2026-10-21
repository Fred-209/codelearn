import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Compiled to out/test/e2e/runTest.js
  const root = path.resolve(__dirname, '../../..');
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, 'suite/index'),
    launchArgs: [path.join(root, 'test/fixtures/sample-repo'), '--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
