// Public route table. Albanian (default language) at the root, English under /en.
// Paths stay close to the old DNN URLs. migration/src/config/site-map.ts uses the same paths for redirects.
export type Lang = "sq" | "en";

export interface PageRoute {
  key: string;
  template: string; // file in web/
  sq: string;
  en: string | null;
  requiredPermission?: string;
  title?: { sq: string; en: string }; // used when the page has no imported DNN title (PageMeta)
}

export const PAGES: PageRoute[] = [
  { key: "home", template: "index.html", sq: "/", en: "/en" },
  { key: "about", template: "about.html", sq: "/per-ne", en: "/en/about-us", title: { sq: "Për ne", en: "About us" } },
  { key: "board", template: "board.html", sq: "/per-ne/bordi", en: "/en/about-us/board", title: { sq: "Bordi", en: "Board" } },
  { key: "staff", template: "staff.html", sq: "/per-ne/stafi", en: "/en/about-us/staff", title: { sq: "Stafi", en: "Staff" } },
  { key: "strategy", template: "strategy.html", sq: "/per-ne/strategjia", en: "/en/about-us/strategy", title: { sq: "Strategjia 2025–2030", en: "Strategy 2025–2030" } },
  { key: "careers", template: "careers.html", sq: "/per-ne/karriera", en: "/en/about-us/careers", title: { sq: "Karriera", en: "Careers" } },
  { key: "donors", template: "donors.html", sq: "/donatoret", en: "/en/donors", title: { sq: "Donatorët dhe partnerët", en: "Donors and partners" } },
  { key: "school-of-politics", template: "school-of-politics.html", sq: "/shkolla-politike", en: "/en/school-of-politics", title: { sq: "Shkolla Politike", en: "School of Politics" } },
  { key: "generation", template: "generation.html", sq: "/shkolla-politike/gjenerata", en: "/en/school-of-politics/generation", title: { sq: "Gjeneratat e Shkollës Politike", en: "School of Politics generations" } },
  { key: "apply", template: "apply.html", sq: "/aplikimi", en: "/en/apply", title: { sq: "Apliko në Shkollën Politike", en: "Apply to the School of Politics" } },
  { key: "programs", template: "programs.html", sq: "/programet", en: "/en/programs", title: { sq: "Programet", en: "Programs" } },
  { key: "activities", template: "activities.html", sq: "/aktivitetet", en: "/en/activities", title: { sq: "Aktivitetet", en: "Activities" } },
  { key: "research", template: "research.html", sq: "/hulumtime", en: "/en/research", title: { sq: "Hulumtime", en: "Research" } },
  { key: "publications", template: "publications.html", sq: "/publikimet", en: "/en/publications", title: { sq: "Publikimet", en: "Publications" } },
  { key: "alumni", template: "alumni.html", sq: "/alumni", en: null, requiredPermission: "page.alumni.view", title: { sq: "Alumni", en: "Alumni" } },
  { key: "news", template: "news.html", sq: "/lajme", en: "/en/news", title: { sq: "Lajme", en: "News" } },
  { key: "contact", template: "contact.html", sq: "/kontakti", en: "/en/contact", title: { sq: "Kontakti", en: "Contact" } },
  { key: "search", template: "search.html", sq: "/kerkimi", en: "/en/search", title: { sq: "Kërkimi", en: "Search" } },
];

/** Prototype file names (web/*.html) → page keys; used to rewrite links and redirect old prototype URLs. */
export const FILE_TO_KEY: Record<string, string> = Object.fromEntries([
  ...PAGES.map(p => [p.template, p.key]),
  ["activity.html", "activity"], ["item.html", "item"],
]);

export function pagePath(key: string, lang: Lang): string {
  const p = PAGES.find(x => x.key === key);
  if (!p) return lang === "en" ? "/en" : "/";
  return (lang === "en" ? p.en : null) ?? p.sq;
}

export const articleSection = (kind: "activity" | "publication") => (kind === "activity" ? "activities" : "publications");

export function articlePath(kind: "activity" | "publication", lang: Lang, id: number, slug: string): string {
  return `${pagePath(articleSection(kind), lang)}/${id}/${slug}`;
}

/** Map "activity.html?id=5", "activities.html?program=x" … to a pretty path for the given language. */
export function prettyFromFile(file: string, query: string, lang: Lang): string | null {
  const key = FILE_TO_KEY[file];
  if (!key) return null;
  const qs = new URLSearchParams(query);
  if (key === "activity" || key === "item") {
    const id = qs.get("id");
    const base = pagePath(key === "activity" ? "activities" : "publications", lang);
    return id && /^\d+$/.test(id) ? `${base}/${id}` : base;
  }
  const q = qs.toString();
  return pagePath(key, lang) + (q ? `?${q}` : "");
}

/** Every public path → (route, lang, article id?). */
export function matchPath(path: string): { key: string; lang: Lang; articleId?: number; slug?: string } | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  for (const lang of ["en", "sq"] as const) {
    for (const p of PAGES) {
      const base = lang === "en" ? p.en : p.sq;
      if (!base) continue;
      if (clean === base) return { key: p.key, lang };
      if (p.key === "activities" || p.key === "publications") {
        const m = new RegExp(`^${base.replace(/\//g, "\\/")}\\/(\\d+)(?:\\/([^/]+))?$`).exec(clean);
        if (m) return { key: p.key === "activities" ? "activity" : "publication", lang, articleId: Number(m[1]), slug: m[2] };
      }
    }
  }
  return null;
}
