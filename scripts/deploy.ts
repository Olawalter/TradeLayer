/**
 * Deploy the TradeLayer Intelligent Contract to GenLayer StudioNet and write
 * the deployment artifact.
 *
 * Run:  npm run deploy      (needs BUYER_PK in .env)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TransactionStatus } from "genlayer-js/types";
import { signer, STUDIO_URL, CHAIN_ID, sleep } from "./genlayer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCE = path.join(ROOT, "contracts", "tradelayer.py");

async function main() {
  const client = signer("BUYER_PK");
  const code = fs.readFileSync(SOURCE, "utf-8");

  console.log("TradeLayer — deploying to StudioNet");
  console.log("  deployer:", (client as any).account.address);
  console.log("  source  :", path.relative(ROOT, SOURCE));
  console.log("  bytes   :", Buffer.byteLength(code, "utf-8"));

  const hash: any = await (client as any).deployContract({ code, args: [] });
  console.log("  deploy tx:", hash);

  let address = "";
  const started = Date.now();
  while (!address && Date.now() - started < 600_000) {
    try {
      const receipt: any = await client.waitForTransactionReceipt({
        hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 12,
      });
      address =
        receipt?.contractAddress ??
        receipt?.data?.contract_address ??
        receipt?.tx_data_decoded?.contract_address ??
        "";
      if (!address) {
        console.log("  receipt carried no address yet, retrying...");
        await sleep(6_000);
      }
    } catch {
      await sleep(6_000);
    }
  }

  if (!address) {
    console.error("Deployment did not surface a contract address in time.");
    process.exit(1);
  }

  console.log("\n  contract address:", address);

  const artifact = {
    name: "TradeLayer",
    network: "studionet",
    chainId: CHAIN_ID,
    rpcUrl: STUDIO_URL,
    contractAddress: address,
    deployTxHash: hash,
    contractFile: "contracts/tradelayer.py",
    deployedAt: new Date().toISOString(),
    explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  };
  const out = path.join(ROOT, "deploy", "deployment.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
  console.log("  artifact written to deploy/deployment.json");

  console.log("\n  Add to .env:");
  console.log(`  TRADELAYER_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error("Deployment failed:", err?.message ?? err);
  process.exit(1);
});
