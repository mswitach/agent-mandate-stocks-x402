// Vendedor x402 local + facilitador local, liquidando en el FORK de Base (chainId 8453, anvil).
// Usa el facilitador oficial de @x402/evm (esquema "exact": verifica la firma EIP-3009 y llama a
// USDC.transferWithAuthorization). Solo cambia el "dónde": la tx se manda al fork, no a Base mainnet.
import http from "node:http";
import { createWalletClient, http as viemHttp, publicActions } from "viem";
import { base } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";

export const FORK_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const FORK_NETWORK = "eip155:8453";

export async function startLocalSeller({ rpc, payTo, facilitatorAccount, port = 4021, amount = "1000", content }) {
  const wc = createWalletClient({ account: facilitatorAccount, chain: base, transport: viemHttp(rpc) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner({
    address: facilitatorAccount.address,
    readContract: (a) => wc.readContract(a),
    verifyTypedData: (a) => wc.verifyTypedData(a),
    writeContract: (a) => wc.writeContract(a),
    sendTransaction: (a) => wc.sendTransaction(a),
    waitForTransactionReceipt: (a) => wc.waitForTransactionReceipt(a),
    getCode: (a) => wc.getCode(a),
  });
  const facilitator = new x402Facilitator().register(FORK_NETWORK, new ExactEvmScheme(signer));
  const requirements = {
    scheme: "exact", network: FORK_NETWORK, amount, asset: FORK_USDC, payTo, maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
  const log = [];
  const server = http.createServer(async (req, res) => {
    const url = `http://127.0.0.1:${port}${req.url}`;
    const resource = { url, description: "Ficha de AAPLc (dato pago, PoC)", mimeType: "application/json" };
    const sig = req.headers["payment-signature"] ?? req.headers["x-payment"];
    if (!sig) {
      res.writeHead(402, { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader({ x402Version: 2, error: "Payment required", resource, accepts: [requirements] }) });
      log.push({ at: new Date().toISOString(), step: "402" });
      return res.end("{}");
    }
    try {
      const payload = decodePaymentSignatureHeader(sig);
      const v = await facilitator.verify(payload, requirements);
      log.push({ at: new Date().toISOString(), step: "verify", result: v });
      if (!v.isValid) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: v.invalidReason ?? "invalid" }));
      }
      const s = await facilitator.settle(payload, requirements);
      log.push({ at: new Date().toISOString(), step: "settle", result: s, authorization: payload.payload?.authorization });
      if (!s.success) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: s.errorReason ?? "settle failed" }));
      }
      res.writeHead(200, { "content-type": "application/json", "payment-response": encodePaymentResponseHeader(s) });
      res.end(JSON.stringify(await content()));
    } catch (e) {
      log.push({ at: new Date().toISOString(), step: "error", error: String(e?.message ?? e) });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}/aaplc`, requirements, log, close: () => new Promise((r) => server.close(r)) };
}
