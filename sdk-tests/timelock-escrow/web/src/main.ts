import { EscrowApp, type EscrowView, type Snapshot } from "./app.js";
import { forgetSeed, loadOrCreateSeed } from "./identity.js";
import {
  FLOW_STAGES,
  describeError,
  formatSol,
  parseSol,
  secondsUntilUnlock,
  stageStates,
  type Flow,
  type Stage,
} from "./model.js";

function element<T extends HTMLElement = HTMLElement>(testId: string): T {
  const found = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`missing element ${testId}`);
  return found;
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
      const item = document.createElement("li");
      item.textContent = label;
      item.dataset["state"] = state;
      return item;
    }),
  );
}

function render(app: EscrowApp, snapshot: Snapshot): void {
  element("solana-address").textContent = snapshot.solanaAddress;
  element("escrow-authority").textContent = snapshot.escrowAuthority;
  element("public-balance").textContent = formatSol(snapshot.publicLamports);
  element("shielded-balance").textContent =
    `${formatSol(snapshot.shieldedLamports)} in ${snapshot.shieldedUtxos} UTXO(s)`;
  element("slot").textContent = snapshot.slot.toString();
  element("page-full").hidden = !snapshot.pageFull;
  element("chain-time").textContent =
    `On-chain clock: ${new Date(Number(snapshot.chainNow) * 1000).toLocaleString()}`;
  element("escrows").replaceChildren(
    ...(snapshot.escrows.length === 0
      ? [Object.assign(document.createElement("li"), { textContent: "No open escrows." })]
      : snapshot.escrows.map((escrow) => escrowItem(app, escrow, snapshot.chainNow))),
  );
}

function escrowItem(app: EscrowApp, escrow: EscrowView, chainNow: bigint): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset["testid"] = "escrow";
  item.dataset["status"] = escrow.status;
  const wait = secondsUntilUnlock(escrow.unlock, chainNow);
  const text = document.createElement("span");
  text.textContent =
    `${formatSol(escrow.amount)}, unlocks ${new Date(Number(escrow.unlock) * 1000).toLocaleString()} ` +
    (escrow.status === "unlocked" ? "(unlocked) " : `(locked, about ${wait}s left) `);
  const button = document.createElement("button");
  button.type = "button";
  button.dataset["testid"] = "withdraw";
  // Left enabled while locked so the program's own rejection can be seen.
  button.textContent = escrow.status === "unlocked" ? "Withdraw" : "Try to withdraw early";
  button.addEventListener("click", () =>
    run(
      app,
      "withdraw",
      (onStage) => app.withdraw(escrow, onStage),
      "Withdrawn to your shielded balance.",
    ),
  );
  item.append(text, button);
  return item;
}

async function run(
  app: EscrowApp,
  flow: Flow,
  action: (onStage: (stage: Stage) => void) => Promise<Snapshot>,
  done: string,
): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.dataset["busy"] = "true";
  let current: Stage = FLOW_STAGES[flow][0];
  setStatus("");
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

async function refresh(app: EscrowApp): Promise<void> {
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
  const app = await EscrowApp.open(loadOrCreateSeed(), location.origin);
  await refresh(app);
  setStatus("Ready.");
  document.body.dataset["ready"] = "true";

  element("refresh").addEventListener("click", () => void refresh(app));
  element("reset").addEventListener("click", () => {
    if (!confirm("Discard this localnet identity? Its funds are not recoverable.")) return;
    forgetSeed();
    location.reload();
  });
  element<HTMLFormElement>("fund-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void run(
      app,
      "fund",
      (onStage) => app.fund(parseSol(String(form.get("amount"))), onStage),
      "Deposited.",
    );
  });
  element<HTMLFormElement>("lock-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void run(
      app,
      "lock",
      async (onStage) => {
        const amount = parseSol(String(form.get("amount")));
        const delay = String(form.get("delay")).trim();
        if (!/^\d+$/u.test(delay)) throw new Error("enter the unlock delay in whole seconds");
        return app.lock(amount, BigInt(delay), onStage);
      },
      "Locked.",
    );
  });
}

start().catch((error: unknown) => {
  console.error(error);
  setStatus(describeError(error), true);
});
