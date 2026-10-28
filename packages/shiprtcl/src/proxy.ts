/**
 * Reference ingestion proxy, spec §10. Node.js only. Deliberately small: it exists to show
 * the runtime requirements end to end, not to replace a production webhook gateway.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Engine, MemoryStore, UnknownContract, type Policy } from './engine.js';
import { UnsupportedMediaType, parse } from './ingest.js';
import { signStandardWebhook, timingSafeEqual, verifyGitHub, verifyHmacSha256, verifyStripe } from './signatures.js';
import { chatCompletionsSynthesizer } from './synthesizer.js';
import type { Contract, Json, Rule, RuleState, ShipEvent } from './types.js';

export interface VerifyConfig {
  scheme: 'github' | 'stripe' | 'hmac-sha256';
  secretEnv: string;
  header?: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
}

export interface ContractConfig extends Contract {
  destination: string;
  /** Env var holding a Standard Webhooks secret (`whsec_…`) used to re-sign deliveries. */
  signingSecretEnv?: string;
  verify?: VerifyConfig;
}

export interface ProxyConfig {
  listen?: { port?: number; host?: string };
  dataDir?: string;
  maxBodyBytes?: number;
  policy?: Partial<Policy>;
  synthesizer?: { baseURL: string; model: string; apiKeyEnv?: string };
  contracts: ContractConfig[];
}

