// The escrow flows for the page, built on the shared helpers in
// ../../typescript/core.ts and the SDK, in the same order as escrow.test.ts.

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
  airdrop,
  chainUnixTimestamp,
  compareBigint,
  creatorTransactions,
  escrowAuthority,
  escrowInstruction,
  escrowUtxos,
  hex,
  keypairFromSeed,
  sendAndConfirmFactory,
  spendableSol,
  withdrawInstruction,
} from "../../typescript/core.js";
import type { DataUtxo, EscrowTerms, FinalizedTransaction } from "../../typescript/wasm-types.js";
import { escrowWasm } from "./escrow-wasm.js";
import { escrowStatus, type EscrowStatus, type Stage } from "./model.js";
import { ProgramProver } from "./prover.js";

declare const __ESCROW_PROGRAM_ID__: string;

/** One page of the tag query; a full page may hide older escrows. */
const TAG_PAGE_LIMIT = 50;
/** The escrow circuit spends at most this many of the creator's UTXOs. */
const MAX_ESCROW_INPUTS = 5;
/** Leaves enough public SOL for fees after a deposit. */
const FEE_RESERVE_LAMPORTS = 100_000_000n;

export interface EscrowView {
  readonly id: string;
  readonly amount: bigint;
  readonly unlock: bigint;
  readonly status: EscrowStatus;
  readonly utxo: DataUtxo<EscrowTerms>;
}

export interface Snapshot {
  readonly solanaAddress: Address;
  readonly escrowAuthority: Address;
  readonly publicLamports: bigint;
  readonly shieldedLamports: bigint;
  readonly shieldedUtxos: number;
  readonly escrows: readonly EscrowView[];
  readonly chainNow: bigint;
  readonly slot: bigint;
  readonly pageFull: boolean;
}

export type OnStage = (stage: Stage) => void;

function total(utxos: readonly ProgramWalletUtxo[]): bigint {
  return utxos.reduce((sum, utxo) => sum + utxo.utxo.amount, 0n);
}

/** Largest first, until `amount` is covered, within the circuit's input limit. */
export function selectInputs(
  utxos: readonly ProgramWalletUtxo[],
  amount: bigint,
): readonly ProgramWalletUtxo[] {
  const sorted = [...utxos].sort((a, b) => compareBigint(b.utxo.amount, a.utxo.amount));
  const picked: ProgramWalletUtxo[] = [];
  let sum = 0n;
  for (const utxo of sorted) {
    if (sum >= amount || picked.length === MAX_ESCROW_INPUTS) break;
    picked.push(utxo);
    sum += utxo.utxo.amount;
  }
  if (sum < amount)
    throw new Error(
      `the ${MAX_ESCROW_INPUTS} largest shielded UTXOs hold less than the amount to lock`,
    );
  return picked;
}

export class EscrowApp {
  readonly #client: ZolanaClient;
  readonly #keypair: ShieldedKeypair;
  readonly #signer: TransactionSigner;
  readonly #authority: ProgramOwner;
  readonly #programId: Address;
  readonly #prover = new ProgramProver();
  readonly #send: ReturnType<typeof sendAndConfirmFactory>;
  readonly #assets = new AssetRegistry();
  #utxos: readonly ProgramWalletUtxo[] = [];

  private constructor(
    client: ZolanaClient,
    keypair: ShieldedKeypair,
    signer: TransactionSigner,
    authority: ProgramOwner,
    programId: Address,
  ) {
    this.#client = client;
    this.#keypair = keypair;
    this.#signer = signer;
    this.#authority = authority;
    this.#programId = programId;
    this.#send = sendAndConfirmFactory(client, signer);
  }

  static async open(seed: Uint8Array, origin: string): Promise<EscrowApp> {
    await initializePoseidon();
    const ws = new URL(origin);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    const client = await createZolanaClient({
      solanaRpcUrl: `${origin}/rpc`,
      solanaRpcSubscriptionsUrl: `${ws.origin}/rpc-ws`,
      indexerUrl: `${origin}/photon`,
      proverUrl: `${origin}/prover`,
    });
    const keypair = keypairFromSeed(seed);
    const signer = await keypair.toSolanaSigner();
    const programId = address(__ESCROW_PROGRAM_ID__);
    const authority = await escrowAuthority(programId, signer.address);
    await escrowWasm();
    return new EscrowApp(client, keypair, signer, authority, programId);
  }

  get solanaAddress(): Address {
    return this.#signer.address;
  }

