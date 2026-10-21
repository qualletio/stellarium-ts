use super::*;
use solana_program::{instruction::Instruction, program_option::COption, program_stubs};
use spl_token::{error::TokenError, state::{AccountState, Mint}};
use std::cell::{Cell, RefCell};

/// Accounts: user (funded signer), authority, escrow PDA, escrow token account,
/// mint, System Program, Token Program, Associated Token Account Program.
fn run_case(change: impl FnOnce(&mut Vec<AccountInfo>, &Pubkey, &Pubkey)) -> ProgramResult {
    let program = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let user = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let address = escrow_address(&program, &authority, &user).0;
    let keys = [
        user,
        authority,
        address,
        get_associated_token_address(&address, &mint),
        mint,
        system_program::ID,
        spl_token::ID,
        spl_associated_token_account::ID,
    ];
    let owners = [system_program::ID; 8];
    let mut balances = [10_000_000, 0, 0, 0, 1, 1, 1, 1];
    let mut data: [Vec<u8>; 8] = std::array::from_fn(|_| vec![]);
    let mut accounts: Vec<_> = keys
        .iter()
        .zip(owners.iter())
        .zip(balances.iter_mut())
        .zip(data.iter_mut())
        .enumerate()
        .map(|(i, (((key, owner), lamports), data))| {
            AccountInfo::new(
                key,
                i == 0,
                i == 0 || i == 2 || i == 3,
                lamports,
                data,
                owner,
                i >= 5,
                0,
            )
        })
        .collect();
    change(&mut accounts, &program, &authority);
    initialize(&program, &accounts, &authority, &mint)
}

#[test]
fn unconfigured_authority_fails_closed_and_configured_authority_requires_accounts() {
    let expected = if ESCROW_AUTHORITY.is_none() {
        ProgramError::Custom(AUTHORITY_NOT_CONFIGURED)
    } else if USDC_MINT.is_none() {
        ProgramError::Custom(MINT_NOT_CONFIGURED)
    } else {
        ProgramError::NotEnoughAccountKeys
    };
    assert_eq!(
        process_instruction(&Pubkey::new_unique(), &[], &[0]),
        Err(expected)
    );
}

#[test]
fn rejects_unknown_and_trailing_instruction_data() {
    for data in [vec![], vec![1], vec![0, 0]] {
        assert_eq!(
            process_instruction(&Pubkey::new_unique(), &[], &data),
            Err(ProgramError::InvalidInstructionData)
        );
    }
}

#[test]
fn user_signs_and_pays_without_the_authority() {
    install_stubs(Pubkey::default());
    let (mut user, mut escrow) = (Pubkey::default(), Pubkey::default());
    let result = run_case(|a, _, _| {
        assert!(!a[1].is_signer);
        user = *a[0].key;
        escrow = *a[2].key;
    });
    assert_eq!(result, Ok(()));
    let invoked = INVOKED.with(|invoked| invoked.borrow().clone());
    let rent = Rent::default().minimum_balance(ESCROW_LEN);
    assert_eq!(invoked[0], system_instruction::transfer(&user, &escrow, rent));
    let token_setup = invoked
        .iter()
        .find(|ix| ix.program_id == spl_associated_token_account::ID)
        .expect("escrow token account setup");
    assert_eq!(token_setup.accounts[0].pubkey, user);
}

#[test]
fn user_must_sign() {
    assert_eq!(
        run_case(|a, _, _| a[0].is_signer = false),
        Err(ProgramError::MissingRequiredSignature)
    );
}

#[test]
fn rejects_another_authority() {
    assert_eq!(
        run_case(|a, _, _| a[1].key = a[0].key),
        Err(ProgramError::Custom(WRONG_AUTHORITY))
    );
}

#[test]
fn rejects_wrong_pda_or_token_account() {
    assert_eq!(
        run_case(|a, _, _| a[2].key = a[1].key),
        Err(ProgramError::InvalidSeeds)
    );
    assert_eq!(
        run_case(|a, _, _| a[3].key = a[1].key),
        Err(ProgramError::InvalidSeeds)
    );
}

