//! JamMap — on-chain consensus for crowdsourced GNSS interference reports.
//!
//! Phones never hold SOL. Each phone owns an ed25519 "device key" and signs a
//! compact report message. A relayer pays the fees and submits the phone's
//! signature through Solana's native Ed25519 program; this program then checks
//! (via the instructions sysvar) that the signature really came from the
//! registered device and covers exactly these report fields. The relayer can
//! pay for, delay or drop reports, but it cannot forge them.
//!
//! An incident is a (zone, time window) pair. It becomes `confirmed` once
//! `quorum` distinct devices report it; every reporter of a confirmed incident
//! can then claim a reward from the vault.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{ed25519_program, sysvar::instructions as ix_sysvar};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const REPORT_DOMAIN: &[u8; 16] = b"jammap:report:v1";
pub const REGISTER_DOMAIN: &[u8; 18] = b"jammap:register:v1";

pub const KIND_JAMMING: u8 = 1;
pub const KIND_SPOOFING: u8 = 2;

/// Reports older/newer than this (seconds) relative to the cluster clock are rejected.
pub const MAX_CLOCK_DRIFT: i64 = 900;

#[program]
pub mod jammap {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        reward_per_report: u64,
        quorum: u8,
        window_secs: i64,
    ) -> Result<()> {
        require!(quorum >= 2, JamError::BadConfig);
        require!(window_secs >= 60, JamError::BadConfig);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.reward_mint = ctx.accounts.reward_mint.key();
        config.reward_per_report = reward_per_report;
        config.quorum = quorum;
        config.window_secs = window_secs;
        config.total_devices = 0;
        config.total_reports = 0;
        config.total_incidents = 0;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        reward_per_report: u64,
        quorum: u8,
    ) -> Result<()> {
        require!(quorum >= 2, JamError::BadConfig);
        let config = &mut ctx.accounts.config;
        config.reward_per_report = reward_per_report;
        config.quorum = quorum;
        Ok(())
    }

    /// Binds a device key to the wallet that receives its rewards.
    /// Must be preceded by an Ed25519 instruction over `REGISTER_DOMAIN || owner`.
    pub fn register_device(ctx: Context<RegisterDevice>, device_key: Pubkey, owner: Pubkey) -> Result<()> {
        let mut msg = Vec::with_capacity(REGISTER_DOMAIN.len() + 32);
        msg.extend_from_slice(REGISTER_DOMAIN);
        msg.extend_from_slice(owner.as_ref());
        verify_prev_ed25519(&ctx.accounts.instructions, &device_key, &msg)?;

        let device = &mut ctx.accounts.device;
        device.device_key = device_key;
        device.owner = owner;
        device.reports = 0;
        device.confirmed_reports = 0;
        device.registered_at = Clock::get()?.unix_timestamp;
        device.bump = ctx.bumps.device;

        let config = &mut ctx.accounts.config;
        config.total_devices = config.total_devices.saturating_add(1);
        Ok(())
    }

    /// Records one signed interference report and advances the incident toward quorum.
    /// Must be preceded by an Ed25519 instruction over `report_message(..)`.
    pub fn submit_report(
        ctx: Context<SubmitReport>,
        cell_id: u64,
        window: u64,
        ts: i64,
        kind: u8,
        severity: u8,
    ) -> Result<()> {
        require!(kind == KIND_JAMMING || kind == KIND_SPOOFING, JamError::BadKind);
        require!((1..=3).contains(&severity), JamError::BadSeverity);

        let config = &mut ctx.accounts.config;
        require!(ts > 0, JamError::BadTimestamp);
        require!(window == (ts / config.window_secs) as u64, JamError::WrongWindow);

        let now = Clock::get()?.unix_timestamp;
        require!((now - ts).abs() <= MAX_CLOCK_DRIFT, JamError::StaleReport);

        let device = &mut ctx.accounts.device;
        let msg = report_message(cell_id, ts, kind, severity);
        verify_prev_ed25519(&ctx.accounts.instructions, &device.device_key, &msg)?;

        let incident = &mut ctx.accounts.incident;
        if incident.reporters == 0 {
            incident.cell_id = cell_id;
            incident.window = window;
            incident.first_ts = ts;
            incident.bump = ctx.bumps.incident;
        }
        incident.reporters = incident.reporters.saturating_add(1);
        incident.kinds |= kind;
        incident.max_severity = incident.max_severity.max(severity);
        incident.last_ts = incident.last_ts.max(ts);

        let vote = &mut ctx.accounts.vote;
        vote.incident = incident.key();
        vote.device = device.key();
        vote.kind = kind;
        vote.severity = severity;
        vote.ts = ts;
        vote.claimed = false;
        vote.bump = ctx.bumps.vote;

        device.reports = device.reports.saturating_add(1);
        config.total_reports = config.total_reports.saturating_add(1);

        emit!(ReportSubmitted {
            cell_id,
            window,
            device: device.key(),
            kind,
            severity,
            reporters: incident.reporters,
        });

        if !incident.confirmed && incident.reporters >= config.quorum {
            incident.confirmed = true;
            incident.confirmed_at = now;
            config.total_incidents = config.total_incidents.saturating_add(1);
            emit!(IncidentConfirmed {
                cell_id,
                window,
                kinds: incident.kinds,
                reporters: incident.reporters,
                max_severity: incident.max_severity,
            });
        }
        Ok(())
    }

    /// Pays `reward_per_report` to the device owner for a vote on a confirmed incident.
    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        require!(ctx.accounts.incident.confirmed, JamError::NotConfirmed);
        require!(!ctx.accounts.vote.claimed, JamError::AlreadyClaimed);

        let config = &ctx.accounts.config;
        let amount = config.reward_per_report;
        require!(ctx.accounts.vault.amount >= amount, JamError::VaultEmpty);

        let bump = [config.bump];
        let seeds: &[&[u8]] = &[b"config".as_ref(), bump.as_ref()];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        ctx.accounts.vote.claimed = true;
        let device = &mut ctx.accounts.device;
        device.confirmed_reports = device.confirmed_reports.saturating_add(1);
        Ok(())
    }
}

