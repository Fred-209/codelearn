import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30_000, color: true });
  const files = await glob('**/*.test.js', { cwd: __dirname });
  for (const f of files) mocha.addFile(path.resolve(__dirname, f));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration tests failed`)) : resolve()));
  });
}
