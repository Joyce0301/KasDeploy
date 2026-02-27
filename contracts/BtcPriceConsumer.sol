// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBtcUsdAggregator {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint32 startedAt,
            uint32 updatedAt,
            uint80 answeredInRound
        );

    function decimals() external view returns (uint8);
}

/// @notice Example consumer contract that reads BTC/USD price
contract BtcPriceConsumer {
    IBtcUsdAggregator public immutable aggregator;

    constructor(address _aggregator) {
        aggregator = IBtcUsdAggregator(_aggregator);
    }

    function getBtcPrice() external view returns (int256 price, uint8 priceDecimals) {
        (, price, , , ) = aggregator.latestRoundData();
        priceDecimals = aggregator.decimals();
    }
}

