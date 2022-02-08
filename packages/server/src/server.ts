import Koa from 'koa';
import koaJsonRpc from 'koa-jsonrpc';
import {Bridge, BridgeImpl} from 'bridge';

const bridge: Bridge = new BridgeImpl();
const app = new Koa();
const rpc = koaJsonRpc();

rpc.use('net_listening', async () => { return "" + bridge.net().listening() });
rpc.use('net_version', async () => { return toHexString(bridge.net().version()) });
rpc.use('eth_blockNumber', async () => { return toHexString(bridge.eth().blockNumber()) });
rpc.use('eth_estimateGas', async () => { return toHexString(bridge.eth().estimateGas()) });
rpc.use('eth_getBalance', async () => { return toHexString(bridge.eth().getBalance()) });
rpc.use('eth_getCode', async () => { return toHexString(bridge.eth().getCode()) });
rpc.use('eth_chainId', async () => { return toHexString(bridge.eth().chainId()) });
rpc.use('eth_getBlockByNumber', async (params:any) => { return bridge.eth().getBlockByNumber(params?.[0]) });
rpc.use('eth_getBlockByHash', async (params:any) => { return bridge.eth().getBlockByHash(params?.[0]) });
rpc.use('eth_gasPrice', async () => { return toHexString(bridge.eth().gasPrice()) });
rpc.use('eth_getTransactionCount', async () => { return toHexString(bridge.eth().getTransactionCount()) });
// rpc.use('eth_sendRawTransaction', async () => { return bridge.eth().sendRawTransaction() });
// rpc.use('eth_getTransactionReceipt', async () => { return bridge.eth().getTransactionReceipt() });
app.use(rpc.app());

export default app;

// const app:Application = new Application();
// app.use(
//     cors({
//         origin: "*",
//         methods: ["POST"]
//     }),
// );
// export default app;
//

function toHexString(num:number) {
    return "0x" + num.toString(16);
}
