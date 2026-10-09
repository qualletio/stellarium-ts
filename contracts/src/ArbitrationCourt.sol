// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {ProtocolBase} from './ProtocolBase.sol';
import {IRandomnessAdapter} from './RandomnessAdapter.sol';
import {ReputationRegistry} from './ReputationRegistry.sol';
import {ProtocolTreasury} from './ProtocolTreasury.sol';
interface IDisputeSettlement { function resolveDispute(bytes32,bool) external; }
contract ArbitrationCourt is ProtocolBase {
    using SafeERC20 for IERC20;
    struct Arbitrator { uint256 stake; string encryptionKey; uint256 locks; bool listed; }
    struct Dispute { address caller; address provider; uint256 fee; uint8 round; uint8 phase; bool callerDeposited; bool providerDeposited; bool providerWins; uint64 appealUntil; }
    struct Round { address[] panel; uint64 evidenceUntil; uint64 voteUntil; bytes32 callerEvidence; bytes32 providerEvidence; uint8 providerVotes; uint8 votes; }
    struct Snapshot { address[] candidates; uint256[] weights; uint256 totalWeight; bytes32 receiptId; uint8 round; address adapter; }
    IERC20 public usdc; ReputationRegistry public reputation; ProtocolTreasury public treasury;
    address public settlement; IRandomnessAdapter public randomness;
    uint256 public minimumStake; uint256 public arbitrationFee;
    mapping(address=>Arbitrator) public arbitrators; address[] public arbitratorList;
    mapping(bytes32=>Dispute) public disputes;
    mapping(bytes32=>mapping(uint8=>Round)) private rounds;
    mapping(bytes32=>Snapshot) private snapshots;
    mapping(bytes32=>mapping(address=>bool)) public usedPanelMember;
    mapping(bytes32=>mapping(address=>bool)) public excludedParticipant;
    mapping(bytes32=>mapping(uint8=>mapping(address=>uint8))) public ballots;
    mapping(bytes32=>address[]) private allPanelMembers;
    mapping(address=>uint256) public withdrawable; mapping(address=>uint256) public feeDebt;
    event PanelAwaitingParticipants(bytes32 indexed receiptId,uint8 round);
    event DisputeOpened(bytes32 indexed receiptId,address caller,address provider);
    event PanelSelected(bytes32 indexed receiptId,uint8 round,address[] panel,uint64 evidenceUntil,uint64 voteUntil);
    event EvidenceCommitted(bytes32 indexed receiptId,uint8 round,address indexed party,bytes32 commitment);
    event RoundDecided(bytes32 indexed receiptId,uint8 round,bool providerWins,uint64 appealUntil);
    event DisputeFinalized(bytes32 indexed receiptId,bool providerWins);
    function initialize(address governance,address token,address reputation_,address treasury_,address settlement_,address randomness_,uint256 minimumStake_,uint256 fee) external initializer {
        __ProtocolBase_init(governance); usdc=IERC20(token); reputation=ReputationRegistry(reputation_); treasury=ProtocolTreasury(treasury_); settlement=settlement_; randomness=IRandomnessAdapter(randomness_); require(minimumStake_>0&&fee>0,'parameters'); minimumStake=minimumStake_; arbitrationFee=fee;
    }
    function setParameters(uint256 stake_,uint256 fee_) external onlyOwner { require(stake_>0&&fee_>0,'parameters'); minimumStake=stake_; arbitrationFee=fee_; }
    function setRandomnessAdapter(address adapter) external onlyOwner { require(adapter.code.length>0,'adapter'); randomness=IRandomnessAdapter(adapter); }
    function stake(uint256 amount,string calldata encryptionKey) external nonReentrant {
        require(reputation.admitted(msg.sender)&&feeDebt[msg.sender]==0&&amount>0&&bytes(encryptionKey).length>0&&bytes(encryptionKey).length<=4096,'arbitrator');
        Arbitrator storage a=arbitrators[msg.sender];
        if(!a.listed) { require(arbitratorList.length<256,'arbitrator capacity'); a.listed=true; arbitratorList.push(msg.sender); }
        require(a.locks==0||keccak256(bytes(a.encryptionKey))==keccak256(bytes(encryptionKey)),'locked encryption key');
        usdc.safeTransferFrom(msg.sender,address(this),amount); a.stake+=amount; a.encryptionKey=encryptionKey;
    }
    function unstake(uint256 amount) external nonReentrant { Arbitrator storage a=arbitrators[msg.sender]; require(a.locks==0&&a.stake>=amount,'locked stake'); a.stake-=amount; usdc.safeTransfer(msg.sender,amount); }
    function openDispute(bytes32 id,address caller,address provider,address challenger,address[] calldata exclusions) external nonReentrant {
        require(msg.sender==settlement&&disputes[id].phase==0&&(challenger==caller||challenger==provider),'settlement');
        Dispute storage d=disputes[id]; d.caller=caller; d.provider=provider; d.fee=arbitrationFee; d.phase=1;
        treasury.reserveArbitration(id,d.fee);
        usdc.safeTransferFrom(challenger,address(this),d.fee);
        if(challenger==caller) d.callerDeposited=true; else d.providerDeposited=true;
        for(uint256 i;i<exclusions.length;++i) excludedParticipant[id][exclusions[i]]=true;
        _request(id,true); emit DisputeOpened(id,caller,provider);
    }
    function depositFee(bytes32 id) external nonReentrant {
        Dispute storage d=disputes[id]; require(d.phase==1||d.phase==2,'phase');
        require(msg.sender==d.caller||msg.sender==d.provider,'party');
        if(d.phase==2) require(block.timestamp<=rounds[id][d.round].evidenceUntil,'deadline');
        if(msg.sender==d.caller) { require(!d.callerDeposited,'deposited'); d.callerDeposited=true; } else { require(!d.providerDeposited,'deposited'); d.providerDeposited=true; }
        usdc.safeTransferFrom(msg.sender,address(this),d.fee);
    }
    function _request(bytes32 id,bool initial) private {
        Dispute storage d=disputes[id]; bytes32 context=keccak256(abi.encode(id,d.round)); Snapshot storage s=snapshots[context]; s.receiptId=id; s.round=d.round; s.adapter=address(randomness);
        for(uint256 i;i<arbitratorList.length;++i) {
            address account=arbitratorList[i]; Arbitrator storage a=arbitrators[account];
            if(excludedParticipant[id][account]||account==d.caller||account==d.provider||a.stake<minimumStake||!reputation.admitted(account)||feeDebt[account]>0||usedPanelMember[id][account]) continue;
            uint256 weight=Math.mulDiv(a.stake,reputation.multiplier(account),1e18);
            s.candidates.push(account); s.weights.push(weight); s.totalWeight+=weight; a.locks++;
        }
        if(s.candidates.length<(initial?15:(d.round==1?12:7))) {
            for(uint256 i;i<s.candidates.length;++i) arbitrators[s.candidates[i]].locks--;
            delete snapshots[context]; emit PanelAwaitingParticipants(id,d.round); return;
        }
        randomness.request(context);
    }
    function requestPanel(bytes32 id) external nonReentrant {
        Dispute storage d=disputes[id]; require(d.phase==1&&snapshots[keccak256(abi.encode(id,d.round))].receiptId==bytes32(0),'panel already requested'); _request(id,d.round==0);
    }
    function randomnessReady(bytes32 context,uint256 word) external {
        Snapshot storage s=snapshots[context]; require(msg.sender==s.adapter,'adapter'); Dispute storage d=disputes[s.receiptId];
        require(s.receiptId!=bytes32(0)&&d.phase==1&&d.round==s.round,'request'); Round storage r=rounds[s.receiptId][d.round];
        uint256 size=d.round==0?3:d.round==1?5:7; uint256 total=s.totalWeight;
        for(uint256 draw;draw<size;++draw) {
            uint256 pick=uint256(keccak256(abi.encode(word,draw,context)))%total; uint256 sum;
            for(uint256 i;i<s.candidates.length;++i) {
                sum+=s.weights[i]; if(pick<sum) { address account=s.candidates[i]; r.panel.push(account); allPanelMembers[s.receiptId].push(account); usedPanelMember[s.receiptId][account]=true; total-=s.weights[i]; s.weights[i]=0; break; }
            }
        }
        for(uint256 i;i<s.candidates.length;++i) if(s.weights[i]>0) arbitrators[s.candidates[i]].locks--;
        r.evidenceUntil=uint64(block.timestamp+24 hours); r.voteUntil=uint64(block.timestamp+48 hours); d.phase=2;
        emit PanelSelected(s.receiptId,d.round,r.panel,r.evidenceUntil,r.voteUntil); delete snapshots[context];
    }
    function commitEvidence(bytes32 id,bytes32 commitment) external {
        Dispute storage d=disputes[id]; Round storage r=rounds[id][d.round]; require(d.phase==2&&block.timestamp<=r.evidenceUntil&&commitment!=bytes32(0),'evidence deadline');
        if(msg.sender==d.caller) { require(r.callerEvidence==bytes32(0),'already committed'); r.callerEvidence=commitment; }
        else { require(msg.sender==d.provider&&r.providerEvidence==bytes32(0),'party'); r.providerEvidence=commitment; }
        emit EvidenceCommitted(id,d.round,msg.sender,commitment);
    }
    function vote(bytes32 id,bool providerWins) external {
        Dispute storage d=disputes[id]; Round storage r=rounds[id][d.round]; require(d.phase==2&&block.timestamp>r.evidenceUntil&&block.timestamp<=r.voteUntil,'vote window');
        bool member; for(uint256 i;i<r.panel.length;++i) if(r.panel[i]==msg.sender) member=true;
        require(member&&ballots[id][d.round][msg.sender]==0,'panel or duplicate'); ballots[id][d.round][msg.sender]=providerWins?2:1; r.votes++; if(providerWins) r.providerVotes++;
    }
    function decide(bytes32 id) external {
        Dispute storage d=disputes[id]; Round storage r=rounds[id][d.round]; require(d.phase==2&&block.timestamp>r.evidenceUntil,'evidence pending');
        bool callerReady=d.callerDeposited&&r.callerEvidence!=bytes32(0); bool providerReady=d.providerDeposited&&r.providerEvidence!=bytes32(0);
        if(callerReady&&providerReady) require(block.timestamp>r.voteUntil||r.votes==r.panel.length,'voting pending');
        d.providerWins=providerReady&&(!callerReady||r.providerVotes>r.panel.length/2);
        for(uint256 i;i<r.panel.length;++i) arbitrators[r.panel[i]].locks--;
        d.phase=3; d.appealUntil=uint64(block.timestamp+24 hours); emit RoundDecided(id,d.round,d.providerWins,d.appealUntil);
    }
    function appeal(bytes32 id) external nonReentrant {
        Dispute storage d=disputes[id]; require(d.phase==3&&block.timestamp<d.appealUntil&&d.round<2&&(msg.sender==d.caller||msg.sender==d.provider),'appeal');
        d.round++; d.phase=1; _request(id,false);
    }
    function finalize(bytes32 id) external nonReentrant {
        Dispute storage d=disputes[id]; require(d.phase==3&&block.timestamp>=d.appealUntil,'appeal pending'); d.phase=4;
        address winner=d.providerWins?d.provider:d.caller; address loser=d.providerWins?d.caller:d.provider;
        bool winnerDeposited=d.providerWins?d.providerDeposited:d.callerDeposited; bool loserDeposited=d.providerWins?d.callerDeposited:d.providerDeposited;
        if(winnerDeposited) withdrawable[winner]+=d.fee;
        treasury.settleArbitrationReserve(id,address(this),loserDeposited?0:d.fee);
        if(!loserDeposited) feeDebt[loser]+=d.fee;
        uint256 votingMembers;
        for(uint8 round;round<=d.round;++round) for(uint256 i;i<rounds[id][round].panel.length;++i) if(ballots[id][round][rounds[id][round].panel[i]]>0) votingMembers++;
        uint256 each=votingMembers==0?0:d.fee/votingMembers; uint256 allocated;
        for(uint8 round;round<=d.round;++round) for(uint256 i;i<rounds[id][round].panel.length;++i) { address account=rounds[id][round].panel[i]; if(ballots[id][round][account]>0) { withdrawable[account]+=each; allocated+=each; } }
        uint256 rest=d.fee-allocated; if(rest>0) { usdc.forceApprove(address(treasury),rest); treasury.fundReserve(rest); }
        Round storage finalRound=rounds[id][d.round]; address[] memory correct=new address[](finalRound.panel.length); uint256 count;
        for(uint256 i;i<finalRound.panel.length;++i) if(ballots[id][d.round][finalRound.panel[i]]==(d.providerWins?2:1)) correct[count++]=finalRound.panel[i];
        assembly { mstore(correct,count) }
        reputation.recordDispute(id,d.caller,d.provider,d.providerWins,correct);
        IDisputeSettlement(settlement).resolveDispute(id,d.providerWins); emit DisputeFinalized(id,d.providerWins);
    }
    function repayFeeDebt(uint256 amount) external nonReentrant { require(amount>0&&amount<=feeDebt[msg.sender],'debt'); feeDebt[msg.sender]-=amount; usdc.safeTransferFrom(msg.sender,address(this),amount); usdc.forceApprove(address(treasury),amount); treasury.fundReserve(amount); }
    function withdrawFees() external nonReentrant { uint256 amount=withdrawable[msg.sender]; withdrawable[msg.sender]=0; usdc.safeTransfer(msg.sender,amount); }
    function getRound(bytes32 id,uint8 round) external view returns(Round memory) { return rounds[id][round]; }
}