/// `REPORT_DOMAIN || cell_id (u64 LE) || ts (i64 LE) || kind (u8) || severity (u8)` — 34 bytes.
/// The Android app and the relayer build exactly the same bytes.
pub fn report_message(cell_id: u64, ts: i64, kind: u8, severity: u8) -> Vec<u8> {
    let mut msg = Vec::with_capacity(34);
    msg.extend_from_slice(REPORT_DOMAIN);
    msg.extend_from_slice(&cell_id.to_le_bytes());
    msg.extend_from_slice(&ts.to_le_bytes());
    msg.push(kind);
    msg.push(severity);
    msg
}

/// Checks that the instruction right before this one is a single-signature
/// Ed25519 verification of `expected_msg` by `expected_key`, with all data inline.
/// The Ed25519 program itself has already verified the signature by the time we run.
fn verify_prev_ed25519(ixs: &AccountInfo, expected_key: &Pubkey, expected_msg: &[u8]) -> Result<()> {
    let current = ix_sysvar::load_current_index_checked(ixs)?;
    require!(current > 0, JamError::MissingSignature);
    let ix = ix_sysvar::load_instruction_at_checked((current - 1) as usize, ixs)?;
    require_keys_eq!(ix.program_id, ed25519_program::ID, JamError::MissingSignature);

    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, JamError::BadSignatureIx);
    let rd = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]);
    let sig_off = rd(2) as usize;
    let sig_ix = rd(4);
    let pk_off = rd(6) as usize;
    let pk_ix = rd(8);
    let msg_off = rd(10) as usize;
    let msg_len = rd(12) as usize;
    let msg_ix = rd(14);

    // Data must live inside the Ed25519 instruction itself, not be borrowed from another one.
    require!(
        sig_ix == u16::MAX && pk_ix == u16::MAX && msg_ix == u16::MAX,
        JamError::BadSignatureIx
    );
    require!(
        d.len() >= sig_off + 64 && d.len() >= pk_off + 32 && d.len() >= msg_off + msg_len,
        JamError::BadSignatureIx
    );
    require!(&d[pk_off..pk_off + 32] == expected_key.as_ref(), JamError::WrongSigner);
    require!(&d[msg_off..msg_off + msg_len] == expected_msg, JamError::WrongMessage);
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub reward_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault"],
        bump,
        token::mint = reward_mint,
        token::authority = config,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(device_key: Pubkey)]
