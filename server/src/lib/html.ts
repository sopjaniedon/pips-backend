// Rich text rules shared with the migration (migration/src/lib/text.ts): same allow-list, same slugs.
import he from "he";
import sanitizeHtml from "sanitize-html";

const IFRAME_HOSTS = ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "player.vimeo.com", "www.google.com", "maps.google.com", "www.facebook.com"];

export function sanitize(html: string): string {
  return sanitizeHtml(html.normalize("NFC"), {
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

export function toText(html: string): string {
  return he.decode(sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })).replace(/\s+/g, " ").trim();
}

export function slugify(s: string, max = 80): string {
  const out = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, max).replace(/-+$/, "") || "item";
}

export const clean = (s: string | null | undefined) => { const t = (s ?? "").normalize("NFC").trim(); return t.length ? t : null; };
