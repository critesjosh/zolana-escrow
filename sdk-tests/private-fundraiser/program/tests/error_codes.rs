use private_fundraiser_program::error::FundraiserError::*;

#[test]
fn error_codes_are_stable() {
    let table = [
        (ProofVerificationFailed as u32, 9100),
        (InvalidInstructionData as u32, 9101),
        (InvalidShieldedPoolProgram as u32, 9102),
        (MissingCampaignAuthority as u32, 9103),
        (HashingFailed as u32, 9104),
        (InvalidCampaign as u32, 9105),
        (InvalidCampaignAddress as u32, 9106),
        (InvalidCampaignTerms as u32, 9107),
        (WrongCoordinator as u32, 9108),
        (ContributionsClosed as u32, 9109),
        (CampaignFull as u32, 9110),
        (MissingContributionOutput as u32, 9111),
        (SettlementNotOpen as u32, 9112),
        (SettlementDeadlinePassed as u32, 9113),
        (CampaignSettled as u32, 9114),
        (NoContributions as u32, 9115),
        (RefundNotOpen as u32, 9116),
        (UnknownContribution as u32, 9117),
        (AlreadyRefunded as u32, 9118),
    ];
    for (got, want) in table {
        assert_eq!(got, want, "error code drifted");
    }
}