/** A MemoryStore that persists to `rules.json` with atomic writes. */
export class FileStore extends MemoryStore {
  private writing = Promise.resolve();
  constructor(private file: string) {
    super();
  }
  static async open(file: string): Promise<FileStore> {
    const s = new FileStore(file);
    try {
      const loaded = MemoryStore.from(JSON.parse(await readFile(file, 'utf8')));
      s.rules = loaded.rules;
      s.index = loaded.index;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return s;
  }
  private flush() {
    const data = JSON.stringify(this.toJSON(), null, 1);
    this.writing = this.writing.then(async () => {
      await writeFile(this.file + '.tmp', data);
      await rename(this.file + '.tmp', this.file);
    });
    return this.writing;
  }
  override async put(rule: Rule) {
    await super.put(rule);
    await this.flush();
  }
  override async alias(contract: string, fp: string, ruleId: string) {
    await super.alias(contract, fp, ruleId);
    await this.flush();
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(Object.assign(new Error('payload too large'), { status: 413 }));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startProxy(config: ProxyConfig, env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const dataDir = config.dataDir ?? '.shiprtcl';
  await mkdir(dataDir, { recursive: true });
  const store = await FileStore.open(join(dataDir, 'rules.json'));
  const contracts = new Map(config.contracts.map((c) => [c.id, c]));
  const eventsFile = join(dataDir, 'events.ndjson');
  const dlqFile = join(dataDir, 'quarantine.ndjson');
  const dlqKey = env.SHIPRTCL_DLQ_KEY ? Buffer.from(env.SHIPRTCL_DLQ_KEY, 'base64') : undefined;
  if (dlqKey && dlqKey.length !== 32) throw new Error('SHIPRTCL_DLQ_KEY must be 32 bytes, base64-encoded');
  const syn = config.synthesizer;

  const engine = new Engine({
    contracts: config.contracts,
    store,
    policy: config.policy,
    source: `shiprtcl://${env.HOSTNAME ?? 'proxy'}`,
    synthesizer: syn ? chatCompletionsSynthesizer({ baseURL: syn.baseURL, model: syn.model, apiKey: syn.apiKeyEnv ? env[syn.apiKeyEnv] : undefined }) : undefined,
    onEvent: (e: ShipEvent) => void appendFile(eventsFile, JSON.stringify(e) + '\n'),
  });

  /** Quarantined payloads contain real data: encrypt at rest when a key is configured. */
  const quarantine = async (record: Record<string, unknown>, payload: string) => {
    let stored: unknown = payload;
    if (dlqKey) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', dlqKey, iv);
      const data = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
      stored = { alg: 'A256GCM', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    }
    await appendFile(dlqFile, JSON.stringify({ at: new Date().toISOString(), ...record, payload: stored }) + '\n');
  };

  const seen = new Map<string, number>();
  const DEDUPE_MS = 24 * 3600_000;
  const duplicate = (key: string) => {
    const now = Date.now();
    if ((seen.get(key) ?? 0) > now - DEDUPE_MS) return true;
    seen.set(key, now);
    if (seen.size > 10_000) seen.delete(seen.keys().next().value!);
    return false;
  };

  const deliver = async (c: ContractConfig, id: string, output: Json, headers: Record<string, string>) => {
    const body = JSON.stringify(output);
    const secret = c.signingSecretEnv ? env[c.signingSecretEnv] : undefined;
    for (const [attempt, wait] of [0, 1_000, 5_000, 25_000].entries()) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const ts = Math.floor(Date.now() / 1000);
      const h: Record<string, string> = { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), ...headers };
      if (secret) h['webhook-signature'] = await signStandardWebhook(secret, id, ts, body);
      try {
        const res = await fetch(c.destination, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(10_000) });
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) return false;
      } catch {
        /* retry */
      }
      if (attempt === 3) return false;
    }
    return false;
  };

  const verify = async (v: VerifyConfig, req: IncomingMessage, body: string) => {
    const secret = env[v.secretEnv];
    if (!secret) throw new Error(`missing env ${v.secretEnv}`);
    const header = (name: string) => req.headers[name.toLowerCase()] as string | undefined;
    if (v.scheme === 'github') return verifyGitHub(secret, body, header(v.header ?? 'x-hub-signature-256'));
    if (v.scheme === 'stripe') return verifyStripe(secret, body, header(v.header ?? 'stripe-signature'));
    return verifyHmacSha256(secret, body, header(v.header ?? 'x-signature'), v.encoding, v.prefix);
  };

  const admin = async (req: IncomingMessage, res: ServerResponse, parts: string[]) => {
    const token = env.SHIPRTCL_ADMIN_TOKEN;
    const auth = req.headers.authorization ?? '';
    if (!token || !timingSafeEqual(auth, `Bearer ${token}`)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && parts[0] === 'rules' && parts[1]) return send(res, 200, await store.list(parts[1]));
    const states: Record<string, RuleState> = { activate: 'active', retire: 'retired', shadow: 'shadow' };
    if (req.method === 'POST' && parts[0] === 'rules' && parts[1] && parts[2] && states[parts[2]])
      return send(res, 200, await engine.transition(parts[1], states[parts[2]]!, 'admin'));
    return send(res, 404, { error: 'not found' });
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (parts[0] === 'admin') return await admin(req, res, parts.slice(1));
      if (req.method !== 'POST' || parts[0] !== 'in' || !parts[1]) return send(res, 404, { error: 'not found' });

      const c = contracts.get(parts[1]);
      if (!c) return send(res, 404, { error: 'unknown contract' });
      const body = await readBody(req, config.maxBodyBytes ?? 1_048_576);
      if (c.verify && !(await verify(c.verify, req, body))) return send(res, 401, { error: 'invalid signature' });
      const contentType = req.headers['content-type'];
      let value: Json;
      try {
        value = parse(body, contentType);
      } catch (e) {
        return send(res, e instanceof UnsupportedMediaType ? 415 : 400, { error: (e as Error).message });
      }
      const id = 'msg_' + createHash('sha256').update(c.id + '\0' + body).digest('hex').slice(0, 24);
      if (duplicate(id)) return send(res, 202, { id, duplicate: true });
      send(res, 202, { id });

      // Acknowledged: everything below is asynchronous with respect to the upstream.
      const r = await engine.process(c.id, { value });
      const meta = { contract: c.id, id, fingerprint: r.fingerprint.id, rule: r.rule.id };
      if (r.status !== 'translated' || !r.output) return void (await quarantine({ ...meta, reason: r.status, errors: r.errors }, body));
      const ok = await deliver(c, id, r.output, { 'shiprtcl-fingerprint': r.fingerprint.id, 'shiprtcl-rule': r.rule.id });
      if (!ok) await quarantine({ ...meta, reason: 'delivery_failed', errors: [] }, body);
    } catch (e) {
      const status = (e as { status?: number }).status ?? (e instanceof UnknownContract ? 404 : 500);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
      if (status === 500) console.error(e);
    }
  });

  const port = config.listen?.port ?? 8787;
  const host = config.listen?.host ?? '127.0.0.1';
  await new Promise<void>((r) => server.listen(port, host, r));
  return server;
}
