// Browser-safe private fundraiser helpers: campaign account, instructions,
// discovery and the coordinator's preimage check. The Node test and the web
// example both build on these; generic localnet helpers come from the timelock
// escrow example.

import { atSlot, type ZolanaClient } from "@heliuslabs/zolana/client";
import {
  encodeTransactInstructionData,
  transactCpiAccounts,
  type TransactInstructionData,
} from "@heliuslabs/zolana/interface";
import {
  P256_PUBLIC_KEY_LENGTH,
  ShieldedAddress,
  bytes32,
  bytes64,
  type ViewingKey,
} from "@heliuslabs/zolana/keypair";
import {
  ProgramOwner,
  decodeConfidential,
  decodeOutputData,
  type AssetRegistry,
  type IndexedShieldedTransaction,
} from "@heliuslabs/zolana/transaction";
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

import { hex } from "../../timelock-escrow/typescript/core.js";
import type {
  CompressedGroth16Proof,
  ContributionTerms,
  DataUtxo,
  SppProofOutputUtxo,
  WalletUtxo,
} from "./wasm-types.js";

export {
  airdrop,
  chainUnixTimestamp,
  customErrorCode,
  hex,
  keypairFromSeed,
  randomKeypair,
  sendAndConfirmFactory,
  spendableSol,
  type SendStage,
} from "../../timelock-escrow/typescript/core.js";

/** The contribution's output slot: after the change, as in the program. */
export const CONTRIBUTION_SLOT = 1;
export const MAX_CONTRIBUTIONS = 4;
/** Token inputs a contribution spends at most; see `CONTRIBUTE_TOKEN_INPUTS`. */
export const CONTRIBUTE_TOKEN_INPUTS = 2;

/** Program error codes, from `program/src/error.rs`. */
export const FundraiserError = Object.freeze({
  ProofVerificationFailed: 9100,
  InvalidCampaignTerms: 9107,
  WrongCoordinator: 9108,
  ContributionsClosed: 9109,
  CampaignFull: 9110,
  SettlementNotOpen: 9112,
  SettlementDeadlinePassed: 9113,
  CampaignSettled: 9114,
  NoContributions: 9115,
  RefundNotOpen: 9116,
  UnknownContribution: 9117,
  AlreadyRefunded: 9118,
});

const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  9100: "The program rejected the proof.",
  9107: "Campaign terms are invalid: the target must be nonzero and now < close < settlement deadline.",
  9108: "Only the campaign's coordinator can co-sign a contribution.",
  9109: "Contributions are closed.",
  9110: "The campaign already holds the maximum number of contributions.",
  9112: "Settlement opens when contributions close.",
  9113: "The settlement deadline has passed; the campaign can only refund.",
  9114: "The campaign has settled.",
  9115: "The campaign has no contributions.",
  9116: "Refunds open at the settlement deadline.",
  9117: "No registered contribution at that index.",
  9118: "That contribution has already been refunded.",
};

export function fundraiserErrorMessage(code: number | undefined): string | undefined {
  return code === undefined ? undefined : ERROR_MESSAGES[code];
}

const CREATE_TAG = 0;
const CONTRIBUTE_TAG = 1;
const SETTLE_TAG = 2;
const REFUND_TAG = 3;
const CAMPAIGN_SEED = "campaign";
const CAMPAIGN_AUTHORITY_SEED = "campaign_authority";
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const SHIELDED_ADDRESS_LENGTH = 99;
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const base64Encoder = getBase64Encoder();

// `state::Campaign`: byte fields, integers little-endian.
const CAMPAIGN_SIZE = 361;
const CAMPAIGN_DISCRIMINATOR = 1;

export interface Campaign {
  readonly address: Address;
  readonly settled: boolean;
  readonly count: number;
  readonly refunded: number;
  readonly campaignSeed: bigint;
  readonly target: bigint;
  readonly closeTs: bigint;
  readonly settleDeadline: bigint;
  readonly coordinator: Address;
  readonly campaignId: Uint8Array;
  readonly beneficiaryOwnerHash: Uint8Array;
  readonly beneficiary: ShieldedAddress;
  /** Accepted contribution hashes, in contribution order. */
  readonly contributions: readonly Uint8Array[];
}

