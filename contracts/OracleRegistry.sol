// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Very simple oracle registry + basic reputation counters
contract OracleRegistry {
    struct OracleInfo {
        bool active;
        uint64 totalAssigned;
        uint64 totalSubmitted;
        uint64 totalAccepted;
    }

    address public owner;
    mapping(address => bool) public authorizedUpdaters;
    mapping(address => OracleInfo) public oracles;
    address[] public oracleList;

    event OracleAdded(address indexed oracle);
    event OracleStatusChanged(address indexed oracle, bool active);
    event OracleStatsUpdated(address indexed oracle, uint64 assigned, uint64 submitted, uint64 accepted);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setAuthorizedUpdater(address updater, bool allowed) external onlyOwner {
        authorizedUpdaters[updater] = allowed;
    }

    function addOracle(address oracle) external onlyOwner {
        require(!oracles[oracle].active, "already active");
        oracles[oracle].active = true;
        oracleList.push(oracle);
        emit OracleAdded(oracle);
    }

    function setOracleActive(address oracle, bool active) external onlyOwner {
        require(oracles[oracle].active != active, "no change");
        oracles[oracle].active = active;
        emit OracleStatusChanged(oracle, active);
    }

    function getAllOracles() external view returns (address[] memory) {
        return oracleList;
    }

    /// @notice Called by aggregator to update reputation-like stats
    function updateStats(
        address oracle,
        uint64 assignedDelta,
        uint64 submittedDelta,
        uint64 acceptedDelta
    ) external {
        require(authorizedUpdaters[msg.sender], "not updater");
        OracleInfo storage info = oracles[oracle];
        require(info.active, "not oracle");
        info.totalAssigned += assignedDelta;
        info.totalSubmitted += submittedDelta;
        info.totalAccepted += acceptedDelta;
        emit OracleStatsUpdated(oracle, info.totalAssigned, info.totalSubmitted, info.totalAccepted);
    }
}
