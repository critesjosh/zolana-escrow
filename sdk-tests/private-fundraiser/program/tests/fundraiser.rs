//! Proof-carrying lifecycle of the private fundraiser on a localnet: SPP, the
//! fundraiser program, Photon and the prover. Time windows are real seconds on
//! the validator clock, so each test waits for its deadlines.

mod localnet;

use anyhow::{anyhow, ensure, Result};
use borsh::BorshDeserialize;
use localnet::{
    assert_error, assert_fails, campaign, chain_now, resend, send, setup, sol_balance,
    transactions_by_tags, wait_until, TestEnv, DEPOSIT,
};
use private_fundraiser_program::{
    circuits::{
        campaign_address, campaign_authority, Contribute, ContributePrivateInputs,
        ContributePublicInputs, ContributionTerms, Refund, RefundPrivateInputs, RefundPublicInputs,
        Settle1, Settle1PrivateInputs, Settle1PublicInputs, Settle2, Settle2PrivateInputs,
        Settle2PublicInputs, Settle3, Settle3PrivateInputs, Settle3PublicInputs, Settle4,
        Settle4PrivateInputs, Settle4PublicInputs, CONTRIBUTE_TOKEN_INPUTS,
    },
    client::{ContributeInstruction, CreateInstruction, RefundInstruction, SettleInstruction},
    error::FundraiserError,
    instructions::contribute::slot,
    state::CampaignStatus,
};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_signer::Signer;
use zolana_hasher::primitives::solana_owner_identity;
use zolana_interface::instruction::instruction_data::transact::TransactIxData;
use zolana_keypair::ShieldedKeypair;
use zolana_program::{
    CompressedProof, DataUtxo, Groth16Prover, ProgramOwner, TxContext, ZkProgram,
};
use zolana_program_test::localnet::FixtureLocalnet;
use zolana_transaction::{AssetRegistry, SppProofOutputUtxo, WalletUtxo};

/// Seconds from creation to the contribution close, and from the close to the
/// settlement deadline. Long enough for the proofs each window holds.
const CONTRIBUTION_WINDOW: i64 = 75;
const SETTLEMENT_WINDOW: i64 = 45;

struct CampaignHandle {
    address: Address,
    authority: ProgramOwner,
    campaign_id: [u8; 32],
    target: u64,
    close_ts: i64,
    settle_deadline: i64,
}

fn create_campaign(env: &TestEnv, seed: u64, target: u64) -> Result<CampaignHandle> {
    let coordinator = env.coordinator.pubkey();
    let now = chain_now(&env.localnet)?;
    let close_ts = now + CONTRIBUTION_WINDOW;
    let settle_deadline = close_ts + SETTLEMENT_WINDOW;
    let instruction = CreateInstruction {
        coordinator,
        campaign_seed: seed,
        target,
        close_ts,
        settle_deadline,
        beneficiary: env.beneficiary.shielded_address()?,
    }
    .instruction()?;
    send(&env.localnet, &[&env.coordinator], instruction)?;
    let address = campaign_address(&coordinator, seed);
    let view = campaign(&env.localnet, address)?;
    ensure!(view.account.target() == target && view.account.count == 0);
    Ok(CampaignHandle {
        address,
        authority: campaign_authority(&address),
        campaign_id: solana_owner_identity(address.as_array())?,
        target,
        close_ts,
        settle_deadline,
    })
}

fn campaign_state(
    env: &TestEnv,
    campaign: &CampaignHandle,
) -> Result<private_fundraiser_program::state::Campaign> {
    Ok(localnet::campaign(&env.localnet, campaign.address)?.account)
}

/// A contribution the contributor proved, waiting for the coordinator's
/// co-signature, with the preimage it sends the coordinator.
#[derive(Clone)]
struct Pending {
    contributor: Address,
    proof: CompressedProof,
    transact: TransactIxData,
    preimage: SppProofOutputUtxo,
}

impl Pending {
    fn instruction(
        &self,
        env: &TestEnv,
        campaign: &CampaignHandle,
        coordinator: Address,
    ) -> Result<Instruction> {
        Ok(ContributeInstruction {
            contributor: self.contributor,
            coordinator,
            campaign: campaign.address,
            tree: env.localnet.tree,
            proof: self.proof,
            transact: self.transact.clone(),
        }
        .instruction()?)
    }
}

