const { ethers } = require("hardhat");

async function logWalletState(provider, deployer) {
  const balance = await provider.getBalance(deployer.address);
  const latestNonce = await provider.getTransactionCount(deployer.address, "latest");
  const pendingNonce = await provider.getTransactionCount(deployer.address, "pending");

  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "KAS");
  console.log("Nonce latest:", latestNonce);
  console.log("Nonce pending:", pendingNonce);
}

async function waitForContractDeployment(label, contract) {
  const deploymentTx = contract.deploymentTransaction();
  console.log(`${label} deploy tx hash:`, deploymentTx ? deploymentTx.hash : "unknown");
  if (deploymentTx) {
    console.log(`${label} deploy nonce:`, deploymentTx.nonce);
  }
  console.log(`Waiting for ${label} deployment confirmation...`);
  await contract.waitForDeployment();
  console.log(`${label} deployed at:`, await contract.getAddress());
}

async function sendAndWait(label, txPromise) {
  const tx = await txPromise;
  console.log(`${label} tx hash:`, tx.hash);
  console.log(`${label} tx nonce:`, tx.nonce);
  console.log(`Waiting for ${label} confirmation...`);
  const receipt = await tx.wait();
  console.log(`${label} confirmed in block:`, receipt.blockNumber);
  return receipt;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  await logWalletState(provider, deployer);

  // 1. Deploy LinkToken
  console.log("\n[1/8] Deploying LinkToken...");
  const LinkToken = await ethers.getContractFactory("LinkToken");
  const initialSupply = ethers.parseEther("1000000");
  const link = await LinkToken.deploy(initialSupply);
  await waitForContractDeployment("LinkToken", link);

  // 2. Deploy OracleRegistry
  console.log("\n[2/8] Deploying OracleRegistry...");
  const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
  const registry = await OracleRegistry.deploy();
  await waitForContractDeployment("OracleRegistry", registry);

  // 3. Deploy BtcUsdAggregator
  console.log("\n[3/8] Deploying BtcUsdAggregator...");
  const paymentPerOracle = ethers.parseEther("10");
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
  await waitForContractDeployment("BtcUsdAggregator", aggregator);

  // 4. Deploy OrderMatching
  console.log("\n[4/8] Deploying OrderMatching...");
  const OrderMatching = await ethers.getContractFactory("OrderMatching");
  const orderMatching = await OrderMatching.deploy(await aggregator.getAddress());
  await waitForContractDeployment("OrderMatching", orderMatching);

  // 5. Authorize aggregator to update registry stats
  console.log("\n[5/8] Authorizing registry and aggregator integrations...");
  await sendAndWait(
    "Authorize aggregator as registry updater",
    registry.setAuthorizedUpdater(await aggregator.getAddress(), true)
  );
  await sendAndWait(
    "Authorize order matching as aggregator requester",
    aggregator.setAuthorizedRequester(await orderMatching.getAddress(), true)
  );

  // 6. Deposit oracle stake and add deployer as first oracle
  console.log("\n[6/8] Staking deployer and registering first oracle...");
  await sendAndWait(
    "Approve stake transfer",
    link.approve(await aggregator.getAddress(), requiredStakeAmount)
  );
  await sendAndWait(
    "Deposit stake",
    aggregator.depositStake(requiredStakeAmount)
  );
  await sendAndWait(
    "Add oracle in registry",
    registry.connect(deployer).addOracle(deployer.address)
  );
  await sendAndWait(
    "Add oracle in aggregator",
    aggregator.connect(deployer).addOracle(deployer.address)
  );

  // 7. Optionally fund aggregator with KLINK for manual rounds
  console.log("\n[7/8] Funding aggregator for manual rounds...");
  const fundAmount = ethers.parseEther("100000");
  await sendAndWait(
    "Fund aggregator with KLINK",
    link.transfer(await aggregator.getAddress(), fundAmount)
  );
  console.log("Fund amount:", fundAmount.toString());

  // 8. Deploy BtcPriceConsumer
  console.log("\n[8/8] Deploying BtcPriceConsumer...");
  const BtcPriceConsumer = await ethers.getContractFactory("BtcPriceConsumer");
  const consumer = await BtcPriceConsumer.deploy(await aggregator.getAddress());
  await waitForContractDeployment("BtcPriceConsumer", consumer);

  console.log("\nDeployment complete.");
  console.log("LinkToken:", await link.getAddress());
  console.log("OracleRegistry:", await registry.getAddress());
  console.log("BtcUsdAggregator:", await aggregator.getAddress());
  console.log("OrderMatching:", await orderMatching.getAddress());
  console.log("BtcPriceConsumer:", await consumer.getAddress());
}

main().catch((error) => {
  console.error("Deployment error:", error);
  process.exitCode = 1;
});
