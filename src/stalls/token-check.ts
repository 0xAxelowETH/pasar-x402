// Stall 1 — BSC token risk check, computed only from on-chain data (no third-party APIs).
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  hexToString,
  isAddress,
  parseAbi,
  parseEther,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { bscMainnetClient, bscMainnetClients } from "../chain.js";
import { TokenProbeAbi, TokenProbeDeployedBytecode } from "../generated/contracts.js";

const PANCAKE_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** Empty address that receives the TokenProbe code via state override. */
const PROBE_ADDRESS = "0x000000000000000000000000000000000000f402";
const PROBE_AMOUNT = parseEther("0.01");

const factoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ownerAbi = parseAbi(["function owner() view returns (address)", "function getOwner() view returns (address)"]);

/** Owner-callable functions that change what holders can do. Matched as PUSH4 selectors in bytecode. */
const RISKY_FUNCTIONS = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "issue(uint256)"],
  blacklist: [
    "pause()",
    "blacklist(address)",
    "addToBlacklist(address)",
    "setBlacklist(address,bool)",
    "blacklistAddress(address,bool)",
    "setBots(address[],bool)",
    "addBots(address[])",
    "setBot(address,bool)",
    "setIsBlacklisted(address,bool)",
  ],
  fees: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTaxFeePercent(uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setTax(uint256,uint256)",
    "updateFees(uint256,uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "setTaxes(uint256,uint256)",
  ],
  limits: [
    "setMaxTxAmount(uint256)",
    "setMaxTxPercent(uint256)",
    "setMaxWalletSize(uint256)",
    "setMaxWallet(uint256)",
    "setMaxWalletAmount(uint256)",
  ],
  trading: ["enableTrading()", "openTrading()", "setTradingEnabled(bool)", "setTrading(bool)"],
} as const;

type RiskyCategory = keyof typeof RISKY_FUNCTIONS;

type Severity = "info" | "warn" | "danger";
type Flag = { code: string; severity: Severity; message: string };

const MESSAGES: Record<string, (v: Record<string, string>) => string> = {
  NOT_CONTRACT: () => "Address has no contract code",
  NOT_ERC20: () => "Does not behave like a BEP-20 token",
  NO_LIQUIDITY: () => "No PancakeSwap v2 liquidity against WBNB or USDT",
  LOW_LIQUIDITY: (v) => `Low liquidity (~$${v.usd})`,
  BUY_FAILS: () => "Buying reverted in simulation (trading disabled or anti-bot)",
  SELL_FAILS: () => "Selling reverted in simulation — likely honeypot",
  HIGH_SELL_TAX: (v) => `Sell tax ${v.pct}%`,
  HIGH_BUY_TAX: (v) => `Buy tax ${v.pct}%`,
  LP_NOT_BURNED: (v) => `Only ${v.pct}% of LP tokens are burned (the rest may be withdrawable or locked elsewhere)`,
  LP_BURNED: (v) => `${v.pct}% of LP tokens are burned`,
  OWNER_HOLDS_LP: (v) => `Owner wallet holds ${v.pct}% of the LP — it can pull the liquidity`,
  PROXY: () => "Upgradeable proxy: its admin can replace the token logic, even if owner() is renounced",
  OWNER_CAN_MINT: () => "Owner can mint new supply",
  OWNER_CAN_BLOCK: () => "Owner can pause transfers or blacklist wallets",
  OWNER_CAN_SET_FEES: () => "Owner can change taxes",
  OWNER_CAN_LIMIT: () => "Owner can change max transaction or wallet limits",
  OWNER_CONTROLS_TRADING: () => "Owner controls when trading is enabled",
  OWNER_RENOUNCED: () => "Ownership is renounced",
  OWNER_BIG_HOLDER: (v) => `Owner wallet holds ${v.pct}% of supply`,
  SIMULATION_UNAVAILABLE: () => "Buy/sell simulation unavailable on the configured RPCs",
};

export class TokenCheckError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const selectorsByCategory = Object.fromEntries(
  Object.entries(RISKY_FUNCTIONS).map(([category, signatures]) => [
    category,
    signatures.map((signature) => ({ signature, selector: toFunctionSelector(`function ${signature}`) })),
  ]),
) as Record<RiskyCategory, { signature: string; selector: Hex }[]>;

