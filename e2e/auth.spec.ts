import { test, expect } from "@playwright/test";

const API_URL = "http://localhost:4100";
const TEST_EMAIL = `e2e-${Date.now()}@sideways.dev`;
const TEST_NAME = "E2E Test User";
const TEST_PASSWORD = "E2eTestPass2026!secure";

test.describe("Authentication", () => {
  test("homepage shows sign in button when not logged in", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("text=Sign in")).toBeVisible();
    await expect(page.locator("text=Sideways")).toBeVisible();
  });

  test("sign up and login flow", async ({ page }) => {
    // Go to signup page
    await page.goto("/auth/signup");
    await expect(page.locator("h1")).toContainText("Create your Sideways account");

    // Fill in the form
    await page.fill('input[name="name"]', TEST_NAME);
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);

    // Submit
    await page.click('button[type="submit"]');

    // Should redirect through Hydra and back to homepage
    await page.waitForURL("/", { timeout: 15000 });

    // Should show user name in header
    await expect(page.locator("text=E2E Test User")).toBeVisible();
    await expect(page.locator("text=Sign out")).toBeVisible();
    await expect(page.locator("text=Sign in")).not.toBeVisible();
  });

  test("logout flow", async ({ page }) => {
    // First login
    await page.goto("/auth/login");
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15000 });

    // Verify logged in
    await expect(page.locator("text=Sign out")).toBeVisible();

    // Logout
    await page.click("text=Sign out");
    await page.waitForURL("/");

    // Should show sign in again
    await expect(page.locator("text=Sign in")).toBeVisible();
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/auth/login");
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', "wrongpassword123!");

    // Listen for the alert
    page.on("dialog", async (dialog) => {
      expect(dialog.message()).toContain("credentials");
      await dialog.accept();
    });

    await page.click('button[type="submit"]');

    // Should stay on login page
    await expect(page).toHaveURL(/auth\/login/);
  });

  test("signup link from login page", async ({ page }) => {
    await page.goto("/auth/login");
    await page.click("text=Sign up");
    await expect(page).toHaveURL(/auth\/signup/);
  });

  test("login link from signup page", async ({ page }) => {
    await page.goto("/auth/signup");
    await page.click("text=Sign in");
    await expect(page).toHaveURL(/auth\/login/);
  });
});

test.describe("Authenticated navigation", () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto("/auth/login");
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15000 });
  });

  test("homepage shows spaces", async ({ page }) => {
    await expect(page.locator("text=Spaces")).toBeVisible();
  });

  test("can navigate to a space", async ({ page }) => {
    // Check if any space cards exist
    const cards = page.locator(".sw-doc-card");
    const count = await cards.count();
    if (count > 0) {
      await cards.first().click();
      await expect(page.locator(".sw-breadcrumb")).toBeVisible();
    }
  });
});
