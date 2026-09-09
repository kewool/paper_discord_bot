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
  await page.goto(invitation.url);
  await expect(
    page.getByRole("button", { name: "이 링크로 참여하기" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/access=/);
  await page.getByRole("button", { name: "이 링크로 참여하기" }).click();
  await expect(
    page.getByRole("button", { name: "읽기 시작하기" }),
  ).toBeVisible();
  await expect(page.locator("#demo-banner")).toBeVisible();
  await page.screenshot({ path: "work/browser-ready.png", fullPage: true });
  const other = await browser.newContext();
  const duplicate = await other.newPage();
  await duplicate.goto(invitation.url);
  await duplicate.getByRole("button", { name: "이 링크로 참여하기" }).click();
  await expect(duplicate.locator("#notice")).toContainText("이미 사용");
  await expect(
    duplicate.getByRole("button", { name: "읽기 시작하기" }),
  ).toHaveCount(0);
  await other.close();

  await page.getByRole("button", { name: "읽기 시작하기" }).click();
  await expect
    .poll(() =>
      page.locator("#paper-canvas").evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBeGreaterThan(0);
  const initialTimer = await page.locator("#timer").innerText();
  await expect(page.locator("#timer")).not.toHaveText(initialTimer);
  await page.getByRole("button", { name: "다음 →" }).click();
  await expect(page.locator("#count")).toHaveText("2 / 3");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "work/browser-reading.png", fullPage: true });
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
      at: Date.now(),
    };
  });
  expect(lostFocus.immediatelyCleared).toBe(true);
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
    page.getByRole("link", { name: "디스코드로 돌아가기" }),
  ).toHaveAttribute(
    "href",
    "https://discord.com/channels/700000000000000001/710000000000000001",
  );
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
  await page.getByRole("button", { name: "웹 세션 종료" }).click();
  await expect(
    page.getByText("Discord에서 참여 링크를 받아 주세요."),
  ).toBeVisible();
});
