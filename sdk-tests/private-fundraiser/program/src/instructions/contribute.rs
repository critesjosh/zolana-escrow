use light_program_profiler::profile;
use pinocchio::{address::address_eq, AccountView, Address, ProgramResult};
use zolana_account_checks::AccountIterator;
use zolana_hasher::primitives::solana_owner_identity;
use zolana_program::CompressedProof;

use crate::{
    error::FundraiserError,
    instructions::shared::{load_campaign, now, store_campaign, CampaignAuthority, IxData},
    zk::{contribute, Groth16Proof},
    MAX_CONTRIBUTIONS,
};

pub mod slot {
    pub const SOURCE: usize = 0;
    pub const CHANGE: usize = 0;
    /// The contribution follows the change, as the escrow UTXO does in the
    /// timelock escrow. SPP keeps a real output's slot and derived blinding
    /// whatever the shape, so the hash at this slot is the contribution's.
    pub const CONTRIBUTION: usize = 1;
}

/// Verifies the contribute proof, registers the contribution's output UTXO
/// hash in the campaign and CPIs SPP to create it. The coordinator co-signs
/// after checking the contribution preimage it was sent against that hash.
#[inline(never)]
#[profile]
pub fn process_contribute_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut iter = AccountIterator::new(accounts);
    let contributor = *iter.next_signer("contributor")?.address();
    let coordinator = *iter.next_signer("coordinator")?.address();
    let campaign_account = iter.next_mut("campaign")?;
    let campaign_address = *campaign_account.address();
    let mut campaign = load_campaign(campaign_account)?;

    if !address_eq(&coordinator, &Address::new_from_array(campaign.coordinator)) {
        return Err(FundraiserError::WrongCoordinator.into());
    }
    if now()? >= campaign.close_ts() {
        return Err(FundraiserError::ContributionsClosed.into());
    }
    if campaign.is_settled() {
        return Err(FundraiserError::CampaignSettled.into());
    }
    let index = usize::from(campaign.count);
    if index >= MAX_CONTRIBUTIONS {
        return Err(FundraiserError::CampaignFull.into());
    }

    let ix = IxData::<CompressedProof>::parse(data)?;
    let contribution_hash = *ix
        .transact
        .outputs
        .get(slot::CONTRIBUTION)
        .ok_or(FundraiserError::MissingContributionOutput)?
        .utxo_hash;
    let authority = CampaignAuthority::from_bump(&campaign_address, campaign.authority_bump)?;
    let proof = &ix.args;
    contribute::verify(
        &Groth16Proof {
            a: &proof.a,
            b: &proof.b,
            c: &proof.c,
        },
        &contribute::PublicInputs {
            campaign_authority: authority.owner_hash()?,
            contributor_identity: solana_owner_identity(contributor.as_array())
                .map_err(FundraiserError::from)?,
            campaign_id: campaign.campaign_id,
            beneficiary: campaign.beneficiary_owner_hash,
        },
        ix.private_tx_hash(),
    )
    .map_err(FundraiserError::from)?;

    campaign.registry[index] = contribution_hash;
    campaign.count += 1;
    store_campaign(campaign_account, &campaign)?;

    let spp_accounts = iter.remaining()?;
    authority.invoke_transact(spp_accounts, ix.transact_bytes)
}
