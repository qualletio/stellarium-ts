// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ProtocolBase} from './ProtocolBase.sol';
import {ReputationRegistry} from './ReputationRegistry.sol';
import {TimelockController} from './TimelockController.sol';
contract Governor is ProtocolBase {
    struct Proposal { address proposer; uint64 snapshot; uint64 deadline; uint256 forVotes; uint256 againstVotes; bool queued; bool executed; address[] targets; uint256[] values; bytes[] data; }
    ReputationRegistry public reputation; TimelockController public timelock;
    address public launchMultisig; bool public activated; uint64 public votingDelay; uint64 public votingPeriod; uint256 public quorumBps;
    mapping(bytes32=>Proposal) private proposals; mapping(bytes32=>mapping(address=>bool)) public hasVoted;
    event Proposed(bytes32 indexed id,address proposer,uint64 snapshot,uint64 deadline);
    event GovernanceActivated();
    function initialize(address governance,address reputation_,address timelock_,address launch_,uint64 delay,uint64 period,uint256 quorum) external initializer {
        __ProtocolBase_init(governance); reputation=ReputationRegistry(reputation_); timelock=TimelockController(payable(timelock_)); launchMultisig=launch_; require(delay>0&&period>=1 days&&quorum>0&&quorum<=10000,'governance parameters'); votingDelay=delay; votingPeriod=period; quorumBps=quorum;
    }
    function activate() external onlyOwner {
        require(!activated&&reputation.activeCount()>=100,'transition condition');
        require(timelock.hasRole(timelock.PROPOSER_ROLE(),address(this))&&!timelock.hasRole(timelock.PROPOSER_ROLE(),launchMultisig)&&!timelock.hasRole(timelock.CANCELLER_ROLE(),launchMultisig),'transition roles');
        activated=true; emit GovernanceActivated();
    }
    function setParameters(uint64 delay,uint64 period,uint256 quorum) external onlyOwner { require(delay>0&&period>=1 days&&quorum>0&&quorum<=10000,'parameters'); votingDelay=delay; votingPeriod=period; quorumBps=quorum; }
    function propose(address[] calldata targets,uint256[] calldata values,bytes[] calldata data,bytes32 descriptionHash) external returns(bytes32 id) {
        require(activated&&reputation.isActive(msg.sender)&&targets.length>0&&targets.length<=100&&targets.length==values.length&&targets.length==data.length,'proposal');
        id=keccak256(abi.encode(targets,values,data,descriptionHash)); require(proposals[id].proposer==address(0),'duplicate');
        Proposal storage p=proposals[id]; p.proposer=msg.sender; p.snapshot=uint64(block.timestamp+votingDelay); p.deadline=p.snapshot+votingPeriod;
        p.targets=targets; p.values=values; p.data=data; emit Proposed(id,msg.sender,p.snapshot,p.deadline);
    }
    function vote(bytes32 id,bool support) external {
        Proposal storage p=proposals[id]; require(block.timestamp>p.snapshot&&block.timestamp<=p.deadline&&p.proposer!=address(0)&&!hasVoted[id][msg.sender],'vote');
        require(reputation.isActive(msg.sender),'inactive voter'); uint256 weight=reputation.getPastVotes(msg.sender,p.snapshot); require(weight>0,'voting power'); hasVoted[id][msg.sender]=true;
        if(support) p.forVotes+=weight; else p.againstVotes+=weight;
    }
    function queue(bytes32 id) external {
        Proposal storage p=proposals[id]; require(p.proposer!=address(0)&&block.timestamp>p.deadline&&!p.queued&&p.forVotes>p.againstVotes&&p.forVotes+p.againstVotes>=reputation.getPastTotalVotes(p.snapshot)*quorumBps/10000,'not passed');
        uint256 delay=timelock.getMinDelay(); for(uint256 i;i<p.targets.length;++i) { uint256 required=timelock.requiredDelay(p.targets[i],p.data[i]); if(required>delay) delay=required; }
        p.queued=true; timelock.scheduleBatch(p.targets,p.values,p.data,bytes32(0),id,delay);
    }
    function execute(bytes32 id) external payable {
        Proposal storage p=proposals[id]; require(p.queued&&!p.executed,'not queued'); p.executed=true; timelock.executeBatch{value:msg.value}(p.targets,p.values,p.data,bytes32(0),id);
    }
    function getProposal(bytes32 id) external view returns(Proposal memory) { return proposals[id]; }
}
