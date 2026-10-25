import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Everything the Snowflake layer needs. The layer is OFF unless `SNOWFLAKE_ENABLED=1` and every
 * required variable is set, so a deploy without these env vars behaves exactly as before.
 */
export interface SnowflakeConfig {
  /** Account identifier as in the URL: `<org>-<account>` (or a legacy locator). */
  account: string;
  user: string;
  /** PKCS#8 PEM of the RSA key whose public half is set on the user (`RSA_PUBLIC_KEY`). */
  privateKeyPem: string;
  role: string;
  warehouse: string;
  database: string;
  schema: string;
  /** Stage path of the Cortex Analyst semantic model, e.g. `@ASSETPULSE.APP.MODELS/assetpulse.yaml`. */
  semanticModelFile: string;
}

const REQUIRED = [
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USER',
  'SNOWFLAKE_ROLE',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_DATABASE',
  'SNOWFLAKE_SCHEMA',
] as const;

type Env = Record<string, string | undefined>;

/**
 * The key comes inline (`SNOWFLAKE_PRIVATE_KEY`) or from a file path. Inline, it is forgiving of
 * how a portal paste arrives: `\n` escapes, or just the base64 body on one line with no
 * BEGIN/END lines, which is rebuilt into a PKCS#8 PEM.
 */
function privateKeyFrom(env: Env): string | null {
  const inline = env.SNOWFLAKE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (inline?.trim()) return inline.includes('-----BEGIN') ? inline : pemFromBody(inline);
  const path = env.SNOWFLAKE_PRIVATE_KEY_PATH;
  return path ? readFileSync(path, 'utf8') : null;
}

function pemFromBody(body: string): string {
  const lines = body.replace(/\s+/g, '').match(/.{1,64}/g) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
}

/** A key Node cannot parse would fail every request, so it keeps the layer off instead. */
function parses(pem: string): boolean {
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

/** `null` means the layer stays off; `missing` names what kept it off, for one startup log line. */
export function loadSnowflakeConfig(env: Env = process.env): {
  config: SnowflakeConfig | null;
  missing: string[];
} {
  if (env.SNOWFLAKE_ENABLED !== '1') return { config: null, missing: [] };
  const missing: string[] = REQUIRED.filter((key) => !env[key]);
  const privateKeyPem = privateKeyFrom(env);
  if (!privateKeyPem) missing.push('SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH');
  else if (!parses(privateKeyPem)) missing.push('a valid SNOWFLAKE_PRIVATE_KEY (it did not parse)');
  if (missing.length > 0 || !privateKeyPem) return { config: null, missing };

  const database = env.SNOWFLAKE_DATABASE!;
  const schema = env.SNOWFLAKE_SCHEMA!;
  return {
    config: {
      account: env.SNOWFLAKE_ACCOUNT!,
      user: env.SNOWFLAKE_USER!,
      privateKeyPem,
      role: env.SNOWFLAKE_ROLE!,
      warehouse: env.SNOWFLAKE_WAREHOUSE!,
      database,
      schema,
      semanticModelFile:
        env.SNOWFLAKE_SEMANTIC_MODEL ?? `@${database}.${schema}.MODELS/assetpulse.yaml`,
    },
    missing: [],
  };
}
