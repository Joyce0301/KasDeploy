require("dotenv").config();
const { ethers } = require("ethers");

const ORDER_MATCHING_ABI = [
  "function link() view returns (address)",
  "function nextRequestId() view returns (uint256)",
  "function createRequest(bytes32 specHash, uint8 oracleCount, uint8 quorum, uint32 biddingWindowSeconds, uint32 roundTimeoutSeconds, uint256 paymentPerOracle, uint256 penaltyAmount) returns (uint256)"
];

const LINK_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)"
];

function getConfig() {
  const rpcUrl = process.env.RPC_URL || "https://rpc.kasplextest.xyz";
  const pk = process.env.REQUESTER_PK || process.env.DEPLOYER_PK;
  const orderMatchingAddress = process.env.ORDER_MATCHING_ADDRESS;

  if (!pk) {
    throw new Error("Missing REQUESTER_PK or DEPLOYER_PK in env");
  }
  if (!orderMatchingAddress) {
    throw new Error("Missing ORDER_MATCHING_ADDRESS in env");
  }

  const specHash = ethers.id(process.env.REQUEST_SPEC || "btc-usd");
  const oracleCount = Number(process.env.REQUEST_ORACLE_COUNT || 2);
  const quorum = Number(process.env.REQUEST_QUORUM || oracleCount);
  const biddingWindowSeconds = Number(process.env.REQUEST_BIDDING_WINDOW_SECONDS || 60);
  const roundTimeoutSeconds = Number(process.env.REQUEST_TIMEOUT_SECONDS || 300);
  const paymentPerOracle = ethers.parseEther(process.env.REQUEST_PAYMENT_PER_ORACLE || "10");
  const penaltyAmount = ethers.parseEther(process.env.REQUEST_PENALTY_AMOUNT || "25");

  return {
    rpcUrl,
    pk,
    orderMatchingAddress,
    specHash,
    oracleCount,
    quorum,
    biddingWindowSeconds,
    roundTimeoutSeconds,
    paymentPerOracle,
    penaltyAmount
  };
}

async function main() {
  const config = getConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.pk, provider);
  const orderMatching = new ethers.Contract(config.orderMatchingAddress, ORDER_MATCHING_ABI, wallet);
  const linkAddress = await orderMatching.link();
  const link = new ethers.Contract(linkAddress, LINK_ABI, wallet);

  const requestId = await orderMatching.nextRequestId();
  const totalBudget = BigInt(config.oracleCount) * config.paymentPerOracle;

  console.log("Requester:", wallet.address);
  console.log("Predicted requestId:", requestId.toString());
  console.log(
    "Request config:",
    JSON.stringify({
      oracleCount: config.oracleCount,
      quorum: config.quorum,
      biddingWindowSeconds: config.biddingWindowSeconds,
      roundTimeoutSeconds: config.roundTimeoutSeconds,
      paymentPerOracle: config.paymentPerOracle.toString(),
      penaltyAmount: config.penaltyAmount.toString()
    })
  );

  const approveTx = await link.approve(config.orderMatchingAddress, totalBudget);
  await approveTx.wait();
  console.log("Approve tx hash:", approveTx.hash);

  const createTx = await orderMatching.createRequest(
    config.specHash,
    config.oracleCount,
    config.quorum,
    config.biddingWindowSeconds,
    config.roundTimeoutSeconds,
    config.paymentPerOracle,
    config.penaltyAmount
  );
  const createReceipt = await createTx.wait();
  console.log("Create request tx hash:", createReceipt.hash);
  console.log("Created requestId:", requestId.toString());
}

main().catch((error) => {
  console.error("Create request error:", error);
  process.exitCode = 1;
});
