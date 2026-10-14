use std::{thread, time::Duration};

use anyhow::{anyhow, bail, Result};
use private_fundraiser_program::{client::CampaignView, error::FundraiserError};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_signer::Signer;
use zolana_client::{ComputeBudgetConfig, IndexerRpcConfig, Rpc};
use zolana_keypair::{ShieldedKeypair, SigningKey};
use zolana_program::instruction::{AssetDeposit, Deposit, DepositAsset};
use zolana_program_test::{
    fixture,
    localnet::{FixtureLocalnet, LocalnetPaths, LocalnetPorts},
    workspace_path,
};
use zolana_transaction::{decrypt_spendable, AssetRegistry, ShieldedTransaction, SOL_MINT};

const TRANSACT_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;
const CLOCK_SYSVAR: &str = "SysvarC1ock11111111111111111111111111111111";

pub const DEPOSIT: u64 = 300_000_000;

pub struct TestEnv {
    pub localnet: FixtureLocalnet,
    /// The fixture payer: funded, so it pays the campaign account's rent.
    pub coordinator: ShieldedKeypair,
    pub contributors: Vec<ShieldedKeypair>,
    /// Never signs anything; only receives the payout.
    pub beneficiary: ShieldedKeypair,
    pub deposit_slot: u64,
}

/// Boots a localnet with SPP and the fundraiser, and shields `DEPOSIT` for
/// each of `contributors` fixture actors.
pub fn setup(test: u16, contributors: u8) -> Result<TestEnv> {
    let localnet = FixtureLocalnet::start(
        "private-fundraiser",
        LocalnetPorts::for_test(test)?,
        vec![(
            private_fundraiser_program::ID,
            workspace_path("target/deploy/private_fundraiser_program.so"),
        )],
        &LocalnetPaths::workspace(),
    )?;
    let payer = fixture::payer();
    let contributors = (0..contributors)
        .map(|index| Ok(ShieldedKeypair::from_keypair(&fixture::actor(index))?))
        .collect::<Result<Vec<_>>>()?;
    let deposits = contributors
        .iter()
        .map(|contributor| {
            let address = contributor.shielded_address()?;
            Ok(AssetDeposit {
                asset: DepositAsset::Sol,
                view_tag: address.confidential_view_tag()?,
                owner: address.owner_hash()?,
                amount: DEPOSIT,
                memo: None,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let deposit = Deposit {
        tree: localnet.tree,
        depositor: payer.pubkey(),
        deposits,
    }
    .instruction()?;
    let deposit_slot = send(&localnet, &[&payer], deposit)?;
    Ok(TestEnv {
        localnet,
        coordinator: ShieldedKeypair::from_keypair(&payer)?,
        contributors,
        beneficiary: ShieldedKeypair::from_keypair(SigningKey::from_ed25519_bytes(&[42; 32]))?,
        deposit_slot,
    })
}

pub fn transactions_by_tags(
    localnet: &FixtureLocalnet,
    tags: Vec<[u8; 32]>,
    slot: u64,
) -> Result<Vec<ShieldedTransaction>> {
    Ok(localnet
        .client
        .get_shielded_transactions_by_tags(
            tags,
            None,
            Some(100),
            Some(IndexerRpcConfig::at_slot(slot)),
        )?
        .transactions)
}

/// The SOL a shielded keypair can spend, found from its own view tag only.
pub fn sol_balance(
    localnet: &FixtureLocalnet,
    keypair: &ShieldedKeypair,
    slot: u64,
) -> Result<(u64, Vec<zolana_transaction::WalletUtxo>)> {
    let tag = keypair.shielded_address()?.confidential_view_tag()?;
    let transactions = transactions_by_tags(localnet, vec![tag], slot)?;
    let balances = decrypt_spendable(keypair, &transactions, &AssetRegistry::default())?.balances;
    Ok(balances
        .get_balance(SOL_MINT)
        .map(|balance| (balance.amount, balance.utxos.clone()))
        .unwrap_or_default())
}

/// Sends one instruction, the first signer paying. `compute_units` varies
/// the message so a resend gets a new signature.
pub fn send_with(
    localnet: &FixtureLocalnet,
    signers: &[&dyn Signer],
    instruction: Instruction,
    compute_units: u32,
) -> Result<u64> {
    let payer = signers
        .first()
        .ok_or_else(|| anyhow!("no signer"))?
        .pubkey();
    let signature = localnet.client.create_and_send_transaction(
        &[instruction],
        payer,
        signers,
        ComputeBudgetConfig::new(compute_units),
    )?;
    localnet
        .client
        .get_signature_statuses(vec![signature])?
        .first()
        .and_then(|status| status.as_ref())
        .map(|status| status.slot)
        .ok_or_else(|| anyhow!("no status for {signature} after confirmation"))
}

pub fn send(
    localnet: &FixtureLocalnet,
    signers: &[&dyn Signer],
    instruction: Instruction,
) -> Result<u64> {
    send_with(localnet, signers, instruction, TRANSACT_COMPUTE_UNIT_LIMIT)
}

/// The same instruction under another compute budget, hence another signature.
pub fn resend(
    localnet: &FixtureLocalnet,
    signers: &[&dyn Signer],
    instruction: Instruction,
) -> Result<u64> {
    send_with(
        localnet,
        signers,
        instruction,
        TRANSACT_COMPUTE_UNIT_LIMIT - 1,
    )
}

/// A custom program error surfaces as `Custom(<decimal>)` or as the
/// program-log line `custom program error: 0x<hex>`.
pub fn assert_error(context: &str, result: Result<u64>, error: FundraiserError) {
    let code = error as u32;
    let text = match result {
        Ok(slot) => panic!("{context}: unexpectedly succeeded at slot {slot}"),
        Err(err) => format!("{err:?}"),
    };
    assert!(
        text.contains(&format!("Custom({code})")) || text.contains(&format!("0x{code:x}")),
        "{context}: expected {error:?} ({code}) in: {text}"
    );
}

pub fn assert_fails(context: &str, result: Result<u64>) {
    if let Ok(slot) = result {
        panic!("{context}: unexpectedly succeeded at slot {slot}");
    }
}

pub fn campaign(localnet: &FixtureLocalnet, address: Address) -> Result<CampaignView> {
    let account = localnet
        .client
        .get_account(address)?
        .ok_or_else(|| anyhow!("campaign {address} does not exist"))?;
    Ok(CampaignView::decode(address, &account.data)?)
}

/// The validator's Clock `unix_timestamp`, which the program checks windows
/// against.
pub fn chain_now(localnet: &FixtureLocalnet) -> Result<i64> {
    let clock: Address = CLOCK_SYSVAR.parse()?;
    let account = localnet
        .client
        .get_account(clock)?
        .ok_or_else(|| anyhow!("no clock sysvar"))?;
    let bytes: [u8; 8] = account
        .data
        .get(32..40)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| anyhow!("clock sysvar too short"))?;
    Ok(i64::from_le_bytes(bytes))
}

pub fn wait_until(localnet: &FixtureLocalnet, timestamp: i64) -> Result<()> {
    for _ in 0..600 {
        if chain_now(localnet)? >= timestamp {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }
    bail!("the clock did not reach {timestamp}")
}
