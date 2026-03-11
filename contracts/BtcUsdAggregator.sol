// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LinkToken.sol";
import "./OracleRegistry.sol";

/// @notice Simple multi-oracle BTC/USD price feed, Chainlink-like
contract BtcUsdAggregator {
    struct Round {
        uint80 roundId;
        int256[] answers;
        uint8 requiredSubmissions;
        uint32 startedAt;
        uint32 timeoutAt;
        uint32 updatedAt;
        uint80 answeredInRound;
        bool finalized;
        bool failed;
    }

    LinkToken public immutable link;
    OracleRegistry public immutable registry;
    address public owner;

    // price has 8 decimals, e.g. 30000 * 1e8
    uint8 public constant DECIMALS = 8;

    // how much LINK is paid per oracle per round
    uint256 public paymentPerOracle;
    uint256 public slashAmount;
    uint256 public requiredStakeAmount;
    uint8 public minSubmissionCount;
    uint32 public roundTimeoutSeconds;

    // active oracles for this aggregator (subset of registry oracles)
    address[] public activeOracles;
    mapping(address => bool) public isActiveOracle;
    mapping(address => uint256) public oracleStake;

    // submissions: roundId => oracle => submitted?
    mapping(uint80 => mapping(address => bool)) public hasSubmitted;
    mapping(uint80 => mapping(address => int256)) public submissions;
    mapping(uint80 => uint256) public submissionCount;

    // latest aggregate
    uint80 public latestRoundId;
    uint80 public latestAnsweredRoundId;
    mapping(uint80 => Round) public rounds;

    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);
    event NewRound(uint80 indexed roundId, uint32 startedAt);
    event OracleSubmission(uint80 indexed roundId, address indexed oracle, int256 answer);
    event AnswerUpdated(int256 current, uint80 indexed roundId, uint32 updatedAt);
    event RoundFailed(uint80 indexed roundId, uint32 updatedAt);
    event OracleSlashed(uint80 indexed roundId, address indexed oracle, uint256 amount);
    event StakeDeposited(address indexed oracle, uint256 amount);
    event StakeWithdrawn(address indexed oracle, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOracle() {
        require(isActiveOracle[msg.sender], "not oracle");
        _;
    }

    modifier onlyOwnerOrOracle() {
        require(msg.sender == owner || isActiveOracle[msg.sender], "not owner/oracle");
        _;
    }

    constructor(
        address _link,
        address _registry,
        uint256 _paymentPerOracle,
        uint8 _minSubmissionCount,
        uint32 _roundTimeoutSeconds,
        uint256 _slashAmount,
        uint256 _requiredStakeAmount
    ) {
        require(_minSubmissionCount > 0, "quorum=0");
        require(_roundTimeoutSeconds > 0, "timeout=0");
        link = LinkToken(_link);
        registry = OracleRegistry(_registry);
        owner = msg.sender;
        paymentPerOracle = _paymentPerOracle;
        minSubmissionCount = _minSubmissionCount;
        roundTimeoutSeconds = _roundTimeoutSeconds;
        slashAmount = _slashAmount;
        requiredStakeAmount = _requiredStakeAmount;
    }

    // --- configuration ---

    function setPaymentPerOracle(uint256 amount) external onlyOwner {
        paymentPerOracle = amount;
    }

    function setMinSubmissionCount(uint8 count) external onlyOwner {
        require(count > 0, "quorum=0");
        minSubmissionCount = count;
    }

    function setRoundTimeoutSeconds(uint32 timeoutSeconds) external onlyOwner {
        require(timeoutSeconds > 0, "timeout=0");
        roundTimeoutSeconds = timeoutSeconds;
    }

    function setSlashAmount(uint256 amount) external onlyOwner {
        slashAmount = amount;
    }

    function setRequiredStakeAmount(uint256 amount) external onlyOwner {
        requiredStakeAmount = amount;
    }

    function depositStake(uint256 amount) external {
        require(amount > 0, "amount=0");
        require(link.transferFrom(msg.sender, address(this), amount), "stake transfer failed");
        oracleStake[msg.sender] += amount;
        emit StakeDeposited(msg.sender, amount);
    }

    function withdrawStake(uint256 amount) external {
        require(amount > 0, "amount=0");
        uint256 currentStake = oracleStake[msg.sender];
        require(currentStake >= amount, "insufficient stake");
        uint256 remaining = currentStake - amount;
        if (isActiveOracle[msg.sender]) {
            require(remaining >= requiredStakeAmount, "active stake too low");
        }
        oracleStake[msg.sender] = remaining;
        require(link.transfer(msg.sender, amount), "withdraw transfer failed");
        emit StakeWithdrawn(msg.sender, amount);
    }

    function addOracle(address oracle) external onlyOwner {
        require(_noOpenRound(), "round in progress");
        require(!isActiveOracle[oracle], "already active");
        require(oracleStake[oracle] >= requiredStakeAmount, "stake too low");
        (bool active, , , ) = registry.oracles(oracle);
        require(active, "registry inactive");
        isActiveOracle[oracle] = true;
        activeOracles.push(oracle);
        emit OracleAdded(oracle);
    }

    function removeOracle(address oracle) external onlyOwner {
        require(_noOpenRound(), "round in progress");
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

    /// @notice starts a new round for the current active oracle set
    function startNewRound() external onlyOwnerOrOracle returns (uint80) {
        require(_noOpenRound(), "round in progress");
        require(activeOracles.length >= minSubmissionCount, "not enough oracles");
        latestRoundId += 1;
        uint80 roundId = latestRoundId;
        Round storage r = rounds[roundId];
        r.roundId = roundId;
        r.requiredSubmissions = minSubmissionCount;
        r.startedAt = uint32(block.timestamp);
        r.timeoutAt = uint32(block.timestamp + roundTimeoutSeconds);
        r.answeredInRound = roundId;

        uint256 len = activeOracles.length;
        for (uint256 i = 0; i < len; i++) {
            registry.updateStats(activeOracles[i], 1, 0, 0);
        }

        emit NewRound(roundId, r.startedAt);
        return roundId;
    }

    /// @notice oracle reports BTC/USD price (8 decimals) for current round
    function submit(int256 answer, uint80 roundId) external onlyOracle {
        require(roundId == latestRoundId && roundId != 0, "invalid round");
        Round storage r = rounds[roundId];
        require(!r.finalized, "round finalized");
        require(block.timestamp <= r.timeoutAt, "round timed out");
        require(!hasSubmitted[roundId][msg.sender], "already submitted");
        require(answer > 0, "invalid answer");

        hasSubmitted[roundId][msg.sender] = true;
        submissions[roundId][msg.sender] = answer;
        submissionCount[roundId] += 1;
        emit OracleSubmission(roundId, msg.sender, answer);

        registry.updateStats(msg.sender, 0, 1, 0); // submittedDelta=1

        // if everyone submitted before timeout, finalize immediately without slashing
        if (submissionCount[roundId] == activeOracles.length && activeOracles.length > 0) {
            _finalizeRound(roundId, false);
        }
    }

    function finalizeTimedOutRound(uint80 roundId) external {
        require(roundId != 0 && roundId == latestRoundId, "invalid round");
        Round storage r = rounds[roundId];
        require(!r.finalized, "round finalized");
        require(block.timestamp > r.timeoutAt, "timeout not reached");

        if (submissionCount[roundId] >= r.requiredSubmissions) {
            _finalizeRound(roundId, true);
        } else {
            _failRound(roundId);
        }
    }

    function _finalizeRound(uint80 roundId, bool applySlashing) internal {
        Round storage r = rounds[roundId];
        uint256 n = submissionCount[roundId];
        int256[] memory values = new int256[](n);
        uint256 j = 0;
        uint256 len = activeOracles.length;
        for (uint256 i = 0; i < len; i++) {
            address oracle = activeOracles[i];
            if (hasSubmitted[roundId][oracle]) {
                values[j] = submissions[roundId][oracle];
                j += 1;
            }
        }

        // sort values
        _sort(values);

        // median
        int256 median = values[n / 2];

        r.answers = values;
        r.updatedAt = uint32(block.timestamp);
        r.finalized = true;
        latestAnsweredRoundId = roundId;

        emit AnswerUpdated(median, roundId, r.updatedAt);

        // reward submitted oracles and update accepted stats
        for (uint256 i = 0; i < len; i++) {
            address oracle = activeOracles[i];
            if (hasSubmitted[roundId][oracle]) {
                if (paymentPerOracle > 0) {
                    require(
                        link.transfer(oracle, paymentPerOracle),
                        "LINK transfer failed"
                    );
                }
                registry.updateStats(oracle, 0, 0, 1); // acceptedDelta=1
            } else if (applySlashing) {
                _slashOracle(roundId, oracle);
            }
        }
    }

    function _failRound(uint80 roundId) internal {
        Round storage r = rounds[roundId];
        r.finalized = true;
        r.failed = true;
        r.updatedAt = uint32(block.timestamp);

        uint256 len = activeOracles.length;
        for (uint256 i = 0; i < len; i++) {
            address oracle = activeOracles[i];
            if (!hasSubmitted[roundId][oracle]) {
                _slashOracle(roundId, oracle);
            }
        }

        emit RoundFailed(roundId, r.updatedAt);
    }

    function _slashOracle(uint80 roundId, address oracle) internal {
        uint256 currentStake = oracleStake[oracle];
        uint256 slash = currentStake < slashAmount ? currentStake : slashAmount;
        if (slash == 0) {
            return;
        }
        oracleStake[oracle] = currentStake - slash;
        emit OracleSlashed(roundId, oracle, slash);
    }

    function _noOpenRound() internal view returns (bool) {
        if (latestRoundId == 0) {
            return true;
        }
        return rounds[latestRoundId].finalized;
    }

    function getLatestRoundStatus()
        external
        view
        returns (
            uint80 roundId,
            bool finalized,
            bool failed,
            uint32 timeoutAt,
            uint256 submissionsCount
        )
    {
        roundId = latestRoundId;
        if (roundId == 0) {
            return (0, false, false, 0, 0);
        }
        Round storage r = rounds[roundId];
        return (roundId, r.finalized, r.failed, r.timeoutAt, submissionCount[roundId]);
    }

    function latestAnswer() external view returns (int256) {
        require(latestAnsweredRoundId != 0, "no answer");
        Round storage r = rounds[latestAnsweredRoundId];
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
        roundId = latestAnsweredRoundId;
        require(roundId != 0, "no answer");
        Round storage r = rounds[roundId];
        require(r.answers.length > 0, "no answer");
        uint256 n = r.answers.length;
        answer = r.answers[n / 2];
        startedAt = r.startedAt;
        updatedAt = r.updatedAt;
        answeredInRound = r.answeredInRound;
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

}
