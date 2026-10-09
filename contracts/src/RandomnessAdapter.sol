// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ProtocolBase} from './ProtocolBase.sol';
interface IRandomnessAdapter { function request(bytes32 context) external returns(uint256); }
interface IRandomnessConsumer { function randomnessReady(bytes32 context,uint256 word) external; }
interface IVRFCoordinatorV2Plus {
    struct RandomWordsRequest { bytes32 keyHash; uint256 subId; uint16 requestConfirmations; uint32 callbackGasLimit; uint32 numWords; bytes extraArgs; }
    function requestRandomWords(RandomWordsRequest calldata) external returns(uint256);
}
/** Chainlink VRF v2.5 subscription adapter. Callback only persists randomness; delivery can be retried permissionlessly. */
contract RandomnessAdapter is ProtocolBase,IRandomnessAdapter {
    IVRFCoordinatorV2Plus public coordinator; address public court;
    bytes32 public keyHash; uint256 public subscriptionId; uint16 public confirmations; uint32 public callbackGasLimit;
    mapping(uint256=>bytes32) public contexts; mapping(uint256=>uint256) public words;
    mapping(uint256=>bool) public fulfilled; mapping(uint256=>bool) public delivered;
    event RandomnessRequested(uint256 indexed requestId,bytes32 indexed context);
    function initialize(address governance,address coordinator_,address court_,bytes32 keyHash_,uint256 subscriptionId_,uint16 confirmations_,uint32 callbackGasLimit_) external initializer {
        __ProtocolBase_init(governance); coordinator=IVRFCoordinatorV2Plus(coordinator_); court=court_; keyHash=keyHash_; subscriptionId=subscriptionId_; confirmations=confirmations_; callbackGasLimit=callbackGasLimit_; require(coordinator_!=address(0)&&court_!=address(0)&&confirmations_>0,'randomness config');
    }
    function request(bytes32 context) external returns(uint256 id) {
        require(msg.sender==court,'court');
        id=coordinator.requestRandomWords(IVRFCoordinatorV2Plus.RandomWordsRequest(keyHash,subscriptionId,confirmations,callbackGasLimit,1,abi.encodeWithSelector(bytes4(keccak256('VRF ExtraArgsV1')),true)));
        require(contexts[id]==bytes32(0),'duplicate request'); contexts[id]=context; emit RandomnessRequested(id,context);
    }
    function rawFulfillRandomWords(uint256 id,uint256[] calldata randomWords) external {
        require(msg.sender==address(coordinator)&&contexts[id]!=bytes32(0)&&!fulfilled[id]&&randomWords.length==1,'VRF callback'); fulfilled[id]=true; words[id]=randomWords[0];
    }
    function deliver(uint256 id) external { require(fulfilled[id]&&!delivered[id],'not deliverable'); delivered[id]=true; IRandomnessConsumer(court).randomnessReady(contexts[id],words[id]); }
}
