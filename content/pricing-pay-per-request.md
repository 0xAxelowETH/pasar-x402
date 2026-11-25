---
title: Pricing a Pay-per-Request API
price: $0.02
excerpt: Account for gas, server costs and margin so your x402 API never sells at a loss.
---
# Pricing a Pay-per-Request API

## 1. Work out the settlement cost
Each `exact` payment is one on-chain transaction whose gas the facilitator pays. On BSC, one `transferWithAuthorization` uses roughly 60–80 thousand gas. Multiply by the current gas price and the BNB price to get the dollar cost per payment.

## 2. Add your service cost
Count RPC, server and compute (for example AI) per request. For expensive services, the price has to cover the worst case, not the average.

## 3. Set a floor
If the price is lower than the settlement cost, every sale loses money. A safe floor on BSC is $0.01.

## 4. Tier your prices
- Light requests (data lookups): $0.01
- Heavy requests (AI, simulations): $0.02–$0.10
- Premium content per item: $0.02–$1

## 5. Never charge for failures
The x402 middleware only settles when the handler succeeds (status below 400). Make sure your service returns an error status when it fails, so buyers never pay for an empty result.
