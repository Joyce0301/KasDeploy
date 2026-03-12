require("dotenv").config();
const { ethers } = require("ethers");

const ORDER_MATCHING_ABI = [
  "function link() view returns (address)",
  "function nextRequestId() view returns (uint256)",
  "function createRequest(bytes32 specHash, uint8 oracleCount, uint8 quorum, uint32 biddingWindowSeconds, uint32 roundTimeoutSeconds, uint256 paymentPerOracle, uint256 penaltyAmount) returns (uint256)",
  "function placeBid(uint256 requestId, uint256 penaltyAmount)",
  "function finalizeRequest(uint256 requestId) returns (uint80)",
  "function requests(uint256 requestId) view returns (address requester, uint8 oracleCount, uint8 quorum, uint32 biddingDeadline, uint32 roundTimeoutSeconds, uint256 paymentPerOracle, uint256 penaltyAmount, bytes32 specHash, bool finalized, bool canceled, uint80 roundId)"
];

const LINK_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)"
];

function parseOracleKeys() {
  const value = process.env.ORACLE_PKS || process.env.ORACLE_PK || "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBiddingDeadline(provider, biddingDeadline) {
  while (true) {
    const block = await provider.getBlock("latest");
    if (block && block.timestamp > biddingDeadline) {
      return block.timestamp;
    }

    const remaining = Math.max(1, biddingDeadline - (block ? block.timestamp : 0));
    console.log(`Waiting for bidding window to close... latest=${block ? block.timestamp : "unknown"} deadline=${biddingDeadline} remaining=${remaining}s`);
    await sleep(Math.min(remaining, 5) * 1000);
  }
}

function getConfig() {
  const rpcUrl = process.env.RPC_URL || "https://rpc.kasplextest.xyz";
  const requesterPk = process.env.REQUESTER_PK || process.env.DEPLOYER_PK;
  const orderMatchingAddress = process.env.ORDER_MATCHING_ADDRESS;
  const oraclePks = parseOracleKeys();

  if (!requesterPk) {
    throw new Error("Missing REQUESTER_PK or DEPLOYER_PK in env");
  }
  if (!orderMatchingAddress) {
    throw new Error("Missing ORDER_MATCHING_ADDRESS in env");
  }
  if (oraclePks.length === 0) {
    throw new Error("Missing ORACLE_PKS or ORACLE_PK in env");
  }

  const oracleCount = Number(process.env.REQUEST_ORACLE_COUNT || oraclePks.length);
  const quorum = Number(process.env.REQUEST_QUORUM || oracleCount);
  const biddingWindowSeconds = Number(process.env.REQUEST_BIDDING_WINDOW_SECONDS || 60);
  const roundTimeoutSeconds = Number(process.env.REQUEST_TIMEOUT_SECONDS || 300);
  const paymentPerOracle = ethers.parseEther(process.env.REQUEST_PAYMENT_PER_ORACLE || "10");
  const penaltyAmount = ethers.parseEther(process.env.REQUEST_PENALTY_AMOUNT || "25");
  const specHash = ethers.id(process.env.REQUEST_SPEC || "btc-usd");

  return {
    rpcUrl,
    requesterPk,
    orderMatchingAddress,
    oraclePks,
    oracleCount,
    quorum,
    biddingWindowSeconds,
    roundTimeoutSeconds,
    paymentPerOracle,
    penaltyAmount,
    specHash
  };
}

async function main() {
  const config = getConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const requester = new ethers.Wallet(config.requesterPk, provider);
  const orderMatching = new ethers.Contract(config.orderMatchingAddress, ORDER_MATCHING_ABI, requester);
  const link = new ethers.Contract(await orderMatching.link(), LINK_ABI, requester);

  const requestId = await orderMatching.nextRequestId();
  const totalBudget = BigInt(config.oracleCount) * config.paymentPerOracle;

  console.log("Requester:", requester.address);
  console.log("Predicted requestId:", requestId.toString());

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
  await createTx.wait();
  console.log("Create request tx hash:", createTx.hash);

  const bidderKeys = config.oraclePks.slice(0, config.oracleCount);
  for (const bidderPk of bidderKeys) {
    const oracleWallet = new ethers.Wallet(bidderPk, provider);
    const bidderOrderMatching = new ethers.Contract(config.orderMatchingAddress, ORDER_MATCHING_ABI, oracleWallet);
    console.log("Placing bid from oracle:", oracleWallet.address);
    const bidTx = await bidderOrderMatching.placeBid(requestId, config.penaltyAmount);
    await bidTx.wait();
    console.log("Bid tx hash:", bidTx.hash);
  }

  const request = await orderMatching.requests(requestId);
  const deadlineSeconds = Number(request.biddingDeadline);
  await waitForBiddingDeadline(provider, deadlineSeconds);

  const finalizeTx = await orderMatching.finalizeRequest(requestId);
  const finalizeReceipt = await finalizeTx.wait();
  console.log("Finalize request tx hash:", finalizeReceipt.hash);

  const finalizedRequest = await orderMatching.requests(requestId);
  console.log(
    "Request finalized:",
    JSON.stringify({
      requestId: requestId.toString(),
      roundId: finalizedRequest.roundId.toString()
    })
  );
}

main().catch((error) => {
  console.error("Demo request flow error:", error);
  process.exitCode = 1;
});
