const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("OrderMatching", function () {
  const initialSupply = ethers.parseEther("1000000");
  const defaultPaymentPerOracle = ethers.parseEther("10");
  const defaultSlashAmount = ethers.parseEther("50");
  const requiredStakeAmount = ethers.parseEther("100");
  const defaultRoundTimeoutSeconds = 3600;

  async function deployFixture() {
    const [owner, requester, oracle1, oracle2, oracle3] = await ethers.getSigners();

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
      defaultPaymentPerOracle,
      2,
      defaultRoundTimeoutSeconds,
      defaultSlashAmount,
      requiredStakeAmount
    );
    await aggregator.waitForDeployment();

    const OrderMatching = await ethers.getContractFactory("OrderMatching");
    const orderMatching = await OrderMatching.deploy(
      await aggregator.getAddress(),
      await link.getAddress(),
      await registry.getAddress()
    );
    await orderMatching.waitForDeployment();

    await registry.setAuthorizedUpdater(await aggregator.getAddress(), true);
    await aggregator.setAuthorizedRequester(await orderMatching.getAddress(), true);

    for (const oracle of [oracle1, oracle2, oracle3]) {
      await link.transfer(oracle.address, requiredStakeAmount);
      await link.connect(oracle).approve(await aggregator.getAddress(), requiredStakeAmount);
      await aggregator.connect(oracle).depositStake(requiredStakeAmount);
      await registry.addOracle(oracle.address);
      await aggregator.addOracle(oracle.address);
    }

    await link.transfer(requester.address, ethers.parseEther("1000"));
    await link.transfer(await aggregator.getAddress(), ethers.parseEther("1000"));

    return { link, registry, aggregator, orderMatching, owner, requester, oracle1, oracle2, oracle3 };
  }

  it("finalizes a request-scoped round with per-request payment", async function () {
    const { link, aggregator, orderMatching, requester, oracle1, oracle2 } = await deployFixture();
    const paymentPerOracle = ethers.parseEther("7");
    const penaltyAmount = ethers.parseEther("25");
    const requestBudget = paymentPerOracle * 2n;

    await link.connect(requester).approve(await orderMatching.getAddress(), requestBudget);
    await orderMatching
      .connect(requester)
      .createRequest(ethers.id("btc-usd"), 2, 2, 60, 600, paymentPerOracle, penaltyAmount);

    await orderMatching.connect(oracle1).placeBid(1, penaltyAmount);
    await orderMatching.connect(oracle2).placeBid(1, penaltyAmount);

    await time.increase(61);
    await orderMatching.finalizeRequest(1);

    const request = await orderMatching.requests(1);
    expect(request.finalized).to.equal(true);
    expect(request.roundId).to.equal(1);

    const selected = await aggregator.getRoundOracles(1);
    expect(selected).to.deep.equal([oracle1.address, oracle2.address]);

    const oracle1BalanceBefore = await link.balanceOf(oracle1.address);
    const oracle2BalanceBefore = await link.balanceOf(oracle2.address);

    await aggregator.connect(oracle1).submit(30000n * 10n ** 8n, 1);
    await aggregator.connect(oracle2).submit(31000n * 10n ** 8n, 1);

    const latest = await aggregator.latestRoundData();
    expect(latest.roundId).to.equal(1);
    expect(latest.answer).to.equal(31000n * 10n ** 8n);

    expect(await link.balanceOf(oracle1.address)).to.equal(oracle1BalanceBefore + paymentPerOracle);
    expect(await link.balanceOf(oracle2.address)).to.equal(oracle2BalanceBefore + paymentPerOracle);
  });

  it("slashes missing selected bidders using the request penalty amount", async function () {
    const { link, aggregator, orderMatching, requester, oracle1, oracle2 } = await deployFixture();
    const paymentPerOracle = ethers.parseEther("9");
    const penaltyAmount = ethers.parseEther("30");
    const requestBudget = paymentPerOracle * 2n;

    await link.connect(requester).approve(await orderMatching.getAddress(), requestBudget);
    await orderMatching
      .connect(requester)
      .createRequest(ethers.id("btc-usd-fast"), 2, 1, 60, 300, paymentPerOracle, penaltyAmount);

    await orderMatching.connect(oracle1).placeBid(1, penaltyAmount);
    await orderMatching.connect(oracle2).placeBid(1, penaltyAmount);

    await time.increase(61);
    await orderMatching.finalizeRequest(1);

    await aggregator.connect(oracle1).submit(29900n * 10n ** 8n, 1);

    await time.increase(301);
    await aggregator.finalizeTimedOutRound(1);

    expect(await aggregator.oracleStake(oracle1.address)).to.equal(requiredStakeAmount);
    expect(await aggregator.oracleStake(oracle2.address)).to.equal(requiredStakeAmount - penaltyAmount);
  });

  it("uses registry reputation to rank bids and lets the requester cancel underfilled requests", async function () {
    const { link, aggregator, orderMatching, requester, oracle1, oracle2, oracle3 } = await deployFixture();

    await aggregator.connect(oracle1).startNewRound();
    await aggregator.connect(oracle1).submit(30000n * 10n ** 8n, 1);
    await aggregator.connect(oracle2).submit(31000n * 10n ** 8n, 1);
    await time.increase(defaultRoundTimeoutSeconds + 1);
    await aggregator.finalizeTimedOutRound(1);

    const paymentPerOracle = ethers.parseEther("5");
    const penaltyAmount = ethers.parseEther("20");
    const requestBudget = paymentPerOracle * 2n;

    await link.connect(requester).approve(await orderMatching.getAddress(), requestBudget * 2n);

    await orderMatching
      .connect(requester)
      .createRequest(ethers.id("ranked"), 2, 2, 60, 600, paymentPerOracle, penaltyAmount);
    await orderMatching.connect(oracle1).placeBid(1, penaltyAmount);
    await orderMatching.connect(oracle2).placeBid(1, penaltyAmount);
    await orderMatching.connect(oracle3).placeBid(1, penaltyAmount);

    await time.increase(61);
    await orderMatching.finalizeRequest(1);

    const selected = await aggregator.getRoundOracles(2);
    expect(selected).to.deep.equal([oracle1.address, oracle2.address]);

    await orderMatching
      .connect(requester)
      .createRequest(ethers.id("cancel-me"), 2, 2, 60, 600, paymentPerOracle, penaltyAmount);
    await orderMatching.connect(oracle1).placeBid(2, penaltyAmount);

    const requesterBalanceBefore = await link.balanceOf(requester.address);
    await time.increase(61);
    await orderMatching.connect(requester).cancelRequest(2);

    const request = await orderMatching.requests(2);
    expect(request.canceled).to.equal(true);
    expect(await link.balanceOf(requester.address)).to.equal(requesterBalanceBefore + requestBudget);
  });
});
