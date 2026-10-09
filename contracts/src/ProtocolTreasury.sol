// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ProtocolBase} from './ProtocolBase.sol';
import {StellariumBalanceVault} from './StellariumBalanceVault.sol';
contract ProtocolTreasury is ProtocolBase {
    using SafeERC20 for IERC20;
    StellariumBalanceVault public vault; IERC20 public usdc; address public settlement; address public court;
    uint256 public operationsReserve; uint256 public daoFunds; uint256 public committedReserve;
    mapping(bytes32=>uint256) public arbitrationCommitments;
    function initialize(address governance,address vault_,address token,address settlement_,address court_) external initializer { __ProtocolBase_init(governance); vault=StellariumBalanceVault(vault_); usdc=IERC20(token); settlement=settlement_; court=court_; }
    function recordFee(uint256 amount) external { require(msg.sender==settlement,'settlement'); uint256 reserve=amount*80/100; operationsReserve+=reserve; daoFunds+=amount-reserve; }
    function fundReserve(uint256 amount) external nonReentrant { usdc.safeTransferFrom(msg.sender,address(this),amount); operationsReserve+=amount; }
    function _pull(uint256 amount) private { uint256 balance=usdc.balanceOf(address(this)); if(balance<amount) vault.withdraw(amount-balance); }
    function spendReserve(address recipient,uint256 amount) external onlyOwner nonReentrant { require(operationsReserve>=committedReserve+amount,'reserve'); operationsReserve-=amount; _pull(amount); usdc.safeTransfer(recipient,amount); }
    function spendDao(address recipient,uint256 amount) external onlyOwner nonReentrant { require(daoFunds>=amount,'treasury'); daoFunds-=amount; _pull(amount); usdc.safeTransfer(recipient,amount); }
    function reserveArbitration(bytes32 id,uint256 amount) external { require(msg.sender==court&&arbitrationCommitments[id]==0,'court reserve'); arbitrationCommitments[id]=amount; committedReserve+=amount; }
    function settleArbitrationReserve(bytes32 id,address recipient,uint256 amount) external nonReentrant {
        uint256 reserved=arbitrationCommitments[id]; require(msg.sender==court&&reserved>0&&amount<=reserved,'court reserve');
        delete arbitrationCommitments[id]; committedReserve-=reserved;
        if(amount>0) { require(operationsReserve>=amount,'reserve replenishment required'); operationsReserve-=amount; _pull(amount); usdc.safeTransfer(recipient,amount); }
    }
}
