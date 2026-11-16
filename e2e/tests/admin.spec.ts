import { expect, test } from "@playwright/test";

test("admin sign-in page, wrong password, strict headers", async ({ page }) => {
  const res = await page.goto("/admin/");
  expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(res?.headers()["cache-control"]).toBe("no-store");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("#l-login").fill("nobody@example.invalid");
  await page.locator("#l-pass").fill("not-a-real-password-123");
  await page.locator("#lf [type=submit]").click();
  await expect(page.locator("#l-err")).toBeVisible();
});

test("admin API refuses anonymous calls", async ({ request }) => {
  expect((await request.get("/api/admin/bootstrap")).status()).toBe(401);
  expect((await request.get("/api/admin/forms/2/export")).status()).toBe(401);
});

test("forgotten-password screen answers the same for unknown addresses", async ({ page }) => {
  await page.goto("/admin/");
  await page.locator("#forgot").click();
  await page.locator("#f-email").fill("nobody@example.invalid");
  await page.locator("#ff [type=submit]").click();
  await expect(page.getByText("If an account exists")).toBeVisible();
});
