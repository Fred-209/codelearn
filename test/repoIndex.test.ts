import { describe, expect, it } from 'vitest';
import type { RepoFile } from '../src/scan/digest';
import { findEntryPoints, grouper, indexRepo, join, packageName, parseJsonc, reexportOnly, spread } from '../src/scan/repoIndex';

const file = (path: string, text: string): RepoFile => ({ path, text, size: text.length });

/** A miniature of a portal with a designer, a publisher and a runtime, built by webpack. */
const portal: RepoFile[] = [
  file('package.json', JSON.stringify({ scripts: { 'build-designer': 'webpack --config webpack.designer.js', 'build-runtime': 'webpack --config webpack.runtime.js' } })),
  file('tsconfig.json', '{\n  // comments are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@services/*": ["src/services/*"] }, },\n}'),
  file('webpack.designer.js', 'module.exports = { entry: { app: ["./src/startup.design.ts"] } };'),
  file('webpack.runtime.js', 'module.exports = { entry: { "scripts/theme": ["./src/startup.runtime.ts"] } };'),
  file('src/startup.design.ts', 'import { DesignModule } from "./apim.design.module";\nconst injector = new Injector();\ninjector.bindModule(new DesignModule());\n'),
  file('src/startup.runtime.ts', 'import { RuntimeModule } from "./apim.runtime.module";\ndocument.addEventListener("DOMContentLoaded", () => start());\n'),
  file(
    'src/apim.design.module.ts',
    'import { UsersService } from "@services/usersService";\nimport { SignInEditor } from "./components/signin/signinEditor";\nexport class DesignModule {}\n',
  ),
  file(
    'src/apim.runtime.module.ts',
    'import { UsersService } from "@services/usersService";\nimport { SignIn } from "./components/signin/signin";\nimport { Authenticator } from "./authentication/defaultAuthenticator";\nexport class RuntimeModule {}\n',
  ),
  file(
    'src/services/usersService.ts',
    'import * as ko from "knockout";\nexport class UsersService {\n  public async signIn(username: string, password: string): Promise<void> {\n    const token = await this.getToken(username, password);\n  }\n\n  public signOut(): void {\n    sessionStorage.removeItem("accessToken");\n  }\n}\n',
  ),
  file('src/services/index.ts', 'export * from "./usersService";\n'),
  file(
    'src/authentication/defaultAuthenticator.ts',
    'export class DefaultAuthenticator {\n  public async getAccessToken(): Promise<string> {\n    return sessionStorage.getItem("accessToken");\n  }\n}\n',
  ),
  file('src/components/signin/signin.ts', 'import * as ko from "knockout";\nimport template from "./signin.html";\nimport { UsersService } from "../../services/usersService";\nexport class SignIn { username = ko.observable(""); }\n'),
  file('src/components/signin/signinEditor.ts', 'import { UsersService } from "../../services";\nexport class SignInEditor {}\n'),
  file('src/components/signin/signin.html', '<form>\n  <input data-bind="textInput: username" />\n  <button data-bind="click: signIn">Sign in</button>\n</form>\n'),
  file('examples/widget/main.ts', 'import { UsersService } from "../../src/services/usersService";\ncreateApp(App).mount("#app");\n'),
  file('tests/usersService.spec.ts', 'import { UsersService } from "../src/services/usersService";\n'),
];

describe('indexRepo on a portal-like repo', () => {
  const index = indexRepo(portal);

  it('finds the bundle entries and build configs', () => {
    const entries = new Map(index.entryPoints.map((e) => [e.path, e.why]));
    expect(entries.get('src/startup.design.ts')).toContain('build entry in webpack.designer.js');
    expect(entries.get('src/startup.runtime.ts')).toContain('build entry in webpack.runtime.js');
    expect(entries.get('webpack.designer.js')).toContain('npm run build-designer');
    // Examples have their own startup code, but they aren't the app.
    expect(entries.has('examples/widget/main.ts')).toBe(false);
  });

  it('resolves relative, aliased, index and template imports', () => {
    expect([...(index.imports.get('src/apim.design.module.ts') ?? [])].sort()).toEqual(['src/components/signin/signinEditor.ts', 'src/services/usersService.ts']);
    expect(index.imports.get('src/components/signin/signinEditor.ts')).toEqual(new Set(['src/services/index.ts']));
    expect(index.imports.get('src/components/signin/signin.ts')?.has('src/components/signin/signin.html')).toBe(true);
    expect(index.packages[0]).toEqual(['knockout', 2]);
  });

  it('ranks wiring and widely used files first, examples and tests last', () => {
    const r = index.ranked;
    const at = (p: string) => r.indexOf(p);
    expect(at('src/startup.runtime.ts')).toBeLessThan(at('src/components/signin/signinEditor.ts'));
    expect(at('src/services/usersService.ts')).toBeLessThan(at('src/services/index.ts'));
    expect(r.slice(-2).sort()).toEqual(['examples/widget/main.ts', 'tests/usersService.spec.ts']);
  });

  it('finds sign-in code by name and by content', () => {
    const signIn = index.topics.find((t) => t.id === 'sign-in');
    const paths = signIn?.hits.map((h) => h.path) ?? [];
    expect(paths).toContain('src/authentication/defaultAuthenticator.ts');
    expect(paths).toContain('src/services/usersService.ts');
    expect(signIn?.hits.find((h) => h.path === 'src/services/usersService.ts')?.text).toContain('signIn');
    expect(paths).not.toContain('tests/usersService.spec.ts');
  });

  it('summarises templates and their binding syntax', () => {
    expect(index.templates.count).toBe(1);
    expect(index.templates.attributes[0]).toEqual(['data-bind', 2]);
    expect(index.templates.top).toEqual(['src/components/signin/signin.html']);
  });
});

