// Browser-safe escrow helpers: instructions, PDA, discovery and balance. The
// Node test and the web example both build on these; Node-only pieces (WASM
// loading, proving-key reads, env config) live in escrow.ts.

import { SOL_MINT } from "@heliuslabs/zolana";
import { atSlot, type ZolanaClient } from "@heliuslabs/zolana/client";
import {
  encodeTransactInstructionData,
  transactCpiAccounts,
  type TransactInstructionData,
} from "@heliuslabs/zolana/interface";
import {
  P256_PUBLIC_KEY_LENGTH,
  ShieldedKeypair,
  SigningKey,
  bytes32,
  bytes64,
  type ViewingKey,
} from "@heliuslabs/zolana/keypair";
import {
  LocalShieldedKeys,
  ProgramOwner,
  Wallet,
  decodeConfidential,
  decodeOutputData,
  decryptTransactions,
  toProgramWalletUtxo,
  type AssetRegistry,
  type IndexedShieldedTransaction,
  type ProgramWalletUtxo,
} from "@heliuslabs/zolana/transaction";
import {
  AccountRole,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getAddressEncoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  isSolanaError,
  lamports,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

import type { CompressedGroth16Proof, DataUtxo, EscrowTerms, WalletUtxo } from "./wasm-types.js";

export const ESCROW_OUTPUT_SLOT = 1;
/** The program's `NotYetUnlocked` error: a withdraw before the Clock passes unlock. */
export const NOT_YET_UNLOCKED = 9005;

const ESCROW_TAG = 0;
const WITHDRAW_TAG = 1;
const ESCROW_AUTHORITY_SEED = "escrow_authority";
const TRANSACT_COMPUTE_UNIT_LIMIT = 1_400_000;
const LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;
const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");
// Clock layout: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, then
// unix_timestamp (i64 LE).
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;
const addressEncoder = getAddressEncoder();
const base64Encoder = getBase64Encoder();

/** Decodes a candidate UTXO into its escrow terms: the WASM `escrowTermsDataUtxo`. */
export type EscrowTermsDecoder = (utxo: WalletUtxo) => DataUtxo<EscrowTerms>;

/** The custom program error code anywhere in an error's cause chain. */
export function customErrorCode(error: unknown): number | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return cause.context.code;
  }
  return undefined;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  parts.reduce((offset, part) => {
    bytes.set(part, offset);
    return offset + part.length;
  }, 0);
  return bytes;
}

/** Ascending order for bigints, for `Array.prototype.sort`. */
export function compareBigint(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomKeypair(): ShieldedKeypair {
  const seed = bytes32(crypto.getRandomValues(new Uint8Array(32)));
  try {
    return keypairFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

/** The shielded keypair and Solana signer for one Ed25519 seed. Does not clear `seed`. */
export function keypairFromSeed(seed: Uint8Array): ShieldedKeypair {
  return ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seed)));
}

export async function airdrop(
  client: ZolanaClient,
  recipient: Address,
  amount: bigint,
): Promise<void> {
  await airdropFactory({
    rpc: client.solanaRpc,
    rpcSubscriptions: client.solanaRpcSubscriptions,
  })({ commitment: "confirmed", recipientAddress: recipient, lamports: lamports(amount) });
}

/** The Clock's unix timestamp, the value `withdraw` checks unlock against. */
export async function chainUnixTimestamp(client: ZolanaClient): Promise<bigint> {
  const { value } = await client.solanaRpc
    .getAccountInfo(CLOCK_SYSVAR, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (value === null) throw new Error("the Clock sysvar is missing");
  const data = base64Encoder.encode(value.data[0]);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(
    CLOCK_UNIX_TIMESTAMP_OFFSET,
    true,
  );
}

/** What `sendAndConfirmFactory` reports as a transaction moves through it. */
export type SendStage = "submitting" | "confirming";

export function sendAndConfirmFactory(
  client: ZolanaClient,
  feePayer: TransactionSigner,
): (instructions: readonly Instruction[], onStage?: (stage: SendStage) => void) => Promise<bigint> {
  const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
  return async (instructions, onStage) => {
    const { value: lifetime } = await client.solanaRpc.getLatestBlockhash().send();
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 1 }),
        (message) => setTransactionMessageFeePayerSigner(feePayer, message),
        (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
        (message) =>
          setTransactionMessageConfig(
            {
              computeUnitLimit: TRANSACT_COMPUTE_UNIT_LIMIT,
              loadedAccountsDataSizeLimit: LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
            },
            message,
          ),
        (message) => appendTransactionMessageInstructions(instructions, message),
      ),
    );
    assertIsTransactionWithBlockhashLifetime(signed);
    onStage?.("submitting");
    await sendTransaction(signed, { commitment: "confirmed" });
    onStage?.("confirming");
    return client.confirmTransaction(getSignatureFromTransaction(signed));
  };
}

export function escrowAuthority(programId: Address, creator: Address): Promise<ProgramOwner> {
  return ProgramOwner.find([ESCROW_AUTHORITY_SEED, addressEncoder.encode(creator)], programId);
}

/**
 * Every transaction tagged for the creator: its own UTXOs (view tag) and its
 * escrows (the escrow-authority owner tag). `slot` holds the read until the
 * indexer has seen that slot.
 */
