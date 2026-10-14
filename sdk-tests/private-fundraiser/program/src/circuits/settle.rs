use zolana_keypair::ShieldedAddress;
use zolana_program::{
    circuit::{
        Assert, Asset, CheckedTransaction, Circuit, CircuitVar, ConfidentialTransaction, DataUtxo,
        Owner, PublicInputs, TokenUtxos, TxContext as TxContextCircuit, Utxo, UtxoTrait, U64,
    },
    conversion::ProofInput,
    CircuitError, TxContext,
};
use zolana_transaction::WalletUtxo;

use super::{ContributionTerms, ContributionTermsCircuit};

/// One settle circuit per contribution count: the DSL does not spend a dummy
/// as a data UTXO, so a campaign with `n` contributions settles with
/// `Settle<n>`. All four share [`settle`].
///
/// The SPP shape for `n` inputs has more output slots than the one payout.
/// The SDK would fill them with empty outputs, which it publishes with a zero
/// owner tag that the default-ring SPP circuit refuses. So the circuit fills
/// them itself with zero-amount outputs to the beneficiary, ahead of the
/// payout: shapes 1x1, 2x2, 3x3 and 4x3.
pub const fn settle_zero_outputs(contributions: usize) -> usize {
    match contributions {
        0 | 1 => 0,
        2 => 1,
        _ => 2,
    }
}
struct SettleRules<'a, P, const N: usize> {
    tx_context: &'a TxContextCircuit,
    contributions: &'a [Utxo; N],
    terms: &'a [ContributionTermsCircuit; N],
    public: &'a P,
    campaign_authority: &'a Owner,
    campaign_id: &'a CircuitVar,
    beneficiary: &'a Owner,
    target: &'a U64,
    registry: [&'a CircuitVar; N],
}

fn settle<P: PublicInputs, const N: usize>(
    rules: SettleRules<'_, P, N>,
) -> Result<CheckedTransaction, CircuitError> {
    let beneficiary_hash = rules.beneficiary.hash()?;
    let mut payout = TokenUtxos::new_init(rules.beneficiary, &Asset::sol());
    let mut transaction = ConfidentialTransaction::new(rules.tx_context, rules.public);
    for ((input, terms), registered) in rules
        .contributions
        .iter()
        .zip(rules.terms)
        .zip(rules.registry)
    {
        input
            .hash()?
            .assert_equal(registered, "a spent contribution is not the registered one")?;
        let mut contribution = DataUtxo::new_close(input, terms)?;
        contribution.owner().assert_equal(
            rules.campaign_authority,
            "a contribution is not owned by the campaign authority",
        )?;
        contribution
            .asset()
            .assert_equal(&Asset::sol(), "a contribution is not SOL")?;
        contribution.campaign_id.assert_equal(
            rules.campaign_id,
            "a contribution belongs to another campaign",
        )?;
        contribution.beneficiary.assert_equal(
            &beneficiary_hash,
            "a contribution names another beneficiary",
        )?;
        contribution.transfer_all(&mut payout)?;
        transaction = transaction.with_data_utxo(contribution);
    }
    rules.target.assert_less_or_equal(
        &payout.amount()?,
        "the contributions do not reach the target",
    )?;
    for _ in 0..settle_zero_outputs(N) {
        transaction =
            transaction.with_token_utxos(TokenUtxos::new_init(rules.beneficiary, &Asset::sol()));
    }
    transaction.with_token_utxos(payout).check()
}

