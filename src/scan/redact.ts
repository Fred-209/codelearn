// Masks values that look like secrets before code goes to an AI: passwords, keys, tokens and
// connection strings written into config files or code. Files that are secrets as a whole
// (.env, keys, certificates) are never read at all; see isSecretPath. Pure.

export const REDACTED = '«redacted»';

/** Names whose values are secrets: "Password", "client_secret", "AccountKey", "apiKey"... */
const SECRET_NAME =
  /(pass(word|wd|phrase)?|pwd|secret|token|(api|access|account|private|signing|encryption|auth|master|secret|storage|subscription|primary|secondary|service|function|host|app)[-_]?key|client[-_]?secret|connection[-_]?string|conn[-_]?str|sas|shared[-_]?access[-_]?(key|signature)|credentials?)$/i;

/** Values that point at a secret instead of holding one: they stay, as they teach how config works. */
const REFERENCE = /^(\$\{\{|\$\(|\$\{|\{\{|%|@Microsoft\.KeyVault|<|\[parameters\(|\[variables\(|\(|env[.:(]|process\.env|Environment\.|os\.environ|secrets\.|vault:|keyvault:|ref\+|true$|false$|null$|none$|\*+$|x+$|changeme$|your[-_ ])/i;

const QUOTED_ASSIGNMENT = /(["'`]?)([\w$.-]+)\1(\s*(?::|=|=>|:=)\s*)(["'`])((?:(?!\4)[^\\\n]|\\.){4,}?)\4/g;
const BARE_ASSIGNMENT = /^(\s*(?:-\s+)?(?:export\s+)?["']?)([\w$.-]+)(["']?\s*[:=]\s*)([^\s"'`#{[][^\s#]*)\s*$/;
const CONNECTION_PART = /\b(Password|Pwd|AccountKey|SharedAccessKey|SharedAccessSignature|AccessKey|ApiKey|Secret|sig)=([^;"'`\s&]+)/gi;
const PEM = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
const TOKENS = [
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{8,}/g, // JWT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // API keys in the sk- style
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

/** A value worth hiding: long enough, not a reference, and not plain words like "accessToken". */
function looksSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 6 || /\s/.test(v) || REFERENCE.test(v)) return false;
  return /\d/.test(v) || /[^\w.-]/.test(v) || (v.length >= 24 && /[a-z]/.test(v) && /[A-Z]/.test(v));
}

export function redactSecrets(text: string): string {
  let out = text.replace(PEM, `-----BEGIN $1PRIVATE KEY-----${REDACTED}-----END $1PRIVATE KEY-----`);
  for (const re of TOKENS) out = out.replace(re, REDACTED);
  out = out.replace(CONNECTION_PART, (m, key: string, value: string) => (REFERENCE.test(value) ? m : `${key}=${REDACTED}`));
  out = out.replace(QUOTED_ASSIGNMENT, (m, q: string, name: string, sep: string, quote: string, value: string) =>
    SECRET_NAME.test(lastPart(name)) && looksSecret(value) ? `${q}${name}${q}${sep}${quote}${REDACTED}${quote}` : m,
  );
  // YAML, INI and .env style: key: value with no quotes.
  return out
    .split('\n')
    .map((line) => {
      const m = BARE_ASSIGNMENT.exec(line);
      return m && SECRET_NAME.test(lastPart(m[2])) && looksSecret(m[4]) ? `${m[1]}${m[2]}${m[3]}${REDACTED}` : line;
    })
    .join('\n');
}

/** "ConnectionStrings.Default" -> "Default"; "db.password" -> "password". */
function lastPart(name: string): string {
  const parts = name.split(/[.:]/).filter(Boolean);
  const last = parts.at(-1) ?? name;
  // "ConnectionStrings": { "Default": "..." } is caught by the connection-string parts instead.
  return parts.length > 1 && /connection/i.test(parts[0]) ? 'connectionstring' : last;
}
