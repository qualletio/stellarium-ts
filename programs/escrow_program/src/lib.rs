use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
};

use solana_sdk_ids::system_program;
use solana_system_interface::instruction as system_instruction;

entrypoint!(process_instruction);

// The operator wallet that signs escrow setup and withdrawals. Use the same wallet as the
// program's upgrade authority. These are local end-to-end keys: set your own before deploying.
pub const ESCROW_AUTHORITY: Option<Pubkey> = Some(solana_program::pubkey!(
    "EjmMczWqevGUXrxmoJqWKj51sjLpWpFXczWqu5Pzerxk"
));
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const DISCRIMINATOR: &[u8; 8] = b"ESCROW01";
pub const ESCROW_LEN: usize = 8 + 32 + 32 + 1;
pub const AUTHORITY_NOT_CONFIGURED: u32 = 0;
pub const WRONG_AUTHORITY: u32 = 1;
pub const FEE_RECIPIENT_NOT_CONFIGURED: u32 = 2;
pub const WRONG_FEE_RECIPIENT: u32 = 3;

// The wallet that receives the protocol fee. Withdrawals fail closed when this is None.
// These are local end-to-end keys: set your own before deploying.
pub const PROTOCOL_FEE_RECIPIENT: Option<Pubkey> = Some(solana_program::pubkey!(
    "6xwrneeAHpUEaMp99YV4WVyRgCNai1XjwC1VxcCz5QPP"
));
/// Protocol fee taken from each withdrawal, in basis points (2000 = 20%).
pub const PROTOCOL_FEE_BPS: u64 = 2_000;

/// Fee owed on a withdrawal of `amount`, rounded down. Never exceeds `amount`.
pub fn protocol_fee(amount: u64) -> u64 {
    (amount as u128 * PROTOCOL_FEE_BPS as u128 / 10_000) as u64
}

/// State: discriminator[8], user[32], authority[32], canonical bump[1].
pub fn escrow_address(program_id: &Pubkey, authority: &Pubkey, user: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[ESCROW_SEED, authority.as_ref(), user.as_ref()],
        program_id,
    )
}

/// Dispatch initialize ([0]) or withdraw ([1] + amount as LE u64).
/// Initialize accounts: payer (writable signer), user (readonly),
/// authority (signer), escrow PDA (writable), System Program (readonly).
/// The authority may also be the payer. No user signature is required: the
/// authority sponsors setup for the user without debiting the user's account.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // 0 = initialize; 1 = withdraw followed by an unsigned LE u64 amount.
    let amount = match instruction_data {
        [0] => None,
        [1, amount @ ..] if amount.len() == 8 => {
            let amount = u64::from_le_bytes(amount.try_into().unwrap());
            if amount == 0 {
                return Err(ProgramError::InvalidInstructionData);
            }
            Some(amount)
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    let authority = ESCROW_AUTHORITY.ok_or(ProgramError::Custom(AUTHORITY_NOT_CONFIGURED))?;
    match amount {
        None => initialize(program_id, accounts, &authority),
        Some(amount) => {
            let fee_recipient =
                PROTOCOL_FEE_RECIPIENT.ok_or(ProgramError::Custom(FEE_RECIPIENT_NOT_CONFIGURED))?;
            // Check the account count before reading the Rent sysvar, so a malformed
            // instruction fails with NotEnoughAccountKeys rather than a sysvar error.
            if accounts.len() < 4 {
                return Err(ProgramError::NotEnoughAccountKeys);
            }
            withdraw(
                program_id,
                accounts,
                &authority,
                &fee_recipient,
                amount,
                &Rent::get()?,
            )
        }
    }
}

/// Withdraw SOL. Accounts: configured authority (signer), escrow (writable),
/// chosen recipient (writable), protocol fee recipient (writable). The escrow is
/// debited `amount`; the fee recipient gets `protocol_fee(amount)` and the
/// recipient the rest. No fee is taken when the recipient is the fee recipient.
/// The escrow retains its rent reserve and state.
fn withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    expected_authority: &Pubkey,
    expected_fee_recipient: &Pubkey,
    amount: u64,
    rent: &Rent,
) -> ProgramResult {
    let mut iter = accounts.iter();
    let authority = next_account_info(&mut iter)?;
    let escrow = next_account_info(&mut iter)?;
    let recipient = next_account_info(&mut iter)?;
    let fee_recipient = next_account_info(&mut iter)?;
    if authority.key != expected_authority {
        return Err(ProgramError::Custom(WRONG_AUTHORITY));
    }
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if fee_recipient.key != expected_fee_recipient {
        return Err(ProgramError::Custom(WRONG_FEE_RECIPIENT));
    }
    if !escrow.is_writable
        || !recipient.is_writable
        || !fee_recipient.is_writable
        || escrow.key == recipient.key
        || escrow.key == fee_recipient.key
        || amount == 0
    {
        return Err(ProgramError::InvalidArgument);
    }
    if escrow.owner != program_id || escrow.executable {
        return Err(ProgramError::InvalidAccountOwner);
    }
    if recipient.executable || fee_recipient.executable {
        return Err(ProgramError::InvalidArgument);
    }
    let data = escrow.try_borrow_data()?;
    if data.len() != ESCROW_LEN || &data[..8] != DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }
    let user = Pubkey::new_from_array(data[8..40].try_into().unwrap());
    let stored_authority = Pubkey::new_from_array(data[40..72].try_into().unwrap());
    if stored_authority != *authority.key {
        return Err(ProgramError::Custom(WRONG_AUTHORITY));
    }
    let (address, bump) = escrow_address(program_id, authority.key, &user);
    if escrow.key != &address || data[72] != bump {
        return Err(ProgramError::InvalidSeeds);
    }
    drop(data);

    // Directly debit our program-owned account. A System Program transfer CPI
    // cannot debit this data-bearing, program-owned escrow.
    let remaining = escrow
        .lamports()
        .checked_sub(amount)
        .filter(|balance| *balance >= rent.minimum_balance(ESCROW_LEN))
        .ok_or(ProgramError::InsufficientFunds)?;
    // The fee wallet pays itself no fee; this also avoids a second mutable
    // borrow of the same account below.
    let fee = if recipient.key == fee_recipient.key {
        0
    } else {
        protocol_fee(amount)
    };
    let credited = recipient
        .lamports()
        .checked_add(amount - fee)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let fee_credited = fee_recipient
        .lamports()
        .checked_add(fee)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    // Acquire all borrows before mutating any balance.
    let mut escrow_lamports = escrow.try_borrow_mut_lamports()?;
    let mut recipient_lamports = recipient.try_borrow_mut_lamports()?;
    let fee_lamports = match fee {
        0 => None,
        _ => Some(fee_recipient.try_borrow_mut_lamports()?),
    };
    **escrow_lamports = remaining;
    **recipient_lamports = credited;
    if let Some(mut fee_lamports) = fee_lamports {
        **fee_lamports = fee_credited;
    }
    Ok(())
}

fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    expected_authority: &Pubkey,
) -> ProgramResult {
    let mut iter = accounts.iter();
    let payer = next_account_info(&mut iter)?;
    let user = next_account_info(&mut iter)?;
    let authority = next_account_info(&mut iter)?;
    let escrow = next_account_info(&mut iter)?;
    let system = next_account_info(&mut iter)?;

    if authority.key != expected_authority {
        return Err(ProgramError::Custom(WRONG_AUTHORITY));
    }
    if !payer.is_signer || !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_writable || !escrow.is_writable || payer.key == escrow.key {
        return Err(ProgramError::InvalidArgument);
    }
    if system.key != &system_program::ID || !system.executable {
        return Err(ProgramError::IncorrectProgramId);
    }
    if payer.owner != &system_program::ID || !payer.data_is_empty() {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let (address, bump) = escrow_address(program_id, authority.key, user.key);
    if escrow.key != &address {
        return Err(ProgramError::InvalidSeeds);
    }
    if escrow.owner == program_id {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    if escrow.owner != &system_program::ID || !escrow.data_is_empty() || escrow.executable {
        return Err(ProgramError::InvalidAccountOwner);
    }

    let rent = Rent::get()?.minimum_balance(ESCROW_LEN);
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[
        ESCROW_SEED,
        authority.key.as_ref(),
        user.key.as_ref(),
        &bump_seed,
    ];
    // Accept prefunded System-owned PDAs, so sending dust cannot block setup.
    let shortfall = rent.saturating_sub(escrow.lamports());
    if shortfall > 0 {
        invoke(
            &system_instruction::transfer(payer.key, escrow.key, shortfall),
            &[payer.clone(), escrow.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(escrow.key, ESCROW_LEN as u64),
        &[escrow.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(escrow.key, program_id),
        &[escrow.clone(), system.clone()],
        &[seeds],
    )?;
    let mut data = escrow.try_borrow_mut_data()?;
    data[..8].copy_from_slice(DISCRIMINATOR);
    data[8..40].copy_from_slice(user.key.as_ref());
    data[40..72].copy_from_slice(authority.key.as_ref());
    data[72] = bump;
    drop(data);
    set_return_data(address.as_ref());
    Ok(())
}

#[cfg(test)]
mod tests;
