import { FundraiserApp, type CampaignView, type Snapshot } from "./app.js";
import { CONTRIBUTORS, forgetAll, type Contributor } from "./identity.js";
import {
  FLOW_STAGES,
  PHASE_LABELS,
  describeError,
  formatSol,
  parseSeconds,
  parseSol,
  secondsUntil,
  stageStates,
  type Flow,
  type Stage,
} from "./model.js";

function element<T extends HTMLElement = HTMLElement>(testId: string): T {
  const found = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`missing element ${testId}`);
  return found;
}

function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  testId?: string,
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  if (testId !== undefined) (node as HTMLElement).dataset["testid"] = testId;
  return node;
}

const status = element("status");
const stages = element("stages");
let busy = false;

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function showStages(flow: Flow, current: Stage | "done", failed = false): void {
  stages.replaceChildren(
    ...stageStates(flow, current, failed).map(({ label, state }) => {
      const item = create("li", { textContent: label });
      item.dataset["state"] = state;
      return item;
    }),
  );
}

const time = (seconds: bigint) => new Date(Number(seconds) * 1000).toLocaleTimeString();

function render(app: FundraiserApp, snapshot: Snapshot): void {
  element("roles")
    .querySelector("tbody")
    ?.replaceChildren(
      ...snapshot.roles.map((role) => {
        const row = create("tr");
        row.dataset["role"] = role.role;
        row.append(
          create("td", { textContent: role.role }),
          create("td", { textContent: role.solanaAddress }),
          create("td", { textContent: formatSol(role.publicLamports) }),
          create(
            "td",
            { textContent: `${formatSol(role.shieldedLamports)} in ${role.shieldedUtxos} UTXO(s)` },
            `shielded-${role.role}`,
          ),
        );
        return row;
      }),
    );
  element("indexer-slot").textContent = `Indexed up to slot ${snapshot.slot}`;
  element("chain-time").textContent = `On-chain clock: ${time(snapshot.chainNow)}`;
  element("campaigns").replaceChildren(
    ...(snapshot.campaigns.length === 0
      ? [create("li", { textContent: "No campaigns yet." })]
      : snapshot.campaigns.map((campaign) => campaignItem(app, campaign, snapshot.chainNow))),
  );
}

function countdown({ state, phase }: CampaignView, chainNow: bigint): string {
  switch (phase) {
    case "open":
      return ` (closes in ${secondsUntil(state.closeTs, chainNow)}s)`;
    case "settling":
      return ` (settlement deadline in ${secondsUntil(state.settleDeadline, chainNow)}s)`;
    default:
      return "";
  }
}