describe('type references (C#)', () => {
  it('links files by the types they mention', () => {
    const index = indexRepo([
      file('src/Api/Program.cs', 'var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddScoped<IPaymentRepository, PaymentRepository>();'),
      file('src/Domain/IPaymentRepository.cs', 'public interface IPaymentRepository { Task<Payment> Get(Guid id); }'),
      file('src/Data/PaymentRepository.cs', 'public class PaymentRepository : IPaymentRepository { }'),
      file('src/Domain/Payment.cs', 'public record Payment(Guid Id, decimal Amount);'),
    ]);
    expect([...(index.imports.get('src/Api/Program.cs') ?? [])].sort()).toEqual(['src/Data/PaymentRepository.cs', 'src/Domain/IPaymentRepository.cs']);
    expect(index.importedBy.get('src/Domain/Payment.cs')).toEqual(new Set(['src/Domain/IPaymentRepository.cs']));
    expect(index.entryPoints.map((e) => e.path)).toEqual(['src/Api/Program.cs']);
  });
});

describe('Python and Go imports', () => {
  it('resolves package-relative and absolute imports', () => {
    const index = indexRepo([
      file('app/main.py', 'from app.services.users import sign_in\nfrom .config import settings\nimport requests\n\nif __name__ == "__main__":\n    run()'),
      file('app/config.py', 'settings = {}'),
      file('app/services/__init__.py', ''),
      file('app/services/users.py', 'def sign_in(): pass'),
    ]);
    expect([...(index.imports.get('app/main.py') ?? [])].sort()).toEqual(['app/config.py', 'app/services/users.py']);
    expect(index.packages.map((p) => p[0])).toContain('requests');
    expect(index.entryPoints[0].path).toBe('app/main.py');
  });

  it('links a Go file to every file of an imported package in the module', () => {
    const index = indexRepo([
      file('go.mod', 'module example.com/shop\n\ngo 1.22'),
      file('cmd/shop/main.go', 'package main\n\nimport (\n\t"fmt"\n\t"example.com/shop/internal/orders"\n)\n\nfunc main() {}'),
      file('internal/orders/orders.go', 'package orders'),
      file('internal/orders/store.go', 'package orders'),
    ]);
    expect([...(index.imports.get('cmd/shop/main.go') ?? [])].sort()).toEqual(['internal/orders/orders.go', 'internal/orders/store.go']);
    expect(index.entryPoints[0]).toEqual({ path: 'cmd/shop/main.go', why: 'startup file; program start' });
  });
});

describe('helpers', () => {
  it('joins paths', () => {
    expect(join('src/components/signin', '../../services/x')).toBe('src/services/x');
    expect(join('', './src/startup.design.ts')).toBe('src/startup.design.ts');
  });

  it('names packages', () => {
    expect(packageName('@paperbits/common/injection')).toBe('@paperbits/common');
    expect(packageName('lodash/fp')).toBe('lodash');
    expect(packageName('node:fs')).toBe('fs');
  });

  it('parses JSON with comments and trailing commas, keeping // inside strings', () => {
    expect(parseJsonc('{ "url": "https://x", // c\n "a": [1,], }')).toEqual({ url: 'https://x', a: [1] });
  });

  it('recognises re-export-only files', () => {
    expect(reexportOnly('// barrel\nexport * from "./a";\nexport { b } from "./b";\n')).toBe(true);
    expect(reexportOnly('export * from "./a";\nexport const x = 1;')).toBe(false);
  });

  it('splits a folder holding most of the repo into its subfolders', () => {
    const paths = [
      ...Array.from({ length: 6 }, (_, i) => `src/components/c${i}/c${i}.ts`),
      ...Array.from({ length: 6 }, (_, i) => `src/components/d${i}/d${i}.ts`),
      'src/services/a.ts',
      'src/startup.ts',
      'tools/build.ts',
    ];
    const g = grouper(paths);
    expect(g('src/services/a.ts')).toBe('src/services');
    expect(g('src/components/c1/c1.ts')).toBe('src/components/c1');
    expect(g('src/startup.ts')).toBe('src');
    expect(g('tools/build.ts')).toBe('tools');
  });

  it('spreads picks across groups', () => {
    const score = new Map([
      ['a/1', 10],
      ['a/2', 9],
      ['a/3', 8],
      ['b/1', 8.5],
    ]);
    expect(spread([...score.keys()], score, (p) => p.split('/')[0])).toEqual(['a/1', 'b/1', 'a/2', 'a/3']);
  });

  it('only counts examples as entry points when nothing else is', () => {
    const entries = findEntryPoints([file('samples/app/main.go', 'package main\nfunc main() {}')], () => true);
    expect(entries).toEqual([]);
  });
});
