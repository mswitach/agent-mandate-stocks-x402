// Arma el recibo unificado (fork + Sepolia), verifica todas las firmas y genera HTML + capturas para X.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { recoverTypedDataAddress, getAddress, formatUnits } from "viem";
import { MANDATE_TYPES, mandateDomain, RECEIPT_TYPES, receiptDomain, ACTION_LABEL } from "../src/mandate.js";

const fork = JSON.parse(readFileSync("out/fork-run.json"));
const sep = existsSync("out/sepolia-payment.json") ? JSON.parse(readFileSync("out/sepolia-payment.json")) : null;
const big = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, ["action"].includes(k) ? Number(v) : (/^\d+$/.test(String(v)) ? BigInt(v) : v)]));

const checks = [];
const dom = { chainId: 8453, verifyingContract: fork.contracts.positionManager };
for (const [k, m] of Object.entries(fork.mandates)) {
  const s = await recoverTypedDataAddress({ domain: mandateDomain(dom), types: MANDATE_TYPES, primaryType: "Mandate", message: big(m), signature: fork.mandateSigs[k] });
  checks.push({ que: `Mandato ${k} (fork) firmado por el usuario`, ok: getAddress(s) === getAddress(fork.actors.user) });
}
for (const r of fork.receipts) {
  const s = await recoverTypedDataAddress({ domain: receiptDomain(8453), types: RECEIPT_TYPES, primaryType: "Receipt", message: big(r.receipt), signature: r.agentSig });
  checks.push({ que: `Recibo ${r.kind} (fork) firmado por el agente`, ok: getAddress(s) === getAddress(fork.actors.agent) });
}
if (sep) {
  const s = await recoverTypedDataAddress({ domain: mandateDomain({ chainId: 84532, verifyingContract: "0x0000000000000000000000000000000000000000" }), types: MANDATE_TYPES, primaryType: "Mandate", message: big(sep.mandate), signature: sep.mandateSig });
  checks.push({ que: "Mandato de pago (Sepolia) firmado por el usuario", ok: getAddress(s) === getAddress(sep.user) });
}
const tx = (k) => fork.receipts.find((r) => r.kind === k)?.receipt.txHash;
const r = fork.risk;
const recibo = {
  titulo: "Recibo Lupa · acciones tokenizadas como colateral + pago x402",
  generado: new Date().toISOString(),
  autorizado: [
    { accion: ACTION_LABEL[0], detalle: `hasta ${formatUnits(BigInt(fork.mandates.supply.maxAmount), 8).replace(".", ",")} AAPLc, queda a tu nombre en Aave v4`, vence: fork.mandates.supply.validUntil },
    { accion: ACTION_LABEL[1], detalle: `hasta ${formatUnits(BigInt(fork.mandates.borrow.maxAmount), 6)} USDC, solo a la wallet de pagos del agente`, vence: fork.mandates.borrow.validUntil },
    { accion: ACTION_LABEL[2], detalle: `hasta 0,002 USDC, solo al vendedor ${fork.mandates.pay.recipient}`, vence: fork.mandates.pay.validUntil },
  ],
  ejecutado: [
    { red: "FORK", accion: "Depósito de 0,0592 AAPLc como colateral", tx: tx("supply") },
    { red: "FORK", accion: "Préstamo de 5 USDC", tx: tx("borrow") },
    { red: "FORK", accion: "Pago x402 de 0,001 USDC (EIP-3009)", tx: tx("pay") },
    ...(sep ? [{ red: "BASE SEPOLIA (real)", accion: "Pago x402 de 0,001 USDC de prueba", tx: sep.txHash, link: sep.basescan }] : []),
  ],
  liquidado: {
    fork: { vendedorRecibio: formatUnits(BigInt(fork.balances.sellerUsdc), 6) + " USDC", agenteQueda: formatUnits(BigInt(fork.balances.agentUsdcAfter), 6) + " USDC", contratoRetiene: `${fork.balances.pmUsdc} USDC y ${fork.balances.pmAaplc} AAPLc` },
    sepolia: sep ? { estado: sep.receiptStatus, bloque: sep.blockNumber, facilitadorPagoGas: true, tx: sep.txHash, link: sep.basescan } : null,
  },
  riesgo: { hf: r.hf, colateralUSD: r.collateralUSD, deudaUSD: r.debtUSD, cf: r.cf, precioAAPL: r.price, precioLiquidacion: r.liqPrice, caidaParaLiquidar: r.caidaParaLiquidar, texto: r.texto },
  verificaciones: checks,
  avisos: [
    "Las operaciones marcadas FORK corrieron en una copia local de Base mainnet (anvil). No existen en la red real.",
    "En el fork el position manager se activó escribiendo storage del spoke (atajo de fork). Sin probar en mainnet, sin auditar.",
    "El chequeo del mandato de pago es off-chain (runtime del agente). Depósito y préstamo se validan on-chain.",
    "Elegibilidad Reg S de AAPLc desde Argentina: sin confirmar.",
  ],
};
writeFileSync("out/recibo.json", JSON.stringify(recibo, null, 2));

