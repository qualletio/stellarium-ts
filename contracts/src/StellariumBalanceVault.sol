// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ProtocolBase} from './ProtocolBase.sol';
import {Protocol} from './Protocol.sol';
interface IAuthorizationVerifier { function verifyAuthorization(Protocol.RequestAuthorization calldata,bytes calldata) external view returns(bytes32); }
interface IFeeDebt { function feeDebt(address) external view returns(uint256); }
contract StellariumBalanceVault is ProtocolBase {
    using SafeERC20 for IERC20;
    struct Budget { address caller; bytes32 authorizationHash; uint256 remainingUsdc; uint64 expiresAt; bool open; }
    IERC20 public usdc; address public settlement; address public court; address public guardian;
    uint64 public pauseUntil; bool public emergencyUsed;
    mapping(address=>uint256) public available;
    mapping(bytes32=>Budget) public budgets;
    mapping(address=>mapping(uint256=>bool)) public usedNonce;
    event Deposited(address indexed caller,uint256 amount);
    event BudgetOpened(bytes32 indexed requestId,address indexed caller,bytes32 authorizationHash,uint256 amount,uint64 expiresAt);
    event BudgetClosed(bytes32 indexed requestId,uint256 returnedAmount);
    modifier onlySettlement() { require(msg.sender==settlement,'only settlement'); _; }
    function initialize(address governance,address token,address settlement_,address court_,address guardian_) external initializer {
        __ProtocolBase_init(governance); require(token!=address(0)&&settlement_!=address(0),'zero address');
        usdc=IERC20(token); settlement=settlement_; court=court_; guardian=guardian_;
    }
    function setGuardian(address account) external onlyOwner { guardian=account; }
    function emergencyPause() external { require(msg.sender==guardian&&!emergencyUsed,'guardian unavailable'); emergencyUsed=true; pauseUntil=uint64(block.timestamp+24 hours); }
    function governancePause(uint64 until) external onlyOwner { pauseUntil=until; }
    function resetEmergency() external onlyOwner { require(block.timestamp>=pauseUntil,'pause active'); emergencyUsed=false; }
    function deposit(uint256 amount) external nonReentrant { require(block.timestamp>=pauseUntil&&amount>0,'deposit paused'); usdc.safeTransferFrom(msg.sender,address(this),amount); available[msg.sender]+=amount; emit Deposited(msg.sender,amount); }
    function withdraw(uint256 amount) external nonReentrant { require(available[msg.sender]>=amount,'balance'); available[msg.sender]-=amount; usdc.safeTransfer(msg.sender,amount); }
    function openRequestBudget(Protocol.RequestAuthorization calldata auth,bytes calldata signature) external nonReentrant {
        require(msg.sender==auth.caller&&auth.budgetUsdc>0,'caller');
        require(court==address(0)||IFeeDebt(court).feeDebt(auth.caller)==0,'arbitration debt');
        bytes32 digest=IAuthorizationVerifier(settlement).verifyAuthorization(auth,signature);
        require(budgets[auth.requestId].caller==address(0)&&!usedNonce[auth.caller][auth.nonce],'replay');
        require(available[auth.caller]>=auth.budgetUsdc,'balance');
        available[auth.caller]-=auth.budgetUsdc; usedNonce[auth.caller][auth.nonce]=true;
        budgets[auth.requestId]=Budget(auth.caller,digest,auth.budgetUsdc,auth.expiresAt,true);
        emit BudgetOpened(auth.requestId,auth.caller,digest,auth.budgetUsdc,auth.expiresAt);
    }
    function closeRequest(bytes32 id) external {
        Budget storage b=budgets[id]; require(b.open&&(msg.sender==b.caller||block.timestamp>=b.expiresAt),'cannot close');
        b.open=false; uint256 amount=b.remainingUsdc; b.remainingUsdc=0; available[b.caller]+=amount; emit BudgetClosed(id,amount);
    }
    function reserveClaim(bytes32 id,bytes32 authHash,uint256 amount) external onlySettlement {
        Budget storage b=budgets[id]; require(b.open&&block.timestamp<b.expiresAt&&b.authorizationHash==authHash&&b.remainingUsdc>=amount,'budget'); b.remainingUsdc-=amount;
    }
    function credit(address account,uint256 amount) external onlySettlement { available[account]+=amount; }
}
