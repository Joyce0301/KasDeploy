// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LinkToken.sol";
import "./OracleRegistry.sol";

interface IBtcUsdAggregatorOrderMatching {
    function link() external view returns (address);
    function registry() external view returns (address);
    function isActiveOracle(address oracle) external view returns (bool);
    function oracleStake(address oracle) external view returns (uint256);
    function startRoundWithSLA(
        address[] calldata selectedOracles,
        uint8 quorum,
        uint32 timeoutSeconds,
        uint256 paymentPerSubmission,
        uint256 slashAmount
    ) external returns (uint80);
}

/// @notice Minimal order-matching + SLA layer for request-scoped oracle selection
contract OrderMatching {
    struct Request {
        address requester;
        uint8 oracleCount;
        uint8 quorum;
        uint32 biddingDeadline;
        uint32 roundTimeoutSeconds;
        uint256 paymentPerOracle;
        uint256 penaltyAmount;
        bytes32 specHash;
        bool finalized;
        bool canceled;
        uint80 roundId;
    }

    struct Bid {
        bool exists;
        uint256 penaltyAmount;
    }

    IBtcUsdAggregatorOrderMatching public immutable aggregator;
    LinkToken public immutable link;
    OracleRegistry public immutable registry;

    uint256 public nextRequestId = 1;
    mapping(uint256 => Request) public requests;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => address[]) private requestBidders;

    event RequestCreated(
        uint256 indexed requestId,
        address indexed requester,
        bytes32 indexed specHash,
        uint8 oracleCount,
        uint8 quorum
    );
    event BidPlaced(uint256 indexed requestId, address indexed oracle, uint256 penaltyAmount);
    event RequestFinalized(uint256 indexed requestId, uint80 indexed roundId, address[] selectedOracles);
    event RequestCanceled(uint256 indexed requestId);

    constructor(address _aggregator, address _link, address _registry) {
        aggregator = IBtcUsdAggregatorOrderMatching(_aggregator);
        link = LinkToken(_link);
        registry = OracleRegistry(_registry);
    }

    function createRequest(
        bytes32 specHash,
        uint8 oracleCount,
        uint8 quorum,
        uint32 biddingWindowSeconds,
        uint32 roundTimeoutSeconds,
        uint256 paymentPerOracle,
        uint256 penaltyAmount
    ) external returns (uint256 requestId) {
        require(oracleCount > 0, "oracleCount=0");
        require(quorum > 0 && quorum <= oracleCount, "invalid quorum");
        require(biddingWindowSeconds > 0, "bidding=0");
        require(roundTimeoutSeconds > 0, "timeout=0");
        require(penaltyAmount > 0, "penalty=0");

        requestId = nextRequestId++;
        uint256 totalBudget = uint256(oracleCount) * paymentPerOracle;
        if (totalBudget > 0) {
            require(link.transferFrom(msg.sender, address(this), totalBudget), "budget transfer failed");
        }

        requests[requestId] = Request({
            requester: msg.sender,
            oracleCount: oracleCount,
            quorum: quorum,
            biddingDeadline: uint32(block.timestamp + biddingWindowSeconds),
            roundTimeoutSeconds: roundTimeoutSeconds,
            paymentPerOracle: paymentPerOracle,
            penaltyAmount: penaltyAmount,
            specHash: specHash,
            finalized: false,
            canceled: false,
            roundId: 0
        });

        emit RequestCreated(requestId, msg.sender, specHash, oracleCount, quorum);
    }

    function placeBid(uint256 requestId, uint256 penaltyAmount) external {
        Request storage request = requests[requestId];
        require(request.requester != address(0), "unknown request");
        require(!request.finalized && !request.canceled, "request closed");
        require(block.timestamp <= request.biddingDeadline, "bidding closed");
        require(!bids[requestId][msg.sender].exists, "already bid");
        require(aggregator.isActiveOracle(msg.sender), "not active oracle");
        require(penaltyAmount >= request.penaltyAmount, "penalty too low");
        require(aggregator.oracleStake(msg.sender) >= penaltyAmount, "stake too low");

        bids[requestId][msg.sender] = Bid({exists: true, penaltyAmount: penaltyAmount});
        requestBidders[requestId].push(msg.sender);

        emit BidPlaced(requestId, msg.sender, penaltyAmount);
    }

    function finalizeRequest(uint256 requestId) external returns (uint80 roundId) {
        Request storage request = requests[requestId];
        require(request.requester != address(0), "unknown request");
        require(!request.finalized && !request.canceled, "request closed");
        require(block.timestamp > request.biddingDeadline, "bidding open");

        address[] memory selected = _selectTopBidders(requestId, request.oracleCount, request.penaltyAmount);
        require(selected.length == request.oracleCount, "not enough bids");

        uint256 totalBudget = uint256(request.oracleCount) * request.paymentPerOracle;
        if (totalBudget > 0) {
            require(link.transfer(address(aggregator), totalBudget), "fund round failed");
        }

        roundId = aggregator.startRoundWithSLA(
            selected,
            request.quorum,
            request.roundTimeoutSeconds,
            request.paymentPerOracle,
            request.penaltyAmount
        );

        request.finalized = true;
        request.roundId = roundId;

        emit RequestFinalized(requestId, roundId, selected);
    }

    function cancelRequest(uint256 requestId) external {
        Request storage request = requests[requestId];
        require(request.requester != address(0), "unknown request");
        require(msg.sender == request.requester, "not requester");
        require(!request.finalized && !request.canceled, "request closed");
        require(block.timestamp > request.biddingDeadline, "bidding open");

        address[] memory selected = _selectTopBidders(requestId, request.oracleCount, request.penaltyAmount);
        require(selected.length < request.oracleCount, "enough bids");

        request.canceled = true;

        uint256 totalBudget = uint256(request.oracleCount) * request.paymentPerOracle;
        if (totalBudget > 0) {
            require(link.transfer(request.requester, totalBudget), "refund failed");
        }

        emit RequestCanceled(requestId);
    }

    function getRequestBidders(uint256 requestId) external view returns (address[] memory) {
        return requestBidders[requestId];
    }

    function _selectTopBidders(
        uint256 requestId,
        uint8 maxCount,
        uint256 minPenalty
    ) internal view returns (address[] memory) {
        address[] storage bidders = requestBidders[requestId];
        address[] memory ranked = new address[](bidders.length);
        uint256 rankedCount = 0;

        for (uint256 i = 0; i < bidders.length; i++) {
            address bidder = bidders[i];
            Bid storage bidInfo = bids[requestId][bidder];
            if (!bidInfo.exists || bidInfo.penaltyAmount < minPenalty) {
                continue;
            }
            if (!aggregator.isActiveOracle(bidder) || aggregator.oracleStake(bidder) < bidInfo.penaltyAmount) {
                continue;
            }

            ranked[rankedCount] = bidder;
            rankedCount += 1;
        }

        for (uint256 i = 1; i < rankedCount; i++) {
            address key = ranked[i];
            uint256 j = i;
            while (j > 0 && _compareOracleScore(key, ranked[j - 1])) {
                ranked[j] = ranked[j - 1];
                j--;
            }
            ranked[j] = key;
        }

        uint256 selectedCount = rankedCount < maxCount ? rankedCount : maxCount;
        address[] memory selected = new address[](selectedCount);
        for (uint256 i = 0; i < selectedCount; i++) {
            selected[i] = ranked[i];
        }
        return selected;
    }

    function _compareOracleScore(address a, address b) internal view returns (bool) {
        (, uint64 assignedA, uint64 submittedA, uint64 acceptedA) = registry.oracles(a);
        (, uint64 assignedB, uint64 submittedB, uint64 acceptedB) = registry.oracles(b);

        if (acceptedA != acceptedB) {
            return acceptedA > acceptedB;
        }
        if (submittedA != submittedB) {
            return submittedA > submittedB;
        }
        if (assignedA != assignedB) {
            return assignedA > assignedB;
        }
        return uint160(a) < uint160(b);
    }
}