const short = (h) => (h ? h.slice(0, 10) + "…" + h.slice(-6) : "");
const css = `*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf6}
.card{width:1200px;height:675px;padding:48px 56px;display:flex;flex-direction:column;gap:18px;background:radial-gradient(1200px 600px at 100% 0%,#1d2b5a 0%,#0b1020 60%)}
h1{font-size:40px;margin:0}h2{font-size:22px;margin:0;color:#9fb0d9;font-weight:600}.row{display:flex;gap:18px}
.box{flex:1;background:#121a33;border:1px solid #26335f;border-radius:16px;padding:20px 22px}.box h3{margin:0 0 10px;font-size:18px;color:#8fd3ff;text-transform:uppercase;letter-spacing:.06em}
.box p,.box li{font-size:19px;line-height:1.45;margin:4px 0}ul{padding-left:20px;margin:0}.mono{font-family:ui-monospace,Menlo,monospace;font-size:16px;color:#c7d2fe}
.tag{display:inline-block;font-size:13px;font-weight:700;padding:3px 9px;border-radius:999px;margin-right:8px}.fork{background:#3b2a00;color:#ffcc4d;border:1px solid #6b4d00}.sep{background:#003b2a;color:#5dffb3;border:1px solid #00704d}
.box p.big{font-size:64px;font-weight:800;margin:0}.foot{margin-top:auto;font-size:15px;color:#7f8bb0}.ok{color:#5dffb3}`;
const page = (body) => `<!doctype html><html lang="es"><meta charset="utf-8"><style>${css}</style><body>${body}</body></html>`;

