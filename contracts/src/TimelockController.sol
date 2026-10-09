// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {TimelockControllerUpgradeable} from '@openzeppelin/contracts-upgradeable/governance/TimelockControllerUpgradeable.sol';
import {UUPSUpgradeable} from '@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol';
contract TimelockController is TimelockControllerUpgradeable,UUPSUpgradeable {
    constructor() { _disableInitializers(); }
    function initialize(address proposer) external initializer {
        address[] memory proposers=new address[](1); proposers[0]=proposer;
        address[] memory executors=new address[](1); executors[0]=address(0);
        __TimelockController_init(48 hours,proposers,executors,address(0));
    }
    function requiredDelay(address,bytes calldata data) public pure returns(uint256) {
        bytes4 selector=data.length>=4?bytes4(data[:4]):bytes4(0);
        if(selector==bytes4(keccak256('upgradeToAndCall(address,bytes)'))||selector==bytes4(keccak256('transferOwnership(address)'))||selector==bytes4(keccak256('updateDelay(uint256)'))||selector==bytes4(keccak256('setRandomnessAdapter(address)'))) return 7 days;
        return 48 hours;
    }
    function schedule(address target,uint256 value,bytes calldata data,bytes32 predecessor,bytes32 salt,uint256 delay) public override {
        require(delay>=requiredDelay(target,data),'operation delay'); super.schedule(target,value,data,predecessor,salt,delay);
    }
    function scheduleBatch(address[] calldata targets,uint256[] calldata values,bytes[] calldata payloads,bytes32 predecessor,bytes32 salt,uint256 delay) public override {
        require(targets.length==payloads.length,'length'); for(uint256 i;i<targets.length;++i) require(delay>=requiredDelay(targets[i],payloads[i]),'operation delay');
        super.scheduleBatch(targets,values,payloads,predecessor,salt,delay);
    }
    function updateDelay(uint256 newDelay) public override { require(newDelay>=48 hours,'minimum delay'); super.updateDelay(newDelay); }
    function _authorizeUpgrade(address) internal view override onlyRole(DEFAULT_ADMIN_ROLE) { require(msg.sender==address(this),'timelock upgrade'); }
}
