// Mandato EIP-712 (adaptado de poc-earn-borrow) + recibos + chequeos off-chain.
// PoC: fork local de Base 8453 y Base Sepolia 84532. Solo wallets descartables. Nunca keys reales.
import { hashTypedData, recoverTypedDataAddress, getAddress } from "viem";

export const SUPPLY_ACTION = 0, BORROW_ACTION = 1, PAY_ACTION = 2;
export const ACTION_LABEL = ["Depositar colateral", "Pedir prestado", "Pagar endpoint x402"];

export const MANDATE_TYPES = {
  Mandate: [
    { name: "user", type: "address" }, { name: "agent", type: "address" }, { name: "action", type: "uint8" },
    { name: "reserveId", type: "uint256" }, { name: "asset", type: "address" }, { name: "maxAmount", type: "uint256" },
    { name: "recipient", type: "address" }, { name: "validUntil", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
export const mandateDomain = ({ chainId, verifyingContract }) => ({ name: "LupaMandate", version: "1", chainId, verifyingContract });
export const mandateHash = (dom, m) => hashTypedData({ domain: mandateDomain(dom), types: MANDATE_TYPES, primaryType: "Mandate", message: m });
export const signMandate = (account, m, dom) => account.signTypedData({ domain: mandateDomain(dom), types: MANDATE_TYPES, primaryType: "Mandate", message: m });

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "mandateHash", type: "bytes32" }, { name: "user", type: "address" }, { name: "agent", type: "address" },
    { name: "action", type: "uint8" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
    { name: "recipient", type: "address" }, { name: "chainId", type: "uint256" }, { name: "txHash", type: "bytes32" },
    { name: "blockNumber", type: "uint256" },
  ],
};
export const receiptDomain = (chainId) => ({ name: "LupaReceipt", version: "1", chainId });
export const signReceipt = (agent, r) => agent.signTypedData({ domain: receiptDomain(Number(r.chainId)), types: RECEIPT_TYPES, primaryType: "Receipt", message: r });

/** Validación del agente ANTES de mandar una tx (en depósito/préstamo el contrato vuelve a validar on-chain). */
export async function checkMandate({ dom, mandate, signature, amount, agent, usedSoFar = 0n, now = BigInt(Math.floor(Date.now() / 1000)) }) {
  const errors = [];
  const signer = await recoverTypedDataAddress({ domain: mandateDomain(dom), types: MANDATE_TYPES, primaryType: "Mandate", message: mandate, signature });
  if (getAddress(signer) !== getAddress(mandate.user)) errors.push("Firma inválida: no la firmó el usuario");
  if (getAddress(agent) !== getAddress(mandate.agent)) errors.push("Este agente no es el autorizado en el mandato");
  if (now > BigInt(mandate.validUntil)) errors.push("Mandato vencido");
  if (usedSoFar + BigInt(amount) > BigInt(mandate.maxAmount)) errors.push("Supera el tope autorizado");
  return { ok: errors.length === 0, errors };
}

/** Pago x402: el USDC ya está en la wallet del agente, así que este chequeo es off-chain (en el runtime del agente). */
export function checkPayment(mandate, { payTo, amount, asset, alreadyUsed = 0n, now }) {
  const errors = [];
  if (mandate.action !== PAY_ACTION) errors.push("El mandato no es de pago");
  if (getAddress(payTo) !== getAddress(mandate.recipient)) errors.push(`Destino no autorizado: ${payTo}`);
  if (getAddress(asset) !== getAddress(mandate.asset)) errors.push("Activo distinto al autorizado");
  if (alreadyUsed + amount > BigInt(mandate.maxAmount)) errors.push("Supera el tope de pagos");
  if (now > BigInt(mandate.validUntil)) errors.push("Mandato vencido");
  return { ok: errors.length === 0, errors };
}

/** Riesgo en lenguaje simple para Aave v4 (CF = LTV máx = umbral de liquidación). */
export function explainRisk({ hf, collateralUSD, debtUSD, qty, cf, price }) {
  const liqPrice = debtUSD > 0 ? debtUSD / (qty * cf) : null;
  const drop = debtUSD > 0 ? 1 - 1 / hf : null;
  let nivel, texto;
  if (debtUSD === 0) { nivel = "sin deuda"; texto = "No debés nada: no hay riesgo de liquidación."; }
  else if (hf >= 2) { nivel = "bajo"; texto = `Holgado: la acción tendría que caer ~${Math.round(drop * 100)}% para que te liquiden.`; }
  else if (hf >= 1.3) { nivel = "medio"; texto = `Ojo: con una caída de ~${Math.round(drop * 100)}% te liquidan.`; }
  else if (hf >= 1) { nivel = "alto"; texto = "Peligro: estás cerca de la liquidación."; }
  else { nivel = "liquidable"; texto = "Tu posición puede ser liquidada ahora mismo."; }
  return { hf, collateralUSD, debtUSD, ltvActual: collateralUSD ? debtUSD / collateralUSD : 0, cf, price, liqPrice, caidaParaLiquidar: drop, nivel, texto };
}

export const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