fn prepare_contribution(
    env: &TestEnv,
    campaign: &CampaignHandle,
    contributor: &ShieldedKeypair,
    amount: u64,
    slot: u64,
) -> Result<Pending> {
    let address = contributor.shielded_address()?;
    let payer = contributor.pubkey();
    let (_, mut utxos) = sol_balance(&env.localnet, contributor, slot)?;
    utxos.truncate(CONTRIBUTE_TOKEN_INPUTS);
    let beneficiary = env.beneficiary.shielded_address()?;
    let inputs = Contribute {
        private: ContributePrivateInputs {
            tx_context: TxContext::new().with_output_tree_id(Some(env.localnet.tree_id)),
            token_utxos: utxos,
            amount,
        },
        public: ContributePublicInputs {
            campaign_authority: campaign.authority.address(address.viewing_pubkey)?,
            contributor_identity: solana_owner_identity(payer.as_array())?,
            campaign_id: campaign.campaign_id,
            beneficiary: beneficiary.owner_hash()?,
        },
    };
    let transaction = inputs.create_program_transaction(&address, payer)?;
    let proof = Groth16Prover::<Contribute>::new_with_test_setup()?
        .prove_inputs(&transaction.proof_inputs)?
        .compressed()?;
    let spp = transaction.finalized.encrypt_with_keys(contributor)?;
    let preimage = spp
        .output_utxos
        .get(slot::CONTRIBUTION)
        .cloned()
        .ok_or_else(|| anyhow!("no contribution output"))?;
    let transact = env.localnet.client.prove_transact(spp, None, contributor)?;
    Ok(Pending {
        contributor: payer,
        proof,
        transact,
        preimage,
    })
}

/// What the coordinator keeps per accepted contribution. In the prototype
/// this is the coordinator's only private state; losing it means the campaign
/// cannot settle and contributors refund.
struct Coordinator<'a> {
    keys: &'a ShieldedKeypair,
    store: Vec<(SppProofOutputUtxo, [u8; 32])>,
}

