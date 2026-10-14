#[cfg(any(feature = "circuits", feature = "wasm"))]
pub mod circuits;
#[cfg(feature = "circuits")]
pub mod client;
pub mod error;
pub mod instructions;
pub mod state;
pub mod zk {
    zolana_macros::include_zk_programs!();
}

use pinocchio::{address::address_eq, error::ProgramError, AccountView, Address, ProgramResult};

use crate::instructions::{
    process_contribute_ix, process_create_ix, process_refund_ix, process_settle_ix,
};

pub mod tag {
    pub const CREATE: u8 = 0;
    pub const CONTRIBUTE: u8 = 1;
    pub const SETTLE: u8 = 2;
    pub const REFUND: u8 = 3;
}

/// Contributions a campaign accepts. Settlement spends them all in one SPP
/// transaction, so this is bounded by the largest SPP input shape the
/// settlement fits in (see the design doc).
pub const MAX_CONTRIBUTIONS: usize = 4;

pub const CAMPAIGN_SEED: &[u8] = b"campaign";
pub const CAMPAIGN_AUTHORITY_SEED: &[u8] = b"campaign_authority";

pub fn campaign_seeds<'a>(coordinator: &'a Address, campaign_seed: &'a [u8; 8]) -> [&'a [u8]; 3] {
    [CAMPAIGN_SEED, coordinator.as_array(), campaign_seed]
}

pub fn campaign_authority_seeds(campaign: &Address) -> [&[u8]; 2] {
    [CAMPAIGN_AUTHORITY_SEED, campaign.as_array()]
}

#[cfg(all(feature = "bpf-entrypoint", not(feature = "no-entrypoint")))]
mod entrypoint {
    pinocchio::entrypoint!(crate::process_instruction);
}

pinocchio::address::declare_id!("5RuvJhVQwXJUjwq1XDZA27rqu6ZA62PFh7QuJxPQoNFX");

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if !address_eq(program_id, &crate::ID) {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (ix_tag, ix_data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *ix_tag {
        tag::CREATE => process_create_ix(accounts, ix_data),
        tag::CONTRIBUTE => process_contribute_ix(accounts, ix_data),
        tag::SETTLE => process_settle_ix(accounts, ix_data),
        tag::REFUND => process_refund_ix(accounts, ix_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