function scanBytecode(code: string) {
  const lower = code.toLowerCase();
  const found = {} as Record<RiskyCategory, string[]>;
  for (const category of Object.keys(selectorsByCategory) as RiskyCategory[]) {
    found[category] = selectorsByCategory[category]
      .filter(({ selector }) => lower.includes(`63${selector.slice(2)}`))
      .map(({ signature }) => signature);
  }
  return found;
}

function pct(numerator: bigint, denominator: bigint, digits = 2) {
  if (denominator === 0n) return 0;
  const scale = 10n ** BigInt(digits + 2);
  return Number((numerator * scale) / denominator) / 10 ** digits;
}

function decodeRevert(data: Hex): string | undefined {
  if (!data || data === "0x") return undefined;
  try {
    const decoded = decodeErrorResult({
      abi: parseAbi(["error Error(string)", "error Panic(uint256)"]),
      data,
    });
    return `${decoded.errorName}(${decoded.args.map(String).join(", ")})`;
  } catch {
    try {
      const text = hexToString(data).replace(/[^\x20-\x7e]/g, "").trim();
      if (text.length >= 4) return text;
    } catch {}
    return data.length > 74 ? `${data.slice(0, 74)}…` : data;
  }
}

async function readOwner(token: Address): Promise<Address | undefined> {
  for (const functionName of ["owner", "getOwner"] as const) {
    try {
      return await bscMainnetClient.readContract({ address: token, abi: ownerAbi, functionName });
    } catch {}
  }
  return undefined;
}

async function simulateRoundTrip(token: Address, amountIn: bigint) {
  const data = encodeFunctionData({
    abi: TokenProbeAbi,
    functionName: "probe",
    args: [PANCAKE_V2_ROUTER, token, amountIn],
  });
  let lastError: unknown;
  for (const client of bscMainnetClients) {
    try {
      const result = await client.call({
        to: PROBE_ADDRESS,
        data,
        gas: 8_000_000n,
        stateOverride: [{ address: PROBE_ADDRESS, code: TokenProbeDeployedBytecode, balance: parseEther("1") }],
      });
      if (!result.data) throw new Error("empty eth_call result");
      return decodeFunctionResult({ abi: TokenProbeAbi, functionName: "probe", data: result.data });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

type PairInfo = {
  dex: "PancakeSwap v2";
  pair: Address;
  quote: "WBNB" | "USDT";
  tokenReserve: string;
  quoteReserve: string;
  liquidityUsd: number;
  lpBurnedPct: number;
};

export async function bnbPriceUsd(): Promise<number> {
  const pair = await bscMainnetClient.readContract({
    address: PANCAKE_V2_FACTORY,
    abi: factoryAbi,
    functionName: "getPair",
    args: [WBNB, USDT],
  });
  const [token0, [r0, r1]] = await Promise.all([
    bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
  ]);
  const [wbnbReserve, usdtReserve] = getAddress(token0) === getAddress(WBNB) ? [r0, r1] : [r1, r0];
  return Number(formatUnits(usdtReserve, 18)) / Number(formatUnits(wbnbReserve, 18));
}

async function readPair(
  token: Address,
  quote: "WBNB" | "USDT",
  decimals: number,
  bnbUsd: number,
  owner: Address | undefined,
) {
  const quoteAddress = quote === "WBNB" ? WBNB : USDT;
  const pair = await bscMainnetClient.readContract({
    address: PANCAKE_V2_FACTORY,
    abi: factoryAbi,
    functionName: "getPair",
    args: [token, quoteAddress],
  });
  if (pair === zeroAddress) return undefined;

  const [token0, [r0, r1], lpSupply, lpDead, lpZero, lpOwner] = await Promise.all([
    bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
    bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }),
    bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: [DEAD] }),
    bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: [zeroAddress] }),
    owner
      ? bscMainnetClient.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: [owner] })
      : Promise.resolve(0n),
  ]);
  const [tokenReserve, quoteReserve] = getAddress(token0) === getAddress(token) ? [r0, r1] : [r1, r0];
  const quoteValue = Number(formatUnits(quoteReserve, 18)) * (quote === "WBNB" ? bnbUsd : 1);

  return {
    raw: { quoteReserve, ownerLpPct: pct(lpOwner, lpSupply) },
    info: {
      dex: "PancakeSwap v2",
      pair,
      quote,
      tokenReserve: formatUnits(tokenReserve, decimals),
      quoteReserve: formatUnits(quoteReserve, 18),
      liquidityUsd: Math.round(quoteValue * 2),
      lpBurnedPct: pct(lpDead + lpZero, lpSupply),
    } satisfies PairInfo,
  };
}

