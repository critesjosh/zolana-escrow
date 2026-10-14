use light_program_profiler::profile;
use pinocchio::{error::ProgramError, AccountView, ProgramResult};
use wincode::{SchemaRead, SchemaWrite};
use zolana_account_checks::AccountIterator;
use zolana_hasher::primitives::solana_owner_identity;

use crate::{
    error::FundraiserError,
    instructions::shared::now,
    state::{Campaign, CampaignStatus, CAMPAIGN_DISCRIMINATOR, SHIELDED_ADDRESS_LEN},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct CreateArgs {
    pub campaign_seed: u64,
    pub target: u64,
    pub close_ts: i64,
    pub settle_deadline: i64,
    pub beneficiary_owner_hash: [u8; 32],
    pub beneficiary_address: [u8; SHIELDED_ADDRESS_LEN],
}

/// Creates the campaign account at `[b"campaign", coordinator, campaign_seed]`
/// with immutable terms. No proof: the coordinator chooses the terms, and every
/// later instruction reads them from this account.
#[inline(never)]
#[profile]
pub fn process_create_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let args: CreateArgs =
        wincode::deserialize(data).map_err(|_| FundraiserError::InvalidInstructionData)?;
    let now = now()?;
    if args.target == 0 || now >= args.close_ts || args.close_ts >= args.settle_deadline {
        return Err(FundraiserError::InvalidCampaignTerms.into());
    }

    let mut iter = AccountIterator::new(accounts);
    let coordinator = iter.next_signer_mut("coordinator")?;
    let campaign = iter.next_mut("campaign")?;
    let system_program = iter.next_account("system_program")?;
    if !pinocchio_system::check_id(system_program.address()) {
        return Err(ProgramError::IncorrectProgramId);
    }

    let seed = args.campaign_seed.to_le_bytes();
    let coordinator_address = *coordinator.address();
    let (bump, authority_bump) = derive_bumps(campaign, &coordinator_address, &seed)?;
    create_account(coordinator, campaign, &coordinator_address, &seed, bump)?;

    let campaign_id =
        solana_owner_identity(campaign.address().as_array()).map_err(FundraiserError::from)?;
    let mut data = campaign
        .try_borrow_mut()
        .map_err(|_| FundraiserError::InvalidCampaign)?;
    let state: &mut Campaign = bytemuck::from_bytes_mut(&mut data[..]);
    *state = Campaign {
        discriminator: CAMPAIGN_DISCRIMINATOR,
        status: CampaignStatus::Open as u8,
        count: 0,
        refunded: 0,
        bump,
        authority_bump,
        campaign_seed: seed,
        target: args.target.to_le_bytes(),
        close_ts: args.close_ts.to_le_bytes(),
        settle_deadline: args.settle_deadline.to_le_bytes(),
        coordinator: *coordinator_address.as_array(),
        campaign_id,
        beneficiary_owner_hash: args.beneficiary_owner_hash,
        beneficiary_address: args.beneficiary_address,
        registry: [[0u8; 32]; crate::MAX_CONTRIBUTIONS],
    };
    Ok(())
}

#[cfg(any(target_os = "solana", target_arch = "bpf"))]
fn derive_bumps(
    campaign: &AccountView,
    coordinator: &pinocchio::Address,
    seed: &[u8; 8],
) -> Result<(u8, u8), ProgramError> {
    use pinocchio::{address::address_eq, Address};

    let (expected, bump) =
        Address::find_program_address(&crate::campaign_seeds(coordinator, seed), &crate::ID);
    if !address_eq(campaign.address(), &expected) {
        return Err(FundraiserError::InvalidCampaignAddress.into());
    }
    let (_, authority_bump) =
        Address::find_program_address(&crate::campaign_authority_seeds(&expected), &crate::ID);
    Ok((bump, authority_bump))
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
fn derive_bumps(
    _campaign: &AccountView,
    _coordinator: &pinocchio::Address,
    _seed: &[u8; 8],
) -> Result<(u8, u8), ProgramError> {
    unimplemented!("derive_bumps requires Solana runtime syscalls")
}

#[cfg(any(target_os = "solana", target_arch = "bpf"))]
fn create_account(
    payer: &AccountView,
    campaign: &mut AccountView,
    coordinator: &pinocchio::Address,
    seed: &[u8; 8],
    bump: u8,
) -> ProgramResult {
    use pinocchio::cpi::{Seed, Signer};

    let bump = [bump];
    let seeds = [
        Seed::from(crate::CAMPAIGN_SEED),
        Seed::from(coordinator.as_array()),
        Seed::from(seed),
        Seed::from(&bump),
    ];
    pinocchio_system::create_account_with_minimum_balance_signed(
        campaign,
        Campaign::SIZE,
        &crate::ID,
        payer,
        None,
        &[Signer::from(&seeds)],
    )
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
fn create_account(
    _payer: &AccountView,
    _campaign: &mut AccountView,
    _coordinator: &pinocchio::Address,
    _seed: &[u8; 8],
    _bump: u8,
) -> ProgramResult {
    unimplemented!("create_account requires Solana runtime syscalls")
}
