// Server-side shell for the prototype pages: injects language, SEO/OG tags, analytics, the page data
// (instead of the static data.js) and rewrites prototype links (about.html, activity.html?id=…) to pretty URLs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_TO_KEY, PAGES, pagePath, prettyFromFile, type Lang } from "./routes.js";

const templates = new Map<string, string>();
export function template(webDir: string, name: string, dev: boolean): string {
  if (dev || !templates.has(name)) templates.set(name, readFileSync(join(webDir, name), "utf8"));
  return templates.get(name)!;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LS = new RegExp(String.fromCharCode(0x2028), "g"), PS = new RegExp(String.fromCharCode(0x2029), "g");
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(LS, "\\u2028").replace(PS, "\\u2029");

export interface RenderOptions {
  lang: Lang;
  title: string;
  description?: string | null;
  canonical: string; // absolute path
  alternates: Partial<Record<Lang, string>>; // absolute paths
  ogImage?: string | null;
  ogType?: "website" | "article";
  baseUrl: string;
  headHtml?: string | null; // site-wide analytics snippet (DNN PageHeadText)
  bodyScript?: string | null; // runs after the page scripts (interface translation)
  nonce: string; // per-response CSP nonce for every <script> on the page
  data: unknown;
  page: unknown;
}

/** Route table for the browser-side link rewriter. */
export function routeTable(lang: Lang) {
  const paths: Record<string, string> = {};
  for (const p of PAGES) paths[p.key] = pagePath(p.key, lang);
  return { lang, files: FILE_TO_KEY, paths };
}

// Rewrites prototype links added later by page scripts (cards, header, search…). Mirrors prettyFromFile().
const LINK_REWRITER = `(function(){var R=window.PIPS_ROUTES;function fix(a){var h=a.getAttribute("href");if(!h)return;var m=/^([a-z-]+\\.html)(?:\\?([^#]*))?(#.*)?$/.exec(h);if(!m)return;var k=R.files[m[1]];if(!k)return;var q=new URLSearchParams(m[2]||""),p;if(k==="activity"||k==="item"){var id=q.get("id");p=(k==="activity"?R.paths.activities:R.paths.publications)+(id&&/^\\d+$/.test(id)?"/"+id:"");}else{p=R.paths[k];var s=q.toString();if(s)p+="?"+s;}a.setAttribute("href",p+(m[3]||""));}
function scan(n){if(!n||n.nodeType!==1)return;if(n.tagName==="A")fix(n);if(n.querySelectorAll)n.querySelectorAll('a[href*=".html"]').forEach(fix);}
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="attributes")fix(m.target);else m.addedNodes.forEach(scan);});}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["href"]});})();`;

export function renderPage(html: string, o: RenderOptions): string {
  const abs = (p: string) => (/^https?:/i.test(p) ? p : o.baseUrl.replace(/\/$/, "") + p);
  const head = [
    `<base href="/">`,
    o.description ? `<meta name="description" content="${esc(o.description)}">` : "",
    `<link rel="canonical" href="${esc(abs(o.canonical))}">`,
    ...Object.entries(o.alternates).map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${esc(abs(p!))}">`),
    o.alternates.sq ? `<link rel="alternate" hreflang="x-default" href="${esc(abs(o.alternates.sq))}">` : "",
    `<meta property="og:type" content="${o.ogType ?? "website"}">`,
    `<meta property="og:title" content="${esc(o.title)}">`,
    o.description ? `<meta property="og:description" content="${esc(o.description)}">` : "",
    `<meta property="og:url" content="${esc(abs(o.canonical))}">`,
    `<meta property="og:locale" content="${o.lang === "en" ? "en_GB" : "sq_AL"}">`,
    o.ogImage ? `<meta property="og:image" content="${esc(abs(o.ogImage))}">` : "",
    `<meta name="twitter:card" content="${o.ogImage ? "summary_large_image" : "summary"}">`,
  ].filter(Boolean).join("\n");

  let out = html
    .replace(/<html lang="[^"]*"/, `<html lang="${o.lang}"`)
    .replace(/<meta name="description"[^>]*>\n?/, "") // the template's own; ours is injected below
    .replace(/<head>/, () => `<head>\n${head}`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(o.title)}</title>`)
    .replace(
      /<script src="assets\/js\/data\.js[^"]*"><\/script>/,
      () => `<script>window.PIPS_DATA=${json(o.data)};window.PIPS_PAGE=${json(o.page)};window.PIPS_ROUTES=${json(routeTable(o.lang))};</script>\n<script>${LINK_REWRITER}</script>`,
    );
  if (o.headHtml) out = out.replace("</head>", () => `${o.headHtml}\n</head>`);
  if (o.bodyScript) out = out.replace(/<\/body>(?![\s\S]*<\/body>)/, () => `<script>${o.bodyScript}</script>\n</body>`);
  // Prototype review notes and controls never show on the real site.
  out = out.replace("</head>", () => `<style>.proto-note,.proto-only{display:none!important}</style>\n</head>`);
  // Every script on the page (template, injected data, analytics) carries the nonce the CSP header allows.
  out = out.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${o.nonce}"`);
  // Static links in the template
  out = out.replace(/href="([a-z-]+\.html)(?:\?([^"#]*))?(#[^"]*)?"/g, (m, file: string, q: string | undefined, hash: string | undefined) => {
    const pretty = prettyFromFile(file, q ?? "", o.lang);
    return pretty ? `href="${pretty}${hash ?? ""}"` : m;
  });
  return out;
}

/** Content Security Policy for public pages: own scripts by nonce, analytics, and the embeds article bodies use. */
export function publicCsp(nonce: string, https: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com https://www.google-analytics.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
    "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.google.com https://maps.google.com https://www.openstreetmap.org https://www.facebook.com",
    "media-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", "report-uri /csp-report",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
