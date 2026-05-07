import fs from "fs";

const vuePath = "apps/web/src/components/ReplayInspector.vue";
let content = fs.readFileSync(vuePath, "utf8");

if (!content.includes("TokenBitfieldInspector")) {
    content = content.replace(/import Timeline from "\.\/Timeline\.vue";/, "import Timeline from \"./Timeline.vue\";\nimport TokenBitfieldInspector from \"./TokenBitfieldInspector.vue\";\nimport type { RawToken } from \"../tokenBitfields\";");
}

if (!content.includes("mockTokens")) {
    const mockTokens = `\nconst mockTokens = ref<RawToken[]>([
  { tokenHex: "0x4B710002", tokenU32: 0x4B710002, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 0, offset: 0 },
  { tokenHex: "0x00F1DD71", tokenU32: 0x00F1DD71, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 0, offset: 2 },
  { tokenHex: "0x000200F1", tokenU32: 0x000200F1, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 0, offset: 1 },
  { tokenHex: "0x0200F14B", tokenU32: 0x0200F14B, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 11, offset: 0 },
]);\n`;
    content = content.replace(/const isCorrelating = ref\(false\);/, "const isCorrelating = ref(false);" + mockTokens);
}

if (!content.includes("<TokenBitfieldInspector")) {
    const templateInjection = `\n    <div class="mt-8">\n      <TokenBitfieldInspector :tokens="mockTokens" />\n    </div>\n  </div>\n</template>`;
    content = content.replace(/<\/div>\s*<\/template>/, templateInjection);
}

fs.writeFileSync(vuePath, content);

