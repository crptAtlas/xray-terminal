import { parseAbi, toEventSelector } from "viem";

// Uniswap v4 PoolManager. Graduated tokens trade in a v4 pool managed by the
// hook; the Swap event carries both signed amounts, so the ETH quote for a
// trade is the side opposite to the token transfer.
export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

export const SWAP_TOPIC = toEventSelector(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);
