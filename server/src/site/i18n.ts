// Albanian interface text. The templates are written in English; for sq pages the server translates the
// static HTML (so crawlers see Albanian) and a small browser script translates what page scripts render later.
// Dictionary: web/i18n/sq.json (exact strings + regex patterns). Anything missing stays in English.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface Dict { strings: Record<string, string>; patterns: [string, string][] }
interface Loaded { mtime: number; dict: Dict; re: [RegExp, string][]; script: string }

let cache: Loaded | null = null;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Matches the browser-side lookup below: exact string first, then the first pattern that matches.
function lookup(d: Loaded, raw: string): string | null {
  const k = norm(raw);
  if (!k || !/[A-Za-z]/.test(k)) return null;
  const hit = d.dict.strings[k];
  if (hit != null) return hit;
  for (const [re, to] of d.re) if (re.test(k)) return k.replace(re, to);
  return null;
}

function load(webDir: string, dev: boolean): Loaded {
  const file = join(webDir, "i18n", "sq.json");
  const mtime = dev ? statSync(file).mtimeMs : 0;
  if (cache && (!dev || cache.mtime === mtime)) return cache;
  const dict = JSON.parse(readFileSync(file, "utf8")) as Dict;
  const re = dict.patterns.map(([p, to]) => [new RegExp(p), to] as [RegExp, string]);
  const payload = JSON.stringify({ s: dict.strings, p: dict.patterns }).replace(/</g, "\\u003c");
  cache = { mtime, dict, re, script: `window.PIPS_I18N=${payload};\n${CLIENT}` };
  return cache;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const encText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const encAttr = (s: string) => encText(s).replace(/"/g, "&quot;");

const SKIP = /(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<textarea\b[\s\S]*?<\/textarea>|<!--[\s\S]*?-->)/i;
const ATTRS = /\b(aria-label|placeholder|title|alt)="([^"]*)"/g;

/** Translates the static text and labelled attributes of a template (scripts and styles are left alone). */
export function translateHtml(html: string, webDir: string, dev: boolean): string {
  const d = load(webDir, dev);
  return html.split(SKIP).map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/<[^>]+>/g, tag => tag.replace(ATTRS, (m, a: string, v: string) => {
        const t = lookup(d, decode(v));
        return t == null ? m : `${a}="${encAttr(t)}"`;
      }))
      .replace(/>([^<]+)</g, (m, text: string) => {
        const t = lookup(d, decode(text));
        if (t == null) return m;
        const lead = /^\s*/.exec(text)![0], trail = /\s*$/.exec(text)![0];
        return `>${lead}${encText(t)}${trail}<`;
      });
  }).join("");
}

/** Inline script for sq pages: dictionary + observer for text rendered by page scripts. */
export function clientScript(webDir: string, dev: boolean): string {
  return load(webDir, dev).script;
}

// Skips anything marked data-no-i18n (article bodies), form fields and app.js's own labels (data-i18n). In the browser,
// PIPS_I18N.missing lists English-looking strings that had no translation (data text excluded).
const CLIENT = `(function(){var D=window.PIPS_I18N,S=D.s,P=D.p.map(function(x){return[new RegExp(x[0]),x[1]];});D.missing=new Set();var O=new Set(Object.keys(S).map(function(k){return S[k];}));
var data="";try{data=JSON.stringify([window.PIPS_DATA,window.PIPS_PAGE]);}catch(e){}
function tr(raw){var k=raw.replace(/\\s+/g," ").trim();if(!k||!/[A-Za-z]/.test(k)||O.has(k))return null;if(Object.prototype.hasOwnProperty.call(S,k))return S[k];
for(var i=0;i<P.length;i++)if(P[i][0].test(k)){var r=k.replace(P[i][0],P[i][1]);O.add(r);return r;}if(/[A-Za-z]{2}/.test(k)&&!/[ëçË]/.test(k)&&data.indexOf(k)<0)D.missing.add(k);return null;}
var SKIP="script,style,textarea,code,pre,[data-no-i18n],[data-i18n],[contenteditable]";
function skip(el){return !el||(el.closest&&el.closest(SKIP));}
function text(n){if(skip(n.parentElement))return;var t=tr(n.nodeValue);if(t!=null&&t!==n.nodeValue.trim()){var v=n.nodeValue;n.nodeValue=v.match(/^\\s*/)[0]+t+v.match(/\\s*$/)[0];}}
var A=["aria-label","placeholder","title","alt"];
function attrs(el){if(skip(el))return;for(var i=0;i<A.length;i++){var v=el.getAttribute(A[i]);if(v){var t=tr(v);if(t!=null&&t!==v)el.setAttribute(A[i],t);}}}
function walk(root){if(root.nodeType===3)return text(root);if(root.nodeType!==1||skip(root))return;attrs(root);
var w=document.createTreeWalker(root,5,null),n;while((n=w.nextNode())){if(n.nodeType===3)text(n);else attrs(n);}}
D.translate=tr;walk(document.body);
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="characterData")text(m.target);else if(m.type==="attributes")attrs(m.target);else m.addedNodes.forEach(walk);});})
.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:A});})();`;
