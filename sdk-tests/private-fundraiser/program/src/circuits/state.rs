use borsh::{BorshDeserialize, BorshSerialize};
use zolana_program::{circuit::CircuitType, Owner};

/// The state a contribution UTXO commits through its data hash. Its asset and
/// amount are the UTXO's own fields, and its owner is the campaign authority.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, CircuitType)]
pub struct ContributionTerms {
    /// `solana_owner_identity(campaign address)`.
    pub campaign_id: [u8; 32],
    /// Refund owner: the owner of the tokens the contribution spent.
    pub contributor: Owner,
    /// The beneficiary's owner hash, which settlement pays.
    pub beneficiary: [u8; 32],
}
