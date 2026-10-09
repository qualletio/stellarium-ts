// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {ProtocolBase} from './ProtocolBase.sol';
contract StewardMultisig is ProtocolBase {
    mapping(address=>bool) public steward; address[5] public stewards;
    address public timelock; address public vault; address public settlement; uint256 public nonce;
    bytes32 private constant ACTION_TYPEHASH=keccak256('StewardAction(uint32 protocolVersion,address target,uint256 value,bytes32 dataHash,uint64 issuedAt,uint64 expiresAt,uint256 nonce)');
    function initialize(address governance,address[5] calldata owners,address vault_,address settlement_) external initializer {
        __ProtocolBase_init(governance); timelock=governance; vault=vault_; settlement=settlement_;
        for(uint256 i;i<5;++i) { require(owners[i]!=address(0)&&!steward[owners[i]]&&owners[i].code.length==0,'steward'); steward[owners[i]]=true; stewards[i]=owners[i]; }
    }
    function execute(address target,uint256 value,bytes calldata data,uint64 issuedAt,uint64 expiresAt,bytes[] calldata signatures) external payable nonReentrant returns(bytes memory result) {
        require(signatures.length>=3&&signatures.length<=5&&issuedAt<=block.timestamp&&expiresAt>block.timestamp,'action');
        bool pause=(target==vault||target==settlement)&&data.length==4&&bytes4(data)==bytes4(keccak256('emergencyPause()'));
        require(target==timelock||pause,'timelock only');
        bytes32 digest=_hashTypedDataV4(keccak256(abi.encode(ACTION_TYPEHASH,uint32(1),target,value,keccak256(data),issuedAt,expiresAt,nonce)));
        address previous; for(uint256 i;i<signatures.length;++i) { address signer=ECDSA.recover(digest,signatures[i]); require(steward[signer]&&signer>previous,'signature'); previous=signer; }
        nonce++; (bool success,bytes memory response)=target.call{value:value}(data); require(success,'action failed'); return response;
    }
    receive() external payable {}
}
