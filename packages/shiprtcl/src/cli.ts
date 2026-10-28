#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fingerprint } from './fingerprint.js';
import { parse } from './ingest.js';
import { startProxy, type ProxyConfig } from './proxy.js';

const USAGE = `shiprtcl — reference implementation of the Self-Healing Ingestion Protocol v0.1

Usage:
  shiprtcl fingerprint [file] [--type <media-type>]   Print the shape, canonical form and fingerprint
  shiprtcl serve [config.json]                         Start the reference proxy (default ./shiprtcl.config.json)
`;

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'fingerprint') {
  const ti = args.indexOf('--type');
  const type = ti >= 0 ? args.splice(ti, 2)[1] : 'application/json';
  const body = args[0] ? await readFile(args[0], 'utf8') : await stdin();
  const fp = await fingerprint(parse(body, type));
  for (const e of fp.shape) console.log(`${e.path || '(root)'}\t${e.types.join('|')}`);
  console.log(`\ncanonical: ${fp.canonical}\nfingerprint: ${fp.id}`);
} else if (cmd === 'serve') {
  const config = JSON.parse(await readFile(args[0] ?? 'shiprtcl.config.json', 'utf8')) as ProxyConfig;
  await startProxy(config);
  console.log(`shiprtcl proxy listening on ${config.listen?.host ?? '127.0.0.1'}:${config.listen?.port ?? 8787}`);
} else {
  process.stdout.write(USAGE);
  process.exit(cmd ? 1 : 0);
}
