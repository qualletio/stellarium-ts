// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IVRFCoordinatorV2Plus,RandomnessAdapter} from '../src/RandomnessAdapter.sol';
contract MockUSDC is ERC20 {
    constructor() ERC20('USD Coin','USDC') {}
    function decimals() public pure override returns(uint8) { return 6; }
    function mint(address account,uint256 amount) external { _mint(account,amount); }
}
contract MockFeed {
    uint256 public updated; int256 public answer=2000e8;
    constructor() { updated=block.timestamp; }
    function decimals() external pure returns(uint8) { return 8; }
    function set(int256 value,uint256 timestamp) external { answer=value; updated=timestamp; }
    function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80) { return(1,answer,updated,updated,1); }
}
contract MockGasOracle { uint256 public fee; function setFee(uint256 value) external { fee=value; } function getL1FeeUpperBound(uint256) external view returns(uint256) { return fee; } }
contract MockVRF is IVRFCoordinatorV2Plus {
    uint256 public lastRequest;
    function requestRandomWords(RandomWordsRequest calldata r) external returns(uint256) { require(r.numWords==1&&r.extraArgs.length==36,'VRF request'); return ++lastRequest; }
    function fulfill(RandomnessAdapter adapter,uint256 id,uint256 word) external { uint256[] memory values=new uint256[](1); values[0]=word; adapter.rawFulfillRandomWords(id,values); adapter.deliver(id); }
}
