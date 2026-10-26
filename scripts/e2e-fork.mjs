// E2E en un FORK LOCAL de Base mainnet (anvil, chainId 8453). Nada se transmite a la red real.
// Wallets descartables generadas en memoria; el ETH de gas se crea con anvil_setBalance (solo existe en el fork).
//
// 1) Usuario recibe AAPLc (impersonando a un holder real del fork).
// 2) Usuario aprueba al MandatePositionManager y firma 3 mandatos EIP-712: depositar, pedir prestado, pagar.
// 3) Agente deposita AAPLc como colateral en Aave v4 (spoke Coinbase Stocks) a nombre del usuario.
// 4) Agente pide ~5 USDC prestados (deuda del usuario) que llegan a la wallet de pagos del agente.
// 5) Agente paga un endpoint x402 local; el facilitador local liquida con transferWithAuthorization (EIP-3009) sobre el USDC real forkeado.
// 6) Recibos firmados por el agente → out/fork-run.json
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, encodeAbiParameters, toHex, pad, formatUnits, getAddress, decodeEventLog } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { SUPPLY_ACTION, BORROW_ACTION, PAY_ACTION, ACTION_LABEL, signMandate, mandateHash, checkMandate, checkPayment, signReceipt, explainRisk, jsonSafe } from "../src/mandate.js";
import { startLocalSeller, FORK_USDC } from "../src/x402-local-server.mjs";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const UPSTREAM = process.env.UPSTREAM_RPC ?? "https://base-rpc.publicnode.com";
const FORK_BLOCK = 53124300;
const SPOKE = "0x17905Db0e4A3514467539956c084180616AE7B8D";
const HOLDER = "0xBc9050D78d2D8d88F7536AF49d4007aEf469d7B4"; // holder real de AAPLc en el bloque del fork
const AAPLC_RESERVE = 0n, USDC_RESERVE = 7n;
const SUPPLY_QTY = BigInt(process.env.AAPLC_UNITS ?? "5920000"); // 0,0592 AAPLc (8 decimales) ≈ US$20
const BORROW_AMT = 5_000_000n; // 5 USDC
const PAY_AMT = "1000"; // 0,001 USDC

const pc = createPublicClient({ chain: base, transport: http(RPC) });
const rpc = (method, params) => pc.request({ method, params });
const wallet = (acct) => createWalletClient({ account: acct, chain: base, transport: http(RPC) });

const spokeAbi = parseAbi([
  "function getReserve(uint256) view returns ((address underlying,address hub,uint16 assetId,uint8 decimals,uint24 collateralRisk,uint8 flags,uint32 dynamicConfigKey))",
  "function getUserAccountData(address) view returns ((uint256 riskPremium,uint256 avgCollateralFactor,uint256 healthFactor,uint256 totalCollateralValue,uint256 totalDebtValueRay,uint256 activeCollateralCount,uint256 borrowCount))",
  "function setUserPositionManager(address,bool)",
  "function isPositionManagerActive(address) view returns (bool)",
  "function ORACLE() view returns (address)",
  "function getUserSuppliedAssets(uint256,address) view returns (uint256)",
  "function getUserTotalDebt(uint256,address) view returns (uint256)",
]);
const oracleAbi = parseAbi(["function getReservePrice(uint256) view returns (uint256)", "function decimals() view returns (uint8)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "event Transfer(address indexed from,address indexed to,uint256 value)", "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]);
const pmArt = JSON.parse(readFileSync(new URL("../contracts/out/MandatePositionManager.sol/MandatePositionManager.json", import.meta.url)));
const steps = [];
const step = (s) => { steps.push({ at: new Date().toISOString(), ...s }); console.log("·", s.title, s.txHash ?? ""); };
const nonce32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