function campaignItem(app: FundraiserApp, view: CampaignView, chainNow: bigint): HTMLLIElement {
  const { state, phase } = view;
  const item = create("li", {}, "campaign");
  item.dataset["phase"] = phase;
  item.dataset["count"] = String(state.count);
  const wait = countdown(view, chainNow);
  const terms = create("p");
  terms.append(
    create("strong", { textContent: PHASE_LABELS[phase] + wait }, "phase"),
    create("br"),
    `Campaign ${state.address}`,
    create("br"),
    `Target ${formatSol(state.target)}; contributions close ${time(state.closeTs)}; settlement deadline ${time(state.settleDeadline)}`,
    create("br"),
    `Accepted contributions: ${state.count} of 4 (amounts hidden); coordinator holds ${view.stored} preimage(s)`,
  );
  item.append(terms);

  if (phase === "open") {
    const form = create("form", {}, "contribute-form");
    const who = create("select", { name: "contributor" });
    who.append(...CONTRIBUTORS.map((name) => create("option", { value: name, textContent: name })));
    const amount = create("input", { name: "amount", value: "0.25", inputMode: "decimal" });
    const label = create("label", { textContent: "Amount (SOL) " });
    label.append(amount);
    form.append(who, label, create("button", { type: "submit", textContent: "Contribute" }));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void run(
        app,
        "contribute",
        (onStage) =>
          app.contribute(who.value as Contributor, state, parseSol(amount.value), onStage),
        "Contribution accepted.",
      );
    });
    item.append(form);
  }
  if (phase !== "settled" && phase !== "refunding") {
    // Offered before the close too, so the program's rejection can be seen.
    const settle = create(
      "button",
      { type: "button", textContent: "Settle (coordinator)" },
      "settle",
    );
    settle.addEventListener("click", () =>
      run(
        app,
        "settle",
        (onStage) => app.settle(state, onStage),
        "Settled: paid to the beneficiary.",
      ),
    );
    item.append(settle);
  }

  const mine = create("ul", {}, "contributions");
  for (const contributor of CONTRIBUTORS) {
    for (const contribution of view.contributions[contributor]) {
      const entry = create("li", {}, "contribution");
      entry.dataset["contributor"] = contributor;
      entry.append(
        `${contributor}: ${formatSol(contribution.amount)} (only ${contributor} sees this) `,
      );
      const refund = create(
        "button",
        {
          type: "button",
          textContent: phase === "refunding" ? "Refund" : "Try to refund early",
        },
        "refund",
      );
      refund.addEventListener("click", () =>
        run(
          app,
          "refund",
          (onStage) => app.refund(contributor, contribution, onStage),
          "Refunded to the contributor's shielded balance.",
        ),
      );
      entry.append(refund);
      mine.append(entry);
    }
  }
  item.append(mine);
  return item;
}

async function run(
  app: FundraiserApp,
  flow: Flow,
  action: (onStage: (stage: Stage) => void) => Promise<Snapshot>,
  done: string,
): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.dataset["busy"] = "true";
  let current: Stage = FLOW_STAGES[flow][0];
  setStatus("");
  showStages(flow, current);
  try {
    const snapshot = await action((stage) => {
      current = stage;
      showStages(flow, stage);
    });
    showStages(flow, "done");
    render(app, snapshot);
    setStatus(done);
  } catch (error) {
    console.error(error);
    showStages(flow, current, true);
    setStatus(describeError(error), true);
  } finally {
    busy = false;
    delete document.body.dataset["busy"];
  }
}

async function refresh(app: FundraiserApp): Promise<void> {
  try {
    render(app, await app.refresh());
  } catch (error) {
    console.error(error);
    setStatus(describeError(error), true);
  }
}

async function start(): Promise<void> {
  if (!crossOriginIsolated) {
    setStatus("This page is not cross-origin isolated, so the threaded prover cannot run.", true);
    return;
  }
  setStatus("Loading…");
  const app = await FundraiserApp.open(location.origin);
  await refresh(app);
  setStatus("Ready.");
  document.body.dataset["ready"] = "true";

  element("refresh").addEventListener("click", () => void refresh(app));
  element("reset").addEventListener("click", () => {
    if (!confirm("Discard every localnet identity, campaign and the coordinator store?")) return;
    forgetAll();
    location.reload();
  });
  element<HTMLInputElement>("coordinator-offline").addEventListener("change", (event) => {
    app.coordinatorOnline = !(event.currentTarget as HTMLInputElement).checked;
  });
  element<HTMLFormElement>("fund-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void run(
      app,
      "fund",
      (onStage) =>
        app.fund(form.get("role") as Contributor, parseSol(String(form.get("amount"))), onStage),
      "Deposited.",
    );
  });
  element<HTMLFormElement>("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void run(
      app,
      "create",
      (onStage) =>
        app.createCampaign(
          parseSol(String(form.get("target"))),
          parseSeconds(String(form.get("contribution")), "contribution window"),
          parseSeconds(String(form.get("settlement")), "settlement window"),
          onStage,
        ),
      "Campaign created.",
    );
  });
}

start().catch((error: unknown) => {
  console.error(error);
  setStatus(describeError(error), true);
});