pub struct RegisterDevice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + Device::INIT_SPACE,
        seeds = [b"device", device_key.as_ref()],
        bump,
    )]
    pub device: Account<'info, Device>,
    /// CHECK: address-checked instructions sysvar
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(cell_id: u64, window: u64)]
pub struct SubmitReport<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"device", device.device_key.as_ref()], bump = device.bump)]
    pub device: Account<'info, Device>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Incident::INIT_SPACE,
        seeds = [b"incident", cell_id.to_le_bytes().as_ref(), window.to_le_bytes().as_ref()],
        bump,
    )]
    pub incident: Account<'info, Incident>,
    /// One vote per device per incident: a second report fails at `init`.
    #[account(
        init,
        payer = payer,
        space = 8 + Vote::INIT_SPACE,
        seeds = [b"vote", incident.key().as_ref(), device.key().as_ref()],
        bump,
    )]
    pub vote: Account<'info, Vote>,
    /// CHECK: address-checked instructions sysvar
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"device", device.device_key.as_ref()], bump = device.bump, has_one = owner)]
    pub device: Account<'info, Device>,
    pub incident: Account<'info, Incident>,
    #[account(
        mut,
        seeds = [b"vote", incident.key().as_ref(), device.key().as_ref()],
        bump = vote.bump,
    )]
    pub vote: Account<'info, Vote>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_token.mint == config.reward_mint @ JamError::WrongMint,
        constraint = owner_token.owner == owner.key() @ JamError::WrongMint,
    )]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_per_report: u64,
    pub quorum: u8,
    pub window_secs: i64,
    pub total_devices: u64,
    pub total_reports: u64,
    pub total_incidents: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Device {
    pub device_key: Pubkey,
    pub owner: Pubkey,
    pub reports: u64,
    pub confirmed_reports: u64,
    pub registered_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Incident {
    pub cell_id: u64,
    pub window: u64,
    /// Bitmask of KIND_JAMMING | KIND_SPOOFING seen in this incident.
    pub kinds: u8,
    pub reporters: u8,
    pub max_severity: u8,
    pub confirmed: bool,
    pub first_ts: i64,
    pub last_ts: i64,
    pub confirmed_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vote {
    pub incident: Pubkey,
    pub device: Pubkey,
    pub kind: u8,
    pub severity: u8,
    pub ts: i64,
    pub claimed: bool,
    pub bump: u8,
}

// ---------------------------------------------------------------- events & errors

#[event]
pub struct ReportSubmitted {
    pub cell_id: u64,
    pub window: u64,
    pub device: Pubkey,
    pub kind: u8,
    pub severity: u8,
    pub reporters: u8,
}

#[event]
pub struct IncidentConfirmed {
    pub cell_id: u64,
    pub window: u64,
    pub kinds: u8,
    pub reporters: u8,
    pub max_severity: u8,
}

#[error_code]
pub enum JamError {
    #[msg("Invalid configuration")]
    BadConfig,
    #[msg("Kind must be 1 (jamming) or 2 (spoofing)")]
    BadKind,
    #[msg("Severity must be 1..=3")]
    BadSeverity,
    #[msg("Timestamp must be positive")]
    BadTimestamp,
    #[msg("Window does not match timestamp")]
    WrongWindow,
    #[msg("Report timestamp too far from cluster clock")]
    StaleReport,
    #[msg("Missing Ed25519 signature instruction")]
    MissingSignature,
    #[msg("Malformed Ed25519 signature instruction")]
    BadSignatureIx,
    #[msg("Signature is not from the device key")]
    WrongSigner,
    #[msg("Signed message does not match report")]
    WrongMessage,
    #[msg("Incident has not reached quorum")]
    NotConfirmed,
    #[msg("Reward already claimed")]
    AlreadyClaimed,
    #[msg("Reward vault is empty")]
    VaultEmpty,
    #[msg("Token account has wrong mint or owner")]
    WrongMint,
}