#[test]
fn rejects_another_mint() {
    assert_eq!(
        run_case(|a, _, _| a[4].key = a[0].key),
        Err(ProgramError::Custom(WRONG_MINT))
    );
}

#[test]
fn mutable_accounts_must_be_writable() {
    for index in [0, 2] {
        assert_eq!(
            run_case(|a, _, _| a[index].is_writable = false),
            Err(ProgramError::InvalidArgument)
        );
    }
}

#[test]
fn rejects_fake_system_token_or_associated_token_program() {
    for index in [5, 6, 7] {
        assert_eq!(
            run_case(|a, _, _| a[index].key = a[1].key),
            Err(ProgramError::IncorrectProgramId)
        );
    }
    assert_eq!(
        run_case(|a, _, _| a[5].executable = false),
        Err(ProgramError::IncorrectProgramId)
    );
}

#[test]
fn cannot_reinitialize_or_use_foreign_owned_account() {
    // The program and foreign owners have fixture-local lifetimes; use leaked
    // public keys only in these short-lived tests.
    assert_eq!(
        run_case(|a, p, _| a[2].owner = Box::leak(Box::new(*p))),
        Err(ProgramError::AccountAlreadyInitialized)
    );
    assert_eq!(
        run_case(|a, _, _| a[2].owner = a[1].key),
        Err(ProgramError::InvalidAccountOwner)
    );
}

#[test]
fn user_must_be_a_wallet() {
    assert_eq!(
        run_case(|a, _, _| a[0].owner = a[1].key),
        Err(ProgramError::InvalidAccountOwner)
    );
}

#[test]
fn pda_is_canonical_and_scoped_to_user_and_authority() {
    let p = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let user = Pubkey::new_unique();
    let (address, bump) = escrow_address(&p, &authority, &user);
    assert_eq!(
        Pubkey::create_program_address(
            &[ESCROW_SEED, authority.as_ref(), user.as_ref(), &[bump]],
            &p
        )
        .unwrap(),
        address
    );
    assert_ne!(
        escrow_address(&p, &authority, &Pubkey::new_unique()).0,
        address
    );
    assert_ne!(escrow_address(&p, &Pubkey::new_unique(), &user).0, address);
}

thread_local! {
    /// The program the current test's CPIs are made from, for checking PDA signatures.
    static CALLER: Cell<Pubkey> = Cell::new(Pubkey::default());
    /// Every CPI made on this thread, in order.
    static INVOKED: RefCell<Vec<Instruction>> = const { RefCell::new(vec![]) };
}

/// Runs Token Program CPIs in-process with spl-token's own processor, so
/// withdrawal tests move real token balances. System Program allocations resize
/// the account's data; other CPIs are only recorded.
struct TokenProgramStubs;

impl program_stubs::SyscallStubs for TokenProgramStubs {
    fn sol_invoke_signed(
        &self,
        instruction: &Instruction,
        account_infos: &[AccountInfo],
        signers_seeds: &[&[&[u8]]],
    ) -> ProgramResult {
        INVOKED.with(|invoked| invoked.borrow_mut().push(instruction.clone()));
        // SystemInstruction::Allocate: a LE u32 tag of 8, then the LE u64 size.
        if instruction.program_id == system_program::ID && instruction.data[..4] == 8u32.to_le_bytes() {
            let space = u64::from_le_bytes(instruction.data[4..12].try_into().unwrap());
            let account = account_infos
                .iter()
                .find(|info| info.key == &instruction.accounts[0].pubkey)
                .expect("CPI account was not passed");
            *account.data.borrow_mut() = Box::leak(vec![0; space as usize].into_boxed_slice());
            return Ok(());
        }
        if instruction.program_id != spl_token::ID {
            return Ok(());
        }
        let caller = CALLER.get();
        let signers: Vec<Pubkey> = signers_seeds
            .iter()
            .map(|seeds| Pubkey::create_program_address(seeds, &caller).unwrap())
            .collect();
        let accounts: Vec<AccountInfo> = instruction
            .accounts
            .iter()
            .map(|meta| {
                let mut info = account_infos
                    .iter()
                    .find(|info| info.key == &meta.pubkey)
                    .expect("CPI account was not passed")
                    .clone();
                info.is_signer |= signers.contains(&meta.pubkey);
                info
            })
            .collect();
        spl_token::processor::Processor::process(&instruction.program_id, &accounts, &instruction.data)
    }

