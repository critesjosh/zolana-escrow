use bytemuck::{Pod, Zeroable};
use pinocchio::AccountView;

use crate::{error::FundraiserError, MAX_CONTRIBUTIONS};

pub const CAMPAIGN_DISCRIMINATOR: u8 = 1;

/// `ShieldedAddress::to_bytes()`: signing pubkey, nullifier pubkey, viewing pubkey.
pub const SHIELDED_ADDRESS_LEN: usize = 34 + 32 + 33;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CampaignStatus {
    Open = 0,
    Settled = 1,
}

/// A campaign's immutable terms, its status and the registry of accepted
/// contributions. Integers are little-endian byte arrays so the struct has
/// alignment 1 and no padding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
#[repr(C)]
pub struct Campaign {
    pub discriminator: u8,
    pub status: u8,
    pub count: u8,
    /// Bit `i` is set once registry entry `i` has been refunded.
    pub refunded: u8,
    pub bump: u8,
    pub authority_bump: u8,
    pub campaign_seed: [u8; 8],
    pub target: [u8; 8],
    pub close_ts: [u8; 8],
    pub settle_deadline: [u8; 8],
    pub coordinator: [u8; 32],
    /// `solana_owner_identity(campaign address)`: the campaign ID every
    /// contribution's terms commit.
    pub campaign_id: [u8; 32],
    /// The owner hash every contribution's terms commit and settlement pays.
    pub beneficiary_owner_hash: [u8; 32],
    /// The beneficiary's full shielded address, for clients to build the
    /// payout and encrypt it. No proof checks it against the owner hash.
    pub beneficiary_address: [u8; SHIELDED_ADDRESS_LEN],
    /// Output UTXO hashes of accepted contributions, in contribution order.
    pub registry: [[u8; 32]; MAX_CONTRIBUTIONS],
}

impl Campaign {
    pub const SIZE: usize = core::mem::size_of::<Self>();

    /// Checks the account is owned by this program; `from_bytes` checks the rest.
    pub fn check_owner(account: &AccountView) -> Result<(), FundraiserError> {
        if !account.owned_by(&crate::ID) {
            return Err(FundraiserError::InvalidCampaign);
        }
        Ok(())
    }

    fn check_data(data: &[u8]) -> Result<(), FundraiserError> {
        if data.len() != Self::SIZE || data[0] != CAMPAIGN_DISCRIMINATOR {
            return Err(FundraiserError::InvalidCampaign);
        }
        Ok(())
    }

    pub fn from_bytes(data: &[u8]) -> Result<&Self, FundraiserError> {
        Self::check_data(data)?;
        Ok(bytemuck::from_bytes(data))
    }

    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, FundraiserError> {
        Self::check_data(data)?;
        Ok(bytemuck::from_bytes_mut(data))
    }

    pub fn target(&self) -> u64 {
        u64::from_le_bytes(self.target)
    }

    pub fn close_ts(&self) -> i64 {
        i64::from_le_bytes(self.close_ts)
    }

    pub fn settle_deadline(&self) -> i64 {
        i64::from_le_bytes(self.settle_deadline)
    }

    pub fn is_settled(&self) -> bool {
        self.status == CampaignStatus::Settled as u8
    }

    pub fn contributions(&self) -> &[[u8; 32]] {
        &self.registry[..usize::from(self.count).min(MAX_CONTRIBUTIONS)]
    }

    pub fn is_refunded(&self, index: usize) -> bool {
        self.refunded & (1 << index) != 0
    }
}
