// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPancakeRouterLike {
    function WETH() external pure returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface IERC20BalanceLike {
    function balanceOf(address account) external view returns (uint256);
}

/// @title TokenProbe
/// @notice Simulates a buy followed by a sell on a PancakeSwap-style router.
/// @dev Never deployed. The token-check service injects this runtime bytecode with an
///      eth_call state override (code + BNB balance), so the simulation is free and
///      leaves no trace on-chain. Taxes are measured against the router's own quotes.
contract TokenProbe {
    struct Result {
        bool buyOk;
        bool sellOk;
        uint256 buyExpected;
        uint256 buyReceived;
        uint256 sellExpected;
        uint256 sellReceived;
        uint256 buyGas;
        uint256 sellGas;
        bytes buyError;
        bytes sellError;
    }

    receive() external payable {}

    function probe(address router, address token, uint256 amountIn) external returns (Result memory r) {
        IPancakeRouterLike pancake = IPancakeRouterLike(router);
        address wbnb = pancake.WETH();

        address[] memory buyPath = new address[](2);
        buyPath[0] = wbnb;
        buyPath[1] = token;

        try pancake.getAmountsOut(amountIn, buyPath) returns (uint256[] memory amounts) {
            r.buyExpected = amounts[1];
        } catch {}

        uint256 tokenBefore = IERC20BalanceLike(token).balanceOf(address(this));
        uint256 gasStart = gasleft();
        try pancake.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amountIn}(
            0, buyPath, address(this), block.timestamp
        ) {
            r.buyGas = gasStart - gasleft();
            r.buyOk = true;
        } catch (bytes memory reason) {
            r.buyError = reason;
            return r;
        }
        r.buyReceived = IERC20BalanceLike(token).balanceOf(address(this)) - tokenBefore;
        if (r.buyReceived == 0) return r;

        // Low-level approve: some tokens return nothing from approve().
        (bool approved,) = token.call(abi.encodeWithSelector(0x095ea7b3, router, type(uint256).max));
        if (!approved) {
            r.sellError = bytes("approve reverted");
            return r;
        }

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = wbnb;

        try pancake.getAmountsOut(r.buyReceived, sellPath) returns (uint256[] memory amounts) {
            r.sellExpected = amounts[1];
        } catch {}

        uint256 bnbBefore = address(this).balance;
        gasStart = gasleft();
        try pancake.swapExactTokensForETHSupportingFeeOnTransferTokens(
            r.buyReceived, 0, sellPath, address(this), block.timestamp
        ) {
            r.sellGas = gasStart - gasleft();
            r.sellOk = true;
            r.sellReceived = address(this).balance - bnbBefore;
        } catch (bytes memory reason) {
            r.sellError = reason;
        }
    }
}
