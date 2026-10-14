use solana_program_error::ProgramError;
use thiserror::Error;
use zolana_hasher::HasherError;

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[repr(u32)]
pub enum FundraiserError {
    #[error("proof verification failed")]
    ProofVerificationFailed = 9100,
    #[error("instruction data is invalid")]
    InvalidInstructionData = 9101,
    #[error("shielded-pool program account is invalid")]
    InvalidShieldedPoolProgram = 9102,
    #[error("campaign-authority account is missing from the transact account list")]
    MissingCampaignAuthority = 9103,
    #[error("hashing failed")]
    HashingFailed = 9104,
    #[error("campaign account is not a campaign of this program")]
    InvalidCampaign = 9105,
    #[error("campaign address is not the PDA of its coordinator and seed")]
    InvalidCampaignAddress = 9106,
    #[error(
        "campaign terms are invalid: need a nonzero target and now < close < settlement deadline"
    )]
    InvalidCampaignTerms = 9107,
    #[error("the coordinator signer is not the campaign's coordinator")]
    WrongCoordinator = 9108,
    #[error("contributions are closed")]
    ContributionsClosed = 9109,
    #[error("the campaign holds the maximum number of contributions")]
    CampaignFull = 9110,
    #[error("the transact has no contribution output")]
    MissingContributionOutput = 9111,
    #[error("settlement opens when contributions close")]
    SettlementNotOpen = 9112,
    #[error("the settlement deadline has passed")]
    SettlementDeadlinePassed = 9113,
    #[error("the campaign has already settled")]
    CampaignSettled = 9114,
    #[error("the campaign has no contributions")]
    NoContributions = 9115,
    #[error("refunds open at the settlement deadline")]
    RefundNotOpen = 9116,
    #[error("no registered contribution at this index")]
    UnknownContribution = 9117,
    #[error("the contribution has already been refunded")]
    AlreadyRefunded = 9118,
}

impl From<FundraiserError> for ProgramError {
    fn from(error: FundraiserError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

impl From<crate::zk::VerifyError> for FundraiserError {
    fn from(error: crate::zk::VerifyError) -> Self {
        match error {
            crate::zk::VerifyError::PublicInputs => Self::HashingFailed,
            crate::zk::VerifyError::MissingVerifyingKey | crate::zk::VerifyError::Proof => {
                Self::ProofVerificationFailed
            }
        }
    }
}

impl From<HasherError> for FundraiserError {
    fn from(_: HasherError) -> Self {
        Self::HashingFailed
    }
}
