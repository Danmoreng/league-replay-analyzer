import { readFileSync } from "node:fs";

function parseSubrecords(dumpText) {
  const families = new Set();
  const regex = /length=(\d+)\)[\s\S]+?Hex: ([0-9A-F]{2})/g;
  for (const match of dumpText.matchAll(regex)) {
    families.add(`${match[2]}:${match[1]}`);
  }
  return families;
}

const f6 = parseSubrecords(readFileSync("chunk_6_subrecords.txt", "utf8"));
const f65 = parseSubrecords(readFileSync("chunk_65_subrecords.txt", "utf8"));

console.log(`Families in chunk 6: ${f6.size}`);
console.log(`Families in chunk 65: ${f65.size}`);

const uniqueTo65 = [...f65].filter(f => !f6.has(f));

console.log("Unique families in chunk 65 vs chunk 6:");
uniqueTo65.forEach(f => console.log(`  ${f}`));
