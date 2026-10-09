// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {ProtocolBase} from './ProtocolBase.sol';
interface IChainlinkFeed { function decimals() external view returns(uint8); function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80); }
interface IBaseGasOracle { function getL1FeeUpperBound(uint256) external view returns(uint256); }
interface IFeeOracle { function batchFee(uint256 measuredGas,uint256 calldataSize) external view returns(uint256); }
contract FeeOracle is ProtocolBase,IFeeOracle {
    IChainlinkFeed public feed; IBaseGasOracle public gasOracle;
    uint256 public overheadGas; uint256 public transactionOverheadBytes; uint256 public maximumGasPrice;
    function initialize(address governance,address feed_,address gasOracle_,uint256 overhead,uint256 byteOverhead,uint256 maxPrice) external initializer { __ProtocolBase_init(governance); _configure(feed_,gasOracle_,overhead,byteOverhead,maxPrice); }
    function _configure(address f,address g,uint256 overhead,uint256 byteOverhead,uint256 maxPrice) private { require(f!=address(0)&&g!=address(0)&&maxPrice>0&&overhead<=2_000_000&&byteOverhead<=10_000,'fee parameters'); feed=IChainlinkFeed(f); gasOracle=IBaseGasOracle(g); require(feed.decimals()<=18,'decimals'); overheadGas=overhead; transactionOverheadBytes=byteOverhead; maximumGasPrice=maxPrice; }
    function configure(address f,address g,uint256 overhead,uint256 byteOverhead,uint256 maxPrice) external onlyOwner { _configure(f,g,overhead,byteOverhead,maxPrice); }
    function batchFee(uint256 measuredGas,uint256 calldataSize) external view returns(uint256) {
        (uint80 round,int256 answer,,uint256 updated,uint80 answered)=feed.latestRoundData();
        require(answer>0&&updated>0&&updated<=block.timestamp&&block.timestamp-updated<=15 minutes&&answered>=round,'stale oracle');
        uint256 gasPrice=tx.gasprice>maximumGasPrice?maximumGasPrice:tx.gasprice;
        uint256 weiCost=(measuredGas+overheadGas)*gasPrice+gasOracle.getL1FeeUpperBound(calldataSize+transactionOverheadBytes);
        return Math.mulDiv(weiCost,uint256(answer)*1e6,1e18*10**feed.decimals(),Math.Rounding.Ceil);
    }
}