    fn sol_get_rent_sysvar(&self, var_addr: *mut u8) -> u64 {
        unsafe { *(var_addr as *mut Rent) = Rent::default() };
        solana_program::entrypoint::SUCCESS
    }
}

fn install_stubs(program: Pubkey) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        program_stubs::set_syscall_stubs(Box::new(TokenProgramStubs));
    });
    CALLER.set(program);
    INVOKED.with(|invoked| invoked.borrow_mut().clear());
}

fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount {
        mint: *mint,
        owner: *owner,
        amount,
        state: AccountState::Initialized,
        ..TokenAccount::default()
    }
    .pack_into_slice(&mut data);
    data
}

fn token_amount(account: &AccountInfo) -> u64 {
    TokenAccount::unpack(&account.try_borrow_data().unwrap()).unwrap().amount
}

/// Accounts: authority, escrow, escrow token (500), recipient token (1,000,000),
/// fee token (1,000,000), mint, Token Program. Returns each result and the final
/// escrow, recipient and fee token balances.
fn withdrawal_case(
    amounts: &[u64],
    change: impl FnOnce(&mut Vec<AccountInfo>),
) -> (Vec<ProgramResult>, u64, u64, u64) {
    let program = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let user = Pubkey::new_unique();
    let fee_recipient = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    install_stubs(program);
    let (address, bump) = escrow_address(&program, &authority, &user);
    let keys = [
        authority,
        address,
        get_associated_token_address(&address, &mint),
        Pubkey::new_unique(),
        get_associated_token_address(&fee_recipient, &mint),
        mint,
        spl_token::ID,
    ];
    let owners = [
        system_program::ID,
        program,
        spl_token::ID,
        spl_token::ID,
        spl_token::ID,
        spl_token::ID,
        solana_sdk_ids::bpf_loader::ID,
    ];
    let mut balances = [1_000_000; 7];
    let mut mint_data = vec![0; Mint::LEN];
    Mint {
        mint_authority: COption::None,
        supply: u64::MAX,
        decimals: USDC_DECIMALS,
        is_initialized: true,
        freeze_authority: COption::None,
    }
    .pack_into_slice(&mut mint_data);
    let mut data: [Vec<u8>; 7] = [
        vec![],
        [
            DISCRIMINATOR.as_slice(),
            user.as_ref(),
            authority.as_ref(),
            &[bump],
        ]
        .concat(),
        token_account_data(&mint, &address, 500),
        token_account_data(&mint, &Pubkey::new_unique(), 1_000_000),
        token_account_data(&mint, &fee_recipient, 1_000_000),
        mint_data,
        vec![],
    ];
    let mut accounts: Vec<_> = keys
        .iter()
        .zip(owners.iter())
        .zip(balances.iter_mut())
        .zip(data.iter_mut())
        .enumerate()
        .map(|(i, (((key, owner), lamports), data))| {
            AccountInfo::new(key, i == 0, (2..=4).contains(&i), lamports, data, owner, i == 6, 0)
        })
        .collect();
    change(&mut accounts);
    let mut results = vec![];
    for amount in amounts {
        let before = (
            token_amount(&accounts[2]),
            token_amount(&accounts[3]),
            token_amount(&accounts[4]),
        );
        let state = accounts[1].try_borrow_data().unwrap().to_vec();
        let lamports: Vec<u64> = accounts.iter().map(|a| a.lamports()).collect();
        let result = withdraw(&program, &accounts, &authority, &fee_recipient, &mint, *amount);
        assert_eq!(accounts[1].try_borrow_data().unwrap().to_vec(), state);
        assert_eq!(accounts.iter().map(|a| a.lamports()).collect::<Vec<_>>(), lamports);
        let after = (
            token_amount(&accounts[2]),
            token_amount(&accounts[3]),
            token_amount(&accounts[4]),
        );
        if result.is_err() {
            assert_eq!(after, before);
        } else if accounts[3].key == accounts[4].key {
            assert_eq!(after, (before.0 - amount, before.1 + amount, before.2 + amount));
        } else {
            let fee = protocol_fee(*amount);
            assert_eq!(after, (before.0 - amount, before.1 + amount - fee, before.2 + fee));
        }
        results.push(result);
    }
    (
        results,
        token_amount(&accounts[2]),
        token_amount(&accounts[3]),
        token_amount(&accounts[4]),
    )
}

