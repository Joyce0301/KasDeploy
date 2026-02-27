# Kaspa Chainlink-style BTC Oracle

一个部署在 **Kasplex EVM 测试网（`rpc.kasplextest.xyz`）** 上的、参考 Chainlink 1.0 架构的 **BTC/USD 预言机 MVP**：

- 使用 Solidity 编写的合约：
  - `LinkToken`：用于支付 oracle 的 ERC20(+transferAndCall) 代币 `KLINK`
  - `OracleRegistry`：管理 oracle 列表与简单声誉计数
  - `BtcUsdAggregator`：多 oracle 聚合 BTC/USD 价格（中位数）
  - `BtcPriceConsumer`：示例用户合约，用于读取 BTC 价格
- 使用 Node.js 编写的 **off-chain oracle**，从公共 API 获取 BTC 价格并提交到链上

---

## 目录结构

- **`contracts/`**
  - `LinkToken.sol`：KLINK 代币
  - `OracleRegistry.sol`：oracle 注册与基本统计
  - `BtcUsdAggregator.sol`：BTC/USD 聚合合约
  - `BtcPriceConsumer.sol`：价格读取示例合约
- **`scripts/`**
  - `deploy.js`：一键部署所有合约并完成基础配置
- **`oracle/`**
  - `oracle-btc.js`：BTC 价格预言机脚本（从 CoinGecko 拉取价格并上链）
- **项目配置**
  - `package.json`：依赖与 npm 脚本
  - `hardhat.config.js`：Hardhat 配置（包含 `kasplexTest` 网络）
  - `.env.example`：环境变量示例

---

## 环境要求

- Node.js ≥ 18
- npm 或 pnpm / yarn
- 一个有测试币的 Kasplex EVM 账户（用于部署和支付 gas）

---

## 安装

```bash
git clone <your-repo-url>
cd <your-repo-folder>

npm install
```

---

## 配置环境变量

复制示例文件并填写：

```bash
cp .env.example .env
```

`.env` 字段说明：

- **`RPC_URL`**：RPC 地址  
  - 默认：`https://rpc.kasplextest.xyz`
- **`DEPLOYER_PK`**：部署者私钥（带 `0x` 前缀）
- **`ORACLE_PK`**：预言机节点的私钥（可以与 `DEPLOYER_PK` 相同，也可以分离）
- **`AGGREGATOR_ADDRESS`**：`BtcUsdAggregator` 合约地址（部署后再填）

---

## 编译合约

```bash
npx hardhat compile
```

---

## 部署到 Kasplex 测试网

```bash
npm run deploy:kasplexTest
```

脚本会完成：

1. 部署 `LinkToken`（`KLINK`）
2. 部署 `OracleRegistry`
3. 部署 `BtcUsdAggregator`
4. 在 `OracleRegistry` 与 `BtcUsdAggregator` 中把部署者地址注册为首个 oracle
5. 把一部分 `KLINK` 转入 `BtcUsdAggregator`，用于支付 oracle 报酬
6. 部署 `BtcPriceConsumer`，并指向 `BtcUsdAggregator`

终端输出中会包含各个合约地址，例如：

```text
LinkToken deployed at:      0x...
OracleRegistry deployed at: 0x...
BtcUsdAggregator deployed at: 0x...
BtcPriceConsumer deployed at: 0x...
```

将 `BtcUsdAggregator` 的地址填回 `.env` 中的：

```dotenv
AGGREGATOR_ADDRESS=0x...
```

---

## 运行 BTC 预言机（off-chain oracle）

`oracle/oracle-btc.js` 是一个最小示例，用来：

1. 调用 `startNewRound()` 开启新一轮报价
2. 从 CoinGecko 获取当前 BTC/USD 价格
3. 将价格按 8 位小数缩放（例如 `30000.12` → `3000012000000`）
4. 调用 `submit(price, roundId)` 把报价提交到聚合合约

运行一次喂价：

```bash
npm run oracle:btc
```

需要确保：

- `.env` 中的 `ORACLE_PK` 有足够的 KAS 测试币支付 gas
- `.env` 中的 `AGGREGATOR_ADDRESS` 已设置为正确的聚合合约地址

---

## 在链上读取 BTC 价格

`BtcPriceConsumer` 为示例用户合约，它通过 `BtcUsdAggregator` 读取价格：

```solidity
function getBtcPrice() external view returns (int256 price, uint8 priceDecimals) {
    (, price, , , ) = aggregator.latestRoundData();
    priceDecimals = aggregator.decimals(); // 固定为 8
}
```

你可以：

- 在前端 / 脚本中直接调用 `BtcUsdAggregator.latestRoundData()`；
- 或与 `BtcPriceConsumer` 交互，从中获取当前价格和小数位。

---

## 设计简要说明

- **参考 Chainlink 1.0**：
  - 链上：`OracleRegistry` + `BtcUsdAggregator` 对应白皮书中的 Reputation + Aggregation
  - 链下：`oracle-btc.js` 对应 Chainlink Node（监听链上、拉取 off-chain 数据、提交结果）
- **价格聚合**：
  - 支持多个 oracle 报价，当前实现为 **中位数聚合**
  - 每个 oracle 报价成功后，会从 `BtcUsdAggregator` 中领取固定 `KLINK` 作为报酬
- **MVP 取舍**：
  - 暂未实现完整 SLA / 罚没逻辑 / 完整声誉系统
  - 专注演示「Kaspa 上 Chainlink 风格 BTC 预言机」的最小闭环

---

## 常用 npm 脚本

- **编译合约**

  ```bash
  npm run compile
  ```

- **运行测试（如果你添加了测试文件）**

  ```bash
  npm test
  ```

- **部署到 Kasplex 测试网**

  ```bash
  npm run deploy:kasplexTest
  ```

- **运行一次 BTC 预言机喂价**

  ```bash
  npm run oracle:btc
  ```

---

如果你后续扩展（比如增加多 oracle、支持更多交易对、完善声誉与罚没机制），可以在 README 末尾补充一个 `Roadmap` 小节列出未来计划。

