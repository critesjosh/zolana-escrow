use light_program_profiler::profile;
use pinocchio::{AccountView, ProgramResult};
use zolana_account_checks::AccountIterator;
use zolana_program::CompressedProof;

use crate::{
    error::FundraiserError,
    instructions::shared::{load_campaign, now, store_campaign, CampaignAuthority, IxData},
    state::CampaignStatus,
    zk::{settle1, settle2, settle3, settle4, Groth16Proof},
};

/// Verifies that the proof spends exactly the registered contributions, that
/// they reach the target and that everything goes to the beneficiary; marks the
/// campaign settled and CPIs SPP. Anyone may send it; only a party holding every
/// contribution preimage (the coordinator) can prove it.
#[inline(never)]
#[profile]
pub fn process_settle_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut iter = AccountIterator::new(accounts);
    let campaign_account = iter.next_mut("campaign")?;
    let campaign_address = *campaign_account.address();
    let mut campaign = load_campaign(campaign_account)?;

    let now = now()?;
    if now < campaign.close_ts() {
        return Err(FundraiserError::SettlementNotOpen.into());
    }
    if now >= campaign.settle_deadline() {
        return Err(FundraiserError::SettlementDeadlinePassed.into());
    }
    if campaign.is_settled() {
        return Err(FundraiserError::CampaignSettled.into());
    }

    let ix = IxData::<CompressedProof>::parse(data)?;
    let authority = CampaignAuthority::from_bump(&campaign_address, campaign.authority_bump)?;
    let proof = &ix.args;
    let groth16 = Groth16Proof {
        a: &proof.a,
        b: &proof.b,
        c: &proof.c,
    };
    let campaign_authority = authority.owner_hash()?;
    let campaign_id = campaign.campaign_id;
    let beneficiary = campaign.beneficiary_owner_hash;
    let target = campaign.target();
    let private_tx_hash = ix.private_tx_hash();
    let verified = match *campaign.contributions() {
        [] => return Err(FundraiserError::NoContributions.into()),
        [contribution_0] => settle1::verify(
            &groth16,
            &settle1::PublicInputs {
                campaign_authority,
                campaign_id,
                beneficiary,
                target,
                contribution_0,
            },
            private_tx_hash,
        ),
        [contribution_0, contribution_1] => settle2::verify(
            &groth16,
            &settle2::PublicInputs {
                campaign_authority,
                campaign_id,
                beneficiary,
                target,
                contribution_0,
                contribution_1,
            },
            private_tx_hash,
        ),
        [contribution_0, contribution_1, contribution_2] => settle3::verify(
            &groth16,
            &settle3::PublicInputs {
                campaign_authority,
                campaign_id,
                beneficiary,
                target,
                contribution_0,
                contribution_1,
                contribution_2,
            },
            private_tx_hash,
        ),
        [contribution_0, contribution_1, contribution_2, contribution_3] => settle4::verify(
            &groth16,
            &settle4::PublicInputs {
                campaign_authority,
                campaign_id,
                beneficiary,
                target,
                contribution_0,
                contribution_1,
                contribution_2,
                contribution_3,
            },
            private_tx_hash,
        ),
        _ => return Err(FundraiserError::InvalidCampaign.into()),
    };
    verified.map_err(FundraiserError::from)?;

    campaign.status = CampaignStatus::Settled as u8;
    store_campaign(campaign_account, &campaign)?;

    let spp_accounts = iter.remaining()?;
    authority.invoke_transact(spp_accounts, ix.transact_bytes)
}
