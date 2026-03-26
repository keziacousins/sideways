import { test, expect } from "@playwright/test";

const TEST_EMAIL = `e2e-${Date.now()}@sideways.dev`;
const TEST_NAME = "E2E Test User";
const TEST_PASSWORD = "E2eTestPass2026!secure";

test.describe("Authentication", () => {
  test("homepage shows sign in button when not logged in", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("text=Sign in")).toBeVisible();
    await expect(page.locator(".logo-text")).toBeVisible();
  });

  test("sign up and login flow", async ({ page }) => {
    await page.goto("/auth/signup");
    await expect(page.locator("h1")).toContainText("Create your account");

    await page.fill('input[name="name"]', TEST_NAME);
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15000 });

    await expect(page.locator("text=E2E Test User")).toBeVisible();
    await expect(page.locator("text=Sign out")).toBeVisible();
  });

  test("logout flow", async ({ page }) => {
    await page.goto("/auth/login");
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15000 });
    await expect(page.locator("text=Sign out")).toBeVisible();

    await page.click("text=Sign out");
    await page.waitForURL("/");
    await expect(page.locator("text=Sign in")).toBeVisible();
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/auth/login");
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', "wrongpassword123!");

    page.on("dialog", async (dialog) => {
      expect(dialog.message()).toContain("credentials");
      await dialog.accept();
    });

    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/auth\/login/);
  });

  test("signup link from login page", async ({ page }) => {
    await page.goto("/auth/login");
    await page.click("text=Create one");
    await expect(page).toHaveURL(/auth\/signup/);
  });

  test("login link from signup page", async ({ page }) => {
    await page.goto("/auth/signup");
    await page.click("text=Sign in");
    await expect(page).toHaveURL(/auth\/login/);
  });
});
