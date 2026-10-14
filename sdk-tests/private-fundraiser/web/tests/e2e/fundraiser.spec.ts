import { expect, test, type Page } from "@playwright/test";

const CONTRIBUTION_WINDOW = 120;
const SETTLEMENT_WINDOW = 90;

async function ready(page: Page): Promise<void> {
  await expect(page.locator("body[data-ready='true']")).toBeAttached();
}

async function idle(page: Page): Promise<void> {
  await expect(page.locator("body[data-busy]")).not.toBeAttached();
}

test("fund, contribute with co-signing, early settle rejected, settle after close, reload recovery", async ({
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
  const status = page.getByTestId("status");
  const campaign = page.getByTestId("campaign").first();

  await test.step("fund both contributors", async () => {
    const form = page.getByTestId("fund-form");
    for (const role of ["alice", "bob"]) {
      await form.getByRole("combobox").selectOption(role);
      await form.getByRole("textbox", { name: /amount/i }).fill("0.5");
      await form.getByRole("button").click();
      await idle(page);
      await expect(status).toHaveText("Deposited.");
      await expect(page.getByTestId(`shielded-${role}`)).toHaveText(/^0\.5 SOL/);
    }
  });

  await test.step("the coordinator creates a campaign", async () => {
    const form = page.getByTestId("create-form");
    await form.getByRole("textbox", { name: /target/i }).fill("0.4");
    await form.getByRole("textbox", { name: /close in/i }).fill(String(CONTRIBUTION_WINDOW));
    await form.getByRole("textbox", { name: /settlement window/i }).fill(String(SETTLEMENT_WINDOW));
    await form.getByRole("button").click();
    await idle(page);
    await expect(status).toHaveText("Campaign created.");
    await expect(campaign).toHaveAttribute("data-phase", "open");
  });

  const contribute = async (contributor: string, amount: string) => {
    const form = campaign.getByTestId("contribute-form");
    await form.getByRole("combobox").selectOption(contributor);
    await form.getByRole("textbox", { name: /amount/i }).fill(amount);
    await form.getByRole("button").click();
    await idle(page);
  };

  await test.step("a coordinator outage blocks contributions", async () => {
    await page.getByTestId("coordinator-offline").check();
    await contribute("alice", "0.25");
    await expect(status).toContainText("coordinator is offline");
    await expect(page.locator("[data-testid='stages'] [data-state='failed']")).toHaveText(
      /Coordinator checks/,
    );
    await expect(campaign).toHaveAttribute("data-count", "0");
    await page.getByTestId("coordinator-offline").uncheck();
  });

  await test.step("two contributions are accepted", async () => {
    await contribute("alice", "0.25");
    await expect(status).toHaveText("Contribution accepted.");
    await contribute("bob", "0.2");
    await expect(status).toHaveText("Contribution accepted.");
    await expect(campaign).toHaveAttribute("data-count", "2");
    await expect(page.getByTestId("shielded-alice")).toHaveText(/^0\.25 SOL/);
    await expect(campaign.locator("[data-testid='contribution']")).toHaveCount(2);
  });

  await test.step("settlement before the close is rejected by the program", async () => {
    await campaign.getByTestId("settle").click();
    await idle(page);
    await expect(status).toContainText("(error 9112)");
    await expect(campaign).toHaveAttribute("data-phase", "open");
  });

  await test.step("a reload rediscovers the campaign and each contribution", async () => {
    await page.reload();
    await ready(page);
    await expect(campaign).toHaveAttribute("data-count", "2");
    await expect(
      campaign.locator("[data-testid='contribution'][data-contributor='alice']"),
    ).toContainText("0.25 SOL");
  });

  await test.step("wait for contributions to close", async () => {
    await expect
      .poll(
        async () => {
          await page.getByTestId("refresh").click();
          await page.waitForTimeout(1_000);
          return campaign.getAttribute("data-phase");
        },
        { timeout: (CONTRIBUTION_WINDOW + 60) * 1000, intervals: [2_000] },
      )
      .toBe("settling");
  });

  await test.step("the coordinator settles and the beneficiary receives the total", async () => {
    await campaign.getByTestId("settle").click();
    await idle(page);
    await expect(status).toHaveText("Settled: paid to the beneficiary.");
    await expect(campaign).toHaveAttribute("data-phase", "settled");
    await expect(page.getByTestId("shielded-beneficiary")).toHaveText(/^0\.45 SOL/);
    await expect(campaign.locator("[data-testid='contribution']")).toHaveCount(0);
  });

  expect(errors).toEqual([]);
});