const c1 = page(`<div class="card"><h1>Tu agente usó acciones como colateral y pagó solo</h1><h2>Aave v4 · Coinbase Stocks (AAPLc) · x402 · con mandato firmado</h2>
<div class="row"><div class="box"><h3>Lo que autorizaste</h3><ul>${recibo.autorizado.map((a) => `<li><b>${a.accion}</b>: ${a.detalle.replace(/0x[0-9a-fA-F]{40}/, (m) => short(m))}</li>`).join("")}</ul><p style="color:#9fb0d9">Vence en 24 h. Revocable.</p></div>
<div class="box"><h3>Lo que hizo el agente</h3><ul>${recibo.ejecutado.map((e) => `<li><span class="tag ${e.red === "FORK" ? "fork" : "sep"}">${e.red}</span>${e.accion}<br><span class="mono">${short(e.tx)}</span></li>`).join("")}</ul></div></div>
<div class="foot">FORK = copia local de Base mainnet (anvil), no es la red real. SEPOLIA = testnet real. Sin keys reales, US$0. Elegibilidad Reg S desde Argentina sin confirmar.</div></div>`);
const c2 = page(`<div class="card"><h1>Cuánto riesgo tiene la posición</h1><h2><span class="tag fork">FORK</span>0,0592 AAPLc (≈ US$${r.collateralUSD.toFixed(2).replace(".", ",")}) de colateral · 5 USDC de deuda</h2>
<div class="row"><div class="box"><h3>Health factor</h3><p class="big">${r.hf.toFixed(2).replace(".", ",")}</p><p>Por debajo de 1 te liquidan.</p></div>
<div class="box"><h3>Precio de liquidación</h3><p class="big">US$${r.liqPrice.toFixed(0)}</p><p>AAPL en el oráculo: US$${r.price.toFixed(2).replace(".", ",")}</p></div>
<div class="box"><h3>Margen</h3><p class="big">−${Math.round(r.caidaParaLiquidar * 100)}%</p><p>Caída de AAPL que dispara la liquidación.</p></div></div>
<div class="box"><p>${r.texto} Factor de colateral ${Math.round(r.cf * 100)}% (= LTV máx = umbral de liquidación en Aave v4). El agente no puede pedir más de 5 USDC: el contrato lo rechaza.</p></div>
<div class="foot">Datos leídos del spoke Coinbase Stocks de Aave v4 en un fork local de Base (bloque ${fork.forkBlock}). No es mainnet.</div></div>`);
const c3 = sep ? page(`<div class="card"><h1>Y un pago x402 real en Base Sepolia</h1><h2><span class="tag sep">BASE SEPOLIA · TESTNET REAL</span>0,001 USDC de prueba por un dato del clima de Buenos Aires</h2>
<div class="row"><div class="box" style="flex:1.1"><h3>Qué pasó</h3><ul><li>El agente recibió un 402 con el precio</li><li>Chequeó el mandato: destino, monto, red, vencimiento</li><li>Firmó una autorización EIP-3009 (sin gas)</li><li>El facilitador liquidó y el servidor respondió 200</li></ul></div>
<div class="box"><h3>Comprobante on-chain</h3><p class="mono" style="word-break:break-all">${sep.txHash}</p><p>Estado: <span class="ok">${sep.receiptStatus === "success" ? "confirmada" : sep.receiptStatus}</span> · bloque ${sep.blockNumber}</p><p class="mono">sepolia.basescan.org/tx/${short(sep.txHash)}</p></div></div>
<div class="foot">USDC de prueba del faucet público de Circle, sin cuenta. Wallet descartable generada en memoria. US$0.</div></div>`) : null;
const full = page(`<div style="padding:40px;max-width:1100px;margin:auto"><h1>${recibo.titulo}</h1><h2>Verificaciones</h2><ul>${checks.map((c) => `<li class="${c.ok ? "ok" : ""}">${c.ok ? "OK" : "FALLA"} · ${c.que}</li>`).join("")}</ul>
<h2>Ejecutado</h2><ul>${recibo.ejecutado.map((e) => `<li><span class="tag ${e.red === "FORK" ? "fork" : "sep"}">${e.red}</span>${e.accion} · <span class="mono">${e.tx}</span>${e.link ? ` · <a style="color:#8fd3ff" href="${e.link}">basescan</a>` : ""}</li>`).join("")}</ul>
<h2>Avisos</h2><ul>${recibo.avisos.map((a) => `<li>${a}</li>`).join("")}</ul><h2>JSON</h2><pre class="mono" style="white-space:pre-wrap">${JSON.stringify(recibo, null, 2).replace(/</g, "&lt;")}</pre></div>`);
mkdirSync("out", { recursive: true });
writeFileSync("out/recibo.html", full);
const cards = [["01-mandato-y-acciones", c1], ["02-riesgo", c2], ["03-pago-sepolia", c3]].filter(([, h]) => h);
for (const [name, html] of cards) {
  writeFileSync(`out/${name}.html`, html);
  try {
    execFileSync("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1200,675", `--screenshot=out/${name}.png`, `file://${process.cwd()}/out/${name}.html`], { stdio: "ignore" });
  } catch (e) { console.log("captura falló", name, e.message); }
}
console.log(checks.map((c) => `${c.ok ? "OK " : "FALLA"} ${c.que}`).join("\n"));
console.log("→ out/recibo.json, out/recibo.html, out/0*.png");
