/// <reference types="node" />

import { createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { LocalKeys, NullifierKeyProofAuthority } from "@heliuslabs/zolana/client";
import {
  DepositAsset,
  depositInstruction,
  type TransactInstructionData,
} from "@heliuslabs/zolana/interface";
import {
  bytes32,
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
import { getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  CONTRIBUTE_TOKEN_INPUTS,
  CONTRIBUTION_SLOT,
  FundraiserError,
  acceptedContributions,
  airdrop,
  campaignAddress,
  campaignAuthority,
  chainUnixTimestamp,
  checkPreimage,
  clientConfig,
  contributeInstruction,
  createCampaignInstruction,
  customErrorCode,
  fetchCampaign,
  fundraiserProgramId,
  keypairFromSeed,
  ownContributions,
  prove,
  refundInstruction,
  sendAndConfirmFactory,
  settleInstruction,
  spendableSol,
  taggedTransactions,
  type Campaign,
  type ContributionPreimage,
} from "./fundraiser.js";
import type { ContributionTerms, DataUtxo, ProgramTransaction } from "./wasm-types.js";
import { wasm } from "./wasm.js";

const DEPOSIT = 300_000_000n;
const LAMPORTS = 2_000_000_000n;
// Long enough for three contributions with their proofs, short enough to wait
// out both windows in real time.
const CONTRIBUTION_WINDOW = 60n;
const SETTLEMENT_WINDOW = 30n;

type Client = Awaited<ReturnType<typeof createZolanaClient>>;

function total(utxos: readonly ProgramWalletUtxo[]): bigint {
  return utxos.reduce((sum, utxo) => sum + utxo.utxo.amount, 0n);
}

async function waitUntil(client: Client, timestamp: bigint): Promise<void> {
  const deadline = Date.now() + 180_000;
  while ((await chainUnixTimestamp(client)) < timestamp) {
    if (Date.now() > deadline) throw new Error(`the localnet clock did not reach ${timestamp}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function rejection(promise: Promise<unknown>): Promise<number | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => customErrorCode(error),
  );
}

function identity(address: Address): Uint8Array {
  return solanaOwnerIdentity(Uint8Array.from(getAddressEncoder().encode(address)));
}

function settleTransaction(
  contributions: readonly DataUtxo<ContributionTerms>[],
  shared: Readonly<{
    txContext: { blindingSeed: Uint8Array; outputTreeId: number };
    campaignAuthority: Uint8Array;
    campaign: Campaign;
  }>,
  sender: Uint8Array,
  payer: Address,
): { circuit: "settle1" | "settle2" | "settle3" | "settle4"; transaction: ProgramTransaction } {
  const hashes = Object.fromEntries(
    contributions.map((contribution, i) => [`contribution${i}`, contribution.utxo.utxoHash]),
  );
  const inputs = {
    private: {
      txContext: shared.txContext,
      contributions: contributions.map((contribution) => contribution.utxo),
      terms: contributions.map((contribution) => contribution.data),
    },
    public: {
      campaignAuthority: shared.campaignAuthority,
      campaignId: shared.campaign.campaignId,
      beneficiary: shared.campaign.beneficiary.toBytes(),
      target: shared.campaign.target,
      ...hashes,
    },
  };
  // The bindings type each count's tuple; the count picks the circuit.
  switch (contributions.length) {
    case 1:
      return {
        circuit: "settle1",
        transaction: wasm.settle1Transaction(inputs as never, sender, payer),
      };
    case 2:
      return {
        circuit: "settle2",
        transaction: wasm.settle2Transaction(inputs as never, sender, payer),
      };
    case 3:
      return {
        circuit: "settle3",
        transaction: wasm.settle3Transaction(inputs as never, sender, payer),
      };
    case 4:
      return {
        circuit: "settle4",
        transaction: wasm.settle4Transaction(inputs as never, sender, payer),
      };
    default:
      throw new Error(`cannot settle ${contributions.length} contributions`);
  }
}

describe("private fundraiser", () => {
  it("settles a funded campaign and refunds a failed one, with wasm proofs", async () => {
    await initializePoseidon();
    const client = await createZolanaClient(clientConfig());
    const programId = fundraiserProgramId();
    const assets = new AssetRegistry();
    const txContext = () => ({ blindingSeed: randomBlinding(), outputTreeId: client.treeId });
    const programNullifierKey = ProgramOwner.nullifierKey();
    const programKeys = new NullifierKeyProofAuthority(programNullifierKey, client.proofService);
    programNullifierKey.destroy();

    const seeds = {
      coordinator: crypto.getRandomValues(new Uint8Array(32)),
      beneficiary: crypto.getRandomValues(new Uint8Array(32)),
      alice: crypto.getRandomValues(new Uint8Array(32)),
      bob: crypto.getRandomValues(new Uint8Array(32)),
    };
    const coordinator = keypairFromSeed(seeds.coordinator);
    const beneficiary = keypairFromSeed(seeds.beneficiary);
    const alice = keypairFromSeed(seeds.alice);
    const bob = keypairFromSeed(seeds.bob);
    const coordinatorSigner = coordinator.toSolanaSigner();
    await airdrop(client, coordinatorSigner.address, LAMPORTS);

    const deposit = async (keypair: ShieldedKeypair): Promise<bigint> => {
      const signer = keypair.toSolanaSigner();
      await airdrop(client, signer.address, LAMPORTS);
      const address = keypair.shieldedAddress();
      return sendAndConfirmFactory(
        client,
        signer,
      )([
        await depositInstruction({
          tree: client.tree,
          depositor: signer,
          deposits: [
            {
              asset: DepositAsset.sol(),
              viewTag: address.confidentialViewTag(),
              recipientOwnerHash: address.ownerHash(),
              amount: DEPOSIT,
            },
          ],
        }),
      ]);
    };
    const balance = async (keypair: ShieldedKeypair, slot: bigint) =>
      spendableSol(
        client,
        keypair,
        await taggedTransactions(client, [keypair.shieldedAddress().confidentialViewTag()], slot),
        assets,
      );
    let slot = await deposit(alice);
    slot = await deposit(bob);

    const now = await chainUnixTimestamp(client);
    const closeTs = now + CONTRIBUTION_WINDOW;
    const settleDeadline = closeTs + SETTLEMENT_WINDOW;
    const sendAsCoordinator = sendAndConfirmFactory(client, coordinatorSigner);
    const createCampaign = async (campaignSeed: bigint, target: bigint) => {
      slot = await sendAsCoordinator([
        await createCampaignInstruction({
          programId,
          coordinator: coordinatorSigner,
          campaignSeed,
          target,
          closeTs,
          settleDeadline,
          beneficiary: beneficiary.shieldedAddress(),
        }),
      ]);
      const address = await campaignAddress(programId, coordinatorSigner.address, campaignSeed);
      return { address, authority: await campaignAuthority(programId, address) };
    };
    const funded = await createCampaign(1n, 400_000_000n);
    const unfunded = await createCampaign(2n, 10_000_000_000n);

    // The coordinator's private state: the preimages it checked before co-signing.
    const store: ContributionPreimage[] = [];
    const contribute = async (
      contributor: ShieldedKeypair,
      campaign: { address: Address; authority: ProgramOwner },
      amount: bigint,
    ): Promise<void> => {
      const signer = contributor.toSolanaSigner();
      const address = contributor.shieldedAddress();
      const state = await fetchCampaign(client, campaign.address);
      const utxos = (await balance(contributor, slot)).slice(0, CONTRIBUTE_TOKEN_INPUTS);
      const transaction = wasm.contributeTransaction(
        {
          private: { txContext: txContext(), tokenUtxos: [...utxos], amount },
          public: {
            campaignAuthority: campaign.authority.address(address.viewingPublicKey).toBytes(),
            contributorIdentity: identity(signer.address),
            campaignId: state.campaignId,
            beneficiary: state.beneficiaryOwnerHash,
          },
        },
        address.toBytes(),
        signer.address,
      );
      const proof = prove("contribute", transaction);
      const keys = LocalKeys.fromKeypair(contributor, client.proofService);
      let transact: TransactInstructionData;
      try {
        transact = await client.proveTransact(
          (await decodeProgramTransaction(transaction.finalizedTx, assets)).toProofInputs(
            contributor,
          ),
          keys,
        );
      } finally {
        keys.destroy();
      }
      const preimage: ContributionPreimage = {
        output: transaction.finalizedTx.outputUtxos[CONTRIBUTION_SLOT]!,
        utxoHash: transaction.finalizedTx.outputHashes[CONTRIBUTION_SLOT]!,
      };
      // Handed to the coordinator, which checks it against this exact transact.
      checkPreimage(
        wasm.contributionTermsDataUtxo,
        preimage,
        transact,
        campaign.authority,
        state,
        client.treeId,
      );
      store.push(preimage);
      slot = await sendAndConfirmFactory(
        client,
        signer,
      )([
        await contributeInstruction({
          programId,
          client,
          campaign: campaign.address,
          authority: campaign.authority,
          contributor: signer,
          coordinator: coordinatorSigner,
          proof: proof.compressedProof,
          transact,
        }),
      ]);
    };
    await contribute(alice, funded, 250_000_000n);
    await contribute(bob, funded, 200_000_000n);
    await contribute(alice, unfunded, 30_000_000n);
    expect((await fetchCampaign(client, funded.address)).count).toBe(2);
    expect((await fetchCampaign(client, unfunded.address)).count).toBe(1);

    const coordinatorAddress = coordinator.shieldedAddress();
    const fundedState = await fetchCampaign(client, funded.address);
    const accepted = acceptedContributions(
      wasm.contributionTermsDataUtxo,
      store,
      await taggedTransactions(client, [funded.authority.ownerTag()], slot),
      funded.authority,
      fundedState,
      client.treeId,
    );
    const { circuit, transaction: settle } = settleTransaction(
      accepted,
      {
        txContext: txContext(),
        campaignAuthority: funded.authority.address(coordinatorAddress.viewingPublicKey).toBytes(),
        campaign: fundedState,
      },
      coordinatorAddress.toBytes(),
      coordinatorSigner.address,
    );
    const settleProof = prove(circuit, settle);
    const settleTransact = await client.proveTransact(
      (await decodeProgramTransaction(settle.finalizedTx, assets)).toProofInputs(coordinator),
      programKeys,
    );
    const settleIx = await settleInstruction({
      programId,
      client,
      campaign: funded.address,
      authority: funded.authority,
      payer: coordinatorSigner,
      proof: settleProof.compressedProof,
      transact: settleTransact,
    });
    expect(await rejection(sendAsCoordinator([settleIx]))).toBe(FundraiserError.SettlementNotOpen);

    await waitUntil(client, closeTs);
    slot = await sendAsCoordinator([settleIx]);
    expect((await fetchCampaign(client, funded.address)).settled).toBe(true);
    expect(total(await balance(beneficiary, slot))).toBe(450_000_000n);
    expect(await rejection(sendAsCoordinator([settleIx]))).toBe(FundraiserError.CampaignSettled);

    // Alice restarts with only her seed: no coordinator, no local state.
    await waitUntil(client, settleDeadline);
    const restarted = keypairFromSeed(bytes32(seeds.alice));
    const restartedSigner = restarted.toSolanaSigner();
    const unfundedState = await fetchCampaign(client, unfunded.address);
    const viewingKey = restarted.viewingKey();
    const transactions = await taggedTransactions(
      client,
      [unfunded.authority.ownerTag(), restarted.shieldedAddress().confidentialViewTag()],
      slot,
    );
    const mine = ownContributions(
      wasm.contributionTermsDataUtxo,
      viewingKey,
      transactions,
      unfunded.authority,
      unfundedState,
      assets,
      client.treeId,
    );
    viewingKey.destroy();
    expect(mine.map((contribution) => contribution.utxo.utxo.amount)).toEqual([30_000_000n]);
    const [contribution] = mine;
    if (contribution === undefined) throw new Error("alice finds no contribution");
    const refund = wasm.refundTransaction(
      {
        private: {
          txContext: txContext(),
          contribution: contribution.utxo,
          terms: contribution.data,
        },
        public: {
          campaignId: unfundedState.campaignId,
          contributorIdentity: identity(restartedSigner.address),
          contribution: contribution.utxo.utxoHash,
        },
      },
      restarted.shieldedAddress().toBytes(),
      restartedSigner.address,
    );
    const refundProof = prove("refund", refund);
    const refundTransact = await client.proveTransact(
      (await decodeProgramTransaction(refund.finalizedTx, assets)).toProofInputs(restarted),
      programKeys,
    );
    slot = await sendAndConfirmFactory(
      client,
      restartedSigner,
    )([
      await refundInstruction({
        programId,
        client,
        campaign: unfunded.address,
        authority: unfunded.authority,
        contributor: restartedSigner,
        index: contribution.index,
        proof: refundProof.compressedProof,
        transact: refundTransact,
      }),
    ]);
    expect((await fetchCampaign(client, unfunded.address)).refunded).toBe(1);
    expect(total(await balance(restarted, slot))).toBe(DEPOSIT - 250_000_000n);

    programKeys.destroy();
    for (const keypair of [coordinator, beneficiary, alice, bob, restarted]) keypair.destroy();
  });
});
