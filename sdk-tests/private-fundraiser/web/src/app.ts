// The fundraiser flows for the page, built on ../../typescript/core.ts and the
// SDK, in the same order as fundraiser.test.ts. Every role is a disposable
// localnet identity in this browser, so one page can play the coordinator, two
// contributors and the beneficiary.

import { createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import {
  LocalKeys,
  NullifierKeyProofAuthority,
  type ProofAuthority,
  type ZolanaClient,
} from "@heliuslabs/zolana/client";
import {
  DepositAsset,
  depositInstruction,
  type TransactInstructionData,
} from "@heliuslabs/zolana/interface";
import {
  randomBlinding,
  solanaOwnerIdentity,
  type ShieldedKeypair,
} from "@heliuslabs/zolana/keypair";
import {
  AssetRegistry,
  ProgramOwner,
  decodeProgramTransaction,
  type ProgramWalletUtxo,
} from "@heliuslabs/zolana/transaction";
import {
  address,
  getAddressEncoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

import {
  CONTRIBUTE_TOKEN_INPUTS,
  CONTRIBUTION_SLOT,
  acceptedContributions,
  airdrop,
  campaignAddress,
  campaignAuthority,
  campaignPhase,
  chainUnixTimestamp,
  checkPreimage,
  contributeInstruction,
  createCampaignInstruction,
  fetchCampaign,
  hex,
  keypairFromSeed,
  ownContributions,
  refundInstruction,
  sendAndConfirmFactory,
  settleInstruction,
  spendableSol,
  taggedTransactions,
  type Campaign,
  type CampaignPhase,
  type ContributionPreimage,
} from "../../typescript/core.js";
import type {
  ContributionTerms,
  DataUtxo,
  FinalizedTransaction,
} from "../../typescript/wasm-types.js";
import { fundraiserWasm } from "./fundraiser-wasm.js";
import {
  CONTRIBUTORS,
  ROLES,
  loadCampaigns,
  loadOrCreateSeed,
  loadStoreText,
  saveCampaign,
  saveStoreText,
  type Contributor,
  type Role,
} from "./identity.js";
import { decodeStore, encodeStore, type Stage } from "./model.js";
import { ProgramProver, type Circuit } from "./prover.js";

declare const __FUNDRAISER_PROGRAM_ID__: string;

/** Leaves enough public SOL for fees and rent after a deposit. */
const FEE_RESERVE_LAMPORTS = 100_000_000n;

export type OnStage = (stage: Stage) => void;

export interface RoleView {
  readonly role: Role;
  readonly solanaAddress: Address;
  readonly publicLamports: bigint;
  readonly shieldedLamports: bigint;
  readonly shieldedUtxos: number;
}

export interface ContributionView {
  readonly campaign: Address;
  readonly index: number;
  readonly amount: bigint;
  readonly utxo: DataUtxo<ContributionTerms>;
}

export interface CampaignView {
  readonly state: Campaign;
  readonly phase: CampaignPhase;
  /** Preimages the coordinator holds for this campaign's registry. */
  readonly stored: number;
  /** Each contributor's open contributions, rediscovered from the chain. */
  readonly contributions: Readonly<Record<Contributor, readonly ContributionView[]>>;
}

export interface Snapshot {
  readonly roles: readonly RoleView[];
  readonly campaigns: readonly CampaignView[];
  readonly chainNow: bigint;
  readonly slot: bigint;
}

interface StoredPreimage extends ContributionPreimage {
  readonly campaign: string;
}

function total(utxos: readonly ProgramWalletUtxo[]): bigint {
  return utxos.reduce((sum, utxo) => sum + utxo.utxo.amount, 0n);
}

function identity(signer: Address): Uint8Array {
  return solanaOwnerIdentity(Uint8Array.from(getAddressEncoder().encode(signer)));
}

export class FundraiserApp {
  readonly #client: ZolanaClient;
  readonly #programId: Address;
  readonly #keypairs: Readonly<Record<Role, ShieldedKeypair>>;
  readonly #signers: Readonly<Record<Role, TransactionSigner>>;
  readonly #prover = new ProgramProver();
  readonly #assets = new AssetRegistry();
  /** Simulates the coordinator going away: no co-signing, no settlement. */
  coordinatorOnline = true;

  private constructor(
    client: ZolanaClient,
    programId: Address,
    keypairs: Record<Role, ShieldedKeypair>,
    signers: Record<Role, TransactionSigner>,
  ) {
    this.#client = client;
    this.#programId = programId;
    this.#keypairs = keypairs;
    this.#signers = signers;
  }

  static async open(origin: string): Promise<FundraiserApp> {
    await initializePoseidon();
    const ws = new URL(origin);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    const client = await createZolanaClient({
      solanaRpcUrl: `${origin}/rpc`,
      solanaRpcSubscriptionsUrl: `${ws.origin}/rpc-ws`,
      indexerUrl: `${origin}/photon`,
      proverUrl: `${origin}/prover`,
    });
    const keypairs = {} as Record<Role, ShieldedKeypair>;
    const signers = {} as Record<Role, TransactionSigner>;
    for (const role of ROLES) {
      keypairs[role] = keypairFromSeed(loadOrCreateSeed(role));
      signers[role] = await keypairs[role].toSolanaSigner();
    }
    await fundraiserWasm();
    return new FundraiserApp(client, address(__FUNDRAISER_PROGRAM_ID__), keypairs, signers);
  }

  #store(): StoredPreimage[] {
    return decodeStore<StoredPreimage[]>(loadStoreText());
  }

  /** Rediscovers every balance, campaign and contribution, holding reads until `slot`. */
  async refresh(slot?: bigint): Promise<Snapshot> {
    const atSlot =
      slot ?? (await this.#client.solanaRpc.getSlot({ commitment: "confirmed" }).send());
    const [wasm, chainNow] = await Promise.all([
      fundraiserWasm(),
      chainUnixTimestamp(this.#client),
    ]);
    const roles = await Promise.all(ROLES.map((role) => this.#roleView(role, atSlot)));
    const store = this.#store();
    const campaigns = await Promise.all(
      loadCampaigns().map(async (campaign) => {
        const state = await fetchCampaign(this.#client, address(campaign));
        const authority = await campaignAuthority(this.#programId, state.address);
        const registry = new Set(state.contributions.map(hex));
        const contributions = {} as Record<Contributor, ContributionView[]>;
        for (const contributor of CONTRIBUTORS) {
          const keypair = this.#keypairs[contributor];
          const transactions = await taggedTransactions(
            this.#client,
            [authority.ownerTag(), keypair.shieldedAddress().confidentialViewTag()],
            atSlot,
          );
          const viewingKey = keypair.viewingKey();
          try {
            contributions[contributor] = ownContributions(
              (utxo) => wasm.contributionTermsDataUtxo(utxo),
              viewingKey,
              transactions,
              authority,
              state,
              this.#assets,
              this.#client.treeId,
            ).map((utxo) => ({
              campaign: state.address,
              index: utxo.index,
              amount: utxo.utxo.utxo.amount,
              utxo,
            }));
          } finally {
            viewingKey.destroy();
          }
        }
        return {
          state,
          phase: campaignPhase(state, chainNow),
          stored: store.filter(
            (entry) => entry.campaign === campaign && registry.has(hex(entry.utxoHash)),
          ).length,
          contributions,
        };
      }),
    );
    return { roles, campaigns, chainNow, slot: atSlot };
  }

  async #roleView(role: Role, slot: bigint): Promise<RoleView> {
    const signer = this.#signers[role];
    const [utxos, balance] = await Promise.all([
      this.#spendable(role, slot),
      this.#client.solanaRpc.getBalance(signer.address, { commitment: "confirmed" }).send(),
    ]);
    return {
      role,
      solanaAddress: signer.address,
      publicLamports: balance.value,
      shieldedLamports: total(utxos),
      shieldedUtxos: utxos.length,
    };
  }

  async #spendable(role: Role, slot: bigint): Promise<readonly ProgramWalletUtxo[]> {
    const keypair = this.#keypairs[role];
    return spendableSol(
      this.#client,
      keypair,
      await taggedTransactions(
        this.#client,
        [keypair.shieldedAddress().confidentialViewTag()],
        slot,
      ),
      this.#assets,
    );
  }

  /** Airdrops localnet SOL to `role` and deposits `amount` into its shielded balance. */
  async fund(role: Role, amount: bigint, onStage: OnStage): Promise<Snapshot> {
    onStage("airdropping");
    const signer = this.#signers[role];
    await airdrop(this.#client, signer.address, amount + FEE_RESERVE_LAMPORTS);
    const shielded = this.#keypairs[role].shieldedAddress();
    const slot = await sendAndConfirmFactory(this.#client, signer)(
      [
        await depositInstruction({
          tree: this.#client.tree,
          depositor: signer,
          deposits: [
            {
              asset: DepositAsset.sol(),
              viewTag: shielded.confidentialViewTag(),
              recipientOwnerHash: shielded.ownerHash(),
              amount,
            },
          ],
        }),
      ],
      onStage,
    );
    onStage("syncing");
    return this.refresh(slot);
  }

  /** The coordinator creates a campaign paying the beneficiary identity. */
  async createCampaign(
    target: bigint,
    contributionWindow: bigint,
    settlementWindow: bigint,
    onStage: OnStage,
  ): Promise<Snapshot> {
    const coordinator = this.#signers.coordinator;
    // The program checks windows against the Clock, so measure from it, not the browser.
    const closeTs = (await chainUnixTimestamp(this.#client)) + contributionWindow;
    const campaignSeed = BigInt(Date.now());
    await airdrop(this.#client, coordinator.address, FEE_RESERVE_LAMPORTS);
    const slot = await sendAndConfirmFactory(this.#client, coordinator)(
      [
        await createCampaignInstruction({
          programId: this.#programId,
          coordinator,
          campaignSeed,
          target,
          closeTs,
          settleDeadline: closeTs + settlementWindow,
          beneficiary: this.#keypairs.beneficiary.shieldedAddress(),
        }),
      ],
      onStage,
    );
    saveCampaign(await campaignAddress(this.#programId, coordinator.address, campaignSeed));
    onStage("syncing");
    return this.refresh(slot);
  }

  /** A contributor proves a contribution; the coordinator checks it and co-signs. */
  async contribute(
    contributor: Contributor,
    campaign: Campaign,
    amount: bigint,
    onStage: OnStage,
  ): Promise<Snapshot> {
    onStage("preparing");
    const keypair = this.#keypairs[contributor];
    const signer = this.#signers[contributor];
    const shielded = keypair.shieldedAddress();
    const authority = await campaignAuthority(this.#programId, campaign.address);
    const utxos = [...(await this.#spendable(contributor, await this.#slot()))]
      .sort((a, b) => (a.utxo.amount < b.utxo.amount ? 1 : -1))
      .slice(0, CONTRIBUTE_TOKEN_INPUTS);
    if (total(utxos) < amount)
      throw new Error(
        `the ${CONTRIBUTE_TOKEN_INPUTS} largest shielded UTXOs of ${contributor} hold less than ${amount} lamports`,
      );
    const wasm = await fundraiserWasm();
    const transaction = wasm.contributeTransaction(
      {
        private: { txContext: this.#txContext(), tokenUtxos: utxos, amount },
        public: {
          campaignAuthority: authority.address(shielded.viewingPublicKey).toBytes(),
          contributorIdentity: identity(signer.address),
          campaignId: campaign.campaignId,
          beneficiary: campaign.beneficiaryOwnerHash,
        },
      },
      shielded.toBytes(),
      signer.address,
    );
    onStage("provingProgram");
    const { proof } = await this.#prover.prove("contribute", transaction.proofInputs);
    const transact = await this.#proveSpp(
      transaction.finalizedTx,
      keypair,
      LocalKeys.fromKeypair(keypair, this.#client.proofService),
      onStage,
    );

    onStage("coordinatorCheck");
    if (!this.coordinatorOnline)
      throw new Error("The coordinator is offline, so nobody can co-sign the contribution.");
    const preimage = {
      output: transaction.finalizedTx.outputUtxos[CONTRIBUTION_SLOT]!,
      utxoHash: transaction.finalizedTx.outputHashes[CONTRIBUTION_SLOT]!,
    };
    checkPreimage(
      (utxo) => wasm.contributionTermsDataUtxo(utxo),
      preimage,
      transact,
      authority,
      campaign,
      this.#client.treeId,
    );
    saveStoreText(encodeStore([...this.#store(), { ...preimage, campaign: campaign.address }]));

    const slot = await sendAndConfirmFactory(this.#client, signer)(
      [
        await contributeInstruction({
          programId: this.#programId,
          client: this.#client,
          campaign: campaign.address,
          authority,
          contributor: signer,
          coordinator: this.#signers.coordinator,
          proof: proof.compressedProof,
          transact,
        }),
      ],
      onStage,
    );
    onStage("syncing");
    return this.refresh(slot);
  }

  /** The coordinator proves that the registered contributions reach the target and pays out. */
  async settle(campaign: Campaign, onStage: OnStage): Promise<Snapshot> {
    onStage("collecting");
    if (!this.coordinatorOnline)
      throw new Error("The coordinator is offline: only it holds the contribution preimages.");
    const wasm = await fundraiserWasm();
    const authority = await campaignAuthority(this.#programId, campaign.address);
    const accepted = acceptedContributions(
      (utxo) => wasm.contributionTermsDataUtxo(utxo),
      this.#store().filter((entry) => entry.campaign === campaign.address),
      await taggedTransactions(this.#client, [authority.ownerTag()], await this.#slot()),
      authority,
      campaign,
      this.#client.treeId,
    );
    onStage("preparing");
    const coordinator = this.#keypairs.coordinator;
    const shielded = coordinator.shieldedAddress();
    const inputs = {
      private: {
        txContext: this.#txContext(),
        contributions: accepted.map((contribution) => contribution.utxo),
        terms: accepted.map((contribution) => contribution.data),
      },
      public: {
        campaignAuthority: authority.address(shielded.viewingPublicKey).toBytes(),
        campaignId: campaign.campaignId,
        beneficiary: campaign.beneficiary.toBytes(),
        target: campaign.target,
        ...Object.fromEntries(
          accepted.map((contribution, i) => [`contribution${i}`, contribution.utxo.utxoHash]),
        ),
      },
    };
    const sender = shielded.toBytes();
    const payer = this.#signers.coordinator.address;
    // The bindings type each count's tuple; the registry count picks the circuit.
    const [circuit, transaction] = (() => {
      switch (accepted.length) {
        case 1:
          return ["settle1", wasm.settle1Transaction(inputs as never, sender, payer)] as const;
        case 2:
          return ["settle2", wasm.settle2Transaction(inputs as never, sender, payer)] as const;
        case 3:
          return ["settle3", wasm.settle3Transaction(inputs as never, sender, payer)] as const;
        case 4:
          return ["settle4", wasm.settle4Transaction(inputs as never, sender, payer)] as const;
        default:
          throw new Error("the campaign has no contributions to settle");
      }
    })();
    onStage("provingProgram");
    const { proof } = await this.#prover.prove(circuit satisfies Circuit, transaction.proofInputs);
    const transact = await this.#proveSpp(
      transaction.finalizedTx,
      coordinator,
      this.#programKeys(),
      onStage,
    );
    return this.#send(
      this.#signers.coordinator,
      settleInstruction({
        programId: this.#programId,
        client: this.#client,
        campaign: campaign.address,
        authority,
        payer: this.#signers.coordinator,
        proof: proof.compressedProof,
        transact,
      }),
      onStage,
    );
  }

  /** A contributor reclaims its own contribution with its keys alone. */
  async refund(
    contributor: Contributor,
    contribution: ContributionView,
    onStage: OnStage,
  ): Promise<Snapshot> {
    onStage("discovering");
    const campaign = await fetchCampaign(this.#client, contribution.campaign);
    const authority = await campaignAuthority(this.#programId, campaign.address);
    onStage("preparing");
    const keypair = this.#keypairs[contributor];
    const signer = this.#signers[contributor];
    const wasm = await fundraiserWasm();
    const transaction = wasm.refundTransaction(
      {
        private: {
          txContext: this.#txContext(),
          contribution: contribution.utxo.utxo,
          terms: contribution.utxo.data,
        },
        public: {
          campaignId: campaign.campaignId,
          contributorIdentity: identity(signer.address),
          contribution: contribution.utxo.utxo.utxoHash,
        },
      },
      keypair.shieldedAddress().toBytes(),
      signer.address,
    );
    onStage("provingProgram");
    const { proof } = await this.#prover.prove("refund", transaction.proofInputs);
    const transact = await this.#proveSpp(
      transaction.finalizedTx,
      keypair,
      this.#programKeys(),
      onStage,
    );
    return this.#send(
      signer,
      refundInstruction({
        programId: this.#programId,
        client: this.#client,
        campaign: campaign.address,
        authority,
        contributor: signer,
        index: contribution.index,
        proof: proof.compressedProof,
        transact,
      }),
      onStage,
    );
  }

  #txContext(): { blindingSeed: Uint8Array; outputTreeId: number } {
    return { blindingSeed: randomBlinding(), outputTreeId: this.#client.treeId };
  }

  #slot(): Promise<bigint> {
    return this.#client.solanaRpc.getSlot({ commitment: "confirmed" }).send();
  }

  /** Contributions are owned by the campaign PDA, so its nullifier key proves them. */
  #programKeys(): ProofAuthority & { destroy(): void } {
    const key = ProgramOwner.nullifierKey();
    const keys = new NullifierKeyProofAuthority(key, this.#client.proofService);
    key.destroy();
    return keys;
  }

  async #proveSpp(
    finalizedTx: FinalizedTransaction,
    sender: ShieldedKeypair,
    keys: ProofAuthority & { destroy(): void },
    onStage: OnStage,
  ): Promise<TransactInstructionData> {
    onStage("provingSpp");
    try {
      const proofInputs = (await decodeProgramTransaction(finalizedTx, this.#assets)).toProofInputs(
        sender,
      );
      return await this.#client.proveTransact(proofInputs, keys);
    } finally {
      keys.destroy();
    }
  }

  async #send(
    signer: TransactionSigner,
    instruction: Promise<Instruction>,
    onStage: OnStage,
  ): Promise<Snapshot> {
    const slot = await sendAndConfirmFactory(this.#client, signer)([await instruction], onStage);
    onStage("syncing");
    return this.refresh(slot);
  }
}
