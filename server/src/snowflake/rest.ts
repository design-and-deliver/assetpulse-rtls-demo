import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { SnowflakeConfig } from './config.js';

/**
 * Snowflake over plain HTTPS: key-pair JWT auth, the SQL API (`/api/v2/statements`), and Cortex
 * Analyst (`/api/v2/cortex/analyst/message`). No driver dependency, so the production bundle is
 * unchanged whether or not the layer is turned on.
 */

const JWT_TTL_S = 3600; // Snowflake's maximum
const JWT_REUSE_S = 3000; // re-sign 10 minutes before expiry
const POLL_MS = 500;
const POLL_TRIES = 20;

export type Fetch = typeof fetch;

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/** `ORG-ACCT` stays as is; a legacy `locator.region` keeps only the locator. Uppercase either way. */
export function jwtAccount(account: string): string {
  return account.split('.')[0]!.toUpperCase();
}

/** `SHA256:<base64 of the DER public key>` — what `DESC USER` shows as RSA_PUBLIC_KEY_FP. */
export function publicKeyFingerprint(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: 'spki',
    format: 'der',
  });
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
}

export function signJwt(config: SnowflakeConfig, nowS = Math.floor(Date.now() / 1000)): string {
  const qualifiedUser = `${jwtAccount(config.account)}.${config.user.toUpperCase()}`;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: `${qualifiedUser}.${publicKeyFingerprint(config.privateKeyPem)}`,
      sub: qualifiedUser,
      iat: nowS,
      exp: nowS + JWT_TTL_S,
    }),
  );
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), config.privateKeyPem);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** One SQL API binding per `?`, in order. Numbers go as FIXED, everything else as TEXT. */
export type Bind = string | number;

export interface QueryResult {
  columns: string[];
  /** The SQL API returns every cell as a string (or null). */
  rows: (string | null)[][];
}

interface StatementResponse {
  statementHandle?: string;
  message?: string;
  resultSetMetaData?: { rowType: { name: string }[] };
  data?: (string | null)[][];
}

export interface AnalystContent {
  type: string;
  text?: string;
  statement?: string;
  suggestions?: string[];
}

export class SnowflakeRest {
  private jwt: { token: string; signedAt: number } | null = null;

  constructor(
    private readonly config: SnowflakeConfig,
    private readonly fetchImpl: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private get baseUrl(): string {
    return `https://${this.config.account.toLowerCase()}.snowflakecomputing.com`;
  }

  private token(): string {
    const nowS = Math.floor(Date.now() / 1000);
    if (!this.jwt || nowS - this.jwt.signedAt > JWT_REUSE_S) {
      this.jwt = { token: signJwt(this.config, nowS), signedAt: nowS };
    }
    return this.jwt.token;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token()}`,
      'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  private async call<T>(path: string, init: RequestInit): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(),
    });
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(`snowflake ${res.status}: ${body.message ?? res.statusText}`);
    return { status: res.status, body };
  }

  /** Runs one statement. A 202 means it is still running; poll its handle until it finishes. */
  async query(statement: string, binds: Bind[] = []): Promise<QueryResult> {
    const { database, schema, warehouse, role } = this.config;
    let { status, body } = await this.call<StatementResponse>('/api/v2/statements', {
      method: 'POST',
      body: JSON.stringify({
        statement,
        bindings: toBindings(binds),
        database,
        schema,
        warehouse,
        role,
        timeout: 60,
      }),
    });
    for (let i = 0; status === 202 && i < POLL_TRIES; i++) {
      await this.sleep(POLL_MS);
      ({ status, body } = await this.call<StatementResponse>(
        `/api/v2/statements/${body.statementHandle}`,
        { method: 'GET' },
      ));
    }
    if (status === 202) throw new Error('snowflake: statement still running after polling');
    return {
      columns: body.resultSetMetaData?.rowType.map((col) => col.name) ?? [],
      rows: body.data ?? [],
    };
  }

  /** One single-turn Cortex Analyst question against the staged semantic model. */
  async askAnalyst(question: string): Promise<AnalystContent[]> {
    const { body } = await this.call<{ message?: { content?: AnalystContent[] } }>(
      '/api/v2/cortex/analyst/message',
      {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
          semantic_model_file: this.config.semanticModelFile,
        }),
      },
    );
    return body.message?.content ?? [];
  }
}

function toBindings(binds: Bind[]): Record<string, { type: string; value: string }> {
  return Object.fromEntries(
    binds.map((value, i) => [
      String(i + 1),
      { type: typeof value === 'number' ? 'FIXED' : 'TEXT', value: String(value) },
    ]),
  );
}
