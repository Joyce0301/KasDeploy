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
  const BtcUsdAggregator = await ethers.getContractFactory("BtcUsdAggregator");
  const aggregator = await BtcUsdAggregator.deploy(
    await link.getAddress(),
    await registry.getAddress(),
    paymentPerOracle
  );
  await aggregator.waitForDeployment();
  console.log("BtcUsdAggregator deployed at:", await aggregator.getAddress());

  // 4. Add deployer as first oracle
  const registryWithSigner = registry.connect(deployer);
  await (await registryWithSigner.addOracle(deployer.address)).wait();
  console.log("Added oracle in registry:", deployer.address);

  const aggregatorWithSigner = aggregator.connect(deployer);
  await (await aggregatorWithSigner.addOracle(deployer.address)).wait();
  console.log("Added oracle in aggregator:", deployer.address);

  // 5. Fund aggregator with KLINK to pay oracle
  const fundAmount = ethers.parseEther("100000"); // 100,000 KLINK
  await (await link.transfer(await aggregator.getAddress(), fundAmount)).wait();
  console.log("Funded aggregator with KLINK:", fundAmount.toString());

  // 6. Deploy BtcPriceConsumer
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

