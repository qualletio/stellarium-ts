use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
};

use solana_sdk_ids::system_program;
use solana_system_interface::instruction as system_instruction;
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account_idempotent,
};
use spl_token::{instruction::transfer_checked, state::Account as TokenAccount};

entrypoint!(process_instruction);

// The operator wallet that signs withdrawals. Users sign and pay for their own escrow setup. Use the same wallet as the
// program's upgrade authority. These are local end-to-end keys: set your own before deploying.
pub const ESCROW_AUTHORITY: Option<Pubkey> = Some(solana_program::pubkey!(
    "BLZc1qdgoJrCZ3TL9yT7gGrrwb5RZyeeZzhkb3kmaBKB"
));
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const DISCRIMINATOR: &[u8; 8] = b"ESCROW02";
pub const ESCROW_LEN: usize = 8 + 32 + 32 + 1;
pub const AUTHORITY_NOT_CONFIGURED: u32 = 0;
pub const WRONG_AUTHORITY: u32 = 1;
pub const FEE_RECIPIENT_NOT_CONFIGURED: u32 = 2;
pub const WRONG_FEE_RECIPIENT: u32 = 3;
pub const MINT_NOT_CONFIGURED: u32 = 4;
pub const WRONG_MINT: u32 = 5;

// The USDC mint escrows hold. Withdrawals and setup fail closed when this is None.
// This is a local end-to-end test mint: use devnet USDC
// (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU) or mainnet USDC
// (EPjFWdd5AufqSSqeM2qZzJpgyyhwJaZgw7tFFtbs2Mn) when deploying there.
pub const USDC_MINT: Option<Pubkey> = Some(solana_program::pubkey!(
    "EPjFWdd5AufqSSqeM2qZzJpgyyhwJaZgw7tFFtbs2Mn"
));
pub const USDC_DECIMALS: u8 = 6;

// The wallet that receives the protocol fee. Withdrawals fail closed when this is None.
// These are local end-to-end keys: set your own before deploying.
pub const PROTOCOL_FEE_RECIPIENT: Option<Pubkey> = Some(solana_program::pubkey!(
    "A9XBu8QhuWe5i4CNzQpVGroSWzhQHcgfU4KvJdQBrzp1"
));
/// Protocol fee taken from each withdrawal, in basis points (2000 = 20%).
pub const PROTOCOL_FEE_BPS: u64 = 2_000;

/// Fee owed on a withdrawal of `amount`, rounded down. Never exceeds `amount`.
pub fn protocol_fee(amount: u64) -> u64 {
    (amount as u128 * PROTOCOL_FEE_BPS as u128 / 10_000) as u64
}

/// State: discriminator[8], user[32], authority[32], canonical bump[1].
/// Funds are held in the PDA's USDC associated token account, not in the PDA itself.
pub fn escrow_address(program_id: &Pubkey, authority: &Pubkey, user: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[ESCROW_SEED, authority.as_ref(), user.as_ref()],
        program_id,
    )
}

/// Dispatch initialize ([0]) or withdraw ([1] + amount in USDC base units as LE u64).
/// Initialize accounts: user (writable signer), authority (readonly),
/// escrow PDA (writable), escrow token account (writable), USDC mint,
/// System Program, Token Program, Associated Token Account Program.
/// The user signs and pays rent for both accounts, so creating escrows costs the
/// authority nothing. The authority doesn't sign setup, only withdrawals.
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
    let mint = USDC_MINT.ok_or(ProgramError::Custom(MINT_NOT_CONFIGURED))?;
    match amount {
        None => initialize(program_id, accounts, &authority, &mint),
        Some(amount) => {
            let fee_recipient =
                PROTOCOL_FEE_RECIPIENT.ok_or(ProgramError::Custom(FEE_RECIPIENT_NOT_CONFIGURED))?;
            withdraw(
                program_id,
                accounts,
                &authority,
                &fee_recipient,
                &mint,
                amount,
            )
        }
    }
}

