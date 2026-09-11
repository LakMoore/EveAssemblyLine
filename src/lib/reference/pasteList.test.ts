import assert from "node:assert/strict";
import test from "node:test";
import { parsePasteList } from "./pasteList";

void test("parses the first two columns of game-export TSV and removes total rows", () => {
  const text = [
    "Amber Mykoserocin\t1665\t-\t-",
    "Atmospheric Gases\t5800\t20,000.00\t400,000.00",
    "Zydrine\t1285\t-\t-",
    "Total:\t\t\t400,000.00",
  ].join("\n");

  assert.deepEqual(
    parsePasteList(text),
    [
      { name: "Amber Mykoserocin", quantity: 1665 },
      { name: "Atmospheric Gases", quantity: 5800 },
      { name: "Zydrine", quantity: 1285 },
    ],
  );
});

void test("keeps parsing the existing one-item-per-line format", () => {
  assert.deepEqual(
    parsePasteList("Raven 2\nVargur 1"),
    [
      { name: "Raven", quantity: 2 },
      { name: "Vargur", quantity: 1 },
    ],
  );
});
