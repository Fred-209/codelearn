import { describe, expect, it } from 'vitest';
import { classify, isSecretPath } from '../src/scan/classify';
import { REDACTED, redactSecrets } from '../src/scan/redact';

// Made-up values, put together at run time so secret scanners don't take them for real ones.
const fake = (...parts: string[]) => parts.join('');

describe('redactSecrets', () => {
  it('masks secret values in JSON config, keeping the keys', () => {
    const json = `{\n  "Smtp": { "Host": "smtp.contoso.com", "Password": "${fake('Pa5', '5word!')}" },\n  "Jwt": { "Secret": "${fake('s3cr3t', '-signing-value')}" }\n}`;
    const out = redactSecrets(json);
    expect(out).toContain(`"Password": "${REDACTED}"`);
    expect(out).toContain(`"Secret": "${REDACTED}"`);
    expect(out).toContain('"Host": "smtp.contoso.com"');
  });

  it('masks the secret parts of connection strings', () => {
    const out = redactSecrets(
      `"Default": "Server=db;Database=pay;User Id=app;Password=${fake('hunt', 'er22')};"\nDefaultEndpointsProtocol=https;AccountName=st;AccountKey=${fake('abc1', '23+/==')};`,
    );
    expect(out).toContain(`Password=${REDACTED};`);
    expect(out).toContain(`AccountKey=${REDACTED};`);
    expect(out).toContain('User Id=app');
  });

  it('masks code assignments, YAML and .env style values, tokens and private keys', () => {
    expect(redactSecrets(`const apiKey = "${fake('AbC123', 'xyz789')}";`)).toBe(`const apiKey = "${REDACTED}";`);
    expect(redactSecrets(`  client_secret: ${fake('x9f8e', '7d6c5')}\n`)).toBe(`  client_secret: ${REDACTED}\n`);
    expect(redactSecrets(`DB_PASSWORD=${fake('tops', '3cret')}`)).toBe(`DB_PASSWORD=${REDACTED}`);
    const jwt = [fake('eyJhbGci', 'OiJIUzI1NiJ9'), fake('eyJzdWIi', 'OiIxMjM0NTY3ODkwIn0'), fake('dozjgNry', 'P4J3jVmNHl0w5N')].join('.');
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toContain(REDACTED);
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----')).not.toContain('MIIEow');
  });

  it('keeps references to secrets and ordinary names', () => {
    const keep = [
      'password: ${{ secrets.DB_PASSWORD }}',
      '"Password": "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/db)"',
      'const tokenKey = "accessToken";',
      'sessionStorage.getItem("accessToken");',
      'token: true',
      '"passwordHint": "Use 8 or more characters"',
      'public const string TokenHeader = "Authorization";',
    ];
    for (const line of keep) expect(redactSecrets(line)).toBe(line);
  });
});

describe('secret and deployment files', () => {
  it('never reads secret files', () => {
    for (const p of ['.env', 'api/.env.local', 'local.settings.json', 'certs/site.pfx', 'keys/server.key', 'config/secrets.json', '.npmrc', 'id_rsa']) {
      expect(isSecretPath(p)).toBe(true);
      expect(classify(p)).toBe('other');
    }
    expect(isSecretPath('src/auth/credentials.ts')).toBe(false);
    expect(isSecretPath('src/models/key.ts')).toBe(false);
  });

  it('recognises pipelines, infrastructure and hosting config', () => {
    for (const p of [
      '.github/workflows/azure-static-web-apps-portal.yml',
      'azure-pipelines.yml',
      '.pipelines/release.yaml',
      'infra/main.bicep',
      'infra/modules/swa.json',
      'terraform/main.tf',
      'src/portal/staticwebapp.config.json',
      'api/host.json',
      'Dockerfile',
      'docker-compose.override.yml',
      'netlify.toml',
    ]) {
      expect(classify(p), p).toBe('deploy');
    }
    expect(classify('src/build/helpers.ts')).toBe('code');
    expect(classify('src/data/settings.yml')).toBe('other');
  });
});
