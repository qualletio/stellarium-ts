// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {StorageSlot} from '@openzeppelin/contracts/utils/StorageSlot.sol';
/** DeploymentFactory creates, initializes, and finalizes these proxies within one transaction. */
contract AtomicProxy is ERC1967Proxy {
    bytes32 private constant INITIALIZED_SLOT=keccak256('stellarium.atomic.proxy.initialized');
    address private immutable factory;
    constructor(address implementation) ERC1967Proxy(implementation,'') { factory=msg.sender; }
    function _unsafeAllowUninitialized() internal pure override returns(bool) { return true; }
    function finalizeInitialization() external { require(msg.sender==factory,'factory'); StorageSlot.getBooleanSlot(INITIALIZED_SLOT).value=true; }
    receive() external payable { _fallback(); }
    function _fallback() internal override {
        require(StorageSlot.getBooleanSlot(INITIALIZED_SLOT).value||msg.sender==factory,'initialization pending'); super._fallback();
    }
}