impl Coordinator<'_> {
    /// Checks the preimage the contributor sent against the exact transaction
    /// it will co-sign, stores it and returns the signed contribution.
    fn cosign(
        &mut self,
        env: &TestEnv,
        campaign: &CampaignHandle,
        pending: &Pending,
    ) -> Result<Instruction> {
        let registered = pending
            .transact
            .outputs
            .get(slot::CONTRIBUTION)
            .ok_or_else(|| anyhow!("the transact has no contribution output"))?
            .utxo_hash;
        let utxo = campaign
            .authority
            .input(&pending.preimage, env.localnet.tree_id, 0)?;
        ensure!(
            utxo.utxo_hash == registered,
            "the preimage does not open the contribution output"
        );
        let terms = ContributionTerms::try_from_slice(
            pending
                .preimage
                .data
                .utxo_data()
                .ok_or_else(|| anyhow!("the contribution carries no terms"))?,
        )?;
        ensure!(
            terms.campaign_id == campaign.campaign_id,
            "terms name another campaign"
        );
        self.store.push((pending.preimage.clone(), registered));
        pending.instruction(env, campaign, self.keys.pubkey())
    }

    /// Rebuilds spendable contributions in registry order: preimages from the
    /// store, leaf indices from the indexer under the campaign authority tag.
    fn accepted(
        &self,
        env: &TestEnv,
        campaign: &CampaignHandle,
        slot: u64,
    ) -> Result<Vec<(WalletUtxo, ContributionTerms)>> {
        let registry = localnet::campaign(&env.localnet, campaign.address)?;
        let transactions =
            transactions_by_tags(&env.localnet, vec![campaign.authority.owner_tag()], slot)?;
        registry
            .account
            .contributions()
            .iter()
            .map(|hash| {
                let (preimage, _) = self
                    .store
                    .iter()
                    .find(|(_, registered)| registered == hash)
                    .ok_or_else(|| anyhow!("no stored preimage for a registered contribution"))?;
                let context = transactions
                    .iter()
                    .flat_map(|tx| &tx.output_slots)
                    .map(|slot| &slot.output_context)
                    .find(|context| &context.hash == hash)
                    .ok_or_else(|| anyhow!("the indexer has no registered contribution"))?;
                let utxo =
                    campaign
                        .authority
                        .input(preimage, context.tree_id, context.leaf_index)?;
                let terms = ContributionTerms::try_from_slice(
                    preimage
                        .data
                        .utxo_data()
                        .ok_or_else(|| anyhow!("no terms"))?,
                )?;
                Ok((utxo, terms))
            })
            .collect()
    }

    fn settle(&self, env: &TestEnv, campaign: &CampaignHandle, slot: u64) -> Result<Instruction> {
        let accepted = self.accepted(env, campaign, slot)?;
        let campaign_authority = campaign.authority.address(self.keys.viewing_pubkey())?;
        let beneficiary = env.beneficiary.shielded_address()?;
        let tx_context = TxContext::new().with_output_tree_id(Some(env.localnet.tree_id));
        let utxo = |i: usize| accepted[i].0.clone();
        let terms = |i: usize| accepted[i].1.clone();
        let hash = |i: usize| accepted[i].0.utxo_hash;
        let (proof, transact) = match accepted.len() {
            1 => self.prove(
                env,
                Settle1 {
                    private: Settle1PrivateInputs {
                        tx_context,
                        contributions: [utxo(0)],
                        terms: [terms(0)],
                    },
                    public: Settle1PublicInputs {
                        campaign_authority,
                        campaign_id: campaign.campaign_id,
                        beneficiary,
                        target: campaign.target,
                        contribution_0: hash(0),
                    },
                },
            )?,
            2 => self.prove(
                env,
                Settle2 {
                    private: Settle2PrivateInputs {
                        tx_context,
                        contributions: [utxo(0), utxo(1)],
                        terms: [terms(0), terms(1)],
                    },
                    public: Settle2PublicInputs {
                        campaign_authority,
                        campaign_id: campaign.campaign_id,
                        beneficiary,
                        target: campaign.target,
                        contribution_0: hash(0),
                        contribution_1: hash(1),
                    },
                },
            )?,
            3 => self.prove(
                env,
                Settle3 {
                    private: Settle3PrivateInputs {
                        tx_context,
                        contributions: [utxo(0), utxo(1), utxo(2)],
                        terms: [terms(0), terms(1), terms(2)],
                    },
                    public: Settle3PublicInputs {
                        campaign_authority,
                        campaign_id: campaign.campaign_id,
                        beneficiary,
                        target: campaign.target,
                        contribution_0: hash(0),
                        contribution_1: hash(1),
                        contribution_2: hash(2),
                    },
                },
            )?,
            4 => self.prove(
                env,
                Settle4 {
                    private: Settle4PrivateInputs {
                        tx_context,
                        contributions: [utxo(0), utxo(1), utxo(2), utxo(3)],
                        terms: [terms(0), terms(1), terms(2), terms(3)],
                    },
                    public: Settle4PublicInputs {
                        campaign_authority,
                        campaign_id: campaign.campaign_id,
                        beneficiary,
                        target: campaign.target,
                        contribution_0: hash(0),
                        contribution_1: hash(1),
                        contribution_2: hash(2),
                        contribution_3: hash(3),
                    },
                },
            )?,
            count => return Err(anyhow!("cannot settle {count} contributions")),
        };
        Ok(SettleInstruction {
            payer: self.keys.pubkey(),
            campaign: campaign.address,
            tree: env.localnet.tree,
            proof,
            transact,
        }
        .instruction()?)
    }

    fn prove<P: ZkProgram>(
        &self,
        env: &TestEnv,
        inputs: P,
    ) -> Result<(CompressedProof, TransactIxData)> {
        let sender = self.keys.shielded_address()?;
        let transaction = inputs.create_program_transaction(&sender, self.keys.pubkey())?;
        let proof = Groth16Prover::<P>::new_with_test_setup()?
            .prove_inputs(&transaction.proof_inputs)?
            .compressed()?;
        let spp = transaction.finalized.encrypt_with_keys(self.keys)?;
        let transact =
            env.localnet
                .client
                .prove_transact(spp, None, &ProgramOwner::nullifier_key())?;
        Ok((proof, transact))
    }
}

/// A contributor's open contributions to the campaign, recovered from the
/// chain with nothing but its keys: the campaign authority and its own view
/// tag, decrypted with its viewing key, then filtered by the campaign's public
/// state. A settlement spends every contribution under tags the contributor
/// does not query, so the campaign status, not a nullifier, says it is gone.
/// Needs neither the coordinator nor local state.
fn own_contributions(
    localnet: &FixtureLocalnet,
    campaign: &CampaignHandle,
    contributor: &ShieldedKeypair,
    slot: u64,
) -> Result<Vec<DataUtxo<ContributionTerms>>> {
    let tags = vec![
        campaign.authority.owner_tag(),
        contributor.shielded_address()?.confidential_view_tag()?,
    ];
    let transactions = transactions_by_tags(localnet, tags, slot)?;
    let view = localnet::campaign(localnet, campaign.address)?.account;
    if view.is_settled() {
        return Ok(Vec::new());
    }
    Ok(campaign
        .authority
        .decrypt_data_utxos::<ContributionTerms>(
            &contributor.viewing_key,
            &transactions,
            &AssetRegistry::default(),
        )?
        .into_iter()
        .filter(|contribution| {
            view.contributions()
                .iter()
                .position(|hash| *hash == contribution.utxo.utxo_hash)
                .is_some_and(|index| !view.is_refunded(index))
        })
        .collect())
}