export function decodeCampaign(campaignAddress: Address, data: Uint8Array): Campaign {
  if (data.length !== CAMPAIGN_SIZE || data[0] !== CAMPAIGN_DISCRIMINATOR)
    throw new Error(`${campaignAddress} is not a campaign account`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = data[2] ?? 0;
  const beneficiary = ShieldedAddress.fromBytes(data.slice(134, 134 + SHIELDED_ADDRESS_LENGTH));
  const beneficiaryOwnerHash = data.slice(102, 134);
  if (hex(beneficiary.ownerHash()) !== hex(beneficiaryOwnerHash))
    throw new Error("the campaign's beneficiary address does not match its owner hash");
  return {
    address: campaignAddress,
    settled: data[1] === 1,
    count,
    refunded: data[3] ?? 0,
    campaignSeed: view.getBigUint64(6, true),
    target: view.getBigUint64(14, true),
    closeTs: view.getBigInt64(22, true),
    settleDeadline: view.getBigInt64(30, true),
    coordinator: addressDecoder.decode(data.slice(38, 70)),
    campaignId: data.slice(70, 102),
    beneficiaryOwnerHash,
    beneficiary,
    contributions: Array.from({ length: Math.min(count, MAX_CONTRIBUTIONS) }, (_, i) =>
      data.slice(233 + 32 * i, 265 + 32 * i),
    ),
  };
}

export async function fetchCampaign(client: ZolanaClient, campaign: Address): Promise<Campaign> {
  const { value } = await client.solanaRpc
    .getAccountInfo(campaign, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (value === null) throw new Error(`campaign ${campaign} does not exist`);
  return decodeCampaign(campaign, base64Encoder.encode(value.data[0]) as Uint8Array);
}

/** Phase of a campaign at chain time `now`, from its public state. */
export type CampaignPhase = "open" | "settling" | "settled" | "refunding";

export function campaignPhase(campaign: Campaign, now: bigint): CampaignPhase {
  if (campaign.settled) return "settled";
  if (now < campaign.closeTs) return "open";
  if (now < campaign.settleDeadline) return "settling";
  return "refunding";
}

export async function campaignAddress(
  programId: Address,
  coordinator: Address,
  campaignSeed: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [CAMPAIGN_SEED, addressEncoder.encode(coordinator), u64le(campaignSeed)],
  });
  return pda;
}

