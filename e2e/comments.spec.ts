import { test, expect, type Page } from "@playwright/test";

const TEST_EMAIL = `comments-e2e-${Date.now()}@sideways.dev`;
const TEST_NAME = "Comments Tester";
const TEST_PASSWORD = "CommentsTest2026!secure";
const API_URL = "http://localhost:4100";
const SPACE = `comments-e2e-${Date.now()}`;
const DOC = "comments-test-doc";

test.beforeAll(async () => {
  await fetch(`${API_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_EMAIL,
      name: TEST_NAME,
      password: TEST_PASSWORD,
    }),
  });

  await fetch(`${API_URL}/api/spaces/${SPACE}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Comments E2E Space", visibility: "public" }),
  });

  await fetch(`${API_URL}/api/documents/${SPACE}/${DOC}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Comments Test Document",
      content:
        "# Comments Test\n\nFirst paragraph for testing inline comments.\n\nSecond paragraph with different content.\n\n## Another Section\n\nMore content here for anchoring.",
    }),
  });
});

test.afterAll(async () => {
  await fetch(`${API_URL}/api/spaces/${SPACE}`, { method: "DELETE" }).catch(() => {});
});

async function login(page: Page) {
  await page.goto("/auth/login");
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("/", { timeout: 15000 });
}

test.describe("Comments — unauthenticated", () => {
  test("panel shows empty state with sign-in prompt", async ({ page }) => {
    await page.goto(`/s/${SPACE}/${DOC}`);
    // Wait for React island to hydrate
    await expect(page.locator(".comments-toggle")).toBeVisible({ timeout: 10000 });
    await page.locator(".comments-toggle").click();
    await expect(page.locator(".comments-panel-overlay")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".comments-empty")).toContainText("Sign in");
    await expect(page.locator(".comment-form")).not.toBeVisible();
  });
});

test.describe("Comments — authenticated", () => {
  test.describe.configure({ mode: "serial" });
  test("can open panel, add page comment, see it appear", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);

    // Open panel
    await page.locator(".comments-toggle").click();
    await expect(page.locator(".comments-panel-overlay")).toBeVisible();

    // Click the compose trigger to expand the form
    await page.locator(".comment-compose-trigger").click();
    await expect(page.locator(".comment-form textarea")).toBeVisible();

    // Type a comment
    await page.locator(".comment-form textarea").fill("This is a page-level comment.");

    // Submit button should be enabled
    await expect(page.locator(".comment-form-submit")).toBeEnabled();

    // Click submit
    await page.locator(".comment-form-submit").click();

    // Wait for comment to appear in the list
    await expect(page.locator(".comment-body").first()).toContainText(
      "page-level comment",
      { timeout: 5000 },
    );
    await expect(page.locator(".comment-author").first()).toContainText(TEST_NAME);

    // Form should collapse back to trigger after submit
    await expect(page.locator(".comment-compose-trigger")).toBeVisible({ timeout: 5000 });
  });

  test("submit button is disabled when textarea is empty", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);
    await page.locator(".comments-toggle").click();
    await page.locator(".comment-compose-trigger").click();

    await expect(page.locator(".comment-form-submit")).toBeDisabled();
  });

  test("can cancel anchor/reply and return to page comment mode", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);
    await page.locator(".comments-toggle").click();

    // Wait for existing comments to load
    await expect(page.locator(".comment-thread").first()).toBeVisible({ timeout: 5000 });

    // Click reply on a comment
    await page.locator(".comment-action").filter({ hasText: "Reply" }).first().click();

    // Should show "Write a reply" placeholder
    await expect(page.locator(".comment-form textarea")).toHaveAttribute(
      "placeholder",
      /reply/i,
    );

    // Cancel button should be visible
    await expect(page.locator(".comment-form-cancel")).toBeVisible();

    // Click cancel
    await page.locator(".comment-form-cancel").click();

    // Should collapse back to trigger
    await expect(page.locator(".comment-compose-trigger")).toBeVisible(
    );
    // Form should be gone
    await expect(page.locator(".comment-form")).not.toBeVisible();
  });

  test("can reply to a comment", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);
    await page.locator(".comments-toggle").click();

    await expect(page.locator(".comment-thread").first()).toBeVisible({ timeout: 5000 });

    // Reply
    await page.locator(".comment-action").filter({ hasText: "Reply" }).first().click();
    await page.locator(".comment-form textarea").click();
    await page.locator(".comment-form textarea").fill("This is a reply.");
    await page.locator(".comment-form-submit").click();

    // Reply should appear
    await expect(page.locator(".comment-item.reply .comment-body").first()).toContainText(
      "This is a reply",
      { timeout: 5000 },
    );

    // Form should collapse after reply
    await expect(page.locator(".comment-compose-trigger")).toBeVisible({ timeout: 5000 });
  });

  test("can resolve and see resolved section", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);
    await page.locator(".comments-toggle").click();

    await expect(page.locator(".comment-thread").first()).toBeVisible({ timeout: 5000 });

    // Resolve
    await page.locator(".comment-action").filter({ hasText: "Resolve" }).first().click();

    // Resolved section should appear
    await expect(page.locator(".resolved-section")).toBeVisible({ timeout: 5000 });
  });

  test("can close panel", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);
    await page.locator(".comments-toggle").click();
    await expect(page.locator(".comments-panel-overlay")).toBeVisible();

    await page.locator(".panel-close").click();
    await expect(page.locator(".comments-panel-overlay")).not.toBeVisible();
  });

  test("badge shows comment count", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);

    // Wait for React island to hydrate and fetch comments
    await expect(page.locator(".comments-badge")).toBeVisible({ timeout: 5000 });
    const count = await page.locator(".comments-badge").textContent();
    expect(Number(count)).toBeGreaterThan(0);
  });
});
