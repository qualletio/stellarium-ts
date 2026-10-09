// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AtomicProxy} from './AtomicProxy.sol';
/** Initializes all circularly referenced proxies atomically, with no public uninitialized interval. */
contract DeploymentFactory {
    address public immutable deployer;
    constructor() { deployer=msg.sender; }
    function predict(address implementation,bytes32 salt) public view returns(address) {
        bytes32 codeHash=keccak256(abi.encodePacked(type(AtomicProxy).creationCode,abi.encode(implementation)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff),address(this),salt,codeHash)))));
    }
    function deploy(address[] calldata implementations,bytes32[] calldata salts,bytes[] calldata initializers) external returns(address[] memory proxies) {
        require(msg.sender==deployer&&implementations.length==salts.length&&salts.length==initializers.length&&salts.length>0&&salts.length<=16,'deployment');
        proxies=new address[](salts.length);
        for(uint256 i;i<salts.length;++i) { require(implementations[i].code.length>0&&initializers[i].length>=4,'implementation'); proxies[i]=address(new AtomicProxy{salt:salts[i]}(implementations[i])); }
        for(uint256 i;i<salts.length;++i) { (bool success,bytes memory reason)=proxies[i].call(initializers[i]); if(!success) assembly { revert(add(reason,32),mload(reason)) } AtomicProxy(payable(proxies[i])).finalizeInitialization(); }
    }
}
