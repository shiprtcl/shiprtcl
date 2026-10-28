// Builds the static site into public/. Same output works on shiprtcl.org and GitHub Pages.
//   SITE_URL  canonical origin            (default https://shiprtcl.org)
//   BASE      path prefix for links       (default /, e.g. /shiprtcl/ on project Pages)
//   REPO      GitHub repository URL       (default https://github.com/shiprtcl/shiprtcl)
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { build } from 'esbuild';
import { Marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');
const SITE_URL = (process.env.SITE_URL ?? 'https://shiprtcl.org').replace(/\/$/, '');
const BASE = process.env.BASE ?? '/';
const REPO = (process.env.REPO ?? 'https://github.com/shiprtcl/shiprtcl').replace(/\/$/, '');
const AUTHOR = 'Srishesh Archik';
const VERSION = '0.1';
const DATE = '2026-10-29';

const r = (...p) => join(ROOT, ...p);
const o = (...p) => join(OUT, ...p);
const read = (p) => readFile(p, 'utf8');
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- clean & assets ----------
for (const entry of await readdir(OUT).catch(() => [])) await rm(o(entry), { recursive: true, force: true });
await mkdir(o('assets'), { recursive: true });

await build({
  entryPoints: [r('packages/shiprtcl/src/index.ts')],
  bundle: true, minify: true, format: 'esm', target: 'es2022', platform: 'browser',
  outfile: o('assets/shiprtcl.min.js'), legalComments: 'none',
  banner: { js: `/* shiprtcl v${VERSION} reference implementation · Apache-2.0 · ${REPO} */` },
});
const assetVersion = {};
const lib = await read(o('assets/shiprtcl.min.js'));
assetVersion['shiprtcl.min.js'] = hash(lib);
const scenarios = await read(r('site/scenarios.js'));
await writeFile(o('assets/scenarios.js'), scenarios);
assetVersion['scenarios.js'] = hash(scenarios);
for (const f of ['home.js', 'playground.js']) {
  const src = (await read(r('site', f)))
    .replace("'./shiprtcl.min.js'", `'./shiprtcl.min.js?v=${assetVersion['shiprtcl.min.js']}'`)
    .replace("'./scenarios.js'", `'./scenarios.js?v=${assetVersion['scenarios.js']}'`);
  await writeFile(o('assets', f), src);
  assetVersion[f] = hash(src);
}
const css = await read(r('site/site.css'));
await writeFile(o('assets/site.css'), css);
assetVersion['site.css'] = hash(css);
await copyFile(r('site/favicon.svg'), o('favicon.svg'));

const fonts = { fontFiles: (await readdir(r('site/fonts'))).filter((f) => f.endsWith('.ttf')).map((f) => r('site/fonts', f)), loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono' };
await writeFile(o('og.png'), new Resvg(await read(r('site/og.svg')), { font: fonts, fitTo: { mode: 'width', value: 1200 } }).render().asPng());
await writeFile(o('apple-touch-icon.png'), new Resvg((await read(r('site/favicon.svg'))).replace(/<style>.*<\/style>/, '<style>.f{fill:#15171a}.s{stroke:#f5f3ec}.h{stroke:#3ddca8}</style>'), { fitTo: { mode: 'width', value: 180 } }).render().asPng());

// Raw sources, so people can cite, diff and implement from them.
await mkdir(o('spec'), { recursive: true });
await mkdir(o('whitepaper'), { recursive: true });
await mkdir(o('conformance'), { recursive: true });
await copyFile(r('spec/shiprtcl-v0.1.md'), o('spec/shiprtcl-v0.1.md'));
await copyFile(r('whitepaper/shiprtcl-whitepaper.md'), o('whitepaper/shiprtcl-whitepaper.md'));
await copyFile(r('conformance/fingerprint-vectors.json'), o('conformance/fingerprint-vectors.json'));

// ---------- layout ----------
const logo = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor"/><g fill="none" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 8h11M6.5 16h11M6.5 12h4" stroke="var(--bg)"/><path d="M14 12h3.5" stroke="var(--heal)"/></g></svg>`;
const ghIcon = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

function head(meta) {
  const url = SITE_URL + meta.path;
  const title = esc(meta.title);
  const desc = esc(meta.description);
  const jsonld = meta.jsonldObj ? `<script type="application/ld+json">${JSON.stringify(meta.jsonldObj).replace(/</g, '\\u003c')}</script>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
${meta.noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="author" content="${AUTHOR}">
<meta name="theme-color" content="#f5f3ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1013" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="${meta.ogType ?? 'website'}">
<meta property="og:site_name" content="SHIPRTCL">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="SHIPRTCL — Upstream APIs drift. Your ingestion heals.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${SITE_URL}/og.png">
<link rel="icon" href="${BASE}favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${BASE}apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${BASE}assets/site.css?v=${assetVersion['site.css']}">
${jsonld}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap">
  <a class="brand" href="${BASE}" aria-label="SHIPRTCL home">${logo}<span class="word">SHIPRTCL</span></a>
  <nav class="nav" aria-label="Primary">
    ${[['whitepaper/', 'Whitepaper'], ['spec/', 'Spec'], ['playground/', 'Playground']].map(([p, l]) => `<a href="${BASE}${p}"${meta.path === '/' + p ? ' aria-current="page"' : ''}>${l}</a>`).join('\n    ')}
    <a class="gh" href="${REPO}">${ghIcon}<span class="hide-sm">GitHub</span></a>
  </nav>
</div></header>
<main id="main">`;
}

function foot(meta) {
  return `</main>
<footer class="foot"><div class="wrap">
  <div>SHIPRTCL v${VERSION} draft · created by ${AUTHOR} · <a href="https://doi.org/10.5281/zenodo.23747811">DOI 10.5281/zenodo.23747811</a> · spec CC-BY-4.0 · code Apache-2.0</div>
  <nav aria-label="Footer">
    <a href="${REPO}">GitHub</a>
    <a href="${REPO}/blob/main/CONTRIBUTING.md">Contribute</a>
    <a href="${REPO}/blob/main/GOVERNANCE.md">Governance</a>
    <a href="${REPO}/security/policy">Security</a>
    <a href="${BASE}conformance/fingerprint-vectors.json">Vectors</a>
  </nav>
</div></footer>
${meta.script ? `<script type="module" src="${BASE}assets/${meta.script}?v=${assetVersion[meta.script]}"></script>` : ''}
</body>
</html>
`;
}

const fill = (html) => html.replaceAll('{{base}}', BASE).replaceAll('{{repo}}', REPO);
const pages = [];
async function emit(path, meta, body) {
  const file = path.endsWith('/') ? o(path, 'index.html') : o(path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, head(meta) + fill(body) + foot(meta));
  if (!meta.noindex) pages.push(path);
}

const person = { '@type': 'Person', name: AUTHOR };
const software = {
  '@context': 'https://schema.org', '@type': 'SoftwareSourceCode', name: 'SHIPRTCL', alternateName: 'Self-Healing Ingestion Protocol',
  description: 'Open protocol and reference implementation for structural fingerprinting and self-healing ingestion of webhooks and API payloads.',
  url: SITE_URL + '/', codeRepository: REPO, programmingLanguage: 'TypeScript', license: 'https://www.apache.org/licenses/LICENSE-2.0',
  author: person, creator: person, dateCreated: DATE, version: VERSION,
};

// ---------- HTML pages ----------
for (const f of await readdir(r('site/pages'))) {
  const src = await read(r('site/pages', f));
  const m = src.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\n?/);
  if (!m) throw new Error(`missing front matter in ${f}`);
  const meta = JSON.parse(m[1]);
  if (meta.jsonld === 'software') meta.jsonldObj = software;
  await emit(meta.path, meta, src.slice(m[0].length));
}

// ---------- Markdown documents ----------
function slugify(text, seen) {
  let s = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
  let n = s, i = 1;
  while (seen.has(n)) n = `${s}-${i++}`;
  seen.add(n);
  return n;
}

function renderDoc(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  const front = {};
  if (fm) for (const line of fm[1].split('\n')) { const i = line.indexOf(':'); front[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, ''); }
  const body = fm ? md.slice(fm[0].length) : md;
  const seen = new Set();
  const toc = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const html = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${html}</h1>\n`;
        const id = slugify(text, seen);
        if (depth <= 3) toc.push({ depth, id, html: html.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}">${html}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(body);
  let tocHtml = '<ol>';
  let open = false;
  for (const t of toc) {
    if (t.depth === 2) { if (open) tocHtml += '</ol></li>'; tocHtml += `<li><a href="#${t.id}">${t.html}</a><ol>`; open = true; }
    else tocHtml += `<li><a href="#${t.id}">${t.html}</a></li>`;
  }
  if (open) tocHtml += '</ol></li>';
  tocHtml += '</ol>';
  return { front, html: html.replace(/<ol><\/ol>/g, ''), toc: tocHtml.replace(/<ol><\/ol>/g, '') };
}

const tocScript = `<script>(()=>{const l=[...document.querySelectorAll('.toc a')];const m=new Map(l.map(a=>[a.getAttribute('href').slice(1),a]));const o=new IntersectionObserver(es=>{for(const e of es)if(e.isIntersecting){l.forEach(a=>a.classList.remove('on'));m.get(e.target.id)?.classList.add('on')}},{rootMargin:'-80px 0px -70% 0px'});document.querySelectorAll('.prose h2[id],.prose h3[id]').forEach(h=>o.observe(h))})();</script>`;

async function docPage({ src, path, title, description, eyebrow, raw, kind }) {
  const { front, html, toc } = renderDoc(await read(r(src)));
  const article = {
    '@context': 'https://schema.org', '@type': kind, headline: front.title, name: front.title, description,
    author: person, datePublished: DATE, dateModified: DATE, version: VERSION, inLanguage: 'en',
    license: 'https://creativecommons.org/licenses/by/4.0/', url: SITE_URL + path, publisher: { '@type': 'Organization', name: 'SHIPRTCL', url: SITE_URL },
  };
  const body = `
<div class="doc-head"><div class="wrap">
  <span class="eyebrow">${eyebrow}</span>
  <h1 style="margin-top:14px">${esc(title)}</h1>
  <div class="meta">
    <span>v${VERSION} · ${front.status ?? 'Draft'}</span><span>${DATE}</span><span>${esc(front.author ?? front.editor ?? AUTHOR)}</span><span>CC-BY-4.0</span>
    <a href="${BASE}${raw}">Markdown source</a><a href="${REPO}/blob/main/${src}">Edit on GitHub</a><a href="javascript:print()">Print / PDF</a>
  </div>
</div></div>
<div class="wrap doc">
  <nav class="toc" aria-label="Contents"><span class="eyebrow">Contents</span>${toc}</nav>
  <article class="prose">${html}</article>
</div>${tocScript}`;
  await emit(path, { title: `${title} — SHIPRTCL`, description, path, ogType: 'article', jsonldObj: article }, body);
}

await docPage({
  src: 'whitepaper/shiprtcl-whitepaper.md', path: '/whitepaper/', kind: 'ScholarlyArticle', eyebrow: 'Whitepaper',
  title: 'Self-healing ingestion with structural fingerprints and lazily synthesized mapping rules',
  description: 'The SHIPRTCL whitepaper: why webhook and API drift keeps breaking production, and how structural fingerprints, a verifiable mapping language and a privacy-bounded synthesis step repair it.',
  raw: 'whitepaper/shiprtcl-whitepaper.md',
});
await docPage({
  src: 'spec/shiprtcl-v0.1.md', path: '/spec/', kind: 'TechArticle', eyebrow: 'Specification · normative',
  title: 'SHIPRTCL Specification v0.1',
  description: 'The normative SHIPRTCL v0.1 specification: IAST normalization, the sr1 structural fingerprint, contracts, the SHIPRTCL Mapping Language, resolution, synthesis constraints, lifecycle, runtime and CloudEvents.',
  raw: 'spec/shiprtcl-v0.1.md',
});

// ---------- crawl & security metadata ----------
await writeFile(o('robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
await writeFile(o('sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${DATE}</lastmod></url>`).join('\n')}\n</urlset>\n`);
await mkdir(o('.well-known'), { recursive: true });
const expires = new Date(Date.parse(DATE) + 365 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
await writeFile(o('.well-known/security.txt'), `Contact: mailto:security@shiprtcl.org\nContact: ${REPO}/security/advisories/new\nExpires: ${expires}\nPreferred-Languages: en\nCanonical: ${SITE_URL}/.well-known/security.txt\nPolicy: ${REPO}/security/policy\n`);
await writeFile(o('.nojekyll'), '');

console.log(`site built → public/ (${pages.length} pages, base ${BASE}, repo ${REPO})`);
