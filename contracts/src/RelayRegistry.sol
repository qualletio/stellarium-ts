// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ProtocolBase} from './ProtocolBase.sol';
import {ReputationRegistry} from './ReputationRegistry.sol';
import {IFeeDebt} from './StellariumBalanceVault.sol';
contract RelayRegistry is ProtocolBase {
    using SafeERC20 for IERC20;
    IERC20 public usdc; ReputationRegistry public reputation; IFeeDebt public court;
    uint256 public minimumStake; mapping(address=>uint256) public stakes;
    function initialize(address governance,address token,address reputation_,address court_,uint256 minimumStake_) external initializer { __ProtocolBase_init(governance); usdc=IERC20(token); reputation=ReputationRegistry(reputation_); court=IFeeDebt(court_); require(minimumStake_>0,'stake'); minimumStake=minimumStake_; }
    function stake(uint256 amount) external nonReentrant { require(reputation.admitted(msg.sender)&&court.feeDebt(msg.sender)==0&&amount>0,'identity'); usdc.safeTransferFrom(msg.sender,address(this),amount); stakes[msg.sender]+=amount; }
    function unstake(uint256 amount) external nonReentrant { require(stakes[msg.sender]>=amount,'stake'); stakes[msg.sender]-=amount; usdc.safeTransfer(msg.sender,amount); }
    function eligible(address account) external view returns(bool) { return reputation.admitted(account)&&stakes[account]>=minimumStake&&court.feeDebt(account)==0; }
    function setMinimumStake(uint256 value) external onlyOwner { require(value>0,'stake'); minimumStake=value; }
}
