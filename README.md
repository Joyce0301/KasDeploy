# Kaspa Chainlink-style BTC Oracle

一个部署在 **Kasplex EVM 测试网（`rpc.kasplextest.xyz`）** 上的、参考 Chainlink 1.0 架构的 **BTC/USD 预言机 MVP**：

- 使用 Solidity 编写的合约：
  - `LinkToken`：用于支付 oracle 的 ERC20(+transferAndCall) 代币 `KLINK`
  - `OracleRegistry`：管理 oracle 列表与简单声誉计数
  - `BtcUsdAggregator`：多 oracle 聚合 BTC/USD 价格（中位数）
  - `BtcPriceConsumer`：示例用户合约，用于读取 BTC 价格
- 使用 Node.js 编写的 **off-chain oracle**，从公共 API 获取 BTC 价格并提交到链上

当前版本在最初 MVP 基础上，已经补上了一套 **最小可用的 slashing + quorum/timeout** 机制：

- oracle 需要先质押 `KLINK` 才能被加入 active set
- 每轮都有固定超时，避免单个 oracle 不提交导致系统卡死
- 超时后只要达到 quorum，就能 finalize 本轮并对未提交者执行 slash
- 超时后如果连 quorum 都没达到，则本轮记为 failed，并对未提交者执行 slash

## 当前已实现

目前仓库里已经打通了下面这条最小可用链路：

1. 部署 `LinkToken`、`OracleRegistry`、`BtcUsdAggregator`、`OrderMatching`、`BtcPriceConsumer`
2. oracle 先质押 `KLINK`，再被加入 active set
3. 请求方通过 `OrderMatching` 创建一条带 SLA 参数的请求
4. active oracle 对请求进行 bid
5. `OrderMatching` 根据基础 reputation 指标挑选中标 oracle，并按该请求的 `payment/quorum/timeout/penalty` 启动 round
6. 中标 oracle 通过链下 worker 自动轮询最新 round，在自己被选中且仍可提交时上报 BTC/USD 价格
7. round 在两种情况下结束：
   - 全部中标 oracle 在 timeout 前提交，立即 finalize
   - timeout 到达后，由任意调用者或 worker 触发 `finalizeTimedOutRound()`
8. 提交成功的 oracle 获得该请求定义的 reward，未提交的中标 oracle 按该请求定义的 penalty 被 slash
9. consumer 合约和外部脚本可以通过 `latestRoundData()` 读取最新聚合价格

已覆盖的机制包括：

- 基础 reputation 计数：`assigned / submitted / accepted`
- request-scoped SLA：每个请求单独配置 `oracleCount / quorum / timeout / payment / penalty`
- request-scoped oracle selection：每轮只允许中标 oracle 提交
- per-request reward/slashing：奖励和罚没不再是全局固定值
- 基础 worker 自动化：自动轮询、自动 submit、自动 timeout finalize
- 基础测试覆盖：manual round、request round、timeout/slash、bid ranking、cancel/refund

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

基础必填：

- **`RPC_URL`**：RPC 地址  
  - 默认：`https://rpc.kasplextest.xyz`
- **`DEPLOYER_PK`**：部署者私钥（带 `0x` 前缀）

运行 oracle worker 时必填：

- **`ORACLE_PK`**：预言机节点的私钥（可以与 `DEPLOYER_PK` 相同，也可以分离）
- **`AGGREGATOR_ADDRESS`**：`BtcUsdAggregator` 合约地址

运行 request 脚本时必填：

- **`ORDER_MATCHING_ADDRESS`**：`OrderMatching` 合约地址
- **`REQUESTER_PK`**：请求方私钥
  - 未设置时默认回退到 `DEPLOYER_PK`

运行 `request:demo` 时额外必填：

- **`ORACLE_PKS`**：用于自动 bidding 的 oracle 私钥列表，逗号分隔

可选参数：

