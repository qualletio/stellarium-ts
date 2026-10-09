// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Initializable} from '@openzeppelin/contracts/proxy/utils/Initializable.sol';
import {OwnableUpgradeable} from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import {EIP712Upgradeable} from '@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol';
import {ReentrancyGuardTransient} from '@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol';
import {UUPSUpgradeable} from '@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol';
abstract contract ProtocolBase is Initializable,OwnableUpgradeable,EIP712Upgradeable,ReentrancyGuardTransient,UUPSUpgradeable {
    constructor() { _disableInitializers(); }
    function __ProtocolBase_init(address governance) internal onlyInitializing {
        require(governance!=address(0),'zero governance');
        __Ownable_init(governance); __EIP712_init('Stellarium','1');
    }
    function _authorizeUpgrade(address) internal override onlyOwner {}
    function domainHash(bytes32 structHash) public view returns(bytes32) { return _hashTypedDataV4(structHash); }
}
