// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Checkpoints} from '@openzeppelin/contracts/utils/structs/Checkpoints.sol';
import {ProtocolBase} from './ProtocolBase.sol';
contract ReputationRegistry is ProtocolBase {
    using Checkpoints for Checkpoints.Trace208;
    struct Facts { uint64 settlements; uint64 acceptances; uint64 wins; uint64 losses; uint64 lastSettlement; }
    mapping(address=>bool) public admitted;
    mapping(address=>bool) public seed;
    mapping(address=>address[3]) public sponsors;
    mapping(address=>uint8) public sponsorCount;
    mapping(address=>uint64[3]) private sponsorshipTimes;
    mapping(address=>mapping(uint8=>Facts)) public facts;
    mapping(address=>bool) public reporter;
    mapping(bytes32=>bool) public recorded;
    address[] public participants;
    uint64 public bootstrapUntil;
    uint256 public settlementWeight; uint256 public acceptanceWeight; uint256 public winWeight; uint256 public lossWeight;
    uint256 public eligibilityThreshold; uint256 public multiplierScale;
    mapping(address=>Checkpoints.Trace208) private votingPower;
    Checkpoints.Trace208 private totalVotingPower;
    event Sponsored(address indexed sponsor,address indexed candidate);
    event Outcome(bytes32 indexed commitment,address indexed identity,uint8 role,uint256 score);
    function initialize(address governance,address[] calldata initialSeeds,uint256[6] calldata parameters) external initializer {
        __ProtocolBase_init(governance); bootstrapUntil=uint64(block.timestamp+30 days);
        _parameters(parameters); require(initialSeeds.length>=3,'need bootstrap sponsors');
        for(uint256 i;i<initialSeeds.length;++i) { require(initialSeeds[i]!=address(0)&&initialSeeds[i].code.length==0&&!admitted[initialSeeds[i]],'duplicate seed'); admitted[initialSeeds[i]]=true; seed[initialSeeds[i]]=true; participants.push(initialSeeds[i]); }
    }
    function _parameters(uint256[6] calldata p) private {
        for(uint256 i;i<4;++i) require(p[i]<=1e12,'coefficient');
        require(p[4]>0&&p[5]>0,'threshold');
        settlementWeight=p[0]; acceptanceWeight=p[1]; winWeight=p[2]; lossWeight=p[3]; eligibilityThreshold=p[4]; multiplierScale=p[5];
    }
    function setParameters(uint256[6] calldata p) external onlyOwner {
        _parameters(p);
        for(uint256 i;i<participants.length;++i) _checkpoint(participants[i]);
    }
    function setReporter(address account,bool enabled) external onlyOwner { reporter[account]=enabled; }
    function score(address account,uint8 role) public view returns(uint256) {
        Facts storage f=facts[account][role]; uint256 positive=uint256(f.settlements)*settlementWeight+uint256(f.acceptances)*acceptanceWeight+uint256(f.wins)*winWeight; uint256 negative=uint256(f.losses)*lossWeight;
        return positive>negative ? positive-negative : 0;
    }
    function isActive(address account) public view returns(bool) {
        for(uint8 role;role<4;++role) if(score(account,role)>0&&facts[account][role].lastSettlement>0&&block.timestamp<=facts[account][role].lastSettlement+90 days) return true;
        return false;
    }
    function activeCount() external view returns(uint256 count) { for(uint256 i;i<participants.length;++i) if(isActive(participants[i])) ++count; }
    function sponsor(address candidate) external {
        require(admitted[msg.sender]&&candidate!=msg.sender&&!admitted[candidate]&&candidate!=address(0)&&candidate.code.length==0,'sponsorship');
        bool eligible; for(uint8 role;role<4;++role) if(score(msg.sender,role)>=eligibilityThreshold) eligible=true;
        require((isActive(msg.sender)&&eligible)||(seed[msg.sender]&&block.timestamp<bootstrapUntil),'inactive sponsor');
        uint64[3] storage times=sponsorshipTimes[msg.sender]; uint256 slot;
        for(uint256 i=1;i<3;++i) if(times[i]<times[slot]) slot=i;
        require(times[slot]==0||block.timestamp>=times[slot]+30 days,'sponsor rate');
        uint8 count=sponsorCount[candidate]; for(uint256 i;i<count;++i) require(sponsors[candidate][i]!=msg.sender,'duplicate sponsor');
        sponsors[candidate][count]=msg.sender; sponsorCount[candidate]=count+1; times[slot]=uint64(block.timestamp);
        if(count==2) { admitted[candidate]=true; participants.push(candidate); }
        emit Sponsored(msg.sender,candidate);
    }
    function recordSettlement(bytes32 commitment,address caller,address provider,address relay,bool accepted) external {
        bytes32 factId=keccak256(abi.encode('settlement',commitment)); require(reporter[msg.sender]&&!recorded[factId],'reporter or duplicate'); recorded[factId]=true;
        _settled(caller,0,accepted); _settled(provider,1,accepted); _settled(relay,2,false);
        emit Outcome(commitment,provider,1,score(provider,1));
    }
    function _settled(address account,uint8 role,bool accepted) private {
        Facts storage f=facts[account][role]; f.settlements++; if(accepted) f.acceptances++; f.lastSettlement=uint64(block.timestamp); _checkpoint(account);
    }
    function recordDispute(bytes32 commitment,address caller,address provider,bool providerWins,address[] calldata panel) external {
        bytes32 factId=keccak256(abi.encode('dispute',commitment)); require(reporter[msg.sender]&&!recorded[factId],'reporter or duplicate'); recorded[factId]=true;
        if(providerWins) { facts[provider][1].wins++; facts[caller][0].losses++; } else { facts[caller][0].wins++; facts[provider][1].losses++; }
        _checkpoint(caller); _checkpoint(provider);
        for(uint256 i;i<panel.length;++i) { facts[panel[i]][3].wins++; _checkpoint(panel[i]); }
    }
    function multiplier(address account) external view returns(uint256) { uint256 extra=score(account,3)*1e18/multiplierScale; return 1e18+(extra>2e18?2e18:extra); }
    function _checkpoint(address account) private {
        uint256 total; for(uint8 role;role<4;++role) total+=score(account,role);
        uint256 old=votingPower[account].latest(); uint256 next=uint256(totalVotingPower.latest())+total-old;
        require(total<=type(uint208).max&&next<=type(uint208).max,'score overflow');
        votingPower[account].push(uint48(block.timestamp),uint208(total)); totalVotingPower.push(uint48(block.timestamp),uint208(next));
    }
    function getPastVotes(address account,uint256 at) external view returns(uint256) { require(at<block.timestamp,'future snapshot'); return votingPower[account].upperLookupRecent(uint48(at)); }
    function getPastTotalVotes(uint256 at) external view returns(uint256) { require(at<block.timestamp,'future snapshot'); return totalVotingPower.upperLookupRecent(uint48(at)); }
}