  /** Rediscovers balance and escrows from the indexer, holding the read until `slot`. */
  async refresh(slot?: bigint): Promise<Snapshot> {
    const atSlot =
      slot ?? (await this.#client.solanaRpc.getSlot({ commitment: "confirmed" }).send());
    const [transactions, wasm, chainNow, balance] = await Promise.all([
      creatorTransactions(this.#client, this.#keypair, this.#authority, atSlot),
      escrowWasm(),
      chainUnixTimestamp(this.#client),
      this.#client.solanaRpc.getBalance(this.#signer.address, { commitment: "confirmed" }).send(),
    ]);
    this.#utxos = await spendableSol(this.#client, this.#keypair, transactions, this.#assets);
    const viewingKey = this.#keypair.viewingKey();
    let escrows: readonly DataUtxo<EscrowTerms>[];
    try {
      escrows = escrowUtxos(
        (utxo) => wasm.escrowTermsDataUtxo(utxo),
        viewingKey,
        transactions,
        this.#authority,
        this.#assets,
        this.#client.treeId,
      );
    } finally {
      viewingKey.destroy();
    }
    return {
      solanaAddress: this.#signer.address,
      escrowAuthority: this.#authority.pda,
      publicLamports: balance.value,
      shieldedLamports: total(this.#utxos),
      shieldedUtxos: this.#utxos.length,
      escrows: escrows
        .map((escrow) => ({
          id: hex(escrow.utxo.utxoHash),
          amount: escrow.utxo.utxo.amount,
          unlock: escrow.data.unlock,
          status: escrowStatus(escrow.data.unlock, chainNow),
          utxo: escrow,
        }))
        .sort((a, b) => compareBigint(a.unlock, b.unlock)),
      chainNow,
      slot: atSlot,
      pageFull: transactions.length >= TAG_PAGE_LIMIT,
    };
  }

  /** Airdrops localnet SOL and deposits `amount` of it into the shielded balance. */
  async fund(amount: bigint, onStage: OnStage): Promise<Snapshot> {
    onStage("airdropping");
    await airdrop(this.#client, this.#signer.address, amount + FEE_RESERVE_LAMPORTS);
    const address = this.#keypair.shieldedAddress();
    const slot = await this.#send(
      [
        await depositInstruction({
          tree: this.#client.tree,
          depositor: this.#signer,
          deposits: [
            {
              asset: DepositAsset.sol(),
              viewTag: address.confidentialViewTag(),
              recipientOwnerHash: address.ownerHash(),
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

  /** Locks `amount` of shielded SOL until `delaySeconds` past the on-chain clock. */
  async lock(amount: bigint, delaySeconds: bigint, onStage: OnStage): Promise<Snapshot> {
    onStage("preparing");
    // The program checks unlock against the Clock, so measure from it, not the browser.
    const unlock = (await chainUnixTimestamp(this.#client)) + delaySeconds;
    const wasm = await escrowWasm();
    const shielded = this.#keypair.shieldedAddress();
    const escrowTransaction = wasm.escrowTransaction(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: this.#client.treeId },
          tokenUtxosAssetA: [...selectInputs(this.#utxos, amount)],
          unlock,
          amount,
        },
        public: {
          escrowOwner: this.#authority.address(shielded.viewingPublicKey).toBytes(),
          creatorIdentity: this.#creatorIdentity(),
        },
      },
      shielded.toBytes(),
      this.#signer.address,
    );
    onStage("provingProgram");
    const { proof } = await this.#prover.prove("escrow", escrowTransaction.proofInputs);
    return this.#proveSppAndSend(
      escrowTransaction.finalizedTx,
      LocalKeys.fromKeypair(this.#keypair, this.#client.proofService),
      (transact) =>
        escrowInstruction({
          programId: this.#programId,
          client: this.#client,
          creator: this.#signer,
          authority: this.#authority,
          proof: proof.compressedProof,
          transact,
        }),
      onStage,
    );
  }

  /** Reclaims an escrow. Before unlock the program rejects it with error 9005. */
  async withdraw(escrow: EscrowView, onStage: OnStage): Promise<Snapshot> {
    onStage("preparing");
    const wasm = await escrowWasm();
    const withdrawTransaction = wasm.withdrawTransaction(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: this.#client.treeId },
          escrow: escrow.utxo.utxo,
          terms: escrow.utxo.data,
        },
        public: { unlock: escrow.unlock, creatorIdentity: this.#creatorIdentity() },
      },
      this.#keypair.shieldedAddress().toBytes(),
      this.#signer.address,
    );
    onStage("provingProgram");
    const { proof } = await this.#prover.prove("withdraw", withdrawTransaction.proofInputs);
    // The escrow UTXO is owned by the program PDA, so its nullifier key proves it.
    const programNullifierKey = ProgramOwner.nullifierKey();
    const keys = new NullifierKeyProofAuthority(programNullifierKey, this.#client.proofService);
    programNullifierKey.destroy();
    return this.#proveSppAndSend(
      withdrawTransaction.finalizedTx,
      keys,
      (transact) =>
        withdrawInstruction({
          programId: this.#programId,
          client: this.#client,
          creator: this.#signer,
          authority: this.#authority,
          proof: proof.compressedProof,
          unlock: escrow.unlock,
          transact,
        }),
      onStage,
    );
  }

  /** Proves the SPP transfer for a finalized program transaction, sends it, and resyncs. */
  async #proveSppAndSend(
    finalizedTx: FinalizedTransaction,
    keys: ProofAuthority & { destroy(): void },
    instruction: (transact: TransactInstructionData) => Promise<Instruction>,
    onStage: OnStage,
  ): Promise<Snapshot> {
    onStage("provingSpp");
    let transact: TransactInstructionData;
    try {
      const proofInputs = (await decodeProgramTransaction(finalizedTx, this.#assets)).toProofInputs(
        this.#keypair,
      );
      transact = await this.#client.proveTransact(proofInputs, keys);
    } finally {
      keys.destroy();
    }
    const slot = await this.#send([await instruction(transact)], onStage);
    onStage("syncing");
    return this.refresh(slot);
  }

  #creatorIdentity(): Uint8Array {
    return solanaOwnerIdentity(Uint8Array.from(getAddressEncoder().encode(this.#signer.address)));
  }
}
