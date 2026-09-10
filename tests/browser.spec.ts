import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("Discord invitation -> web reading -> permanent focus-loss termination", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to/.test(message.text())
    )
      errors.push(message.text());
  });
  const invitation = JSON.parse(
    await readFile("work/browser-invite.json", "utf8"),
  );
  let holdTranslation = true;
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    if (holdTranslation && state.authenticated && !state.attempt)
      state.translation = {
        status: "translating",
        readyPages: 1,
        totalPages: 3,
      };
    await route.fulfill({ response, json: state });
  });
  await page.goto(invitation.url);
  await expect(page.getByRole("button", { name: "참여하기" })).toBeVisible();
  await expect(page).not.toHaveURL(/access=/);
  await page.getByRole("button", { name: "참여하기" }).click();
  await expect(page.locator("#start")).toBeDisabled();
  await expect(page.locator(".translation-progress")).toContainText("1 / 3");
  holdTranslation = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: "읽기 시작" })).toBeVisible();
  await expect(page.locator("#demo-banner")).toBeVisible();
  await page.screenshot({ path: "work/browser-ready.png", fullPage: true });
  const other = await browser.newContext();
  const duplicate = await other.newPage();
  await duplicate.goto(invitation.url);
  await duplicate.getByRole("button", { name: "참여하기" }).click();
  await expect(duplicate.locator("#notice")).toContainText("이미 사용");
  await expect(
    duplicate.getByRole("button", { name: "읽기 시작" }),
  ).toHaveCount(0);
  await other.close();

  await page.getByRole("button", { name: "읽기 시작" }).click();
  await expect
    .poll(() =>
      page.locator("#paper-canvas").evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /이전|다음/ })).toHaveCount(0);
  await expect
    .poll(() => page.locator(".translation-canvas").count())
    .toBeGreaterThan(0);
  await expect(page.locator(".document-flow")).toHaveCount(1);
  await expect(page.locator(".document-flow .source-group")).toHaveCount(3);
  await expect(page.locator(".document-flow .translation-sheet")).toHaveCount(
    4,
  );
  expect(
    await page.evaluate(
      async () => (await fetch("/api/attempt/translation/4?part=1")).status,
    ),
  ).toBe(200);
  await expect
    .poll(() =>
      page
        .locator(".translation-canvas")
        .first()
        .evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBeGreaterThan(0);
  const initialTimer = await page.locator("#timer").innerText();
  await expect(page.locator("#timer")).not.toHaveText(initialTimer);
  await page.locator("#paper-document").evaluate((node) => {
    node
      .querySelector<HTMLElement>('.source-group[data-page="2"]')
      ?.scrollIntoView();
  });
  await expect(
    page.locator('.source-group[data-page="2"] .source-canvas'),
  ).toHaveCount(1);
  const fourthTranslation = page.locator('.translation-sheet[data-page="4"]');
  await fourthTranslation.scrollIntoViewIfNeeded();
  await expect(fourthTranslation.locator(".translation-canvas")).toHaveCount(1);
  await page.locator("#paper-document").evaluate((node) => {
    node
      .querySelector<HTMLElement>('.source-group[data-page="3"]')
      ?.scrollIntoView();
  });
  await expect(
    page.locator('.source-group[data-page="3"] .source-canvas'),
  ).toHaveCount(1);
  await expect(
    page.locator('.translation-sheet[data-page="3"] .translation-canvas'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .locator('.translation-sheet[data-page="3"] .translation-canvas')
        .first()
        .evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBeGreaterThan(0);
  await page.locator("#paper-document").evaluate((node) => {
    node
      .querySelector<HTMLElement>('.translation-sheet[data-page="4"]')
      ?.scrollIntoView();
  });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "work/browser-reading.png", fullPage: true });
  await page.locator("#paper-document").evaluate((node) => {
    node
      .querySelector<HTMLElement>('.source-group[data-page="1"]')
      ?.scrollIntoView();
  });
  await expect(page.locator("#paper-canvas")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "페이지 확대", exact: true }).click();
  await page.getByRole("button", { name: "페이지 확대", exact: true }).click();
  await expect(page.locator("#zoom-level")).toHaveText("150%");
  expect(
    await page.locator("#paper-document").evaluate((document) => {
      const [original, translation] = document.querySelectorAll<HTMLElement>(
        ".document-pair:first-child > .document-side",
      );
      const originalBox = original.getBoundingClientRect();
      const translationBox = translation.getBoundingClientRect();
      return (
        originalBox.right <= translationBox.left &&
        document.scrollWidth > document.clientWidth
      );
    }),
  ).toBe(true);
  await page.screenshot({
    path: "work/browser-bilingual-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "페이지 축소", exact: true }).click();
  await page.getByRole("button", { name: "페이지 축소", exact: true }).click();
  const original = await page.evaluate(
    async () => (await (await fetch("/api/state")).json()).attempt,
  );
  let holdFinish = true;
  await page
    .context()
    .route("**/api/attempt/finish", (route) =>
      holdFinish ? route.abort() : route.continue(),
    );
  await page.context().setOffline(true);
  const lostFocus = await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    const canvas = document.getElementById(
      "paper-canvas",
    ) as HTMLCanvasElement | null;
    return {
      immediatelyCleared: !canvas || canvas.width === 0,
      translationCleared: [
        ...document.querySelectorAll<HTMLCanvasElement>(".translation-canvas"),
      ].every((c) => c.width === 0),
      at: Date.now(),
    };
  });
  expect(lostFocus.immediatelyCleared).toBe(true);
  expect(lostFocus.translationCleared).toBe(true);
  await expect(page.locator("#focus-ended")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#paper-canvas")).toHaveCount(0);
  // Reconnect after the original deadline so delayed termination must still be replayed.
  await page.waitForTimeout(
    Math.max(0, original.readingEndsAt - Date.now() + 150),
  );
  await page.context().setOffline(false);
  await page.reload();
  await expect(page.locator("#focus-ended, #discord-handoff")).toBeVisible();
  await expect(page.locator("#paper-canvas")).toHaveCount(0);
  await page.screenshot({
    path: "work/browser-focus-ended.png",
    fullPage: true,
  });
  holdFinish = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await (await fetch("/api/state")).json()).attempt.readingEndsAt,
      ),
    )
    .toBeLessThanOrEqual(lostFocus.at + 250);
  await expect(page.locator("#discord-handoff")).toBeVisible();
  await expect(page.locator("#discord-handoff")).toContainText("/submit");
  await expect(
    page.locator("form, textarea, #rankings, .grade-total"),
  ).toHaveCount(0);
  const ended = await page.evaluate(
    async () => (await (await fetch("/api/state")).json()).attempt,
  );
  expect(ended.readingEndsAt).toBeLessThan(original.readingEndsAt);
  expect(ended.submitBy - ended.readingEndsAt).toBe(30000);
  const expiredStatus = await page.evaluate(
    async () => (await fetch("/api/attempt/page/1")).status,
  );
  expect(expiredStatus).toBe(410);
  expect(
    await page.evaluate(
      async () => (await fetch("/api/attempt/translation/4?part=1")).status,
    ),
  ).toBe(410);
  await page.reload();
  await expect(page.locator("#discord-handoff")).toBeVisible();
  await expect(page.locator("#paper-canvas")).toHaveCount(0);
  const afterReload = await page.evaluate(
    async () => (await (await fetch("/api/state")).json()).attempt,
  );
  expect(afterReload.readingEndsAt).toBe(ended.readingEndsAt);
  expect(afterReload.submitBy).toBe(ended.submitBy);
  const webSubmission = await page.evaluate(async () => {
    const response = await fetch("/api/attempt/submit", { method: "POST" });
    return response.status;
  });
  expect(webSubmission).toBe(404);
  await page.screenshot({ path: "work/browser-handoff.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "work/browser-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(
    page.getByText("Discord에서 /paper로 열람 링크를 받아 주세요."),
  ).toBeVisible();
});
