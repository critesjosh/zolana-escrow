use light_program_profiler::profile;
use pinocchio::{AccountView, ProgramResult};
use wincode::{SchemaRead, SchemaWrite};
use zolana_account_checks::AccountIterator;
use zolana_hasher::primitives::solana_owner_identity;
use zolana_program::CompressedProof;

use crate::{
    error::FundraiserError,
    instructions::shared::{load_campaign, now, store_campaign, CampaignAuthority, IxData},
    zk::{refund, Groth16Proof},
};

pub mod slot {
    pub const CONTRIBUTION: usize = 0;
    pub const REFUND_OUTPUT: usize = 0;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct RefundArgs {
    pub proof: CompressedProof,
    /// The contribution's position in the campaign registry.
    pub index: u8,
}

/// From the settlement deadline on, if the campaign did not settle, returns one
/// registered contribution to its committed contributor, who signs. Needs no
/// coordinator.
#[inline(never)]
#[profile]
pub fn process_refund_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut iter = AccountIterator::new(accounts);
    let contributor = *iter.next_signer("contributor")?.address();
    let campaign_account = iter.next_mut("campaign")?;
    let campaign_address = *campaign_account.address();
    let mut campaign = load_campaign(campaign_account)?;

    if now()? < campaign.settle_deadline() {
        return Err(FundraiserError::RefundNotOpen.into());
    }
    if campaign.is_settled() {
        return Err(FundraiserError::CampaignSettled.into());
    }

    let ix = IxData::<RefundArgs>::parse(data)?;
    let index = usize::from(ix.args.index);
    let contribution = *campaign
        .contributions()
        .get(index)
        .ok_or(FundraiserError::UnknownContribution)?;
    if campaign.is_refunded(index) {
        return Err(FundraiserError::AlreadyRefunded.into());
    }

    let proof = &ix.args.proof;
    refund::verify(
        &Groth16Proof {
            a: &proof.a,
            b: &proof.b,
            c: &proof.c,
        },
        &refund::PublicInputs {
            campaign_id: campaign.campaign_id,
            contributor_identity: solana_owner_identity(contributor.as_array())
                .map_err(FundraiserError::from)?,
            contribution,
        },
        ix.private_tx_hash(),
    )
    .map_err(FundraiserError::from)?;

    campaign.refunded |= 1 << index;
    store_campaign(campaign_account, &campaign)?;

    let spp_accounts = iter.remaining()?;
    CampaignAuthority::from_bump(&campaign_address, campaign.authority_bump)?
        .invoke_transact(spp_accounts, ix.transact_bytes)
}