fn prepare_refund(
    env: &TestEnv,
    campaign: &CampaignHandle,
    contributor: &ShieldedKeypair,
    contribution: &DataUtxo<ContributionTerms>,
) -> Result<(CompressedProof, u8, TransactIxData)> {
    let view = localnet::campaign(&env.localnet, campaign.address)?;
    let index = view
        .account
        .contributions()
        .iter()
        .position(|hash| *hash == contribution.utxo.utxo_hash)
        .ok_or_else(|| anyhow!("the contribution is not registered"))?;
    let address = contributor.shielded_address()?;
    let payer = contributor.pubkey();
    let inputs = Refund {
        private: RefundPrivateInputs {
            tx_context: TxContext::new().with_output_tree_id(Some(env.localnet.tree_id)),
            contribution: contribution.utxo.clone(),
            terms: contribution.data.clone(),
        },
        public: RefundPublicInputs {
            campaign_id: campaign.campaign_id,
            contributor_identity: solana_owner_identity(payer.as_array())?,
            contribution: contribution.utxo.utxo_hash,
        },
    };
    let transaction = inputs.create_program_transaction(&address, payer)?;
    let proof = Groth16Prover::<Refund>::new_with_test_setup()?
        .prove_inputs(&transaction.proof_inputs)?
        .compressed()?;
    let spp = transaction.finalized.encrypt_with_keys(contributor)?;
    let transact = env
        .localnet
        .client
        .prove_transact(spp, None, &ProgramOwner::nullifier_key())?;
    Ok((proof, u8::try_from(index)?, transact))
}

fn refund_instruction(
    env: &TestEnv,
    campaign: &CampaignHandle,
    signer: Address,
    (proof, index, transact): &(CompressedProof, u8, TransactIxData),
) -> Result<Instruction> {
    Ok(RefundInstruction {
        contributor: signer,
        campaign: campaign.address,
        tree: env.localnet.tree,
        proof: *proof,
        index: *index,
        transact: transact.clone(),
    }
    .instruction()?)
}