- **`ORACLE_POLL_INTERVAL_MS`**：worker 轮询最新 round 的间隔，默认 `15000`
- **`ORACLE_AUTO_FINALIZE`**：是否在 round 超时后自动调用 `finalizeTimedOutRound()`，默认 `true`
- **`ORACLE_RUN_ONCE`**：是否只执行一次检查，默认 `false`

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
4. 授权 `BtcUsdAggregator` 更新 `OracleRegistry` 中的声誉统计
5. 为首个 oracle 质押最小 stake，并在 `OracleRegistry` 与 `BtcUsdAggregator` 中注册
6. 把一部分 `KLINK` 转入 `BtcUsdAggregator`，用于支付 oracle 报酬
7. 部署 `BtcPriceConsumer`，并指向 `BtcUsdAggregator`

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

同时也要把 `OrderMatching` 地址填回 `.env`：

```dotenv
ORDER_MATCHING_ADDRESS=0x...
```

---

## 创建请求并启动 round

如果你只是想快速把 round 跑起来，让 worker 不再一直提示 `No rounds exist yet`，现在有两种方式：

只创建 request：

```bash
npm run request:create
```

这个脚本会：

1. 用 `REQUESTER_PK` 或 `DEPLOYER_PK` 作为请求方
2. 给 `OrderMatching` 授权本次 request 预算
3. 创建一条新的 request

它不会自动 bid 和 finalize，所以 round 还不会启动。

跑完整 demo flow：

```bash
npm run request:demo
```

这个脚本会：

1. 创建 request
2. 使用 `ORACLE_PKS` 里的前 `REQUEST_ORACLE_COUNT` 个 oracle 自动 bid
3. 等 bidding window 结束
4. 自动调用 `finalizeRequest()`
5. 启动新的 round

常用可选环境变量：

- `REQUEST_SPEC`：请求标识，默认 `btc-usd`
- `REQUEST_ORACLE_COUNT`：需要的 oracle 数量，默认等于 `ORACLE_PKS` 数量
- `REQUEST_QUORUM`：quorum，默认等于 `REQUEST_ORACLE_COUNT`
- `REQUEST_BIDDING_WINDOW_SECONDS`：bidding 窗口，默认 `60`
- `REQUEST_TIMEOUT_SECONDS`：round timeout，默认 `300`
- `REQUEST_PAYMENT_PER_ORACLE`：每个 oracle 的奖励，默认 `10`
- `REQUEST_PENALTY_AMOUNT`：每个 oracle 的 penalty，默认 `25`

在 `npm run request:demo` 完成后，再启动或保持 `npm run oracle:btc` 运行，worker 就会发现最新 round 并自动提交。

### 关于 oracle 数量的说明

`REQUEST_ORACLE_COUNT` 和 `REQUEST_QUORUM` 决定了一条 request 需要多少个 oracle 参与。

例如：

- `REQUEST_ORACLE_COUNT=2`
- `REQUEST_QUORUM=2`

表示这条 request 需要 2 个 active oracle 参与 bidding，并且最终需要 2 个 oracle 都提交，才能在 timeout 前直接 finalize。

这意味着你需要同时满足下面两个条件：

1. 链上已经注册了足够数量的 active oracle
   - 这些 oracle 地址已经完成 `depositStake()`
   - 已经被加入 `OracleRegistry`
   - 已经被加入 `BtcUsdAggregator`
2. `.env` 中配置了足够数量的 oracle 私钥
   - 例如：`ORACLE_PKS=0xpk1,0xpk2`

如果你只有 1 个 oracle 账户在本地运行，但 request 配成了 `2/2`，那么：

- request 可以被创建
- 但不容易完成 bidding 和 finalize
- worker 也会一直看不到可提交的 round

如果你只是想先快速把整条链路调通，建议先用单 oracle 配置：

```dotenv
REQUEST_ORACLE_COUNT=1
REQUEST_QUORUM=1
ORACLE_PKS=0x你的单个oracle私钥
```