export function campaignAuthority(programId: Address, campaign: Address): Promise<ProgramOwner> {
  return ProgramOwner.find([CAMPAIGN_AUTHORITY_SEED, addressEncoder.encode(campaign)], programId);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  parts.reduce((offset, part) => {
    bytes.set(part, offset);
    return offset + part.length;
  }, 0);
  return bytes;
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

function signerMeta(
  account: TransactionSigner,
  role: AccountRole.READONLY_SIGNER | AccountRole.WRITABLE_SIGNER,
): AccountSignerMeta {
  return { address: account.address, role, signer: account };
}

function proofBytes(proof: CompressedGroth16Proof): Uint8Array {
  return concat(bytes32(proof.a), bytes64(proof.b), bytes32(proof.c));
}

export interface CreateCampaignInput {
  readonly programId: Address;
  readonly coordinator: TransactionSigner;
  readonly campaignSeed: bigint;
  readonly target: bigint;
  readonly closeTs: bigint;
  readonly settleDeadline: bigint;
  readonly beneficiary: ShieldedAddress;
}

export async function createCampaignInstruction(input: CreateCampaignInput): Promise<Instruction> {
  return {
    programAddress: input.programId,
    accounts: [
      signerMeta(input.coordinator, AccountRole.WRITABLE_SIGNER),
      {
        address: await campaignAddress(
          input.programId,
          input.coordinator.address,
          input.campaignSeed,
        ),
        role: AccountRole.WRITABLE,
      },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: concat(
      Uint8Array.of(CREATE_TAG),
      u64le(input.campaignSeed),
      u64le(input.target),
      i64le(input.closeTs),
      i64le(input.settleDeadline),
      input.beneficiary.ownerHash(),
      input.beneficiary.toBytes(),
    ),
  };
}

interface ProgramTransactInput {
  readonly programId: Address;
  readonly client: ZolanaClient;
  readonly campaign: Address;
  readonly authority: ProgramOwner;
  readonly proof: CompressedGroth16Proof;
  readonly transact: TransactInstructionData;
}

async function programTransact(
  input: ProgramTransactInput,
  payer: TransactionSigner,
  tag: number,
  args: Uint8Array,
  accounts: readonly AccountMeta[],
): Promise<Instruction> {
  const sppAccounts = await transactCpiAccounts({
    payer,
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

export function contributeInstruction(
  input: ProgramTransactInput &
    Readonly<{ contributor: TransactionSigner; coordinator: TransactionSigner }>,
): Promise<Instruction> {
  return programTransact(input, input.contributor, CONTRIBUTE_TAG, proofBytes(input.proof), [
    signerMeta(input.contributor, AccountRole.READONLY_SIGNER),
    signerMeta(input.coordinator, AccountRole.READONLY_SIGNER),
    { address: input.campaign, role: AccountRole.WRITABLE },
  ]);
}

export function settleInstruction(
  input: ProgramTransactInput & Readonly<{ payer: TransactionSigner }>,
): Promise<Instruction> {
  return programTransact(input, input.payer, SETTLE_TAG, proofBytes(input.proof), [
    { address: input.campaign, role: AccountRole.WRITABLE },
  ]);
}

export function refundInstruction(
  input: ProgramTransactInput & Readonly<{ contributor: TransactionSigner; index: number }>,
): Promise<Instruction> {
  return programTransact(
    input,
    input.contributor,
    REFUND_TAG,
    concat(proofBytes(input.proof), Uint8Array.of(input.index)),
    [
      signerMeta(input.contributor, AccountRole.READONLY_SIGNER),
      { address: input.campaign, role: AccountRole.WRITABLE },
    ],
  );
}

/**
 * Every transaction carrying one of `tags`: the campaign authority's owner tag
 * for contributions, a shielded address's view tag for its own UTXOs. `slot`
 * holds the read until the indexer has seen that slot.
 */
export async function taggedTransactions(
  client: ZolanaClient,
  tags: readonly Uint8Array[],
  slot: bigint,
): Promise<readonly IndexedShieldedTransaction[]> {
  const response = await client.getShieldedTransactionsByTags(
    {
      tags: tags.map((tag) => bytes32(tag)),
      limit: 100,
    },
    atSlot(slot),
  );
  return response.transactions;
}

/** Decodes a candidate UTXO into contribution terms: the WASM `contributionTermsDataUtxo`. */
export type TermsDecoder = (utxo: WalletUtxo) => DataUtxo<ContributionTerms>;

/**
 * The viewer's open contributions to `campaign`: outputs under the campaign
 * authority tag that `viewingKey` decrypts, checked against their commitment,
 * still in the registry, not refunded, and the campaign not settled. Needs only
 * the viewing key and public state, never the coordinator.
 */
export function ownContributions(
  decodeTerms: TermsDecoder,
  viewingKey: ViewingKey,
  transactions: readonly IndexedShieldedTransaction[],
  authority: ProgramOwner,
  campaign: Campaign,
  assets: AssetRegistry,
  treeId: number,
): readonly (DataUtxo<ContributionTerms> & { readonly index: number })[] {
  if (campaign.settled) return [];
  const ownerTag = hex(authority.ownerTag());
  const owner = authority.publicKey().toBytes();
  const nullifierPubkey = ProgramOwner.nullifierPublicKey();
  const nullifierKey = ProgramOwner.nullifierKey();
  const registry = campaign.contributions.map(hex);
  const found = new Map<string, DataUtxo<ContributionTerms> & { readonly index: number }>();
  try {
    for (const tx of transactions) {
      const { txViewingPublicKey, salt } = tx;
      if (txViewingPublicKey === undefined || salt === undefined) continue;
      tx.outputSlots.forEach((slot, slotIndex) => {
        if (hex(slot.viewTag) !== ownerTag) return;
        const index = registry.indexOf(hex(slot.outputContext.hash));
        if (index < 0 || (campaign.refunded & (1 << index)) !== 0) return;
        let plaintext;
        try {
          const body = decodeOutputData(slot.payload).body;
          plaintext = decodeConfidential(
            viewingKey.decryptUtxo(
              body.slice(P256_PUBLIC_KEY_LENGTH),
              txViewingPublicKey,
              salt,
              slotIndex,
            ),
          );
        } catch {
          return; // Another contributor's: encrypted to their viewing key.
        }
        const utxoHash = slot.outputContext.hash;
        const contribution = decodeTerms({
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
        found.set(hex(utxoHash), { ...contribution, index });
      });
    }
  } finally {
    nullifierKey.destroy();
  }
  return [...found.values()].sort((left, right) => left.index - right.index);
}

/** What a contributor hands the coordinator with its proved contribution. */
export interface ContributionPreimage {
  readonly output: SppProofOutputUtxo;
  readonly utxoHash: Uint8Array;
}

/**
 * The coordinator's check before co-signing: the preimage opens the
 * contribution output of the exact transact it signs, and its terms name this
 * campaign and beneficiary. Returns the decoded contribution (leaf index 0
 * until the indexer reports it).
 */
export function checkPreimage(
  decodeTerms: TermsDecoder,
  preimage: ContributionPreimage,
  transact: TransactInstructionData,
  authority: ProgramOwner,
  campaign: Campaign,
  treeId: number,
): DataUtxo<ContributionTerms> {
  const output = transact.outputs[CONTRIBUTION_SLOT];
  if (output === undefined || hex(output.utxoHash) !== hex(preimage.utxoHash))
    throw new Error("the preimage is not for this transaction's contribution output");
  const contribution = openPreimage(decodeTerms, preimage, authority, treeId, 0n);
  if (hex(contribution.data.campaignId) !== hex(campaign.campaignId))
    throw new Error("the contribution names another campaign");
  if (hex(contribution.data.beneficiary) !== hex(campaign.beneficiaryOwnerHash))
    throw new Error("the contribution names another beneficiary");
  return contribution;
}

/**
 * Rebuilds a spendable contribution from a stored preimage and its leaf
 * index. The decoder recomputes the commitment, so a wrong preimage fails.
 */
export function openPreimage(
  decodeTerms: TermsDecoder,
  preimage: ContributionPreimage,
  authority: ProgramOwner,
  treeId: number,
  leafIndex: bigint,
): DataUtxo<ContributionTerms> {
  const nullifierKey = ProgramOwner.nullifierKey();
  try {
    const { output } = preimage;
    return decodeTerms({
      utxo: {
        owner: authority.publicKey().toBytes(),
        asset: output.asset,
        amount: output.amount,
        blinding: output.blinding,
        ...(output.data === undefined ? {} : { data: output.data }),
      },
      nullifierPubkey: ProgramOwner.nullifierPublicKey(),
      utxoHash: preimage.utxoHash,
      nullifier: nullifierKey.nullifier(bytes32(preimage.utxoHash), bytes32(output.blinding)),
      treeId,
      leafIndex,
    });
  } finally {
    nullifierKey.destroy();
  }
}

/**
 * The coordinator's spendable contributions in registry order: preimages from
 * its store, leaf indices from the indexer under the campaign authority tag.
 * `treeId` is the campaign's output tree (one tree on localnet).
 */
export function acceptedContributions(
  decodeTerms: TermsDecoder,
  store: readonly ContributionPreimage[],
  transactions: readonly IndexedShieldedTransaction[],
  authority: ProgramOwner,
  campaign: Campaign,
  treeId: number,
): readonly DataUtxo<ContributionTerms>[] {
  const contexts = new Map(
    transactions
      .flatMap((tx) => tx.outputSlots)
      .map((slot) => [hex(slot.outputContext.hash), slot.outputContext] as const),
  );
  return campaign.contributions.map((hash) => {
    const preimage = store.find((entry) => hex(entry.utxoHash) === hex(hash));
    if (preimage === undefined)
      throw new Error("the coordinator holds no preimage for a registered contribution");
    const context = contexts.get(hex(hash));
    if (context === undefined)
      throw new Error("the indexer has not reported a registered contribution yet");
    return openPreimage(decodeTerms, preimage, authority, treeId, context.leafIndex);
  });
}
