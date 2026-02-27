// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LinkToken.sol";
import "./OracleRegistry.sol";

/// @notice Simple multi-oracle BTC/USD price feed, Chainlink-like
contract BtcUsdAggregator {
    struct Round {
        uint80 roundId;
        int256[] answers;
        uint32 startedAt;
        uint32 updatedAt;
        uint32 answeredInRound;
    }

    LinkToken public immutable link;
    OracleRegistry public immutable registry;
    address public owner;

    // price has 8 decimals, e.g. 30000 * 1e8
    uint8 public constant DECIMALS = 8;

    // how much LINK is paid per oracle per round
    uint256 public paymentPerOracle;

    // active oracles for this aggregator (subset of registry oracles)
    address[] public activeOracles;
    mapping(address => bool) public isActiveOracle;

    // submissions: roundId => oracle => submitted?
    mapping(uint80 => mapping(address => bool)) public hasSubmitted;
    mapping(uint80 => mapping(address => int256)) public submissions;
    mapping(uint80 => uint256) public submissionCount;

    // latest aggregate
    uint80 public latestRoundId;
    mapping(uint80 => Round) public rounds;

    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);
    event NewRound(uint80 indexed roundId, uint32 startedAt);
    event OracleSubmission(uint80 indexed roundId, address indexed oracle, int256 answer);
    event AnswerUpdated(int256 current, uint80 indexed roundId, uint32 updatedAt);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOracle() {
        require(isActiveOracle[msg.sender], "not oracle");
        _;
    }

    constructor(
        address _link,
        address _registry,
        uint256 _paymentPerOracle
    ) {
        link = LinkToken(_link);
        registry = OracleRegistry(_registry);
        owner = msg.sender;
        paymentPerOracle = _paymentPerOracle;
    }

    // --- configuration ---

    function setPaymentPerOracle(uint256 amount) external onlyOwner {
        paymentPerOracle = amount;
    }

    function addOracle(address oracle) external onlyOwner {
        require(!isActiveOracle[oracle], "already active");
        isActiveOracle[oracle] = true;
        activeOracles.push(oracle);
        emit OracleAdded(oracle);
    }

    function removeOracle(address oracle) external onlyOwner {
        require(isActiveOracle[oracle], "not active");
        isActiveOracle[oracle] = false;
        uint256 len = activeOracles.length;
        for (uint256 i = 0; i < len; i++) {
            if (activeOracles[i] == oracle) {
                activeOracles[i] = activeOracles[len - 1];
                activeOracles.pop();
                break;
            }
        }
        emit OracleRemoved(oracle);
    }

    function getActiveOracles() external view returns (address[] memory) {
        return activeOracles;
    }

    // --- round / submission logic ---

    /// @notice starts a new round (can be called by owner or anyone, depending on policy)
    function startNewRound() external returns (uint80) {
        latestRoundId += 1;
        uint80 roundId = latestRoundId;
        Round storage r = rounds[roundId];
        r.roundId = roundId;
        r.startedAt = uint32(block.timestamp);
        emit NewRound(roundId, r.startedAt);
        return roundId;
    }

    /// @notice oracle reports BTC/USD price (8 decimals) for current round
    function submit(int256 answer, uint80 roundId) external onlyOracle {
        require(roundId == latestRoundId && roundId != 0, "invalid round");
        require(!hasSubmitted[roundId][msg.sender], "already submitted");

        hasSubmitted[roundId][msg.sender] = true;
        submissions[roundId][msg.sender] = answer;
        submissionCount[roundId] += 1;
        emit OracleSubmission(roundId, msg.sender, answer);

        registry.updateStats(msg.sender, 0, 1, 0); // submittedDelta=1

        // check if enough submissions to aggregate
        if (submissionCount[roundId] == activeOracles.length && activeOracles.length > 0) {
            _finalizeRound(roundId);
        }
    }

    function _finalizeRound(uint80 roundId) internal {
        uint256 n = activeOracles.length;
        int256[] memory values = new int256[](n);
        for (uint256 i = 0; i < n; i++) {
            values[i] = submissions[roundId][activeOracles[i]];
        }

        // sort values
        _sort(values);

        // median
        int256 median = values[n / 2];

        Round storage r = rounds[roundId];
        r.answers = values;
        r.updatedAt = uint32(block.timestamp);
        r.answeredInRound = r.updatedAt;

        emit AnswerUpdated(median, roundId, r.updatedAt);

        // reward oracles and update accepted stats
        for (uint256 i = 0; i < n; i++) {
            address oracle = activeOracles[i];
            if (paymentPerOracle > 0) {
                require(
                    link.transfer(oracle, paymentPerOracle),
                    "LINK transfer failed"
                );
            }
            registry.updateStats(oracle, 0, 0, 1); // acceptedDelta=1
        }
    }

    // insertion sort for small n
    function _sort(int256[] memory arr) internal pure {
        uint256 n = arr.length;
        for (uint256 i = 1; i < n; i++) {
            int256 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
    }

    // --- consumer (USER-SC) view API ---

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function latestAnswer() external view returns (int256) {
        require(latestRoundId != 0, "no round");
        Round storage r = rounds[latestRoundId];
        require(r.answers.length > 0, "no answer");
        uint256 n = r.answers.length;
        return r.answers[n / 2];
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint32 startedAt,
            uint32 updatedAt,
            uint80 answeredInRound
        )
    {
        roundId = latestRoundId;
        require(roundId != 0, "no round");
        Round storage r = rounds[roundId];
        require(r.answers.length > 0, "no answer");
        uint256 n = r.answers.length;
        answer = r.answers[n / 2];
        startedAt = r.startedAt;
        updatedAt = r.updatedAt;
        answeredInRound = r.answeredInRound;
    }
}