export async function creatorTransactions(
  client: ZolanaClient,
  creator: ShieldedKeypair,
  authority: ProgramOwner,
  slot: bigint,
): Promise<readonly IndexedShieldedTransaction[]> {
  const response = await client.getShieldedTransactionsByTags(
    { tags: [creator.shieldedAddress().confidentialViewTag(), authority.ownerTag()], limit: 50 },
    atSlot(slot),
  );
  return response.transactions;
}

export async function spendableSol(
  client: ZolanaClient,
  creator: ShieldedKeypair,
  transactions: readonly IndexedShieldedTransaction[],
  assets: AssetRegistry,
): Promise<readonly ProgramWalletUtxo[]> {
  const wallet = new Wallet({ identity: creator.shieldedAddress(), registry: assets });
  const keys = LocalShieldedKeys.fromKeypair(creator);
  try {
    await decryptTransactions({ wallet, keys, transactions });
  } finally {
    keys.destroy();
  }
  return wallet
    .utxos()
    .filter((utxo) => !utxo.spent && utxo.utxo.asset === SOL_MINT)
    .map((utxo) =>
      toProgramWalletUtxo(utxo, {
        nullifierPublicKey: creator.nullifierPublicKey(),
        treeId: client.treeId,
        assets,
      }),
    );
}

/** The creator's open escrows: decrypted escrow UTXOs whose nullifier is not yet published. */
export function escrowUtxos(
  decodeTerms: EscrowTermsDecoder,
  viewingKey: ViewingKey,
  transactions: readonly IndexedShieldedTransaction[],
  authority: ProgramOwner,
  assets: AssetRegistry,
  treeId: number,
): readonly DataUtxo<EscrowTerms>[] {
  const ownerTag = hex(authority.ownerTag());
  const owner = authority.publicKey().toBytes();
  const nullifierPubkey = ProgramOwner.nullifierPublicKey();
  const nullifierKey = ProgramOwner.nullifierKey();
  const spent = new Set(transactions.flatMap((tx) => tx.nullifiers.map(hex)));
  const escrows = new Map<string, DataUtxo<EscrowTerms>>();
  try {
    for (const tx of transactions) {
      const { txViewingPublicKey, salt } = tx;
      if (txViewingPublicKey === undefined || salt === undefined) continue;
      tx.outputSlots.forEach((slot, slotIndex) => {
        if (hex(slot.viewTag) !== ownerTag) return;
        const body = decodeOutputData(slot.payload).body;
        const plaintext = decodeConfidential(
          viewingKey.decryptUtxo(
            body.slice(P256_PUBLIC_KEY_LENGTH),
            txViewingPublicKey,
            salt,
            slotIndex,
          ),
        );
        const utxoHash = slot.outputContext.hash;
        const escrow = decodeTerms({
          utxo: {
            owner,
            asset: { asset: assets.resolve(plaintext.assetId), assetId: plaintext.assetId },
            amount: plaintext.amount,
            blinding: plaintext.blinding,
            data: { records: [...plaintext.data.records()] },
          },
          nullifierPubkey,
          utxoHash,
          nullifier: nullifierKey.nullifier(utxoHash, plaintext.blinding),
          treeId,
          leafIndex: slot.outputContext.leafIndex,
        });
        if (!spent.has(hex(escrow.utxo.nullifier))) escrows.set(hex(utxoHash), escrow);
      });
    }
  } finally {
    nullifierKey.destroy();
  }
  return [...escrows.values()];
}

interface ProgramTransactInput {
  readonly programId: Address;
  readonly client: ZolanaClient;
  readonly creator: TransactionSigner;
  readonly authority: ProgramOwner;
  readonly proof: CompressedGroth16Proof;
  readonly transact: TransactInstructionData;
}

function signer(
  account: TransactionSigner,
  role: AccountRole.READONLY_SIGNER | AccountRole.WRITABLE_SIGNER,
): AccountSignerMeta {
  return { address: account.address, role, signer: account };
}

function proofBytes(proof: CompressedGroth16Proof): Uint8Array {
  return concat(bytes32(proof.a), bytes64(proof.b), bytes32(proof.c));
}

async function programTransact(
  input: ProgramTransactInput,
  tag: number,
  args: Uint8Array,
  accounts: readonly AccountMeta[],
): Promise<Instruction> {
  const sppAccounts = await transactCpiAccounts({
    payer: input.creator,
    inputTree: input.client.tree,
    outputTree: input.client.tree,
    data: input.transact,
    signerPdas: [input.authority.pda],
  });
  return {
    programAddress: input.programId,
    accounts: [...accounts, ...sppAccounts],
    data: concat(Uint8Array.of(tag), args, encodeTransactInstructionData(input.transact)),
  };
}

export function escrowInstruction(input: ProgramTransactInput): Promise<Instruction> {
  return programTransact(input, ESCROW_TAG, proofBytes(input.proof), [
    signer(input.creator, AccountRole.READONLY_SIGNER),
  ]);
}

export function withdrawInstruction(
  input: ProgramTransactInput & Readonly<{ unlock: bigint }>,
): Promise<Instruction> {
  return programTransact(
    input,
    WITHDRAW_TAG,
    concat(proofBytes(input.proof), u64le(input.unlock)),
    [
      signer(input.creator, AccountRole.WRITABLE_SIGNER),
      signer(input.creator, AccountRole.READONLY_SIGNER),
    ],
  );
}
