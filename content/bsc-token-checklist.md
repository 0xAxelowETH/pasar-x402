---
title: The 10-Minute BSC Token Checklist
price: $0.03
excerpt: Ten quick checks you can run yourself before putting money into a new token.
---
# The 10-Minute BSC Token Checklist

1. **Is the contract verified?** Open BscScan. Unverified code means you cannot read the rules.
2. **Is the owner still active?** Check `owner()`. An active owner plus `mint` or `setFee` functions means the rules can change at any time.
3. **Is it a proxy?** A proxy's logic can be replaced by its admin, even when `owner()` is renounced.
4. **Simulate a sell.** Honeypots can be bought but not sold. Always simulate a buy followed by a sell.
5. **Buy and sell tax.** Taxes above 10% eat capital quickly. Above 50% is almost certainly a trap.
6. **Liquidity.** Below $1,000 the price is easy to manipulate and hard to exit.
7. **Is the LP burned or locked?** If the owner's wallet holds the LP, liquidity can be pulled at any time (a rug pull).
8. **Holder distribution.** One wallet holding a large share of supply can crash the price.
9. **Blacklist and pause functions.** The owner can stop specific wallets from selling.
10. **Start small.** Test with a small amount, and try selling before you add to the position.

The Token Check stall in Pasar x402 automates points 2 to 7 in a single request.