#[derive(Clone, ProofInput)]
pub struct Settle1 {
    pub private: Settle1PrivateInputs,
    pub public: Settle1PublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct Settle1PrivateInputs {
    pub tx_context: TxContext,
    pub contributions: [WalletUtxo; 1],
    pub terms: [ContributionTerms; 1],
}

#[derive(Clone, PublicInputs)]
pub struct Settle1PublicInputs {
    pub campaign_authority: ShieldedAddress,
    pub campaign_id: [u8; 32],
    pub beneficiary: ShieldedAddress,
    pub target: u64,
    pub contribution_0: [u8; 32],
}

impl Circuit for Settle1Circuit {
    fn circuit(&self) -> Result<CheckedTransaction, CircuitError> {
        let public = &self.public;
        settle(SettleRules {
            tx_context: &self.private.tx_context,
            contributions: &self.private.contributions,
            terms: &self.private.terms,
            public,
            campaign_authority: &public.campaign_authority,
            campaign_id: &public.campaign_id,
            beneficiary: &public.beneficiary,
            target: &public.target,
            registry: [&public.contribution_0],
        })
    }
}

#[derive(Clone, ProofInput)]
pub struct Settle2 {
    pub private: Settle2PrivateInputs,
    pub public: Settle2PublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct Settle2PrivateInputs {
    pub tx_context: TxContext,
    pub contributions: [WalletUtxo; 2],
    pub terms: [ContributionTerms; 2],
}

#[derive(Clone, PublicInputs)]
pub struct Settle2PublicInputs {
    pub campaign_authority: ShieldedAddress,
    pub campaign_id: [u8; 32],
    pub beneficiary: ShieldedAddress,
    pub target: u64,
    pub contribution_0: [u8; 32],
    pub contribution_1: [u8; 32],
}

impl Circuit for Settle2Circuit {
    fn circuit(&self) -> Result<CheckedTransaction, CircuitError> {
        let public = &self.public;
        settle(SettleRules {
            tx_context: &self.private.tx_context,
            contributions: &self.private.contributions,
            terms: &self.private.terms,
            public,
            campaign_authority: &public.campaign_authority,
            campaign_id: &public.campaign_id,
            beneficiary: &public.beneficiary,
            target: &public.target,
            registry: [&public.contribution_0, &public.contribution_1],
        })
    }
}

#[derive(Clone, ProofInput)]
pub struct Settle3 {
    pub private: Settle3PrivateInputs,
    pub public: Settle3PublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct Settle3PrivateInputs {
    pub tx_context: TxContext,
    pub contributions: [WalletUtxo; 3],
    pub terms: [ContributionTerms; 3],
}

#[derive(Clone, PublicInputs)]
pub struct Settle3PublicInputs {
    pub campaign_authority: ShieldedAddress,
    pub campaign_id: [u8; 32],
    pub beneficiary: ShieldedAddress,
    pub target: u64,
    pub contribution_0: [u8; 32],
    pub contribution_1: [u8; 32],
    pub contribution_2: [u8; 32],
}

impl Circuit for Settle3Circuit {
    fn circuit(&self) -> Result<CheckedTransaction, CircuitError> {
        let public = &self.public;
        settle(SettleRules {
            tx_context: &self.private.tx_context,
            contributions: &self.private.contributions,
            terms: &self.private.terms,
            public,
            campaign_authority: &public.campaign_authority,
            campaign_id: &public.campaign_id,
            beneficiary: &public.beneficiary,
            target: &public.target,
            registry: [
                &public.contribution_0,
                &public.contribution_1,
                &public.contribution_2,
            ],
        })
    }
}

#[derive(Clone, ProofInput)]
pub struct Settle4 {
    pub private: Settle4PrivateInputs,
    pub public: Settle4PublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct Settle4PrivateInputs {
    pub tx_context: TxContext,
    pub contributions: [WalletUtxo; 4],
    pub terms: [ContributionTerms; 4],
}

#[derive(Clone, PublicInputs)]
pub struct Settle4PublicInputs {
    pub campaign_authority: ShieldedAddress,
    pub campaign_id: [u8; 32],
    pub beneficiary: ShieldedAddress,
    pub target: u64,
    pub contribution_0: [u8; 32],
    pub contribution_1: [u8; 32],
    pub contribution_2: [u8; 32],
    pub contribution_3: [u8; 32],
}

impl Circuit for Settle4Circuit {
    fn circuit(&self) -> Result<CheckedTransaction, CircuitError> {
        let public = &self.public;
        settle(SettleRules {
            tx_context: &self.private.tx_context,
            contributions: &self.private.contributions,
            terms: &self.private.terms,
            public,
            campaign_authority: &public.campaign_authority,
            campaign_id: &public.campaign_id,
            beneficiary: &public.beneficiary,
            target: &public.target,
            registry: [
                &public.contribution_0,
                &public.contribution_1,
                &public.contribution_2,
                &public.contribution_3,
            ],
        })
    }
}
