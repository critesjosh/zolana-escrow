#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use light_program_profiler::profile;
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use pinocchio::cpi::{Seed, Signer};
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};
use wincode::{config::DefaultConfig, SchemaReadOwned};
use zolana_interface::instruction::instruction_data::transact::TransactIxDataRef;
use zolana_program::compression::PdaOwner;
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use zolana_program::cpi::{SppTransactAccounts, TransactAccountsError};

use crate::{error::FundraiserError, state::Campaign};

/// An instruction's own arguments followed by the SPP `transact` bytes it
/// forwards unchanged.
pub struct IxData<'a, A> {
    pub args: A,
    pub transact: TransactIxDataRef<'a>,
    pub transact_bytes: &'a [u8],
}

impl<'a, A: SchemaReadOwned<DefaultConfig, Dst = A>> IxData<'a, A> {
    pub fn parse(data: &'a [u8]) -> Result<Self, ProgramError> {
        let mut transact_bytes = data;
        let args = wincode::deserialize_from(&mut transact_bytes)
            .map_err(|_| FundraiserError::InvalidInstructionData)?;
        let transact = TransactIxDataRef::from_bytes(transact_bytes)
            .map_err(|_| FundraiserError::InvalidInstructionData)?;
        Ok(Self {
            args,
            transact,
            transact_bytes,
        })
    }

    pub fn private_tx_hash(&self) -> &'a [u8; 32] {
        self.transact.private_tx_hash
    }
}

pub fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Copies the campaign out of its account after checking owner, size and
/// discriminator, so handlers can release the borrow before the SPP CPI.
pub fn load_campaign(account: &AccountView) -> Result<Campaign, ProgramError> {
    Campaign::check_owner(account)?;
    let data = account
        .try_borrow()
        .map_err(|_| FundraiserError::InvalidCampaign)?;
    Ok(*Campaign::from_bytes(&data)?)
}

pub fn store_campaign(account: &mut AccountView, campaign: &Campaign) -> ProgramResult {
    let mut data = account
        .try_borrow_mut()
        .map_err(|_| FundraiserError::InvalidCampaign)?;
    *Campaign::from_bytes_mut(&mut data)? = *campaign;
    Ok(())
}

/// The campaign's PDA that owns every contribution UTXO and signs the SPP
/// CPI that creates or spends one.
pub struct CampaignAuthority {
    address: Address,
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    campaign: Address,
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    bump: u8,
}

impl CampaignAuthority {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    pub fn from_bump(campaign: &Address, bump: u8) -> Result<Self, ProgramError> {
        let address = Address::create_program_address(
            &[crate::CAMPAIGN_AUTHORITY_SEED, campaign.as_array(), &[bump]],
            &crate::ID,
        )
        .map_err(|_| FundraiserError::InvalidCampaign)?;
        Ok(Self {
            address,
            campaign: *campaign,
            bump,
        })
    }

    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    pub fn from_bump(_campaign: &Address, _bump: u8) -> Result<Self, ProgramError> {
        unimplemented!("CampaignAuthority::from_bump requires Solana runtime syscalls")
    }

    pub fn address(&self) -> &Address {
        &self.address
    }

    pub fn owner_hash(&self) -> Result<[u8; 32], FundraiserError> {
        Ok(*PdaOwner::new(&self.address)
            .map_err(|_| FundraiserError::HashingFailed)?
            .owner_hash())
    }

    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    #[inline(never)]
    #[profile]
    pub fn invoke_transact(&self, spp_accounts: &[AccountView], transact: &[u8]) -> ProgramResult {
        let signer_pdas = [&self.address];
        let spp = SppTransactAccounts::new(spp_accounts, &signer_pdas)
            .map_err(transact_accounts_error)?;
        let bump = [self.bump];
        let seeds = [
            Seed::from(crate::CAMPAIGN_AUTHORITY_SEED),
            Seed::from(self.campaign.as_array()),
            Seed::from(&bump),
        ];
        spp.invoke::<16>(transact, &[Signer::from(&seeds)])
    }

    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    pub fn invoke_transact(
        &self,
        _spp_accounts: &[AccountView],
        _transact: &[u8],
    ) -> ProgramResult {
        unimplemented!("CampaignAuthority::invoke_transact requires Solana runtime syscalls")
    }
}

#[cfg(any(target_os = "solana", target_arch = "bpf"))]
fn transact_accounts_error(error: TransactAccountsError) -> ProgramError {
    match error {
        TransactAccountsError::InvalidSppProgram => {
            FundraiserError::InvalidShieldedPoolProgram.into()
        }
        TransactAccountsError::MissingPdaSigner { .. } => {
            FundraiserError::MissingCampaignAuthority.into()
        }
        TransactAccountsError::NotEnoughAccounts => ProgramError::NotEnoughAccountKeys,
    }
}
