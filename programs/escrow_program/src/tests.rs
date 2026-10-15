use super::*;

fn run_case(change: impl FnOnce(&mut Vec<AccountInfo>, &Pubkey, &Pubkey)) -> ProgramResult {
    let program = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let user = Pubkey::new_unique();
    let address = escrow_address(&program, &authority, &user).0;
    let keys = [
        Pubkey::new_unique(),
        user,
        authority,
        address,
        system_program::ID,
    ];
    let owners = [system_program::ID; 5];
    let mut balances = [10_000_000, 0, 0, 0, 1];
    let mut data: [Vec<u8>; 5] = std::array::from_fn(|_| vec![]);
    let mut accounts: Vec<_> = keys
        .iter()
        .zip(owners.iter())
        .zip(balances.iter_mut())
        .zip(data.iter_mut())
        .enumerate()
        .map(|(i, (((key, owner), lamports), data))| {
            AccountInfo::new(
                key,
                i == 0 || i == 2,
                i == 0 || i == 3,
                lamports,
                data,
                owner,
                i == 4,
                0,
            )
        })
        .collect();
    change(&mut accounts, &program, &authority);
    initialize(&program, &accounts, &authority)
}

#[test]
fn unconfigured_authority_fails_closed_and_configured_authority_requires_accounts() {
    let expected = if ESCROW_AUTHORITY.is_none() {
        ProgramError::Custom(AUTHORITY_NOT_CONFIGURED)
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
fn authority_must_sign() {
    assert_eq!(
        run_case(|a, _, _| a[2].is_signer = false),
        Err(ProgramError::MissingRequiredSignature)
    );
}

#[test]
fn payer_must_sign() {
    assert_eq!(
        run_case(|a, _, _| a[0].is_signer = false),
        Err(ProgramError::MissingRequiredSignature)
    );
}

#[test]
fn another_signer_cannot_replace_authority() {
    assert_eq!(
        run_case(|a, _, _| a[2].key = a[0].key),
        Err(ProgramError::Custom(WRONG_AUTHORITY))
    );
}

#[test]
fn rejects_wrong_pda() {
    assert_eq!(
        run_case(|a, _, _| a[3].key = a[1].key),
        Err(ProgramError::InvalidSeeds)
    );
}

#[test]
fn mutable_accounts_must_be_writable() {
    for index in [0, 3] {
        assert_eq!(
            run_case(|a, _, _| a[index].is_writable = false),
            Err(ProgramError::InvalidArgument)
        );
    }
}

#[test]
fn rejects_fake_system_program() {
    assert_eq!(
        run_case(|a, _, _| a[4].key = a[1].key),
        Err(ProgramError::IncorrectProgramId)
    );
    assert_eq!(
        run_case(|a, _, _| a[4].executable = false),
        Err(ProgramError::IncorrectProgramId)
    );
}

#[test]
fn cannot_reinitialize_or_use_foreign_owned_account() {
    // The program and foreign owners have fixture-local lifetimes; use leaked
    // public keys only in these short-lived tests.
    assert_eq!(
        run_case(|a, p, _| a[3].owner = Box::leak(Box::new(*p))),
        Err(ProgramError::AccountAlreadyInitialized)
    );
    assert_eq!(
        run_case(|a, _, _| a[3].owner = a[1].key),
        Err(ProgramError::InvalidAccountOwner)
    );
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

fn withdrawal_case(
    amounts: &[u64],
    change: impl FnOnce(&mut Vec<AccountInfo>),
) -> (Vec<ProgramResult>, u64, u64, u64) {
    let program = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let user = Pubkey::new_unique();
    let fee_recipient = Pubkey::new_unique();
    let (address, bump) = escrow_address(&program, &authority, &user);
    let keys = [authority, address, Pubkey::new_unique(), fee_recipient];
    let owners = [system_program::ID, program, system_program::ID, system_program::ID];
    let rent = Rent::default();
    let mut balances = [
        1_000_000,
        rent.minimum_balance(ESCROW_LEN) + 500,
        1_000_000,
        1_000_000,
    ];
    let mut data: [Vec<u8>; 4] = [
        vec![],
        [
            DISCRIMINATOR.as_slice(),
            user.as_ref(),
            authority.as_ref(),
            &[bump],
        ]
        .concat(),
        vec![],
        vec![],
    ];
    let mut accounts: Vec<_> = keys
        .iter()
        .zip(owners.iter())
        .zip(balances.iter_mut())
        .zip(data.iter_mut())
        .enumerate()
        .map(|(i, (((key, owner), lamports), data))| {
            AccountInfo::new(key, i == 0, i != 0, lamports, data, owner, false, 0)
        })
        .collect();
    change(&mut accounts);
    let mut results = vec![];
    for amount in amounts {
        let before = (
            accounts[1].lamports(),
            accounts[2].lamports(),
            accounts[3].lamports(),
        );
        let state = accounts[1].try_borrow_data().unwrap().to_vec();
        let result = withdraw(&program, &accounts, &authority, &fee_recipient, *amount, &rent);
        assert_eq!(accounts[1].try_borrow_data().unwrap().to_vec(), state);
        let after = (
            accounts[1].lamports(),
            accounts[2].lamports(),
            accounts[3].lamports(),
        );
        if result.is_err() {
            assert_eq!(after, before);
        } else if accounts[2].key == accounts[3].key {
            assert_eq!(after, (before.0 - amount, before.1 + amount, before.2 + amount));
        } else {
            let fee = protocol_fee(*amount);
            assert_eq!(after, (before.0 - amount, before.1 + amount - fee, before.2 + fee));
        }
        results.push(result);
    }
    (
        results,
        accounts[1].lamports(),
        accounts[2].lamports(),
        accounts[3].lamports(),
    )
}

#[test]
fn withdrawal_transfers_to_chosen_recipient_and_preserves_rent_and_state() {
    let (results, escrow_balance, recipient_balance, fee_balance) =
        withdrawal_case(&[200, 300, 1], |_| {});
    assert_eq!(
        results,
        vec![Ok(()), Ok(()), Err(ProgramError::InsufficientFunds)]
    );
    assert_eq!(escrow_balance, Rent::default().minimum_balance(ESCROW_LEN));
    assert_eq!(recipient_balance, 1_000_400);
    assert_eq!(fee_balance, 1_000_100);
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
}

#[test]
fn withdrawal_to_fee_recipient_takes_no_fee() {
    let (results, _, recipient_balance, fee_balance) =
        withdrawal_case(&[500], |a| a[2] = a[3].clone());
    assert_eq!(results, vec![Ok(())]);
    assert_eq!(recipient_balance, 1_000_500);
    assert_eq!(fee_balance, 1_000_500);
}

#[test]
fn withdrawal_requires_configured_fee_recipient() {
    assert_eq!(
        withdrawal_case(&[1], |a| a[3] = a[2].clone()).0,
        vec![Err(ProgramError::Custom(WRONG_FEE_RECIPIENT))]
    );
}

#[test]
fn withdrawal_rejects_fee_overflow_without_debiting_escrow() {
    assert_eq!(
        withdrawal_case(&[10], |a| **a[3].try_borrow_mut_lamports().unwrap() =
            u64::MAX)
        .0,
        vec![Err(ProgramError::ArithmeticOverflow)]
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
        withdrawal_case(&[1], |a| a[0].key = a[2].key).0,
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
fn withdrawal_requires_distinct_writable_nonexecutable_destination() {
    for index in [1, 2, 3] {
        assert_eq!(
            withdrawal_case(&[1], |a| a[index].is_writable = false).0,
            vec![Err(ProgramError::InvalidArgument)]
        );
    }
    assert_eq!(
        withdrawal_case(&[1], |a| a[2] = a[1].clone()).0,
        vec![Err(ProgramError::InvalidArgument)]
    );
    for index in [2, 3] {
        assert_eq!(
            withdrawal_case(&[1], |a| a[index].executable = true).0,
            vec![Err(ProgramError::InvalidArgument)]
        );
    }
}

#[test]
fn withdrawal_can_pay_the_controlling_wallet() {
    let (results, _, recipient_balance, fee_balance) = withdrawal_case(&[500], |a| {
        a[2] = a[0].clone();
        a[2].is_writable = true;
    });
    assert_eq!(results, vec![Ok(())]);
    assert_eq!(recipient_balance, 1_000_400);
    assert_eq!(fee_balance, 1_000_100);
}

#[test]
fn withdrawal_rejects_recipient_overflow_without_debiting_escrow() {
    assert_eq!(
        withdrawal_case(&[1], |a| **a[2].try_borrow_mut_lamports().unwrap() =
            u64::MAX)
        .0,
        vec![Err(ProgramError::ArithmeticOverflow)]
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
