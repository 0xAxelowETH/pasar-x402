import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, parseSignature, parseUnits, toHex, type Hex } from "viem";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const ONE_PUSD = parseUnits("1", 6);

describe("PasarUSD", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, alice, bob] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  async function deployToken() {
    const token = await viem.deployContract("PasarUSD", [owner.account.address]);
    await token.write.mint([alice.account.address, 100n * ONE_PUSD]);
    return { token };
  }

  async function signAuthorization(
    tokenAddress: Hex,
    primaryType: "TransferWithAuthorization" | "ReceiveWithAuthorization",
    message: { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex },
    signer = alice,
  ) {
    return signer.signTypedData({
      account: signer.account,
      domain: { name: "Pasar USD", version: "1", chainId, verifyingContract: tokenAddress },
      types: { [primaryType]: authorizationTypes[primaryType] },
      primaryType,
      message,
    });
  }

  async function authorization(value = ONE_PUSD) {
    const now = await networkHelpers.time.latest();
    return {
      from: alice.account.address,
      to: bob.account.address,
      value,
      validAfter: 0n,
      validBefore: BigInt(now + 3600),
      nonce: keccak256(toHex(`nonce-${Math.random()}`)),
    };
  }

  it("exposes the metadata x402 relies on", async function () {
    const { token } = await networkHelpers.loadFixture(deployToken);
    assert.equal(await token.read.name(), "Pasar USD");
    assert.equal(await token.read.symbol(), "pUSD");
    assert.equal(await token.read.decimals(), 6);
    assert.equal(await token.read.version(), "1");
    const [, name, version] = await token.read.eip712Domain();
    assert.equal(name, "Pasar USD");
    assert.equal(version, "1");
  });

  it("moves funds with a v,r,s authorization and burns the nonce", async function () {
    const { token } = await networkHelpers.loadFixture(deployToken);
    const auth = await authorization();
    const signature = await signAuthorization(token.address, "TransferWithAuthorization", auth);
    const { v, r, s } = parseSignature(signature);

    await viem.assertions.emitWithArgs(
      token.write.transferWithAuthorization(
        [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, Number(v), r, s],
        { account: owner.account },
      ),
      token,
      "AuthorizationUsed",
      [getAddress(auth.from), auth.nonce],
    );

    assert.equal(await token.read.balanceOf([bob.account.address]), ONE_PUSD);
    assert.equal(await token.read.authorizationState([auth.from, auth.nonce]), true);

    await viem.assertions.revertWithCustomError(
      token.write.transferWithAuthorization(
        [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, Number(v), r, s],
        { account: owner.account },
      ),
      token,
      "AuthorizationUsedOrCanceled",
    );
  });

  it("accepts the bytes-signature overload", async function () {
    const { token } = await networkHelpers.loadFixture(deployToken);
    const auth = await authorization(2n * ONE_PUSD);
    const signature = await signAuthorization(token.address, "TransferWithAuthorization", auth);

    await token.write.transferWithAuthorization(
      [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature],
      { account: owner.account },
    );
    assert.equal(await token.read.balanceOf([bob.account.address]), 2n * ONE_PUSD);
  });

  it("rejects expired, not-yet-valid and forged authorizations", async function () {
    const { token } = await networkHelpers.loadFixture(deployToken);
    const now = BigInt(await networkHelpers.time.latest());

    const expired = { ...(await authorization()), validBefore: now };
    const expiredSig = await signAuthorization(token.address, "TransferWithAuthorization", expired);
    await viem.assertions.revertWithCustomError(
      token.write.transferWithAuthorization([
        expired.from, expired.to, expired.value, expired.validAfter, expired.validBefore, expired.nonce, expiredSig,
      ]),
      token,
      "AuthorizationExpired",
    );

    const early = { ...(await authorization()), validAfter: now + 600n };
    const earlySig = await signAuthorization(token.address, "TransferWithAuthorization", early);
    await viem.assertions.revertWithCustomError(
      token.write.transferWithAuthorization([
        early.from, early.to, early.value, early.validAfter, early.validBefore, early.nonce, earlySig,
      ]),
      token,
      "AuthorizationNotYetValid",
    );

    const forged = await authorization();
    const forgedSig = await signAuthorization(token.address, "TransferWithAuthorization", forged, bob);
    await viem.assertions.revertWithCustomError(
      token.write.transferWithAuthorization([
        forged.from, forged.to, forged.value, forged.validAfter, forged.validBefore, forged.nonce, forgedSig,
      ]),
      token,
      "InvalidSignature",
    );
  });

  it("only lets the payee submit receiveWithAuthorization", async function () {
    const { token } = await networkHelpers.loadFixture(deployToken);
    const auth = await authorization();
    const signature = await signAuthorization(token.address, "ReceiveWithAuthorization", auth);
    const args = [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature] as const;

    await viem.assertions.revertWithCustomError(
      token.write.receiveWithAuthorization(args, { account: owner.account }),
      token,
      "CallerMustBePayee",
    );
    await token.write.receiveWithAuthorization(args, { account: bob.account });
    assert.equal(await token.read.balanceOf([bob.account.address]), ONE_PUSD);
  });

  it("rate-limits the public faucet", async function () {
    const { token } = await networkHelpers.loadFixture(deployToken);
    await token.write.faucet({ account: bob.account });
    assert.equal(await token.read.balanceOf([bob.account.address]), 100n * ONE_PUSD);

    await viem.assertions.revertWithCustomError(token.write.faucet({ account: bob.account }), token, "FaucetCooldown");

    await networkHelpers.time.increase(24 * 60 * 60);
    await token.write.faucet({ account: bob.account });
    assert.equal(await token.read.balanceOf([bob.account.address]), 200n * ONE_PUSD);
  });

  it("settles a real x402 exact payment end to end", async function () {
    const { token } = await networkHelpers.loadFixture(deployToken);
    const caip2 = `eip155:${chainId}` as const;

    const facilitator = new x402Facilitator();
    registerExactEvmScheme(facilitator, {
      networks: caip2,
      signer: toFacilitatorEvmSigner({
        address: owner.account.address,
        readContract: (args) => publicClient.readContract(args as never),
        verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
        writeContract: (args) => owner.writeContract({ ...args, account: owner.account } as never),
        sendTransaction: (args) => owner.sendTransaction({ ...args, account: owner.account }),
        waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
        getCode: (args) => publicClient.getCode(args),
      }),
    });

    const requirements = {
      scheme: "exact",
      network: caip2,
      asset: token.address,
      amount: (ONE_PUSD / 100n).toString(),
      payTo: bob.account.address,
      maxTimeoutSeconds: 120,
      extra: { name: "Pasar USD", version: "1" },
    };
    const client = new ExactEvmScheme({
      address: alice.account.address,
      signTypedData: (msg) => alice.signTypedData({ ...msg, account: alice.account } as never),
    });
    const partial = await client.createPaymentPayload(2, requirements);
    const payload = {
      ...partial,
      resource: { url: "http://localhost/test", description: "test", mimeType: "application/json" },
      accepted: requirements,
    };

    const verified = await facilitator.verify(payload, requirements);
    assert.equal(verified.isValid, true, JSON.stringify(verified));

    const settled = await facilitator.settle(payload, requirements);
    assert.equal(settled.success, true, JSON.stringify(settled));
    assert.equal(await token.read.balanceOf([bob.account.address]), ONE_PUSD / 100n);

    const replay = await facilitator.verify(payload, requirements);
    assert.equal(replay.isValid, false);
  });
});
