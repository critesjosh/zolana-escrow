use zolana_keypair::ShieldedAddress;
use zolana_program::{
    circuit::{
        Assert, Asset, CheckedTransaction, Circuit, ConfidentialTransaction, DataUtxo,
        PublicInputs, TokenUtxos, UtxoTrait,
    },
    conversion::ProofInput,
    CircuitError, TxContext,
};
use zolana_transaction::WalletUtxo;

use super::ContributionTermsCircuit;

/// Two inputs keep the transaction at SPP shape 1x2 or 2x2, which its two
/// outputs fill. A wider shape needs padding outputs, which the SDK publishes
/// with a zero owner tag that SPP refuses. Merge more UTXOs first.
pub const CONTRIBUTE_TOKEN_INPUTS: usize = 2;

#[derive(Clone, ProofInput)]
pub struct Contribute {
    pub private: ContributePrivateInputs,
    pub public: ContributePublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct ContributePrivateInputs {
    pub tx_context: TxContext,
    #[max_len(CONTRIBUTE_TOKEN_INPUTS)]
    pub token_utxos: Vec<WalletUtxo>,
    pub amount: u64,
}

#[derive(Clone, PublicInputs)]
pub struct ContributePublicInputs {
    pub campaign_authority: ShieldedAddress,
    pub contributor_identity: [u8; 32],
    pub campaign_id: [u8; 32],
    pub beneficiary: [u8; 32],
}

impl Circuit for ContributeCircuit {
    fn circuit(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;
        private
            .amount
            .assert_not_zero("the contribution is empty")?;
        let mut tokens = TokenUtxos::new_mut(&private.token_utxos)?;
        tokens.owner().key().identity()?.assert_equal(
            &public.contributor_identity,
            "the signer does not own the contributed tokens",
        )?;
        tokens
            .asset()
            .assert_equal(&Asset::sol(), "the campaign raises SOL only")?;
        let mut contribution =
            DataUtxo::<ContributionTermsCircuit>::new_init(&public.campaign_authority)
                .with_asset(&tokens.asset())?;
        tokens.transfer(&mut contribution, &private.amount)?;
        contribution.campaign_id = public.campaign_id.clone();
        contribution.contributor = tokens.owner();
        contribution.beneficiary = public.beneficiary.clone();

        ConfidentialTransaction::new(&private.tx_context, public)
            .with_token_utxos(tokens)
            .with_data_utxo(contribution)
            .check()
    }
}