/// Withdraw USDC. Accounts: configured authority (signer), escrow PDA (readonly),
/// escrow token account (writable), recipient token account (writable), protocol
/// fee recipient's associated token account (writable), USDC mint, Token Program.
/// The escrow token account is debited `amount`; the fee account gets
/// `protocol_fee(amount)` and the recipient the rest. No fee is taken when the
/// recipient token account is the fee account. The escrow PDA keeps its state and rent.
fn withdraw<'a>(
    program_id: &Pubkey,
    accounts: &[AccountInfo<'a>],
    expected_authority: &Pubkey,
    expected_fee_recipient: &Pubkey,
    expected_mint: &Pubkey,
    amount: u64,
) -> ProgramResult {
    let mut iter = accounts.iter();
    let authority = next_account_info(&mut iter)?;
    let escrow = next_account_info(&mut iter)?;
    let escrow_token = next_account_info(&mut iter)?;
    let recipient_token = next_account_info(&mut iter)?;
    let fee_token = next_account_info(&mut iter)?;
    let mint = next_account_info(&mut iter)?;
    let token_program = next_account_info(&mut iter)?;
    if authority.key != expected_authority {
        return Err(ProgramError::Custom(WRONG_AUTHORITY));
    }
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if mint.key != expected_mint {
        return Err(ProgramError::Custom(WRONG_MINT));
    }
    if token_program.key != &spl_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if fee_token.key != &get_associated_token_address(expected_fee_recipient, mint.key) {
        return Err(ProgramError::Custom(WRONG_FEE_RECIPIENT));
    }
    if !escrow_token.is_writable
        || !recipient_token.is_writable
        || !fee_token.is_writable
        || escrow_token.key == recipient_token.key
        || escrow_token.key == fee_token.key
        || amount == 0
    {
        return Err(ProgramError::InvalidArgument);
    }
    if escrow.owner != program_id || escrow.executable {
        return Err(ProgramError::InvalidAccountOwner);
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
    if escrow_token.key != &get_associated_token_address(escrow.key, mint.key) {
        return Err(ProgramError::InvalidSeeds);
    }

    // Report an overdraw as InsufficientFunds before the Token Program sees it.
    if escrow_token.owner != &spl_token::ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let balance = TokenAccount::unpack(&escrow_token.try_borrow_data()?)?.amount;
    if balance < amount {
        return Err(ProgramError::InsufficientFunds);
    }
    // The fee account pays itself no fee.
    let fee = if recipient_token.key == fee_token.key {
        0
    } else {
        protocol_fee(amount)
    };
    let seeds: &[&[u8]] = &[ESCROW_SEED, authority.key.as_ref(), user.as_ref(), &[bump]];
    // The Token Program checks the mint, decimals, frozen state and destination
    // accounts. A failed transfer aborts the whole transaction, including the first.
    let pay = |destination: &AccountInfo<'a>, amount: u64| {
        invoke_signed(
            &transfer_checked(
                token_program.key,
                escrow_token.key,
                mint.key,
                destination.key,
                escrow.key,
                &[],
                amount,
                USDC_DECIMALS,
            )?,
            &[
                escrow_token.clone(),
                mint.clone(),
                destination.clone(),
                escrow.clone(),
                token_program.clone(),
            ],
            &[seeds],
        )
    };
    pay(recipient_token, amount - fee)?;
    if fee > 0 {
        pay(fee_token, fee)?;
    }
    Ok(())
}

fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    expected_authority: &Pubkey,
    expected_mint: &Pubkey,
) -> ProgramResult {
    let mut iter = accounts.iter();
    let user = next_account_info(&mut iter)?;
    let authority = next_account_info(&mut iter)?;
    let escrow = next_account_info(&mut iter)?;
    let escrow_token = next_account_info(&mut iter)?;
    let mint = next_account_info(&mut iter)?;
    let system = next_account_info(&mut iter)?;
    let token_program = next_account_info(&mut iter)?;
    let ata_program = next_account_info(&mut iter)?;

    if authority.key != expected_authority {
        return Err(ProgramError::Custom(WRONG_AUTHORITY));
    }
    if mint.key != expected_mint {
        return Err(ProgramError::Custom(WRONG_MINT));
    }
    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !user.is_writable || !escrow.is_writable || user.key == escrow.key {
        return Err(ProgramError::InvalidArgument);
    }
    if system.key != &system_program::ID
        || !system.executable
        || token_program.key != &spl_token::ID
        || ata_program.key != &spl_associated_token_account::ID
    {
        return Err(ProgramError::IncorrectProgramId);
    }
    if user.owner != &system_program::ID || !user.data_is_empty() {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let (address, bump) = escrow_address(program_id, authority.key, user.key);
    if escrow.key != &address
        || escrow_token.key != &get_associated_token_address(&address, mint.key)
    {
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
            &system_instruction::transfer(user.key, escrow.key, shortfall),
            &[user.clone(), escrow.clone(), system.clone()],
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
    // Idempotent, so a token account someone created ahead of setup cannot block it.
    invoke(
        &create_associated_token_account_idempotent(
            user.key,
            escrow.key,
            mint.key,
            token_program.key,
        ),
        &[
            user.clone(),
            escrow_token.clone(),
            escrow.clone(),
            mint.clone(),
            system.clone(),
            token_program.clone(),
        ],
    )?;
    set_return_data(address.as_ref());
    Ok(())
}

#[cfg(test)]
mod tests;
