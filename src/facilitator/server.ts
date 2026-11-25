// Self-hosted x402 facilitator for BNB Smart Chain (testnet) and the local chain.
// Verifies EIP-3009 payment signatures and settles them on-chain, paying the gas.
import express, { type NextFunction, type Request, type Response } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { formatEther, isAddressEqual, type Address } from "viem";
import { walletFor } from "../chain.js";
import { config, explorerTx, requireKey } from "../config.js";
import { formatPusd, requireToken } from "../x402.js";

const wallet = walletFor(requireKey(config.keys.facilitator, "FACILITATOR_PRIVATE_KEY"));
const token = requireToken();
const allowedPayTo = config.payTo ? [config.payTo] : [];

const signer = toFacilitatorEvmSigner(
  {
    address: wallet.account.address,
    readContract: (args) => wallet.readContract(args as never),
    verifyTypedData: (args) => wallet.verifyTypedData(args as never),
    writeContract: (args) => wallet.writeContract(args as never),
    sendTransaction: (args) => wallet.sendTransaction(args as never),
    waitForTransactionReceipt: (args) => wallet.waitForTransactionReceipt(args),
    getCode: (args) => wallet.getCode(args),
  },
  { confirmationTimeoutMs: 60_000 },
);

const facilitator = new x402Facilitator();
registerExactEvmScheme(facilitator, { signer, networks: config.caip2 });

type FacilitatorRequest = { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };

/** Only settle our own token, on our network, to our seller: the gas key is not a public utility. */
function rejectForeignRequirements(body: FacilitatorRequest): string | undefined {
  const req = body.paymentRequirements;
  if (!body.paymentPayload || !req) return "paymentPayload and paymentRequirements are required";
  if (req.network !== config.caip2) return `unsupported network ${req.network}`;
  if (!isAddressEqual(req.asset as Address, token.address)) return `unsupported asset ${req.asset}`;
  if (allowedPayTo.length && !allowedPayTo.some((a) => isAddressEqual(a, req.payTo as Address))) {
    return `payTo ${req.payTo} is not served by this facilitator`;
  }
  return undefined;
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!config.facilitatorApiKey) return next();
  if (req.header("authorization") === `Bearer ${config.facilitatorApiKey}`) return next();
  res.status(401).json({ error: "unauthorized" });
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", async (_req, res) => {
  const gas = await wallet.getBalance({ address: wallet.account.address }).catch(() => undefined);
  res.json({
    ok: true,
    network: config.caip2,
    facilitator: wallet.account.address,
    gasBalance: gas === undefined ? null : formatEther(gas),
    token: token.address,
  });
});

app.get("/supported", requireApiKey, (_req, res) => {
  // The EVM helper also registers legacy v1 networks; advertise only what this facilitator settles.
  const supported = facilitator.getSupported();
  res.json({ ...supported, kinds: supported.kinds.filter((kind) => kind.network === config.caip2) });
});

app.post("/verify", requireApiKey, async (req, res) => {
  const body = req.body as FacilitatorRequest;
  const problem = rejectForeignRequirements(body);
  if (problem) return void res.status(400).json({ isValid: false, invalidReason: problem });
  try {
    res.json(await facilitator.verify(body.paymentPayload!, body.paymentRequirements!));
  } catch (error) {
    console.error("[facilitator] verify error", error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/settle", requireApiKey, async (req, res) => {
  const body = req.body as FacilitatorRequest;
  const problem = rejectForeignRequirements(body);
  if (problem) {
    return void res.status(400).json({ success: false, errorReason: problem, transaction: "", network: config.caip2 });
  }
  try {
    const result = await facilitator.settle(body.paymentPayload!, body.paymentRequirements!);
    const amount = formatPusd(body.paymentRequirements!.amount);
    if (result.success) {
      console.log(`[facilitator] settled ${amount} from ${result.payer} -> ${explorerTx(result.transaction)}`);
    } else {
      console.warn(`[facilitator] settle failed (${result.errorReason}) for ${amount}`);
    }
    res.json(result);
  } catch (error) {
    console.error("[facilitator] settle error", error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(config.ports.facilitator, async () => {
  const gas = await wallet.getBalance({ address: wallet.account.address }).catch(() => 0n);
  console.log(`[facilitator] ${config.network.label} (${config.caip2}) on http://127.0.0.1:${config.ports.facilitator}`);
  console.log(`[facilitator] signer ${wallet.account.address}, gas balance ${formatEther(gas)} BNB`);
  if (gas === 0n) console.warn("[facilitator] signer has no gas — settlements will fail until it is funded");
  if (!config.facilitatorApiKey && !config.isLocal) {
    console.warn("[facilitator] FACILITATOR_API_KEY is not set; anyone who can reach this port can spend its gas");
  }
});
