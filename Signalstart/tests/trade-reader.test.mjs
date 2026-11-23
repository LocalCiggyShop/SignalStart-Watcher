import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../trade-reader.js";

const reader=globalThis.SignalStartTradeReader;
const fixture=JSON.parse((await readFile(new URL("fixtures/signalstart-locked-row.json",import.meta.url),"utf8")).replace(/^\uFEFF/,""));
function documentFor(cells, tablePresent=true) {
  const cell=value=>({textContent:value.text??value,querySelector(){return value.locked ? {} : null;}});
  const row={querySelectorAll(){return cells.map(cell);}};
  const table={querySelectorAll(selector){return selector==="thead th" ? fixture.headers.map(cell) : [row];}};
  return {getElementById(id){assert.equal(id,"openTradesListData");return {querySelector(selector){assert.equal(selector,"#openTradesTable");return tablePresent ? table : null;}};}};
}
function readyRow(overrides={}) {
  const fields={"Open Date":"16/10/2026","Symbol":"US30","Action":"Buy","Lots":"0.10","Open Price":"50000","SL":"-","TP":"-",...overrides};
  return fixture.headers.map(header=>({text:fields[header]??"0",locked:false}));
}

test("the real public Open Trades table cannot leak locked lots as a zero or default",()=>{
  const result=reader.read(documentFor(fixture.cells),1);
  assert.equal(result.status,"unavailable");
  assert.match(result.reason,/hidden the lot size/);
});
test("reads actual table columns, source side, lots and explicitly absent stops",()=>{
  const result=reader.read(documentFor(readyRow()),1);
  assert.equal(result.status,"ready");assert.equal(result.symbol,"US30");assert.equal(result.lots,.1);
  assert.equal(result.sl,0);assert.equal(result.tp,0);assert.equal(result.side,1);
  const sell=reader.read(documentFor(readyRow({Action:"Sell",SL:"51,000.50",TP:"49000.25"})),1);
  assert.equal(sell.side,-1);assert.equal(sell.sl,51000.5);assert.equal(sell.tp,49000.25);
});
test("never borrows History values and distinguishes hidden stops from absent stops",()=>{
  assert.equal(reader.read(documentFor(readyRow(),false),1).status,"unavailable");
  const cells=readyRow();cells[fixture.headers.indexOf("SL")].locked=true;
  assert.equal(reader.read(documentFor(cells),1).status,"unavailable");
  assert.equal(reader.read(documentFor(readyRow({Lots:"0,10"})),1).status,"unavailable");
  assert.equal(reader.read(documentFor(readyRow({SL:"N/A"})),1).status,"unavailable");
  assert.equal(reader.read(documentFor(readyRow()),2).status,"multiple");
  assert.equal(reader.read(documentFor(readyRow()),0).status,"flat");
});
test("validates untrusted forwarded values before the native boundary",()=>{
  const valid=reader.read(documentFor(readyRow()),1);
  assert.equal(reader.validate({...valid,lots:Infinity},1).status,"unavailable");
  assert.equal(reader.validate({...valid,sl:null},1).status,"unavailable");
  assert.equal(reader.validate({...valid,symbol:"../../other"},1).status,"unavailable");
});

test("new-trade alerts can identify public rows when private trade fields are locked", () => {
  assert.deepEqual(reader.readOpenTradeKeys(documentFor(fixture.cells), 1), ['["15/10/2026","CHFJPY"]']);
  assert.equal(reader.readOpenTradeKeys(documentFor(fixture.cells), 2), null);
  assert.equal(reader.readOpenTradeKeys(documentFor(fixture.cells, false), 1), null);
  assert.deepEqual(reader.readOpenTradeKeys(documentFor(fixture.cells, false), 0), []);
});
