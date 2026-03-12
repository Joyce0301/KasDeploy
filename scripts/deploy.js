const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // 1. Deploy LinkToken
  const LinkToken = await ethers.getContractFactory("LinkToken");
  const initialSupply = ethers.parseEther("1000000"); // 1,000,000 KLINK
  const link = await LinkToken.deploy(initialSupply);
  await link.waitForDeployment();
  console.log("LinkToken deployed at:", await link.getAddress());

  // 2. Deploy OracleRegistry
  const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
  const registry = await OracleRegistry.deploy();
  await registry.waitForDeployment();
  console.log("OracleRegistry deployed at:", await registry.getAddress());

  // 3. Deploy BtcUsdAggregator
  const paymentPerOracle = ethers.parseEther("10"); // 10 KLINK per round per oracle
  const minSubmissionCount = 1;
  const roundTimeoutSeconds = 300;
  const slashAmount = ethers.parseEther("50");
  const requiredStakeAmount = ethers.parseEther("100");
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
  console.log("BtcUsdAggregator deployed at:", await aggregator.getAddress());

  // 4. Deploy OrderMatching
  const OrderMatching = await ethers.getContractFactory("OrderMatching");
  const orderMatching = await OrderMatching.deploy(await aggregator.getAddress());
  await orderMatching.waitForDeployment();
  console.log("OrderMatching deployed at:", await orderMatching.getAddress());

  // 5. Authorize aggregator to update registry stats
  await (await registry.setAuthorizedUpdater(await aggregator.getAddress(), true)).wait();
  console.log("Authorized aggregator as registry updater");
  await (await aggregator.setAuthorizedRequester(await orderMatching.getAddress(), true)).wait();
  console.log("Authorized order matching as aggregator requester");

  // 6. Deposit oracle stake and add deployer as first oracle
  await (await link.approve(await aggregator.getAddress(), requiredStakeAmount)).wait();
  await (await aggregator.depositStake(requiredStakeAmount)).wait();

  const registryWithSigner = registry.connect(deployer);
  await (await registryWithSigner.addOracle(deployer.address)).wait();
  console.log("Added oracle in registry:", deployer.address);

  const aggregatorWithSigner = aggregator.connect(deployer);
  await (await aggregatorWithSigner.addOracle(deployer.address)).wait();
  console.log("Added oracle in aggregator:", deployer.address);

  // 7. Optionally fund aggregator with KLINK for manual rounds
  const fundAmount = ethers.parseEther("100000"); // 100,000 KLINK
  await (await link.transfer(await aggregator.getAddress(), fundAmount)).wait();
  console.log("Funded aggregator with KLINK for manual rounds:", fundAmount.toString());

  // 8. Deploy BtcPriceConsumer
  const BtcPriceConsumer = await ethers.getContractFactory("BtcPriceConsumer");
  const consumer = await BtcPriceConsumer.deploy(await aggregator.getAddress());
  await consumer.waitForDeployment();
  console.log("BtcPriceConsumer deployed at:", await consumer.getAddress());

  console.log("Deployment complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