#[test]
fn withdrawal_transfers_tokens_to_chosen_recipient_and_preserves_state() {
    let (results, escrow_balance, recipient_balance, fee_balance) =
        withdrawal_case(&[200, 300, 1], |_| {});
    assert_eq!(
        results,
        vec![Ok(()), Ok(()), Err(ProgramError::InsufficientFunds)]
    );
    assert_eq!(escrow_balance, 0);
    assert_eq!(recipient_balance, 1_000_400);
    assert_eq!(fee_balance, 1_000_100);
}

#[test]
fn withdrawal_signs_two_checked_transfers_as_the_escrow() {
    let (results, ..) = withdrawal_case(&[500], |_| {});
    assert_eq!(results, vec![Ok(())]);
    let invoked = INVOKED.with(|invoked| invoked.borrow().clone());
    let amounts: Vec<_> = invoked
        .iter()
        .map(|ix| match spl_token::instruction::TokenInstruction::unpack(&ix.data).unwrap() {
            spl_token::instruction::TokenInstruction::TransferChecked { amount, decimals } => {
                (amount, decimals)
            }
            other => panic!("unexpected instruction {other:?}"),
        })
        .collect();
    assert_eq!(amounts, vec![(400, USDC_DECIMALS), (100, USDC_DECIMALS)]);
}

#[test]
fn protocol_fee_is_twenty_percent_rounded_down() {
    assert_eq!(PROTOCOL_FEE_BPS, 2_000);
    assert_eq!(protocol_fee(1_000), 200);
    assert_eq!(protocol_fee(9), 1);
    assert_eq!(protocol_fee(4), 0);
    assert_eq!(protocol_fee(u64::MAX), u64::MAX / 5);
}

#[test]
fn withdrawal_below_fee_granularity_pays_recipient_in_full() {
    let (results, _, recipient_balance, fee_balance) = withdrawal_case(&[4], |_| {});
    assert_eq!(results, vec![Ok(())]);
    assert_eq!(recipient_balance, 1_000_004);
    assert_eq!(fee_balance, 1_000_000);
    assert_eq!(INVOKED.with(|invoked| invoked.borrow().len()), 1);
}

#[test]
fn withdrawal_to_fee_account_takes_no_fee() {
    let (results, _, recipient_balance, fee_balance) =
        withdrawal_case(&[500], |a| a[3] = a[4].clone());
    assert_eq!(results, vec![Ok(())]);
    assert_eq!(recipient_balance, 1_000_500);
    assert_eq!(fee_balance, 1_000_500);
}

#[test]
fn withdrawal_requires_configured_fee_recipient() {
    assert_eq!(
        withdrawal_case(&[1], |a| a[4] = a[3].clone()).0,
        vec![Err(ProgramError::Custom(WRONG_FEE_RECIPIENT))]
    );
}

#[test]
fn withdrawal_requires_configured_mint_and_token_program() {
    assert_eq!(
        withdrawal_case(&[1], |a| a[5].key = a[0].key).0,
        vec![Err(ProgramError::Custom(WRONG_MINT))]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[6].key = a[0].key).0,
        vec![Err(ProgramError::IncorrectProgramId)]
    );
}

#[test]
fn withdrawal_rejects_overdraw_and_zero_amount_without_changing_balances() {
    assert_eq!(
        withdrawal_case(&[501, u64::MAX, 0], |_| {}).0,
        vec![
            Err(ProgramError::InsufficientFunds),
            Err(ProgramError::InsufficientFunds),
            Err(ProgramError::InvalidArgument)
        ]
    );
}