这样一个 active oracle 就能完成 demo flow，更适合本地联调。

---

## 运行 BTC 预言机（off-chain oracle）

在 round 已经被创建并启动之后，再运行 `oracle/oracle-btc.js`。

它现在是一个可持续运行的 worker，会按“最新 round”工作，而不是自行开启 round。它会：

1. 读取聚合合约的最新 round 状态
2. 在 round 超时后，尝试自动调用 `finalizeTimedOutRound()`
3. 检查当前 oracle 地址是否是该 round 的中标 oracle
4. 检查该 round 当前是否仍可提交
5. 只有在“已中标且可提交”时，才会从 CoinGecko 获取 BTC/USD 价格并上链

以 worker 模式持续运行：

```bash
npm run oracle:btc
```

只执行一次检查：

```bash
npm run oracle:btc:once
```

需要确保：

- `.env` 中的 `ORACLE_PK` 有足够的 KAS 测试币支付 gas
- `.env` 中的 `AGGREGATOR_ADDRESS` 已设置为正确的聚合合约地址
- 已经通过 `OrderMatching` 创建请求、完成 bidding，并成功启动了最新 round

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
- **最小可用 slashing + quorum/timeout**：
  - oracle 先通过 `depositStake()` 质押 `KLINK`，stake 达到门槛后才能被 owner 加入 active set
  - `startNewRound()` 会开启新 round，并记录本轮的 `timeoutAt`
  - 若所有 active oracle 都在超时前提交，则立即 finalize，不执行 slash
  - 若超时后仍未收齐，只要提交数达到 `quorum`，任何人都可以调用 `finalizeTimedOutRound()` 用已提交数据完成聚合
  - timeout finalize 时，未提交的 active oracle 会被扣除固定 `slashAmount`
  - 若超时后连 quorum 都没达到，则 round 会被标记为 failed，同时仍会 slash 未提交者
- **当前仍然是 MVP**：
  - 还没有做“离群值/恶意错误值”的 slashing，只惩罚“不提交”
  - 还没有完整的自动 round 调度，但已经有基础的 worker 轮询和 timeout finalize
  - 声誉系统目前仍是基础计数器，不包含更复杂的评分模型

### 关键参数

- `paymentPerOracle`：每轮每个成功提交 oracle 的固定奖励
- `requiredStakeAmount`：成为 active oracle 所需的最低质押
- `slashAmount`：超时未提交时扣除的固定 stake
- `minSubmissionCount`：timeout 后允许 finalize 的最小提交数
- `roundTimeoutSeconds`：每轮的超时秒数

### Round 生命周期

1. oracle 先持有并质押 `KLINK`
2. owner 将其加入 `OracleRegistry` 和 aggregator 的 active oracle 列表
3. owner 或 active oracle 调用 `startNewRound()`
4. active oracle 在 timeout 前调用 `submit(answer, roundId)`
5. 若全员提交，round 立即 finalize
6. 若 timeout 到达：
   - 达到 quorum：允许 finalize，并 slash 未提交者
   - 未达到 quorum：round fail，并 slash 未提交者

---

## 常用 npm 脚本

- **编译合约**

  ```bash
  npm run compile
  ```

- **运行测试（如果你添加了测试文件）**
  - 当前仓库已包含针对 quorum/timeout/slashing 的基础测试

  ```bash
  npm test
  ```

- **部署到 Kasplex 测试网**

  ```bash
  npm run deploy:kasplexTest
  ```

- **创建 request**

  ```bash
  npm run request:create
  ```

- **跑完整 demo request flow**

  ```bash
  npm run request:demo
  ```

- **运行一次 BTC 预言机喂价**
  - `oracle:btc` 会持续轮询并在需要时自动 submit / finalize

  ```bash
  npm run oracle:btc
  ```

- **运行一次单次检查**

  ```bash
  npm run oracle:btc:once
  ```

---