#[test]
fn successful_campaign_pays_the_beneficiary() -> Result<()> {
    let env = setup(20, 3)?;
    let localnet = &env.localnet;
    let amounts = [200_000_000, 150_000_000, 250_000_000];
    let target = 500_000_000;
    let campaign = create_campaign(&env, 1, target)?;
    let mut coordinator = Coordinator {
        keys: &env.coordinator,
        store: Vec::new(),
    };

    // A contribution signed by anyone but the coordinator is refused.
    let first = prepare_contribution(
        &env,
        &campaign,
        &env.contributors[0],
        amounts[0],
        env.deposit_slot,
    )?;
    let impostor = &env.contributors[1];
    assert_error(
        "contribution co-signed by a non-coordinator",
        send(
            localnet,
            &[&env.contributors[0], impostor],
            first.instruction(&env, &campaign, impostor.pubkey())?,
        ),
        FundraiserError::WrongCoordinator,
    );

    let mut slot = env.deposit_slot;
    let mut accepted = Vec::new();
    for (i, amount) in amounts.into_iter().enumerate() {
        let contributor = &env.contributors[i];
        let pending = if i == 0 {
            first.clone()
        } else {
            prepare_contribution(&env, &campaign, contributor, amount, slot)?
        };
        let instruction = coordinator.cosign(&env, &campaign, &pending)?;
        slot = send(
            localnet,
            &[contributor, &env.coordinator],
            instruction.clone(),
        )?;
        accepted.push(instruction);
    }
    let view = campaign_state(&env, &campaign)?;
    assert_eq!(view.count, 3);
    assert_eq!(
        view.contributions().to_vec(),
        coordinator
            .store
            .iter()
            .map(|(_, hash)| *hash)
            .collect::<Vec<_>>()
    );
    for (contributor, amount) in env.contributors.iter().zip(amounts) {
        assert_eq!(
            sol_balance(localnet, contributor, slot)?.0,
            DEPOSIT - amount
        );
    }

    // Replaying an accepted contribution reaches the registry write, then SPP
    // refuses the spent inputs; the whole transaction reverts.
    assert_fails(
        "replayed contribution",
        resend(
            localnet,
            &[&env.contributors[0], &env.coordinator],
            accepted[0].clone(),
        ),
    );
    assert_eq!(campaign_state(&env, &campaign)?.count, 3);

    // A corrupted proof is refused and leaves the campaign and balance as they were.
    let late = prepare_contribution(&env, &campaign, &env.contributors[0], 10_000_000, slot)?;
    let mut corrupted = late.clone();
    corrupted.proof.a[0] ^= 1;
    assert_error(
        "contribution with a corrupted proof",
        send(
            localnet,
            &[&env.contributors[0], &env.coordinator],
            corrupted.instruction(&env, &campaign, env.coordinator.pubkey())?,
        ),
        FundraiserError::ProofVerificationFailed,
    );
    assert_eq!(campaign_state(&env, &campaign)?.count, 3);
    assert_eq!(
        sol_balance(localnet, &env.contributors[0], slot)?.0,
        DEPOSIT - amounts[0]
    );

    // Settlement and refund are refused before their windows.
    let settle = coordinator.settle(&env, &campaign, slot)?;
    assert_error(
        "settlement before the close",
        send(localnet, &[&env.coordinator], settle.clone()),
        FundraiserError::SettlementNotOpen,
    );
    let contribution = own_contributions(localnet, &campaign, &env.contributors[1], slot)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("contributor 1 finds no contribution"))?;
    let refund = prepare_refund(&env, &campaign, &env.contributors[1], &contribution)?;
    assert_error(
        "refund before the settlement deadline",
        send(
            localnet,
            &[&env.contributors[1]],
            refund_instruction(&env, &campaign, env.contributors[1].pubkey(), &refund)?,
        ),
        FundraiserError::RefundNotOpen,
    );

    wait_until(localnet, campaign.close_ts)?;
    assert_error(
        "contribution after the close",
        send(
            localnet,
            &[&env.contributors[0], &env.coordinator],
            late.instruction(&env, &campaign, env.coordinator.pubkey())?,
        ),
        FundraiserError::ContributionsClosed,
    );

    let settled = send(localnet, &[&env.coordinator], settle.clone())?;
    let view = campaign_state(&env, &campaign)?;
    assert_eq!(view.status, CampaignStatus::Settled as u8);
    assert_eq!(
        sol_balance(localnet, &env.beneficiary, settled)?.0,
        amounts.iter().sum::<u64>()
    );
    assert!(own_contributions(localnet, &campaign, &env.contributors[1], settled)?.is_empty());

    assert_error(
        "second settlement",
        resend(localnet, &[&env.coordinator], settle),
        FundraiserError::CampaignSettled,
    );

    wait_until(localnet, campaign.settle_deadline)?;
    assert_error(
        "refund after success",
        send(
            localnet,
            &[&env.contributors[1]],
            refund_instruction(&env, &campaign, env.contributors[1].pubkey(), &refund)?,
        ),
        FundraiserError::CampaignSettled,
    );
    Ok(())
}

