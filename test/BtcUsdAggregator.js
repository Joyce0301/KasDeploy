const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BtcUsdAggregator", function () {
  const initialSupply = ethers.parseEther("1000000");
  const paymentPerOracle = ethers.parseEther("10");
  const slashAmount = ethers.parseEther("50");
  const requiredStakeAmount = ethers.parseEther("100");
  const roundTimeoutSeconds = 3600;

  async function deployFixture(minSubmissionCount = 2) {
    const [owner, oracle1, oracle2, oracle3] = await ethers.getSigners();

    const LinkToken = await ethers.getContractFactory("LinkToken");
    const link = await LinkToken.deploy(initialSupply);
    await link.waitForDeployment();

    const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
    const registry = await OracleRegistry.deploy();
    await registry.waitForDeployment();

    const BtcUsdAggregator = await ethers.getContractFactory("BtcUsdAggregator");
    const aggregator = await BtcUsdAggregator.deploy(
      await link.getAddress(),
      await registry.getAddress(),
      paymentPerOracle,
      minSubmissionCount,
      roundTimeoutSeconds,
      slashAmount,
      requiredStakeAmount
    );
    await aggregator.waitForDeployment();

    await registry.setAuthorizedUpdater(await aggregator.getAddress(), true);

    for (const oracle of [oracle1, oracle2, oracle3]) {
      await link.transfer(oracle.address, requiredStakeAmount);
      await link.connect(oracle).approve(await aggregator.getAddress(), requiredStakeAmount);
      await aggregator.connect(oracle).depositStake(requiredStakeAmount);
      await registry.addOracle(oracle.address);
      await aggregator.addOracle(oracle.address);
    }

    await link.transfer(await aggregator.getAddress(), ethers.parseEther("1000"));

    return { link, registry, aggregator, owner, oracle1, oracle2, oracle3 };
  }

  it("finalizes immediately when all assigned oracles submit before timeout", async function () {
    const { aggregator, oracle1, oracle2, oracle3 } = await deployFixture(2);

    await aggregator.connect(oracle1).startNewRound();
    await aggregator.connect(oracle1).submit(30000n * 10n ** 8n, 1);
    await aggregator.connect(oracle2).submit(31000n * 10n ** 8n, 1);
    await aggregator.connect(oracle3).submit(32000n * 10n ** 8n, 1);

    const round = await aggregator.rounds(1);
    expect(round.finalized).to.equal(true);
    expect(round.failed).to.equal(false);

    const latest = await aggregator.latestRoundData();
    expect(latest.roundId).to.equal(1);
    expect(latest.answer).to.equal(31000n * 10n ** 8n);
    expect(latest.answeredInRound).to.equal(1);

    expect(await aggregator.oracleStake(oracle3.address)).to.equal(requiredStakeAmount);
  });

  it("finalizes after timeout with quorum and slashes missing submissions", async function () {
    const { aggregator, oracle1, oracle2, oracle3 } = await deployFixture(2);

    await aggregator.connect(oracle1).startNewRound();
    await aggregator.connect(oracle1).submit(30000n * 10n ** 8n, 1);
    await aggregator.connect(oracle2).submit(32000n * 10n ** 8n, 1);

    let round = await aggregator.rounds(1);
    expect(round.finalized).to.equal(false);

    await time.increase(roundTimeoutSeconds + 1);
    await aggregator.finalizeTimedOutRound(1);

    round = await aggregator.rounds(1);
    expect(round.finalized).to.equal(true);
    expect(round.failed).to.equal(false);

    const latest = await aggregator.latestRoundData();
    expect(latest.roundId).to.equal(1);
    expect(latest.answer).to.equal(32000n * 10n ** 8n);

    expect(await aggregator.oracleStake(oracle1.address)).to.equal(requiredStakeAmount);
    expect(await aggregator.oracleStake(oracle2.address)).to.equal(requiredStakeAmount);
    expect(await aggregator.oracleStake(oracle3.address)).to.equal(requiredStakeAmount - slashAmount);
  });

  it("fails a timed out round below quorum, slashes non-submitters, and allows the next round to start", async function () {
    const { aggregator, oracle1, oracle2, oracle3 } = await deployFixture(3);

    await aggregator.connect(oracle1).startNewRound();
    await aggregator.connect(oracle1).submit(30000n * 10n ** 8n, 1);

    await time.increase(roundTimeoutSeconds + 1);
    await aggregator.finalizeTimedOutRound(1);

    const round = await aggregator.rounds(1);
    expect(round.finalized).to.equal(true);
    expect(round.failed).to.equal(true);

    await expect(aggregator.latestRoundData()).to.be.revertedWith("no answer");
    expect(await aggregator.oracleStake(oracle1.address)).to.equal(requiredStakeAmount);
    expect(await aggregator.oracleStake(oracle2.address)).to.equal(requiredStakeAmount - slashAmount);
    expect(await aggregator.oracleStake(oracle3.address)).to.equal(requiredStakeAmount - slashAmount);

    await expect(aggregator.connect(oracle1).startNewRound()).to.not.be.reverted;
    expect(await aggregator.latestRoundId()).to.equal(2);
  });
});
