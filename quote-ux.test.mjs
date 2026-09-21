import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const index=await readFile(new URL("./index.html",import.meta.url),"utf8");
const quote=await readFile(new URL("./frontend-quote.mjs",import.meta.url),"utf8");
const worker=await readFile(new URL("./worker.js",import.meta.url),"utf8");
const quick=index.slice(index.indexOf('id="quoteStepQuick"'),index.indexOf('class="calc-result quick-result"'));
const confirm=index.slice(index.indexOf('id="quoteStepConfirm"'),index.indexOf('class="calc-test-note"'));

test("01 — orçamento rápido exige somente coleta e entrega",()=>{assert.match(quick,/id="dcPickup"/);assert.match(quick,/id="dcDelivery"/);assert.doesNotMatch(quick,/id="dcName"/);assert.doesNotMatch(quick,/id="dcItem"/);assert.doesNotMatch(quick,/invoice-btn/);});
test("02 — múltiplas entregas continuam disponíveis e respeitam o limite existente",()=>{assert.match(quick,/id="addDelivery"/);assert.match(index,/MAX_DELIVERIES/);assert.match(index,/Cada orçamento aceita no máximo/);});
test("03 — cálculo continua usando a única fonte oficial existente",()=>{assert.match(index,/requestOfficialQuote\(pickup,ds\)/);assert.match(index,/from "\.\/frontend-quote\.mjs"/);});
test("04 — resultado destaca preço, distância e CTA dinâmico",()=>{assert.match(index,/id="rPrice"/);assert.match(index,/id="rDistance"/);assert.match(index,/requestQuoteBtn/);assert.match(index,/SOLICITAR ESTA ENTREGA —/);});
test("05 — segunda etapa contém dados complementares da contratação",()=>{assert.match(confirm,/id="dcName"/);assert.match(confirm,/data-when="now"/);assert.match(confirm,/data-when="schedule"/);assert.match(confirm,/id="dcPickupRef"/);assert.match(confirm,/id="deliveryRefsFields"/);assert.match(confirm,/id="dcItem"/);assert.match(confirm,/invoice-btn/);});
test("06 — dados calculados são mantidos sem redigitar endereços",()=>{assert.match(index,/officialQuote/);assert.match(index,/calculatedRouteKey/);assert.match(index,/summaryPickup/);assert.match(index,/summaryDeliveries/);assert.match(index,/summaryPrice/);});
test("07 — WhatsApp recebe os dados solicitados e o valor oficial",()=>{for(const field of ["Nome: ","Coleta:","Entrega ","Item: ","Nota Fiscal: ","Distância: ","Valor: ","Quero confirmar a disponibilidade"])assert.ok(index.includes(field),field);assert.match(index,/wa\.me\/\'+WA/);});
test("08 — alteração da rota invalida imediatamente o orçamento",()=>{assert.match(index,/addEventListener\('input',invalidate\)/);assert.match(index,/addEventListener\('change',invalidate\)/);assert.match(index,/const invalidate=.*hideResult/s);assert.match(index,/calculatedRouteKey!==routeKey\(\)/);});
test("09 — cálculo impede concorrência durante a chamada",()=>{assert.match(index,/b\.disabled=true/);assert.match(index,/finally\{b\.disabled=false/);});
test("10 — agendamento e Nota Fiscal continuam no fluxo de confirmação",()=>{assert.match(index,/scheduleFields/);assert.match(index,/Informe a data e o horário da coleta/);assert.match(index,/invoiceMode/);assert.match(index,/Precisa de Nota Fiscal/);});
test("11 — complementos das entregas são preservados e enviados",()=>{assert.match(index,/delivery-ref-input/);assert.match(index,/Complemento da entrega/);assert.match(index,/dcDeliveryRef/);});
test("12 — /calcular é uma entrada direta sem alterar o cálculo",async()=>{const redirects=await readFile(new URL("./_redirects",import.meta.url),"utf8");assert.equal(redirects.trim(),"/calcular /index.html 200");assert.match(index,/new URLSearchParams\(location\.search\)/);});
test("13 — origem da campanha é preservada sem interferir na rota",()=>{assert.match(index,/p\.get\('origem'\)/);assert.match(index,/fonseca_quote_origin/);assert.match(index,/Origem: '\+origin/);});
test("14 — backend e contrato oficial permanecem fora do escopo",()=>{assert.match(quote,/export const ROUTE_API = "https:\/\/fonseca-logistica-api/);assert.match(quote,/MAX_DELIVERIES = 20/);assert.match(worker,/function corsHeadersFor/);assert.match(worker,/function isCanonicalWebOrigin/);assert.match(index,/@media\(max-width:680px\)/);});
