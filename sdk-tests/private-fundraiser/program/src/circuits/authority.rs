use pinocchio::Address;
use zolana_program::ProgramOwner;

use crate::{campaign_authority_seeds, campaign_seeds, ID};

pub fn campaign_address(coordinator: &Address, campaign_seed: u64) -> Address {
    let seed = campaign_seed.to_le_bytes();
    Address::find_program_address(&campaign_seeds(coordinator, &seed), &ID).0
}

pub fn campaign_authority(campaign: &Address) -> ProgramOwner {
    ProgramOwner::find(&campaign_authority_seeds(campaign), &ID)
}
