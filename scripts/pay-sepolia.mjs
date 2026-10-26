// Pago x402 REAL en Base Sepolia (testnet) con una wallet descartable en memoria.
// La clave se genera al arrancar, nunca se escribe a disco y muere con el proceso.
// Flujo: 1) imprime la dirección; 2) espera USDC de prueba (faucet público de Circle, sin cuenta);
// 3) chequea el mandato (payTo, monto, red, vencimiento); 4) paga vía x402 (EIP-3009, gas lo paga el facilitador).
import { createPublicClient, http, formatUnits, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { writeFileSync, mkdirSync } from "node:fs";
import { signMandate, checkPayment, PAY_ACTION, mandateHash, signReceipt } from "../src/mandate.js";

const ENDPOINT = process.env.ENDPOINT ?? "https://wallets-demo-seller-server.calebgcarithers.workers.dev/weather?location=Buenos%20Aires";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC de Circle en Base Sepolia
const EXPECTED_PAYTO = getAddress("0xCBd4E4218B2Cd8300f1bd07b9B4B720fAb6B51B3");
const pc = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

const user = privateKeyToAccount(generatePrivateKey());   // "usuario" descartable
const agent = privateKeyToAccount(generatePrivateKey());  // agente descartable
console.log(`AGENT_ADDRESS=${agent.address}`);
console.log(`USER_ADDRESS=${user.address}`);
console.log("Esperando USDC de prueba en Base Sepolia (faucet.circle.com)...");

// Mandato de pago firmado por el usuario: tope 0,002 USDC, solo a ese payTo, 24 h.
const mandate = {
  user: user.address, agent: agent.address, action: PAY_ACTION, reserveId: 0n, asset: USDC,
  maxAmount: 2000n, recipient: EXPECTED_PAYTO, validUntil: BigInt(Math.floor(Date.now() / 1000) + 86400),
  nonce: "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
};
const mandateSig = await signMandate(user, mandate, { chainId: 84532, verifyingContract: "0x0000000000000000000000000000000000000000" });

const deadline = Date.now() + 45 * 60_000;
let bal = 0n;
while (Date.now() < deadline) {
  bal = await pc.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [agent.address] }).catch(() => 0n);
  if (bal >= 1000n) break;
  await new Promise(r => setTimeout(r, 10_000));
}
if (bal < 1000n) { console.log("SIN_FONDOS: no llegó USDC de prueba en 45 min. Fin."); process.exit(2); }
console.log(`Saldo agente: ${formatUnits(bal, 6)} USDC (Sepolia)`);

// Probe sin pagar para leer los requisitos y validarlos contra el mandato ANTES de firmar nada.
const probe = await fetch(ENDPOINT);
const req = JSON.parse(Buffer.from(probe.headers.get("payment-required"), "base64").toString());
const accept = req.accepts.find(a => a.network === "eip155:84532" && a.scheme === "exact");
const verdict = checkPayment(mandate, { payTo: accept.payTo, amount: BigInt(accept.amount), asset: accept.asset, alreadyUsed: 0n, now: BigInt(Math.floor(Date.now() / 1000)) });
console.log("Chequeo de mandato:", verdict);
if (!verdict.ok) process.exit(3);

const f = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(agent) }] });
const t0 = new Date();
const res = await f(ENDPOINT, { method: "GET" });
const body = await res.text();
const prh = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
const settle = prh ? decodePaymentResponseHeader(prh) : null;
console.log("HTTP", res.status, "settle:", settle);
let rcpt = null;
if (settle?.transaction) {
  rcpt = await pc.waitForTransactionReceipt({ hash: settle.transaction, timeout: 60_000 }).catch(e => ({ error: String(e) }));
}
const balAfter = await pc.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [agent.address] });
// Recibo firmado por el agente (agregado después de la corrida del 26/10: esa corrida no lo tiene).
let agentReceipt = null;
if (rcpt?.blockNumber) {
  const dom = { chainId: 84532, verifyingContract: "0x0000000000000000000000000000000000000000" };
  const rec = { mandateHash: mandateHash(dom, mandate), user: user.address, agent: agent.address, action: PAY_ACTION, asset: USDC, amount: BigInt(accept.amount), recipient: accept.payTo, chainId: 84532n, txHash: settle.transaction, blockNumber: rcpt.blockNumber };
  agentReceipt = { receipt: Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, String(v)])), agentSig: await signReceipt(agent, rec) };
}
mkdirSync("out", { recursive: true });
const out = {
  red: "Base Sepolia (testnet real, chainId 84532)", endpoint: ENDPOINT, at: t0.toISOString(),
  agent: agent.address, user: user.address, mandate: Object.fromEntries(Object.entries(mandate).map(([k, v]) => [k, String(v)])), mandateSig,
  requirements: accept, httpStatus: res.status, responseBody: body.slice(0, 2000), settle,
  txHash: settle?.transaction ?? null, basescan: settle?.transaction ? `https://sepolia.basescan.org/tx/${settle.transaction}` : null,
  receiptStatus: rcpt?.status ?? null, blockNumber: rcpt?.blockNumber ? String(rcpt.blockNumber) : null,
  balanceBefore: formatUnits(bal, 6), balanceAfter: formatUnits(balAfter, 6), agentReceipt,
};
writeFileSync("out/sepolia-payment.json", JSON.stringify(out, null, 2));
console.log("RESULT", JSON.stringify(out, null, 2));
