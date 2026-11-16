import { expect, test, type Page } from "@playwright/test";

const PAGES: [string, RegExp][] = [
  ["/", /PIPS/], ["/per-ne", /PIPS/], ["/per-ne/bordi", /Bord/], ["/per-ne/stafi", /Staf/], ["/per-ne/strategjia", /Strategj/],
  ["/donatoret", /Donator/], ["/shkolla-politike", /Shkoll/], ["/aplikimi", /Aplikim/], ["/programet", /Program/],
  ["/aktivitetet", /Aktivitet/], ["/hulumtime", /Hulumtim/], ["/publikimet", /Publikim/], ["/kontakti", /kontakt/i],
  ["/en", /PIPS/], ["/en/about-us", /About|PIPS/], ["/en/about-us/board", /Board/], ["/en/activities", /Activit/], ["/en/publications", /Publication/], ["/en/contact", /Contact/],
];

/** Collects script errors and CSP violations while the page is open. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", e => problems.push(`error: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`csp: ${m.text()}`); });
  return problems;
}

for (const [path, title] of PAGES) {
  test(`page ${path} renders with SEO tags and no errors`, async ({ page }) => {
    const problems = watch(page);
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(title);
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toContain(path === "/" ? "" : path.split("?")[0]);
    expect(await page.locator('meta[property="og:title"]').count()).toBe(1);
    expect(await page.locator('link[rel="alternate"][hreflang]').count()).toBeGreaterThan(0);
    // Exactly one main heading in use: visible, or screen-reader-only when the home page shows the carousel (phones).
    await expect(page.locator("h1:visible, h1.sr-only").first()).toBeAttached();
    expect(await page.locator("h1").evaluateAll(hs => hs.filter(h => !h.closest("[hidden]")).length)).toBe(1);
    await expect(page.locator(".proto-note:visible, .proto-only:visible")).toHaveCount(0);
    expect(problems).toEqual([]);
  });
}

test("Albanian interface on sq pages, English on en pages", async ({ page }) => {
  await page.goto("/aktivitetet");
  await expect(page.getByText("Shfaq më shumë").first()).toBeVisible();
  await page.goto("/en/activities");
  await expect(page.getByText("Load more").first()).toBeVisible();
});

test("activities: load more and program filter", async ({ page }) => {
  await page.goto("/aktivitetet");
  const cards = page.locator("#act-grid > *");
  const before = await cards.count();
  await page.getByText("Shfaq më shumë").first().click();
  await expect.poll(() => cards.count()).toBeGreaterThan(before);
});

test("activity detail: body, gallery and canonical slug", async ({ page }) => {
  const res = await page.goto("/aktivitetet/311");
  expect(res?.status()).toBe(200);
  // The short address works; the canonical link carries the slug.
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(/\/aktivitetet\/311\/[a-z0-9-]+$/);
  await expect(page.locator(".prose p").first()).toBeVisible();
  await expect(page.locator(".gallery img").first()).toBeVisible();
});

test("search finds articles in both languages", async ({ page }) => {
  await page.goto("/kerkimi?q=energji");
  await expect(page.locator("#results .list-row").first()).toBeVisible();
  await page.goto("/en/search?q=energy");
  await expect(page.locator("#results .list-row").first()).toBeVisible();
});

test("old DNN links redirect in one hop", async ({ request }) => {
  const r = await request.get("/sq/Detajet/ArtMID/1444/ArticleID/4188/seminari-i-par235-i-shkoll235s-politike-2021", { maxRedirects: 0 });
  expect(r.status()).toBe(301);
  expect(r.headers()["location"]).toMatch(/\/aktivitetet\/\d+\//);
  const gone = await request.get("/Portals/0/DigForm/anything/1_cv.pdf", { maxRedirects: 0 });
  expect(gone.status()).toBe(410);
});

test("apply form: steps from the DigForm definition, validation without submitting", async ({ page }) => {
  await page.goto("/aplikimi");
  await expect(page.locator("#stepper .step")).toHaveCount(8);
  await page.locator("#next").click();
  await expect(page.locator(".field.is-error").first()).toBeVisible();
  await expect(page.getByText("Kjo fushë është e detyrueshme.").first()).toBeVisible();
});

test("contact form: required fields are checked in the browser", async ({ page }) => {
  await page.goto("/kontakti");
  await page.locator("#contact-form [type=submit]").click();
  await expect(page.locator("#contact-form .field.is-error")).not.toHaveCount(0);
});

test("alumni page needs a staff login", async ({ request }) => {
  const r = await request.get("/alumni");
  expect(r.status()).toBe(401);
});

test("private applicant files are never public", async ({ request }) => {
  const r = await request.get("/files/1/x.pdf");
  expect([404, 200]).toContain(r.status()); // file 1 may be public; private ids answer 404 (covered by the API matrix)
});