const cache = new Map<string, { at: number; report: TokenReport }>();
const CACHE_MS = 60_000;

export type TokenReport = Awaited<ReturnType<typeof analyze>>;

export async function checkToken(input: string) {
  if (!isAddress(input)) throw new TokenCheckError("Invalid address. Expected a 0x-prefixed BSC token address.", 400);
  const token = getAddress(input);
  const key = token;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;

  const report = await analyze(token);
  cache.set(key, { at: Date.now(), report });
  return report;
}

async function analyze(token: Address) {
  const flags: Flag[] = [];
  let score = 0;
  const flag = (code: string, severity: Severity, points: number, vars: Record<string, string> = {}) => {
    flags.push({ code, severity, message: MESSAGES[code](vars) });
    score += points;
  };

  const code = await bscMainnetClient.getCode({ address: token }).catch((error: unknown) => {
    throw new TokenCheckError(`BSC RPC unavailable: ${error instanceof Error ? error.message : error}`, 503);
  });

  const base = { chain: "bsc" as const, chainId: 56, address: token, checkedAt: new Date().toISOString() };
  const disclaimer = "Automated heuristic check from on-chain data. Not financial advice.";

  if (!code || code === "0x") {
    flag("NOT_CONTRACT", "danger", 100);
    return { ...base, token: null, contract: null, liquidity: null, simulation: null, risk: summarize(100, flags), disclaimer };
  }

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    bscMainnetClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => undefined),
    bscMainnetClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => undefined),
    bscMainnetClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => undefined),
    bscMainnetClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => undefined),
  ]);
  if (decimals === undefined || totalSupply === undefined) {
    flag("NOT_ERC20", "danger", 60);
    return {
      ...base,
      token: { name: name ?? null, symbol: symbol ?? null, decimals: null, totalSupply: null },
      contract: null,
      liquidity: null,
      simulation: null,
      risk: summarize(score, flags),
      disclaimer,
    };
  }

  // Contract controls -----------------------------------------------------
  const implSlot = await bscMainnetClient.getStorageAt({ address: token, slot: EIP1967_IMPLEMENTATION_SLOT });
  const implementation =
    implSlot && BigInt(implSlot) !== 0n ? getAddress(`0x${implSlot.slice(-40)}`) : undefined;
  const logicCode = implementation ? ((await bscMainnetClient.getCode({ address: implementation })) ?? "0x") : code;
  const risky = scanBytecode(implementation ? `${code}${logicCode}` : code);

  const owner = await readOwner(token);
  const ownerRenounced = owner !== undefined && (owner === zeroAddress || getAddress(owner) === getAddress(DEAD));
  const ownerActive = owner !== undefined && !ownerRenounced;
  // Without owner() we cannot tell who holds admin rights, so treat detected setters as live.
  const controlsLive = ownerActive || owner === undefined;

  if (implementation) flag("PROXY", "warn", 20);
  if (ownerRenounced) flag("OWNER_RENOUNCED", "info", 0);
  if (controlsLive) {
    if (risky.mint.length) flag("OWNER_CAN_MINT", "danger", 25);
    if (risky.blacklist.length) flag("OWNER_CAN_BLOCK", "warn", 20);
    if (risky.fees.length) flag("OWNER_CAN_SET_FEES", "warn", 15);
    if (risky.limits.length) flag("OWNER_CAN_LIMIT", "info", 5);
    if (risky.trading.length) flag("OWNER_CONTROLS_TRADING", "info", 5);
  }

  let ownerSharePct: number | null = null;
  if (ownerActive && totalSupply > 0n) {
    const ownerBalance = await bscMainnetClient
      .readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner!] })
      .catch(() => 0n);
    ownerSharePct = pct(ownerBalance, totalSupply);
    if (ownerSharePct >= 20) flag("OWNER_BIG_HOLDER", "warn", 10, { pct: ownerSharePct.toString() });
  }

  // Liquidity --------------------------------------------------------------
  const bnbUsd = await bnbPriceUsd();
  const lpOwner = ownerActive ? owner : undefined;
  const pairs = (
    await Promise.all([
      readPair(token, "WBNB", decimals, bnbUsd, lpOwner),
      readPair(token, "USDT", decimals, bnbUsd, lpOwner),
    ])
  ).filter((p) => p !== undefined);
  const totalLiquidityUsd = pairs.reduce((sum, p) => sum + p.info.liquidityUsd, 0);

  if (pairs.length === 0) {
    flag("NO_LIQUIDITY", "warn", 25);
  } else {
    if (totalLiquidityUsd < 1_000) flag("LOW_LIQUIDITY", "warn", 15, { usd: totalLiquidityUsd.toLocaleString("en-US") });
    const deepest = pairs.reduce((a, b) => (b.info.liquidityUsd > a.info.liquidityUsd ? b : a));
    const burned = deepest.info.lpBurnedPct;
    if (deepest.raw.ownerLpPct >= 50) {
      flag("OWNER_HOLDS_LP", "danger", 30, { pct: deepest.raw.ownerLpPct.toString() });
    } else if (burned >= 95) {
      flag("LP_BURNED", "info", 0, { pct: burned.toString() });
    } else if (totalLiquidityUsd < 50_000) {
      // Deep pools are normally held by many LPs; unburned LP only matters for thin ones.
      flag("LP_NOT_BURNED", "warn", 10, { pct: burned.toString() });
    }
  }

  // Buy/sell simulation ------------------------------------------------------
  let simulation: Record<string, unknown> | null = null;
  const wbnbPair = pairs.find((p) => p.info.quote === "WBNB");
  if (wbnbPair && wbnbPair.raw.quoteReserve > 0n) {
    const cap = wbnbPair.raw.quoteReserve / 100n;
    const amountIn = cap < PROBE_AMOUNT ? cap : PROBE_AMOUNT;
    try {
      const r = await simulateRoundTrip(token, amountIn);
      const buyTaxPct =
        r.buyOk && r.buyExpected > 0n && r.buyReceived < r.buyExpected ? pct(r.buyExpected - r.buyReceived, r.buyExpected) : 0;
      const sellTaxPct =
        r.sellOk && r.sellExpected > 0n && r.sellReceived < r.sellExpected
          ? pct(r.sellExpected - r.sellReceived, r.sellExpected)
          : 0;
      simulation = {
        ran: true,
        dex: "PancakeSwap v2",
        amountInBnb: formatEther(amountIn),
        buyOk: r.buyOk,
        sellOk: r.sellOk,
        buyTaxPct: r.buyOk ? buyTaxPct : null,
        sellTaxPct: r.sellOk ? sellTaxPct : null,
        buyGas: r.buyOk ? Number(r.buyGas) : null,
        sellGas: r.sellOk ? Number(r.sellGas) : null,
        buyError: r.buyOk ? null : (decodeRevert(r.buyError) ?? null),
        sellError: r.sellOk ? null : (decodeRevert(r.sellError) ?? null),
      };
      if (!r.buyOk) flag("BUY_FAILS", "danger", 40);
      else if (!r.sellOk) flag("SELL_FAILS", "danger", 70);
      if (r.sellOk && sellTaxPct >= 50) flag("HIGH_SELL_TAX", "danger", 60, { pct: sellTaxPct.toString() });
      else if (r.sellOk && sellTaxPct >= 10) flag("HIGH_SELL_TAX", "warn", 20, { pct: sellTaxPct.toString() });
      if (r.buyOk && buyTaxPct >= 10) flag("HIGH_BUY_TAX", "warn", 15, { pct: buyTaxPct.toString() });
    } catch (error) {
      simulation = { ran: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
      flag("SIMULATION_UNAVAILABLE", "info", 0);
    }
  }

  return {
    ...base,
    token: {
      name: name ?? null,
      symbol: symbol ?? null,
      decimals,
      totalSupply: formatUnits(totalSupply, decimals),
    },
    contract: {
      isProxy: Boolean(implementation),
      implementation: implementation ?? null,
      owner: owner ?? null,
      ownerRenounced,
      ownerSharePct,
      riskyFunctions: risky,
    },
    liquidity: { bnbPriceUsd: Math.round(bnbUsd * 100) / 100, totalUsd: totalLiquidityUsd, pairs: pairs.map((p) => p.info) },
    simulation,
    risk: summarize(score, flags),
    disclaimer,
  };
}

function summarize(score: number, flags: Flag[]) {
  const capped = Math.min(100, score);
  const level = capped >= 60 ? "high" : capped >= 25 ? "medium" : "low";
  return { score: capped, level, flags };
}
