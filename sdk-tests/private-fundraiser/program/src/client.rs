use pinocchio::Address;
use solana_instruction::{AccountMeta, Instruction};
use zolana_interface::instruction::instruction_data::transact::TransactIxData;
use zolana_keypair::ShieldedAddress;
use zolana_program::{instruction::Transact, CompressedProof};

use crate::{
    circuits::{campaign_address, campaign_authority},
    instructions::{create::CreateArgs, refund::RefundArgs},
    state::Campaign,
    tag, ID,
};

pub struct CreateInstruction {
    pub coordinator: Address,
    pub campaign_seed: u64,
    pub target: u64,
    pub close_ts: i64,
    pub settle_deadline: i64,
    pub beneficiary: ShieldedAddress,
}

impl CreateInstruction {
    pub fn instruction(&self) -> Result<Instruction, CampaignClientError> {
        let args = CreateArgs {
            campaign_seed: self.campaign_seed,
            target: self.target,
            close_ts: self.close_ts,
            settle_deadline: self.settle_deadline,
            beneficiary_owner_hash: self.beneficiary.owner_hash()?,
            beneficiary_address: self.beneficiary.to_bytes(),
        };
        let mut data = vec![tag::CREATE];
        data.extend(wincode::serialize(&args)?);
        Ok(Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(self.coordinator, true),
                AccountMeta::new(
                    campaign_address(&self.coordinator, self.campaign_seed),
                    false,
                ),
                AccountMeta::new_readonly(Address::default(), false),
            ],
            data,
        })
    }
}

pub struct ContributeInstruction {
    pub contributor: Address,
    pub coordinator: Address,
    pub campaign: Address,
    pub tree: Address,
    pub proof: CompressedProof,
    pub transact: TransactIxData,
}

impl ContributeInstruction {
    pub fn instruction(self) -> Result<Instruction, CampaignClientError> {
        ProgramTransact {
            tag: tag::CONTRIBUTE,
            args: wincode::serialize(&self.proof)?,
            accounts: vec![
                AccountMeta::new_readonly(self.contributor, true),
                AccountMeta::new_readonly(self.coordinator, true),
                AccountMeta::new(self.campaign, false),
            ],
            payer: self.contributor,
            campaign: self.campaign,
            tree: self.tree,
        }
        .instruction(self.transact)
    }
}

pub struct SettleInstruction {
    pub payer: Address,
    pub campaign: Address,
    pub tree: Address,
    pub proof: CompressedProof,
    pub transact: TransactIxData,
}

impl SettleInstruction {
    pub fn instruction(self) -> Result<Instruction, CampaignClientError> {
        ProgramTransact {
            tag: tag::SETTLE,
            args: wincode::serialize(&self.proof)?,
            accounts: vec![AccountMeta::new(self.campaign, false)],
            payer: self.payer,
            campaign: self.campaign,
            tree: self.tree,
        }
        .instruction(self.transact)
    }
}

pub struct RefundInstruction {
    pub contributor: Address,
    pub campaign: Address,
    pub tree: Address,
    pub proof: CompressedProof,
    pub index: u8,
    pub transact: TransactIxData,
}

impl RefundInstruction {
    pub fn instruction(self) -> Result<Instruction, CampaignClientError> {
        ProgramTransact {
            tag: tag::REFUND,
            args: wincode::serialize(&RefundArgs {
                proof: self.proof,
                index: self.index,
            })?,
            accounts: vec![
                AccountMeta::new_readonly(self.contributor, true),
                AccountMeta::new(self.campaign, false),
            ],
            payer: self.contributor,
            campaign: self.campaign,
            tree: self.tree,
        }
        .instruction(self.transact)
    }
}

struct ProgramTransact {
    tag: u8,
    args: Vec<u8>,
    accounts: Vec<AccountMeta>,
    payer: Address,
    campaign: Address,
    tree: Address,
}

impl ProgramTransact {
    fn instruction(self, data: TransactIxData) -> Result<Instruction, CampaignClientError> {
        let Self {
            tag,
            args,
            mut accounts,
            payer,
            campaign,
            tree,
        } = self;
        let transact_data = data.serialize()?;
        let transact = Transact {
            payer,
            input_trees: vec![tree],
            output_tree: tree,
            owner_signers: Vec::new(),
            interface_transfer_accounts: Vec::new(),
            data,
        };
        accounts.extend(transact.cpi_accounts(&[*campaign_authority(&campaign).pda()]));
        let mut instruction_data = vec![tag];
        instruction_data.extend(args);
        instruction_data.extend(transact_data);
        Ok(Instruction {
            program_id: ID,
            accounts,
            data: instruction_data,
        })
    }
}

/// A campaign as clients read it: the account plus its decoded beneficiary,
/// checked against the owner hash the proofs bind.
pub struct CampaignView {
    pub address: Address,
    pub account: Campaign,
    pub beneficiary: ShieldedAddress,
}

impl CampaignView {
    pub fn decode(address: Address, data: &[u8]) -> Result<Self, CampaignClientError> {
        let account = *Campaign::from_bytes(data).map_err(CampaignClientError::Campaign)?;
        let beneficiary = ShieldedAddress::from_bytes(&account.beneficiary_address)?;
        if beneficiary.owner_hash()? != account.beneficiary_owner_hash {
            return Err(CampaignClientError::BeneficiaryMismatch);
        }
        Ok(Self {
            address,
            account,
            beneficiary,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CampaignClientError {
    #[error("encoding instruction data: {0}")]
    Encode(#[from] wincode::Error),
    #[error("encoding instruction data: {0}")]
    Write(#[from] wincode::WriteError),
    #[error("shielded address: {0}")]
    Keypair(#[from] zolana_keypair::KeypairError),
    #[error("campaign account: {0}")]
    Campaign(crate::error::FundraiserError),
    #[error("the campaign's beneficiary address does not match its owner hash")]
    BeneficiaryMismatch,
}
