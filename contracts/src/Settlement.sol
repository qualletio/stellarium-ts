// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {ProtocolBase} from './ProtocolBase.sol';
import {Protocol} from './Protocol.sol';
import {StellariumBalanceVault} from './StellariumBalanceVault.sol';
import {ResourceRegistry} from './ResourceRegistry.sol';
import {RelayRegistry} from './RelayRegistry.sol';
import {ReputationRegistry} from './ReputationRegistry.sol';
import {IFeeOracle} from './FeeOracle.sol';
import {ProtocolTreasury} from './ProtocolTreasury.sol';
interface IArbitrationCourt { function openDispute(bytes32 receiptId,address caller,address provider,address challenger,address[] calldata exclusions) external; }
contract Settlement is ProtocolBase {
    struct PendingClaim { address caller; address provider; address recipient; address relay; uint256 gross; uint256 relayFee; uint256 protocolFee; uint256 providerNet; uint64 challengeUntil; uint8 state; bool accepted; }
    StellariumBalanceVault public vault; ResourceRegistry public registry; RelayRegistry public relays;
    ReputationRegistry public reputation; IFeeOracle public feeOracle; ProtocolTreasury public treasury; address public court; address public guardian;
    uint64 public pauseUntil; bool public emergencyUsed;
    mapping(bytes32=>PendingClaim) public claims;
    mapping(bytes32=>bool) public usedInvocation;
    mapping(bytes32=>address[]) private disputeExclusions;
    event ClaimSubmitted(bytes32 indexed receiptId,bytes32 indexed requestId,bytes32 indexed invocationId,uint64 challengeUntil,bool accepted);
    event ClaimRejected(bytes32 indexed receiptId,bytes reason);
    event ClaimResolved(bytes32 indexed receiptId,bool paid);
    function initialize(address governance,address vault_,address registry_,address relays_,address reputation_,address fee_,address treasury_,address court_,address guardian_) external initializer {
        __ProtocolBase_init(governance); vault=StellariumBalanceVault(vault_); registry=ResourceRegistry(registry_); relays=RelayRegistry(relays_); reputation=ReputationRegistry(reputation_); feeOracle=IFeeOracle(fee_); treasury=ProtocolTreasury(treasury_); court=court_; guardian=guardian_;
    }
    function setGuardian(address account) external onlyOwner { guardian=account; }
    function emergencyPause() external { require(msg.sender==guardian&&!emergencyUsed,'guardian unavailable'); emergencyUsed=true; pauseUntil=uint64(block.timestamp+24 hours); }
    function governancePause(uint64 until) external onlyOwner { pauseUntil=until; }
    function resetEmergency() external onlyOwner { require(block.timestamp>=pauseUntil,'pause active'); emergencyUsed=false; }
    function setFeeOracle(address oracle) external onlyOwner { require(oracle.code.length>0,'oracle'); feeOracle=IFeeOracle(oracle); }
    function verifyAuthorization(Protocol.RequestAuthorization calldata a,bytes calldata signature) public view returns(bytes32 digest) {
        require(a.protocolVersion==1&&a.issuedAt<=block.timestamp&&a.expiresAt>block.timestamp&&a.expiresAt>a.issuedAt,'authorization time');
        require(a.caller.code.length==0&&a.executionAuthority.code.length==0&&a.executionAuthority!=address(0)&&reputation.admitted(a.caller),'EOA or admission');
        digest=_hashTypedDataV4(Protocol.hash(a)); require(ECDSA.recover(digest,signature)==a.caller,'caller signature');
    }
    function hashGrant(Protocol.InvocationGrant calldata g) external view returns(bytes32) { return _hashTypedDataV4(Protocol.hash(g)); }
    function hashReceipt(Protocol.ExecutionReceipt calldata r) external view returns(bytes32) { return _hashTypedDataV4(Protocol.hash(r)); }
    function validateClaim(Protocol.Claim calldata c,address submitter) public view returns(bytes32 invocationKey,bool accepted) {
        Protocol.RequestAuthorization calldata a=c.authorization; Protocol.InvocationGrant calldata g=c.grant; Protocol.ExecutionReceipt calldata r=c.receipt;
        bytes32 authHash=verifyAuthorization(a,c.callerSignature);
        require(g.protocolVersion==1&&r.protocolVersion==1&&g.requestId==a.requestId&&g.authorizationHash==authHash,'grant request');
        bytes32 grantHash=_hashTypedDataV4(Protocol.hash(g)); require(ECDSA.recover(grantHash,c.authoritySignature)==a.executionAuthority,'grant signature');
        require(g.issuedAt>=a.issuedAt&&g.issuedAt<=r.executedAt&&g.expiresAt<=a.expiresAt&&g.expiresAt>=g.issuedAt&&r.executedAt<=g.expiresAt,'grant time');
        require(r.requestId==a.requestId&&r.authorizationHash==authHash&&r.invocationId==grantHash&&r.invocationGrantHash==grantHash,'receipt request');
        require(r.receiptId==keccak256(abi.encode(block.chainid,address(this),a.requestId,grantHash)),'receipt id');
        invocationKey=keccak256(abi.encode(a.requestId,grantHash)); require(!usedInvocation[invocationKey]&&claims[r.receiptId].state==0,'duplicate');
        require(r.resourceId==g.resourceId&&r.manifestRevision==g.manifestRevision&&r.providerPaymentIdentity==g.providerPaymentIdentity&&r.functionNameHash==g.functionNameHash&&r.parametersHash==g.parametersHash&&r.quoteId==g.quoteId&&r.grossPriceUsdc==g.grossPriceUsdc,'receipt terms');
        require(r.executedAt<=block.timestamp&&block.timestamp-r.executedAt<=30 minutes&&r.issuedAt>=r.executedAt&&r.issuedAt<=block.timestamp,'receipt time');
        require(registry.validateQuote(r.resourceId,r.manifestRevision,r.quoteId,r.functionNameHash,r.grossPriceUsdc,g.issuedAt,r.executedAt,r.providerPaymentIdentity,r.paymentRecipient,r.receiptSigner),'historical quote');
        require(ECDSA.recover(_hashTypedDataV4(Protocol.hash(r)),c.providerSignature)==r.receiptSigner,'provider signature');
        require(r.relay==submitter&&relays.eligible(submitter)&&r.relay.code.length==0&&r.relayFeeUsdc<=r.grossPriceUsdc,'relay');
        (address caller,bytes32 hash,uint256 remaining,uint64 expiry,bool open)=vault.budgets(a.requestId);
        require(caller==a.caller&&hash==authHash&&open&&expiry==a.expiresAt&&remaining>=r.grossPriceUsdc,'budget');
        if(c.acceptanceSignature.length>0) {
            require(c.acceptance.protocolVersion==1&&c.acceptance.receiptHash==_hashTypedDataV4(Protocol.hash(r))&&c.acceptance.issuedAt>=r.executedAt&&c.acceptance.issuedAt<=block.timestamp,'acceptance terms');
            require(ECDSA.recover(_hashTypedDataV4(Protocol.hash(c.acceptance)),c.acceptanceSignature)==a.caller,'acceptance signature'); accepted=true;
        }
    }
    function acceptClaim(Protocol.Claim calldata c,address submitter) external {
        require(msg.sender==address(this),'self');
        (bytes32 invocationKey,bool accepted)=validateClaim(c,submitter);
        Protocol.ExecutionReceipt calldata r=c.receipt;
        vault.reserveClaim(r.requestId,r.authorizationHash,r.grossPriceUsdc); usedInvocation[invocationKey]=true;
        claims[r.receiptId]=PendingClaim(c.authorization.caller,r.providerPaymentIdentity,r.paymentRecipient,r.relay,r.grossPriceUsdc,r.relayFeeUsdc,0,0,uint64(block.timestamp+1 hours),1,accepted);
        address[] storage excluded=disputeExclusions[r.receiptId]; excluded.push(c.authorization.caller); excluded.push(r.providerPaymentIdentity); excluded.push(r.paymentRecipient); excluded.push(r.receiptSigner); excluded.push(r.relay);
        emit ClaimSubmitted(r.receiptId,r.requestId,r.invocationId,uint64(block.timestamp+1 hours),accepted);
    }
    function submitBatch(Protocol.Claim[] calldata batch) external nonReentrant {
        require(block.timestamp>=pauseUntil&&batch.length>0&&batch.length<=100,'batch or pause');
        uint256 startGas=gasleft(); bytes32[] memory ids=new bytes32[](batch.length); uint256 count;
        for(uint256 i;i<batch.length;++i) {
            try this.acceptClaim(batch[i],msg.sender) { ids[count++]=batch[i].receipt.receiptId; }
            catch(bytes memory reason) { emit ClaimRejected(batch[i].receipt.receiptId,reason); }
        }
        require(count>0,'no valid claims');
        uint256 totalFee=feeOracle.batchFee(startGas-gasleft(),msg.data.length);
        uint256 each=totalFee/count; uint256 remainder=totalFee%count;
        for(uint256 i;i<count;++i) {
            PendingClaim storage c=claims[ids[i]]; uint256 fee=each+(i<remainder?1:0); uint256 room=c.gross-c.relayFee;
            c.protocolFee=fee>room?room:fee; c.providerNet=room-c.protocolFee;
        }
    }
    function challenge(bytes32 id) external nonReentrant {
        PendingClaim storage c=claims[id]; require(c.state==1&&block.timestamp<c.challengeUntil&&(msg.sender==c.caller||msg.sender==c.provider),'challenge');
        require(c.caller!=c.provider,'same identity'); c.state=2; IArbitrationCourt(court).openDispute(id,c.caller,c.provider,msg.sender,disputeExclusions[id]);
    }
    function finalize(bytes32 id) external nonReentrant { PendingClaim storage c=claims[id]; require(c.state==1&&block.timestamp>=c.challengeUntil,'locked'); _resolve(id,true); }
    function resolveDispute(bytes32 id,bool providerWins) external nonReentrant { require(msg.sender==court&&claims[id].state==2,'court'); _resolve(id,providerWins); }
    function _resolve(bytes32 id,bool paid) private {
        PendingClaim storage c=claims[id]; c.state=paid?3:4;
        if(paid) {
            vault.credit(c.recipient,c.providerNet); vault.credit(c.relay,c.relayFee); vault.credit(address(treasury),c.protocolFee); treasury.recordFee(c.protocolFee);
            reputation.recordSettlement(id,c.caller,c.provider,c.relay,c.accepted);
        } else vault.credit(c.caller,c.gross);
        emit ClaimResolved(id,paid);
    }
}
