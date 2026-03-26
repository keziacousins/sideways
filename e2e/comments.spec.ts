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
        "# Comments Test\n\nFirst paragraph for testing.\n\nSecond paragraph here.",
    }),
  });
});

async function login(page: Page) {
  await page.goto("/auth/login");
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("/", { timeout: 15000 });
}

test.describe("Comments — unauthenticated", () => {
  test("toggle opens panel, shows empty state, no form", async ({ page }) => {
    await page.goto(`/s/${SPACE}/${DOC}`);
    await page.locator(".comments-toggle").click();
    await expect(page.locator(".comments-panel-overlay")).toBeVisible();
    await expect(page.locator(".comments-empty")).toContainText("Sign in");
    await expect(page.locator(".comment-form")).not.toBeVisible();
  });
});

test.describe("Comments — authenticated", () => {
  test("full comment lifecycle: add, reply, resolve", async ({ page }) => {
    await login(page);
    await page.goto(`/s/${SPACE}/${DOC}`);

    // Listen for network to debug
    const apiResponses: string[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/api/comments")) {
        apiResponses.push(`${res.status()} ${res.request().method()} ${res.url().slice(0, 100)}`);
      }
    });

    // Open panel
    await page.locator(".comments-toggle").click();

    // Check if comment form is visible (means we have auth)
    const hasForm = await page.locator(".comment-form").isVisible();
    if (!hasForm) {
      // Token might not have been passed — check page
      console.log("No comment form — checking if user is authenticated on page");
      const headerText = await page.locator(".user-name").textContent().catch(() => "not found");
      console.log("Header user:", headerText);
    }
    expect(hasForm).toBe(true);

    // Add comment
    await page.locator(".comment-form textarea").fill("This is a great doc!");
    await page.locator(".comment-form-submit").click({ force: true });

    // Wait for API response
    await page.waitForResponse(
      (res) => res.url().includes("/api/comments") && res.request().method() === "POST",
      { timeout: 5000 },
    );

    // Wait for refetch
    await page.waitForResponse(
      (res) => res.url().includes("/api/comments") && res.request().method() === "GET",
      { timeout: 5000 },
    );

    // Now check for the comment
    await expect(page.locator(".comment-body").first()).toContainText(
      "great doc",
      { timeout: 5000 },
    );

    // Reply
    await page
      .locator(".comment-action")
      .filter({ hasText: "Reply" })
      .first()
      .click({ force: true });

    await page.locator(".comment-form textarea").fill("Thanks!");
    await page.locator(".comment-form-submit").click({ force: true });

    await page.waitForResponse(
      (res) => res.url().includes("/api/comments") && res.request().method() === "POST",
      { timeout: 5000 },
    );

    await expect(page.locator(".comment-item.reply").first()).toBeVisible({
      timeout: 5000,
    });

    // Resolve
    const resolvePromise = page.waitForResponse(
      (res) => res.url().includes("/resolve") && res.request().method() === "POST",
      { timeout: 5000 },
    );
    await page
      .locator(".comment-action")
      .filter({ hasText: "Resolve" })
      .first()
      .click({ force: true });

    const resolveRes = await resolvePromise;
    console.log("Resolve response:", resolveRes.status());

    // Wait for refetch after resolve
    await page.waitForResponse(
      (res) => res.url().includes("/api/comments") && res.request().method() === "GET",
      { timeout: 5000 },
    );

    await expect(page.locator(".resolved-section")).toBeVisible({
      timeout: 5000,
    });

    console.log("API responses:", apiResponses);
  });
});
