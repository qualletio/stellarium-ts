// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {ProtocolBase} from './ProtocolBase.sol';
import {Protocol} from './Protocol.sol';
import {IFeeDebt} from './StellariumBalanceVault.sol';
interface IAdmission { function admitted(address) external view returns(bool); }
contract ResourceRegistry is ProtocolBase {
    struct Revision { address paymentIdentity; address paymentRecipient; address receiptSigner; bytes32 manifestHash; uint64 activatedAt; uint64 retiredAt; }
    struct Quote { bytes32 functionNameHash; uint256 grossPriceUsdc; bool exists; }
    address public usdc; IAdmission public reputation; IFeeDebt public court;
    mapping(bytes32=>uint256) public currentRevision;
    mapping(bytes32=>mapping(uint256=>Revision)) public revisions;
    mapping(bytes32=>mapping(uint256=>mapping(bytes32=>Quote))) public quotes;
    mapping(bytes32=>bool) public usedQuoteId;
    mapping(bytes32=>mapping(uint256=>string)) private manifestData;
    event ManifestPublished(bytes32 indexed resourceId,uint256 indexed revision,bytes32 manifestHash);
    function initialize(address governance,address token,address reputation_,address court_) external initializer { __ProtocolBase_init(governance); usdc=token; reputation=IAdmission(reputation_); court=IFeeDebt(court_); }
    function publishManifest(Protocol.MonetizationManifest calldata m,bytes calldata signature,string calldata data) external {
        require(m.protocolVersion==1&&m.usdc==usdc&&m.issuedAt<=block.timestamp&&m.functions.length>0&&m.functions.length<=128,'manifest');
        require(m.paymentIdentity!=address(0)&&m.paymentRecipient!=address(0)&&m.receiptSigner!=address(0)&&m.paymentIdentity.code.length==0&&m.paymentRecipient.code.length==0&&m.receiptSigner.code.length==0&&reputation.admitted(m.paymentIdentity),'identity'); require(court.feeDebt(m.paymentIdentity)==0,'arbitration debt');
        bytes32 digest=_hashTypedDataV4(Protocol.hash(m)); require(ECDSA.recover(digest,signature)==m.paymentIdentity,'signature');
        uint256 old=currentRevision[m.resourceId]; require(m.manifestRevision==old+1,'revision');
        if(old>0) { require(revisions[m.resourceId][old].paymentIdentity==m.paymentIdentity,'owner'); revisions[m.resourceId][old].retiredAt=uint64(block.timestamp); }
        for(uint256 i;i<m.functions.length;++i) {
            Protocol.FunctionQuote calldata q=m.functions[i]; require(!usedQuoteId[q.quoteId]&&bytes(q.name).length>0,'quote');
            bytes32 fn=keccak256(bytes(q.name));
            for(uint256 j;j<i;++j) require(keccak256(bytes(m.functions[j].name))!=fn,'duplicate function');
            usedQuoteId[q.quoteId]=true; quotes[m.resourceId][m.manifestRevision][q.quoteId]=Quote(fn,q.grossPriceUsdc,true);
        }
        revisions[m.resourceId][m.manifestRevision]=Revision(m.paymentIdentity,m.paymentRecipient,m.receiptSigner,digest,uint64(block.timestamp),0);
        currentRevision[m.resourceId]=m.manifestRevision; manifestData[m.resourceId][m.manifestRevision]=data;
        emit ManifestPublished(m.resourceId,m.manifestRevision,digest);
    }
    function getManifest(bytes32 id,uint256 revision) external view returns(string memory) { return manifestData[id][revision]; }
    function activeAt(bytes32 id,uint256 revision,uint64 at) public view returns(bool) { Revision storage r=revisions[id][revision]; return r.activatedAt>0&&at>=r.activatedAt&&(r.retiredAt==0||at<r.retiredAt); }
    function validateQuote(bytes32 id,uint256 revision,bytes32 quoteId,bytes32 functionHash,uint256 price,uint64 issuedAt,uint64 executedAt,address identity,address recipient,address signer) external view returns(bool) {
        Revision storage r=revisions[id][revision]; Quote storage q=quotes[id][revision][quoteId];
        return activeAt(id,revision,issuedAt)&&activeAt(id,revision,executedAt)&&q.exists&&q.functionNameHash==functionHash&&q.grossPriceUsdc==price&&r.paymentIdentity==identity&&r.paymentRecipient==recipient&&r.receiptSigner==signer;
    }
}