async function send(acct, req) {
  const hash = await wallet(acct).writeContract(req);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx revertida ${hash}`);
  return r;
}

// 0) Fork limpio y reproducible en el bloque fijado.
await rpc("anvil_reset", [{ forking: { jsonRpcUrl: UPSTREAM, blockNumber: FORK_BLOCK } }]);
const chainId = await pc.getChainId();
if (chainId !== 8453) throw new Error("No es un fork de Base");

const user = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const deployer = privateKeyToAccount(generatePrivateKey());
const facilitator = privateKeyToAccount(generatePrivateKey());
const seller = privateKeyToAccount(generatePrivateKey());
for (const a of [user, agent, deployer, facilitator]) await rpc("anvil_setBalance", [a.address, toHex(10n ** 18n)]);
step({ title: "Fork reseteado y wallets descartables creadas (ETH de gas solo en el fork)", chain: "fork", block: FORK_BLOCK, user: user.address, agent: agent.address });

const AAPLC = (await pc.readContract({ address: SPOKE, abi: spokeAbi, functionName: "getReserve", args: [AAPLC_RESERVE] })).underlying;
const USDC = (await pc.readContract({ address: SPOKE, abi: spokeAbi, functionName: "getReserve", args: [USDC_RESERVE] })).underlying;
if (getAddress(USDC) !== getAddress(FORK_USDC)) throw new Error("La reserva 7 no es USDC");

// 1) Desplegar el position manager y activarlo (ATAJO DE FORK: escribimos el storage del Spoke. Sin probar en mainnet, sin auditar).
const depHash = await wallet(deployer).deployContract({ abi: pmArt.abi, bytecode: pmArt.bytecode.object, args: [SPOKE] });
const dep = await pc.waitForTransactionReceipt({ hash: depHash });
const PM = dep.contractAddress;
const slot = toHex(BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [PM, 7n]))) + 1n);
await rpc("anvil_setStorageAt", [SPOKE, slot, pad("0x01")]);
const pmActive = await pc.readContract({ address: SPOKE, abi: spokeAbi, functionName: "isPositionManagerActive", args: [PM] });
step({ title: "MandatePositionManager desplegado y activado por escritura de storage (solo fork)", chain: "fork", txHash: depHash, pm: PM, pmActive });

// 2) El usuario recibe AAPLc de un holder real (impersonado en el fork).
await rpc("anvil_impersonateAccount", [HOLDER]);
await rpc("anvil_setBalance", [HOLDER, toHex(10n ** 17n)]);
const tHash = await pc.request({ method: "eth_sendTransaction", params: [{ from: HOLDER, to: AAPLC, data: (await import("viem")).encodeFunctionData({ abi: erc20, functionName: "transfer", args: [user.address, SUPPLY_QTY] }) }] });
await pc.waitForTransactionReceipt({ hash: tHash });
await rpc("anvil_stopImpersonatingAccount", [HOLDER]);
step({ title: `Usuario recibe ${formatUnits(SUPPLY_QTY, 8)} AAPLc (holder impersonado, solo fork)`, chain: "fork", txHash: tHash });

// 3) Permisos del usuario: allowance de AAPLc al PM y alta del PM como position manager de SU posición.
const ap = await send(user, { address: AAPLC, abi: erc20, functionName: "approve", args: [PM, SUPPLY_QTY] });
const up = await send(user, { address: SPOKE, abi: spokeAbi, functionName: "setUserPositionManager", args: [PM, true] });
step({ title: "Usuario aprueba AAPLc y habilita el position manager en su posición", chain: "fork", txHash: up.transactionHash, approveTx: ap.transactionHash });

// 4) Mandatos firmados por el usuario.
const block = await pc.getBlock();
const validUntil = block.timestamp + 86400n;
const sellerPayTo = seller.address;
const dom = { chainId: 8453, verifyingContract: PM };
const mandates = {
  supply: { user: user.address, agent: agent.address, action: SUPPLY_ACTION, reserveId: AAPLC_RESERVE, asset: AAPLC, maxAmount: SUPPLY_QTY, recipient: user.address, validUntil, nonce: nonce32() },
  borrow: { user: user.address, agent: agent.address, action: BORROW_ACTION, reserveId: USDC_RESERVE, asset: USDC, maxAmount: BORROW_AMT, recipient: agent.address, validUntil, nonce: nonce32() },
  pay: { user: user.address, agent: agent.address, action: PAY_ACTION, reserveId: 0n, asset: USDC, maxAmount: 2000n, recipient: sellerPayTo, validUntil, nonce: nonce32() },
};
const sigs = {};
for (const [k, m] of Object.entries(mandates)) sigs[k] = await signMandate(user, m, dom);
step({ title: "Usuario firma 3 mandatos EIP-712 (depositar, pedir prestado, pagar)", chain: "fork" });

const receipts = [];
async function receiptFor(kind, m, amount, r) {
  const rec = { mandateHash: mandateHash(dom, m), user: m.user, agent: m.agent, action: m.action, asset: m.asset, amount, recipient: m.recipient, chainId: 8453n, txHash: r.transactionHash, blockNumber: r.blockNumber };
  receipts.push({ kind, chain: "fork", label: ACTION_LABEL[m.action], receipt: rec, agentSig: await signReceipt(agent, rec) });
}

// 5) Agente: depositar colateral (el contrato re-valida todo on-chain).
const now = () => block.timestamp + 60n;
let chk = await checkMandate({ dom, mandate: mandates.supply, signature: sigs.supply, amount: SUPPLY_QTY, agent: agent.address, now: now() });
if (!chk.ok) throw new Error(chk.errors.join("; "));
const rS = await send(agent, { address: PM, abi: pmArt.abi, functionName: "execute", args: [mandates.supply, sigs.supply, SUPPLY_QTY], gas: 2_000_000n });
await receiptFor("supply", mandates.supply, SUPPLY_QTY, rS);
step({ title: `Agente deposita ${formatUnits(SUPPLY_QTY, 8)} AAPLc como colateral en Aave v4 (Coinbase Stocks) a nombre del usuario`, chain: "fork", txHash: rS.transactionHash });

// 6) Agente: pedir prestado 5 USDC → van directo a la wallet de pagos del agente.
chk = await checkMandate({ dom, mandate: mandates.borrow, signature: sigs.borrow, amount: BORROW_AMT, agent: agent.address, now: now() });
if (!chk.ok) throw new Error(chk.errors.join("; "));
const rB = await send(agent, { address: PM, abi: pmArt.abi, functionName: "execute", args: [mandates.borrow, sigs.borrow, BORROW_AMT], gas: 2_000_000n });
await receiptFor("borrow", mandates.borrow, BORROW_AMT, rB);
step({ title: "Agente pide prestado 5 USDC (deuda del usuario, USDC al agente)", chain: "fork", txHash: rB.transactionHash });

// Prueba negativa: el contrato rechaza pedir 1 USDC más de lo firmado.
let overCap = null;
try {
  await pc.simulateContract({ account: agent, address: PM, abi: pmArt.abi, functionName: "execute", args: [mandates.borrow, sigs.borrow, 1n] });
  overCap = "NO RECHAZÓ (error)";
} catch (e) { overCap = e.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? (e.shortMessage ?? String(e)).split("\n")[0]; }
step({ title: "Prueba negativa: pedir más del tope revierte on-chain", chain: "fork", result: overCap });

// 7) Riesgo.
const acct = await pc.readContract({ address: SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [user.address] });
const ORACLE = await pc.readContract({ address: SPOKE, abi: spokeAbi, functionName: "ORACLE" });
const odec = await pc.readContract({ address: ORACLE, abi: oracleAbi, functionName: "decimals" });
const pA = Number(await pc.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getReservePrice", args: [AAPLC_RESERVE] })) / 10 ** odec;
const pU = Number(await pc.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getReservePrice", args: [USDC_RESERVE] })) / 10 ** odec;
const supplied = await pc.readContract({ address: SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [AAPLC_RESERVE, user.address] });
const debt = await pc.readContract({ address: SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [USDC_RESERVE, user.address] });
const qty = Number(supplied) / 1e8;
const hf = Number(acct.healthFactor) / 1e18;
const cf = Number(acct.avgCollateralFactor) / 1e18;
const risk = explainRisk({ hf, collateralUSD: qty * pA, debtUSD: (Number(debt) / 1e6) * pU, qty, cf, price: pA });
step({ title: `HF ${hf.toFixed(3)} · precio de liquidación AAPL ≈ US$${risk.liqPrice.toFixed(2)}`, chain: "fork", risk });

// 8) Pago x402 en el fork.
const sellerSrv = await startLocalSeller({
  rpc: RPC, payTo: sellerPayTo, facilitatorAccount: facilitator, amount: PAY_AMT,
  content: async () => ({ ticker: "AAPLc", precioOracleAaveUSD: pA, bloque: String((await pc.getBlock()).number), fuente: "oráculo de Aave v4 en el fork" }),
});
const agentUsdcBefore = await pc.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [agent.address] });
const probe = await fetch(sellerSrv.url);
const req = JSON.parse(Buffer.from(probe.headers.get("payment-required"), "base64").toString());
const accept = req.accepts[0];
const pv = checkPayment(mandates.pay, { payTo: accept.payTo, amount: BigInt(accept.amount), asset: accept.asset, alreadyUsed: 0n, now: now() });
if (!pv.ok) throw new Error(pv.errors.join("; "));
// Prueba negativa off-chain: un vendedor con otro payTo sería rechazado por el agente antes de firmar.
const pvBad = checkPayment(mandates.pay, { payTo: deployer.address, amount: BigInt(accept.amount), asset: accept.asset, alreadyUsed: 0n, now: now() });
const f = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(agent) }] });
const res = await f(sellerSrv.url, { method: "GET" });
const body = await res.text();
const prh = res.headers.get("payment-response");
const settle = prh ? decodePaymentResponseHeader(prh) : null;
await sellerSrv.close();
if (!settle?.success) throw new Error("Pago x402 en fork falló: " + body + JSON.stringify(sellerSrv.log));
const rP = await pc.getTransactionReceipt({ hash: settle.transaction });
const events = rP.logs.filter(l => getAddress(l.address) === getAddress(USDC)).map(l => { try { const d = decodeEventLog({ abi: erc20, ...l }); return jsonSafe({ event: d.eventName, ...d.args }); } catch { return null; } }).filter(Boolean);
await receiptFor("pay", mandates.pay, BigInt(accept.amount), rP);
const agentUsdcAfter = await pc.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [agent.address] });
const sellerUsdc = await pc.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [sellerPayTo] });
step({ title: "Agente paga 0,001 USDC al endpoint x402 local, liquidado con transferWithAuthorization en el fork", chain: "fork", txHash: settle.transaction, httpStatus: res.status, txFrom: rP.from, events, rejectedOtherPayTo: pvBad.errors });

const pmUsdc = await pc.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [PM] });
const pmAaplc = await pc.readContract({ address: AAPLC, abi: erc20, functionName: "balanceOf", args: [PM] });
mkdirSync("out", { recursive: true });
const out = jsonSafe({
  red: "FORK LOCAL de Base mainnet (anvil, chainId 8453). Nada de esto se transmitió a la red real.",
  forkBlock: FORK_BLOCK, upstream: UPSTREAM, at: new Date().toISOString(),
  contracts: { spoke: SPOKE, aaplc: AAPLC, usdc: USDC, oracle: ORACLE, positionManager: PM },
  actors: { user: user.address, agent: agent.address, sellerPayTo, facilitator: facilitator.address, holderImpersonado: HOLDER },
  fork_only_shortcuts: [
    "Position manager activado con anvil_setStorageAt (slot 7 de Spoke), un atajo de fork. Sin probar en mainnet, sin auditar. En mainnet ya hay position managers nativos de v4 activos en este spoke y un mandato podría montarse encima, pero no está probado.",
    "AAPLc obtenido impersonando un holder real (anvil_impersonateAccount).",
    "ETH de gas creado con anvil_setBalance.",
  ],
  mandates, mandateSigs: sigs, receipts, steps,
  x402: { requirements: accept, response: body, settle, facilitatorLog: sellerSrv.log },
  balances: { agentUsdcBefore, agentUsdcAfter, sellerUsdc, pmUsdc, pmAaplc, supplied, debt },
  accountData: acct, risk,
});
writeFileSync("out/fork-run.json", JSON.stringify(out, null, 2));
console.log(`\nOK. HF=${hf.toFixed(4)} liq≈US$${risk.liqPrice.toFixed(2)} precio=${pA} pago=${settle.transaction}`);
console.log("→ out/fork-run.json");
