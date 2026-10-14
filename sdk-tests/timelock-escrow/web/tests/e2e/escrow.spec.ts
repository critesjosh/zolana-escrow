import { expect, test, type Page } from "@playwright/test";

const UNLOCK_DELAY_SECONDS = 20;

async function ready(page: Page): Promise<void> {
  await expect(page.locator("body[data-ready='true']")).toBeAttached();
}

async function idle(page: Page): Promise<void> {
  await expect(page.locator("body[data-busy]")).not.toBeAttached();
}

test("deposit, lock, early withdraw rejected, withdraw after unlock, reload recovery", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[browser] ${message.text()}`);
  });

  await page.goto("/");
  await ready(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const address = await page.getByTestId("solana-address").textContent();
  const status = page.getByTestId("status");
  const shielded = page.getByTestId("shielded-balance");
  const escrows = page.locator("[data-testid='escrow']");

  await test.step("fund and deposit 0.5 SOL", async () => {
    await page
      .getByTestId("fund-form")
      .getByRole("textbox", { name: /amount/i })
      .fill("0.5");
    await page.getByTestId("fund-form").getByRole("button").click();
    await idle(page);
    await expect(status).toHaveText("Deposited.");
    await expect(shielded).toHaveText(/^0\.5 SOL/);
  });

  await test.step("lock 0.3 SOL", async () => {
    const form = page.getByTestId("lock-form");
    await form.getByRole("textbox", { name: /amount/i }).fill("0.3");
    await form.getByRole("textbox", { name: /unlock in/i }).fill(String(UNLOCK_DELAY_SECONDS));
    await form.getByRole("button").click();
    await idle(page);
    await expect(status).toHaveText("Locked.");
    await expect(shielded).toHaveText(/^0\.2 SOL/);
    await expect(escrows).toHaveCount(1);
    await expect(escrows.first()).toHaveAttribute("data-status", "locked");
    await expect(escrows.first()).toContainText("0.3 SOL");
  });

  await test.step("an early withdraw is rejected by the program", async () => {
    await escrows.first().getByTestId("withdraw").click();
    await idle(page);
    await expect(status).toContainText("not yet unlocked (error 9005)");
    await expect(page.locator("[data-testid='stages'] [data-state='failed']")).toHaveText(
      "Submitting",
    );
    await expect(escrows).toHaveCount(1);
  });

  await test.step("a reload rediscovers the same identity and escrow", async () => {
    await page.reload();
    await ready(page);
    await expect(page.getByTestId("solana-address")).toHaveText(address ?? "");
    await expect(escrows).toHaveCount(1);
    await expect(shielded).toHaveText(/^0\.2 SOL/);
  });

  await test.step("wait for the on-chain clock to pass the unlock", async () => {
    await expect
      .poll(
        async () => {
          await page.getByTestId("refresh").click();
          await page.waitForTimeout(1_000);
          return escrows.first().getAttribute("data-status");
        },
        { timeout: (UNLOCK_DELAY_SECONDS + 60) * 1000, intervals: [2_000] },
      )
      .toBe("unlocked");
  });

  await test.step("withdraw after unlock", async () => {
    await escrows.first().getByTestId("withdraw").click();
    await idle(page);
    await expect(status).toHaveText("Withdrawn to your shielded balance.");
    await expect(escrows).toHaveCount(0);
    await expect(shielded).toHaveText(/^0\.5 SOL/);
  });

  await test.step("a reload shows the escrow closed and the balance restored", async () => {
    await page.reload();
    await ready(page);
    await expect(escrows).toHaveCount(0);
    await expect(shielded).toHaveText(/^0\.5 SOL/);
  });

  expect(errors).toEqual([]);
});
