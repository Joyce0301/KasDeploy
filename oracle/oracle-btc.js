require("dotenv").config();
const axios = require("axios");
const { ethers } = require("ethers");

const AGGREGATOR_ABI = [
  "function latestRoundId() view returns (uint80)",
  "function getLatestRoundStatus() view returns (uint80 roundId, bool finalized, bool failed, uint32 timeoutAt, uint256 submissionsCount)",
  "function getRoundOracles(uint80 roundId) view returns (address[] memory)",
  "function canSubmit(address oracle, uint80 roundId) view returns (bool)",
  "function hasSubmitted(uint80 roundId, address oracle) view returns (bool)",
  "function finalizeTimedOutRound(uint80 roundId)",
  "function submit(int256 answer, uint80 roundId)"
];

const DEFAULT_POLL_INTERVAL_MS = 15000;

async function fetchBtcPrice() {
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

async function loadRoundForOracle(aggregator, oracleAddress) {
  const latestRoundId = await aggregator.latestRoundId();
  if (latestRoundId === 0n) {
    return { latestRoundId, status: null, selected: false, canSubmit: false };
  }

  const status = await aggregator.getLatestRoundStatus();
  const selectedOracles = await aggregator.getRoundOracles(latestRoundId);
  const selected = selectedOracles.some((address) => address.toLowerCase() === oracleAddress.toLowerCase());
  const canSubmit = await aggregator.canSubmit(oracleAddress, latestRoundId);

  return {
    latestRoundId,
    status,
    selected,
    canSubmit,
    selectedOracles
  };
}

function getConfig() {
  const rpcUrl = process.env.RPC_URL || "https://rpc.kasplextest.xyz";
  const pk = process.env.ORACLE_PK;
  const aggAddress = process.env.AGGREGATOR_ADDRESS;
  const runOnce = String(process.env.ORACLE_RUN_ONCE || "").toLowerCase() === "true";
  const autoFinalize = String(process.env.ORACLE_AUTO_FINALIZE || "true").toLowerCase() !== "false";
  const pollIntervalMs = Number(process.env.ORACLE_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);

  if (!pk) {
    throw new Error("Missing ORACLE_PK in env");
  }
  if (!aggAddress) {
    throw new Error("Missing AGGREGATOR_ADDRESS in env");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Invalid ORACLE_POLL_INTERVAL_MS in env");
  }

  return { rpcUrl, pk, aggAddress, runOnce, autoFinalize, pollIntervalMs };
}

async function tryFinalizeTimedOutRound(aggregator, roundInfo) {
  if (!roundInfo.status || roundInfo.status.finalized) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const timeoutAt = Number(roundInfo.status.timeoutAt);
  if (!Number.isFinite(timeoutAt) || now <= timeoutAt) {
    return false;
  }

  const tx = await aggregator.finalizeTimedOutRound(roundInfo.latestRoundId);
  const receipt = await tx.wait();
  console.log("Finalize tx hash:", receipt.hash);
  return true;
}

async function runIteration(aggregator, wallet, autoFinalize) {
  const roundInfo = await loadRoundForOracle(aggregator, wallet.address);
  if (roundInfo.latestRoundId === 0n) {
    console.log("No rounds exist yet. Waiting for OrderMatching to finalize a request.");
    return;
  }

  console.log("Latest roundId:", roundInfo.latestRoundId.toString());
  if (roundInfo.status) {
    console.log(
      "Round status:",
      JSON.stringify({
        finalized: roundInfo.status.finalized,
        failed: roundInfo.status.failed,
        timeoutAt: Number(roundInfo.status.timeoutAt),
        submissionsCount: roundInfo.status.submissionsCount.toString()
      })
    );
  }

  if (autoFinalize) {
    try {
      const finalized = await tryFinalizeTimedOutRound(aggregator, roundInfo);
      if (finalized) {
        console.log("Timed out round finalized by worker.");
        return;
      }
    } catch (error) {
      console.log("Finalize skipped:", error.shortMessage || error.message);
    }
  }

  if (!roundInfo.selected) {
    console.log("This oracle was not selected for the latest round. Skipping.");
    return;
  }

  if (!roundInfo.canSubmit) {
    const alreadySubmitted = await aggregator.hasSubmitted(roundInfo.latestRoundId, wallet.address);
    if (alreadySubmitted) {
      console.log("Submission already recorded for this oracle. Nothing to do.");
      return;
    }
    console.log("This oracle is selected, but the round is closed or no longer submittable.");
    return;
  }

  const priceUsd = await fetchBtcPrice();
  console.log("Fetched BTC/USD:", priceUsd);

  const scaled = BigInt(Math.round(priceUsd * 1e8));
  console.log("Submitting price:", scaled.toString());

  const txSubmit = await aggregator.submit(scaled, roundInfo.latestRoundId);
  const receiptSubmit = await txSubmit.wait();
  console.log("Submit tx hash:", receiptSubmit.hash);
}

async function runWorker() {
  const { rpcUrl, pk, aggAddress, runOnce, autoFinalize, pollIntervalMs } = getConfig();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const aggregator = new ethers.Contract(aggAddress, AGGREGATOR_ABI, wallet);

  console.log("Oracle address:", wallet.address);
  console.log(
    "Worker config:",
    JSON.stringify({ runOnce, autoFinalize, pollIntervalMs })
  );

  if (runOnce) {
    await runIteration(aggregator, wallet, autoFinalize);
    return;
  }

  let stopped = false;
  const stop = (signal) => {
    if (stopped) {
      return;
    }
    stopped = true;
    console.log(`Received ${signal}. Stopping worker.`);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopped) {
    try {
      await runIteration(aggregator, wallet, autoFinalize);
    } catch (error) {
      console.error("Worker iteration error:", error);
    }

    if (stopped) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function main() {
  try {
    await runWorker();
  } catch (e) {
    console.error("Oracle error:", e);
    process.exitCode = 1;
  }
}

main();
