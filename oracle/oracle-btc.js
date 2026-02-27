require("dotenv").config();
const axios = require("axios");
const { ethers } = require("ethers");

// Minimal ABI for BtcUsdAggregator used by the oracle
const AGGREGATOR_ABI = [
  "function latestRoundId() view returns (uint80)",
  "function startNewRound() returns (uint80)",
  "function submit(int256 answer, uint80 roundId)"
];

async function fetchBtcPrice() {
  // Using CoinGecko simple price API as example
  const resp = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price",
    {
      params: {
        ids: "bitcoin",
        vs_currencies: "usd"
      },
      timeout: 5000
    }
  );
  const price = resp.data?.bitcoin?.usd;
  if (typeof price !== "number") {
    throw new Error("Invalid BTC price from API");
  }
  return price;
}

async function runOnce() {
  const rpcUrl = process.env.RPC_URL || "https://rpc.kasplextest.xyz";
  const pk = process.env.ORACLE_PK;
  const aggAddress = process.env.AGGREGATOR_ADDRESS;

  if (!pk) {
    throw new Error("Missing ORACLE_PK in env");
  }
  if (!aggAddress) {
    throw new Error("Missing A GGREGATOR_ADDRESS in env");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const aggregator = new ethers.Contract(aggAddress, AGGREGATOR_ABI, wallet);

  console.log("Oracle address:", wallet.address);

  // 1) Start a new round
  console.log("Starting new round...");
  const txStart = await aggregator.startNewRound();
  const receiptStart = await txStart.wait();
  console.log("New round tx hash:", receiptStart.hash);

  const latestRoundId = await aggregator.latestRoundId();
  console.log("Current roundId:", latestRoundId.toString());

  // 2) Fetch BTC price
  const priceUsd = await fetchBtcPrice();
  console.log("Fetched BTC/USD:", priceUsd);

  // Convert to 8 decimals (as in aggregator)
  const scaled = BigInt(Math.round(priceUsd * 1e8));

  // 3) Submit price
  console.log("Submitting price:", scaled.toString());
  const txSubmit = await aggregator.submit(scaled, latestRoundId);
  const receiptSubmit = await txSubmit.wait();
  console.log("Submit tx hash:", receiptSubmit.hash);
}

async function main() {
  try {
    await runOnce();
  } catch (e) {
    console.error("Oracle error:", e);
    process.exitCode = 1;
  }
}

main();

