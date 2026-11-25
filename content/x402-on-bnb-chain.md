---
title: x402 on BNB Chain, Explained
price: $0.05
excerpt: How x402 works, why BSC tokens need special handling, and how to run your own facilitator.
---
# x402 on BNB Chain, Explained

## The flow
1. A client calls a paid endpoint without paying.
2. The server answers `402 Payment Required` with a `PAYMENT-REQUIRED` header: price, token, network and recipient.
3. The client signs a payment authorization (EIP-712) and repeats the request with a `PAYMENT-SIGNATURE` header.
4. The server asks a facilitator to verify the signature, runs its handler, then asks the facilitator to settle on-chain.
5. The client receives the data plus a `PAYMENT-RESPONSE` header that carries the transaction hash.

## Why BSC is different
The simplest `exact` scheme uses EIP-3009 (`transferWithAuthorization`): the buyer only signs and the facilitator pays gas. Binance-Peg USDT and USDC on BSC do not implement EIP-3009, so you have two options:

- **Permit2**: the buyer approves the Permit2 contract once; every later payment is just a signature.
- **A token that supports EIP-3009**, such as Pasar USD (pUSD) in this project for testnet use.

## Running your own facilitator
A facilitator is a server with three endpoints: `GET /supported`, `POST /verify` and `POST /settle`. Its wallet needs BNB for gas. Restrict it to your own token, network and recipient, and protect it with an API key.

## Pricing tip
Settlement gas on BSC is tiny but not zero. Charge at least about $0.01 per request, or use batch settlement for smaller payments.