#[test]
fn withdrawal_requires_controlling_signer() {
    assert_eq!(
        withdrawal_case(&[1], |a| a[0].is_signer = false).0,
        vec![Err(ProgramError::MissingRequiredSignature)]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[0].key = a[3].key).0,
        vec![Err(ProgramError::Custom(WRONG_AUTHORITY))]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[1].try_borrow_mut_data().unwrap()[40] ^= 1).0,
        vec![Err(ProgramError::Custom(WRONG_AUTHORITY))]
    );
}

#[test]
fn withdrawal_rejects_spoofed_escrow_state() {
    assert_eq!(
        withdrawal_case(&[1], |a| a[1].owner = a[0].owner).0,
        vec![Err(ProgramError::InvalidAccountOwner)]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[1].executable = true).0,
        vec![Err(ProgramError::InvalidAccountOwner)]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[1].try_borrow_mut_data().unwrap()[0] ^= 1).0,
        vec![Err(ProgramError::InvalidAccountData)]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[1].try_borrow_mut_data().unwrap()[72] ^= 1).0,
        vec![Err(ProgramError::InvalidSeeds)]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[1].try_borrow_mut_data().unwrap()[8] ^= 1).0,
        vec![Err(ProgramError::InvalidSeeds)]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[1].key = a[0].key).0,
        vec![Err(ProgramError::InvalidSeeds)]
    );
}

#[test]
fn withdrawal_only_debits_the_escrow_token_account() {
    // Another account of the same mint, even one the escrow owns, is not its associated account.
    assert_eq!(
        withdrawal_case(&[1], |a| a[2].key = Box::leak(Box::new(Pubkey::new_unique()))).0,
        vec![Err(ProgramError::InvalidSeeds)]
    );
    assert_eq!(
        withdrawal_case(&[1], |a| a[2].owner = a[0].owner).0,
        vec![Err(ProgramError::InvalidAccountOwner)]
    );
}

#[test]
fn withdrawal_requires_distinct_writable_token_accounts() {
    for index in [2, 3, 4] {
        assert_eq!(
            withdrawal_case(&[1], |a| a[index].is_writable = false).0,
            vec![Err(ProgramError::InvalidArgument)]
        );
    }
    assert_eq!(
        withdrawal_case(&[1], |a| a[3] = a[2].clone()).0,
        vec![Err(ProgramError::InvalidArgument)]
    );
}

#[test]
fn token_program_rejects_a_recipient_of_another_mint() {
    assert_eq!(
        withdrawal_case(&[1], |a| {
            let other = token_account_data(&Pubkey::new_unique(), &Pubkey::new_unique(), 0);
            a[3].try_borrow_mut_data().unwrap().copy_from_slice(&other);
        })
        .0,
        vec![Err(TokenError::MintMismatch.into())]
    );
}

#[test]
fn token_program_rejects_recipient_overflow_without_debiting_escrow() {
    assert_eq!(
        withdrawal_case(&[1], |a| {
            let mut account = TokenAccount::unpack(&a[3].try_borrow_data().unwrap()).unwrap();
            account.amount = u64::MAX;
            account.pack_into_slice(&mut a[3].try_borrow_mut_data().unwrap());
        })
        .0,
        vec![Err(TokenError::Overflow.into())]
    );
}

#[test]
fn withdrawal_parser_rejects_missing_trailing_and_zero_amounts() {
    for data in [
        vec![1],
        vec![1, 1],
        vec![1; 10],
        vec![1, 0, 0, 0, 0, 0, 0, 0, 0],
        vec![2; 9],
    ] {
        assert_eq!(
            process_instruction(&Pubkey::new_unique(), &[], &data),
            Err(ProgramError::InvalidInstructionData)
        );
    }
    let expected = if ESCROW_AUTHORITY.is_none() {
        ProgramError::Custom(AUTHORITY_NOT_CONFIGURED)
    } else if USDC_MINT.is_none() {
        ProgramError::Custom(MINT_NOT_CONFIGURED)
    } else if PROTOCOL_FEE_RECIPIENT.is_none() {
        ProgramError::Custom(FEE_RECIPIENT_NOT_CONFIGURED)
    } else {
        ProgramError::NotEnoughAccountKeys
    };
    assert_eq!(
        process_instruction(&Pubkey::new_unique(), &[], &[1, 1, 0, 0, 0, 0, 0, 0, 0]),
        Err(expected)
    );
}
