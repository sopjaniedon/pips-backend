import he from "he";
import sanitizeHtml from "sanitize-html";

/** NFC-normalise and trim; empty strings become null. */
export function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.normalize("NFC").trim();
  return t.length ? t : null;
}

/** DNN stores HTML entity-encoded ("&lt;p&gt;…"). Decode once when it looks encoded. */
export function decodeHtml(s: string | null | undefined): string {
  if (!s) return "";
  let out = s.normalize("NFC");
  if (/&lt;\/?[a-z]/i.test(out)) out = he.decode(out);
  return out;
}

/** Allow-list sanitiser for legacy rich text. Raw HTML is kept separately as a legacy revision. */
const IFRAME_HOSTS = ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "player.vimeo.com", "www.google.com", "maps.google.com", "www.facebook.com"];
export function sanitize(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "sub", "sup", "small",
      "blockquote", "ul", "ol", "li", "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
      "caption", "div", "span", "iframe", "pre", "code",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      iframe: ["src", "width", "height", "title", "allow", "allowfullscreen", "frameborder"],
      td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"],
      "*": ["class", "id"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    allowedIframeHostnames: IFRAME_HOSTS,
    transformTags: {
      a: (tagName, attribs) => attribs.target === "_blank" ? { tagName, attribs: { ...attribs, rel: "noopener noreferrer" } } : { tagName, attribs },
    },
  }).trim();
}

/** Plain text for search and summaries. */
export function toText(html: string): string {
  return he.decode(sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })).replace(/\s+/g, " ").trim();
}

/** URL slug: strip diacritics (ë→e, ç→c), lower-case, hyphenate. */
export function slugify(s: string, max = 80): string {
  const out = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (out.slice(0, max).replace(/-+$/, "") || "item");
}

/** Path key used for redirects: NFC, lower-case, no trailing slash, no query. */
export function normPath(p: string): string {
  let out = p.normalize("NFC").split("?")[0].toLowerCase().replace(/\/+/g, "/");
  if (out.length > 1) out = out.replace(/\/$/, "");
  return out.startsWith("/") ? out : "/" + out;
}

/** DNN uses a far-future expire date (+1000 years) for "never". */
export function realExpiry(d: Date | null): Date | null {
  if (!d) return null;
  return d.getUTCFullYear() >= 2100 ? null : d;
}