#[test]
fn failed_campaign_refunds_each_contributor_without_the_coordinator() -> Result<()> {
    let env = setup(21, 4)?;
    let localnet = &env.localnet;
    let amount = 100_000_000;
    let target = 1_000_000_000;
    let campaign = create_campaign(&env, 7, target)?;
    let mut coordinator = Coordinator {
        keys: &env.coordinator,
        store: Vec::new(),
    };

    let mut slot = env.deposit_slot;
    for contributor in &env.contributors {
        let pending = prepare_contribution(&env, &campaign, contributor, amount, slot)?;
        let instruction = coordinator.cosign(&env, &campaign, &pending)?;
        slot = send(localnet, &[contributor, &env.coordinator], instruction)?;
    }
    assert_eq!(campaign_state(&env, &campaign)?.count, 4);

    let fifth = prepare_contribution(&env, &campaign, &env.contributors[0], amount, slot)?;
    assert_error(
        "contribution beyond the cap",
        send(
            localnet,
            &[&env.contributors[0], &env.coordinator],
            fifth.instruction(&env, &campaign, env.coordinator.pubkey())?,
        ),
        FundraiserError::CampaignFull,
    );

    // 400 SOL-lamport units against a 1000 target: no settle proof exists.
    let shortfall = coordinator
        .settle(&env, &campaign, slot)
        .err()
        .ok_or_else(|| anyhow!("an under-target settlement was proven"))?;
    assert!(
        format!("{shortfall:?}").contains("the contributions do not reach the target"),
        "{shortfall:?}"
    );

    // The coordinator goes away with its store. Each contributor restarts with
    // only its keys and recovers its contribution from the chain.
    drop(coordinator);
    wait_until(localnet, campaign.settle_deadline)?;

    let refunds = env
        .contributors
        .iter()
        .map(|contributor| {
            let mine = own_contributions(localnet, &campaign, contributor, slot)?;
            ensure!(
                mine.len() == 1,
                "a contributor sees exactly its own contribution"
            );
            ensure!(mine[0].utxo.utxo.amount == amount);
            prepare_refund(&env, &campaign, contributor, &mine[0])
        })
        .collect::<Result<Vec<_>>>()?;

    // Someone else cannot use a contributor's refund, nor point it at another entry.
    let (alice, bob) = (&env.contributors[0], &env.contributors[1]);
    assert_error(
        "refund signed by another contributor",
        send(
            localnet,
            &[bob],
            refund_instruction(&env, &campaign, bob.pubkey(), &refunds[0])?,
        ),
        FundraiserError::ProofVerificationFailed,
    );
    let (proof, index, transact) = &refunds[0];
    assert_error(
        "refund against another registry entry",
        send(
            localnet,
            &[alice],
            refund_instruction(
                &env,
                &campaign,
                alice.pubkey(),
                &(*proof, (index + 1) % 4, transact.clone()),
            )?,
        ),
        FundraiserError::ProofVerificationFailed,
    );

    // Settlement is closed for good once the deadline passes.
    let settle_after_deadline = SettleInstruction {
        payer: alice.pubkey(),
        campaign: campaign.address,
        tree: localnet.tree,
        proof: *proof,
        transact: transact.clone(),
    }
    .instruction()?;
    assert_error(
        "settlement after the deadline",
        send(localnet, &[alice], settle_after_deadline),
        FundraiserError::SettlementDeadlinePassed,
    );

    for (contributor, refund) in env.contributors.iter().zip(&refunds) {
        slot = send(
            localnet,
            &[contributor],
            refund_instruction(&env, &campaign, contributor.pubkey(), refund)?,
        )?;
    }
    let view = campaign_state(&env, &campaign)?;
    assert_eq!(view.refunded, 0b1111);
    assert_eq!(view.status, CampaignStatus::Open as u8);
    for contributor in &env.contributors {
        assert_eq!(sol_balance(localnet, contributor, slot)?.0, DEPOSIT);
        assert!(own_contributions(localnet, &campaign, contributor, slot)?.is_empty());
    }

    assert_error(
        "second refund",
        resend(
            localnet,
            &[alice],
            refund_instruction(&env, &campaign, alice.pubkey(), &refunds[0])?,
        ),
        FundraiserError::AlreadyRefunded,
    );
    Ok(())
}

/// The widest settlement: four contribution inputs and the payout plus two
/// zero-amount outputs, against the v1 size and compute limits.
#[test]
fn full_campaign_settles_four_contributions() -> Result<()> {
    let env = setup(22, 4)?;
    let localnet = &env.localnet;
    let amount = 100_000_000;
    let campaign = create_campaign(&env, 9, 4 * amount)?;
    let mut coordinator = Coordinator {
        keys: &env.coordinator,
        store: Vec::new(),
    };
    let mut slot = env.deposit_slot;
    for contributor in &env.contributors {
        let pending = prepare_contribution(&env, &campaign, contributor, amount, slot)?;
        let instruction = coordinator.cosign(&env, &campaign, &pending)?;
        slot = send(localnet, &[contributor, &env.coordinator], instruction)?;
    }
    let settle = coordinator.settle(&env, &campaign, slot)?;
    wait_until(localnet, campaign.close_ts)?;
    let settled = send(localnet, &[&env.coordinator], settle)?;
    assert_eq!(
        campaign_state(&env, &campaign)?.status,
        CampaignStatus::Settled as u8
    );
    assert_eq!(
        sol_balance(localnet, &env.beneficiary, settled)?.0,
        4 * amount
    );
    Ok(())
}
