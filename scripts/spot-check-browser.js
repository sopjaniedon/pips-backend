/* Spot check, browser half (see server/src/cli/spot-check.ts). Run in a normal browser tab on https://pips-ks.org
   (DevTools console), after setting window.SPOT_URLS to the contents of data/reports/spot-urls.json.
   Reads each page at a slow pace (1.5 s apart), read-only; the result is in window.SPOT_LIVE — save it as
   data/reports/spot-live.json. Documents are hashed in the browser (SHA-256) to compare the bytes. */
(async () => {
  const out = [];
  window.SPOT_LIVE = out; window.SPOT_DONE = false;
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  const text = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  for (const s of window.SPOT_URLS) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const res = await fetch(s.url, { credentials: "omit", cache: "no-store" });
      if (s.kind === "document") {
        const buf = await res.arrayBuffer();
        out.push({ url: s.url, status: res.status, size: buf.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", buf)) });
        continue;
      }
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const art = doc.querySelector(".EDN_article.EDN_details");
      if (!art) { out.push({ url: s.url, status: res.status === 200 ? 404 : res.status }); continue; }
      const content = art.querySelector(".EDN_article-content");
      const body = content ? content.cloneNode(true) : null;
      if (body) body.querySelectorAll(".EDN_cf_all_fields_container, .edn_article_gallery, .EDN_meta-details, .EDN_meta-tags, .EDN_rating, .edn_socialPrintWrapper, script, style").forEach(e => e.remove());
      const day = art.querySelector(".EDN_article-date");
      out.push({
        url: s.url, status: 200,
        title: text(art.querySelector(".EDN_title-container h1") || art.querySelector(".EDN_title-container")),
        date: day ? [...day.querySelectorAll("span")].map(x => x.textContent.trim()).join(" ") : text(art.querySelector(".EDN_publish-date")),
        gallery: art.querySelectorAll(".edn_article_gallery li a[href*='/Portals/' i]").length,
        docs: art.querySelectorAll("a[href*='DocumentDownload' i]").length,
        fields: text(art.querySelector(".EDN_cf_all_fields_container")),
        body: text(body),
      });
    } catch (e) { out.push({ url: s.url, status: 0 }); }
  }
  window.SPOT_DONE = true;
  console.log("spot check: read", out.length, "items");
})();
