use zolana_program::{
    circuit::{
        Assert, CheckedTransaction, Circuit, ConfidentialTransaction, DataUtxo, PublicInputs,
        TokenUtxos, UtxoTrait,
    },
    conversion::ProofInput,
    CircuitError, TxContext,
};
use zolana_transaction::WalletUtxo;

use super::ContributionTerms;

#[derive(Clone, ProofInput)]
pub struct Refund {
    pub private: RefundPrivateInputs,
    pub public: RefundPublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct RefundPrivateInputs {
    pub tx_context: TxContext,
    pub contribution: WalletUtxo,
    pub terms: ContributionTerms,
}

#[derive(Clone, PublicInputs)]
pub struct RefundPublicInputs {
    pub campaign_id: [u8; 32],
    pub contributor_identity: [u8; 32],
    /// The registry entry the program reads: the spent contribution's hash.
    pub contribution: [u8; 32],
}

impl Circuit for RefundCircuit {
    fn circuit(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;
        private.contribution.hash()?.assert_equal(
            &public.contribution,
            "the spent contribution is not the registered one",
        )?;
        let mut contribution = DataUtxo::new_close(&private.contribution, &private.terms)?;
        contribution
            .amount()?
            .assert_not_zero("the contribution holds nothing")?;
        contribution.campaign_id.assert_equal(
            &public.campaign_id,
            "the contribution belongs to another campaign",
        )?;
        contribution.contributor.key().identity()?.assert_equal(
            &public.contributor_identity,
            "the signer is not the contributor",
        )?;
        let mut payout = TokenUtxos::new_init(&contribution.contributor, &contribution.asset());
        contribution.transfer_all(&mut payout)?;

        ConfidentialTransaction::new(&private.tx_context, public)
            .with_data_utxo(contribution)
            .with_token_utxos(payout)
            .check()
    }
}
