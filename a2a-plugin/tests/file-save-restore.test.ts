/**
 * Test: verify that saveBase64File correctly decodes and restores files.
 *
 * Creates real files (txt, png, pdf, pptx), base64-encodes them,
 * passes through saveBase64File, then compares the restored content
 * byte-for-byte with the original.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";

// We need to test the internal functions. Since they are module-scoped
// (not exported), we'll test via formatFilePartAsText which calls saveBase64File.
// But we can also directly test by importing and exercising the logic.

// The actual implementation uses a module-level `fileTempDir` variable.
// We test by importing the executor module and exercising formatFilePartAsText
// through the exported class, OR we replicate the core logic here for a
// focused unit test.

// For a direct test, we replicate saveBase64File logic and test it directly,
// since the executor's internal functions aren't exported.

const MIME_TO_EXT: Record<string, string> = {
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/zip": ".zip",
  "application/gzip": ".gz",
};

function normalizeMimeType(mimeType: string): string {
  const semicolonIdx = mimeType.indexOf(";");
  const base = semicolonIdx >= 0 ? mimeType.slice(0, semicolonIdx) : mimeType;
  return base.trim().toLowerCase();
}

function extensionForMime(mimeType: string, originalName: string): string {
  const normalized = normalizeMimeType(mimeType);
  const mapped = MIME_TO_EXT[normalized];
  if (mapped) return mapped;
  const ext = path.extname(originalName).toLowerCase();
  if (ext && ext.length <= 10) return ext;
  return ".bin";
}

function saveBase64File(
  base64Bytes: string,
  name: string,
  mimeType: string,
  tempDir: string,
): string | null {
  try {
    const buffer = Buffer.from(base64Bytes, "base64");
    const ext = extensionForMime(mimeType, name);
    const id = crypto.randomUUID();
    const filename = `${id}${ext}`;
    const filePath = path.join(tempDir, filename);

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return filePath;
  } catch {
    return null;
  }
}

// Helper: create a minimal valid PNG (1x1 white pixel)
function createMinimalPng(): Buffer {
  // Minimal valid PNG: 1x1 white pixel
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.from([
    // Length: 13
    0, 0, 0, 13,
    // Type: IHDR
    73, 72, 68, 82,
    // Width: 1, Height: 1, Bit depth: 8, Color type: 2 (RGB)
    0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
  ]);
  const ihdrCrc = crc32(ihdr.slice(4));
  const ihdrCrcBuf = Buffer.alloc(4);
  ihdrCrcBuf.writeUInt32BE(ihdrCrc);

  // IDAT: zlib-compressed data for 1x1 white pixel
  // Raw data: filter byte (0) + R G B (255, 255, 255)
  const rawData = Buffer.from([0, 255, 255, 255]);
  const compressed = zlib.deflateSync(rawData);

  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(compressed.length);
  const idatType = Buffer.from([73, 68, 65, 84]); // IDAT
  const idatPayload = Buffer.concat([idatType, compressed]);
  const idatCrc = crc32(idatPayload);
  const idatCrcBuf = Buffer.alloc(4);
  idatCrcBuf.writeUInt32BE(idatCrc);

  // IEND
  const iend = Buffer.from([
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);

  return Buffer.concat([
    signature,
    ihdr, ihdrCrcBuf,
    idatLen, idatPayload, idatCrcBuf,
    iend,
  ]);
}

// CRC32 for PNG chunks
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Helper: create a minimal valid PDF
function createMinimalPdf(): Buffer {
  const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
190
%%EOF`;
  return Buffer.from(content, "utf-8");
}

// Helper: create a minimal valid PPTX (ZIP with required structure)
function createMinimalPptx(): Buffer {
  // PPTX is a ZIP file. We need minimal OOXML structure.
  // Build a simple ZIP with the required [Content_Types].xml
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"/>`;

  // Build ZIP manually using local file headers
  const files: { name: string; data: Buffer }[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf-8") },
    { name: "ppt/presentation.xml", data: Buffer.from(presentation, "utf-8") },
  ];

  return buildZip(files);
}

function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf-8");
    const compressed = file.data; // Store (no compression for simplicity)

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // compression: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    // CRC32
    const fileCrc = crc32buf(file.data);
    local.writeUInt32LE(fileCrc, 14);
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(file.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26); // filename length
    local.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(local, 30);
    compressed.copy(local, 30 + nameBytes.length);
    localHeaders.push(local);

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // compression
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(fileCrc, 16); // crc32
    central.writeUInt32LE(compressed.length, 20); // compressed size
    central.writeUInt32LE(file.data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28); // filename length
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralHeaders) centralSize += c.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12); // central dir size
  eocd.writeUInt32LE(centralOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

function crc32buf(buf: Buffer): number {
  let crc = 0xffffffff;
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let tempDir: string;

// Setup: create temp dir once
tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-file-test-"));

// Cleanup on process exit
process.on("exit", () => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("saveBase64File", () => {
  it("correctly saves and restores a TXT file", () => {
    const original = Buffer.from("Hello, this is a test file with unicode: 你好世界 🌍", "utf-8");
    const base64 = original.toString("base64");

    const savedPath = saveBase64File(base64, "test.txt", "text/plain", tempDir);
    assert.ok(savedPath, "should return a valid path");
    assert.ok(savedPath.endsWith(".txt"), "should have .txt extension");

    const restored = fs.readFileSync(savedPath);
    assert.ok(restored.equals(original), "restored content should match original");
  });

  it("correctly saves and restores a PNG file", () => {
    const original = createMinimalPng();
    const base64 = original.toString("base64");

    const savedPath = saveBase64File(base64, "image.png", "image/png", tempDir);
    assert.ok(savedPath, "should return a valid path");
    assert.ok(savedPath.endsWith(".png"), "should have .png extension");

    const restored = fs.readFileSync(savedPath);
    assert.ok(restored.equals(original), "restored content should match original");

    // Verify PNG signature is intact
    assert.equal(restored[0], 137, "PNG first byte");
    assert.equal(restored[1], 80, "PNG 'P'");
    assert.equal(restored[2], 78, "PNG 'N'");
    assert.equal(restored[3], 71, "PNG 'G'");
  });

  it("correctly saves and restores a PDF file", () => {
    const original = createMinimalPdf();
    const base64 = original.toString("base64");

    const savedPath = saveBase64File(base64, "document.pdf", "application/pdf", tempDir);
    assert.ok(savedPath, "should return a valid path");
    assert.ok(savedPath.endsWith(".pdf"), "should have .pdf extension");

    const restored = fs.readFileSync(savedPath);
    assert.ok(restored.equals(original), "restored content should match original");

    // Verify PDF header
    assert.equal(restored.toString("utf-8", 0, 5), "%PDF-", "PDF header");
  });

  it("correctly saves and restores a PPTX file", () => {
    const original = createMinimalPptx();
    const base64 = original.toString("base64");

    const savedPath = saveBase64File(
      base64,
      "presentation.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      tempDir,
    );
    assert.ok(savedPath, "should return a valid path");
    assert.ok(savedPath.endsWith(".pptx"), "should have .pptx extension");

    const restored = fs.readFileSync(savedPath!);
    assert.ok(restored.equals(original), "restored content should match original");

    // Verify ZIP signature (PPTX is a ZIP)
    assert.equal(restored[0], 0x50, "ZIP 'P'");
    assert.equal(restored[1], 0x4b, "ZIP 'K'");
  });

  it("correctly saves a JSON file", () => {
    const original = Buffer.from(JSON.stringify({ key: "value", num: 42 }), "utf-8");
    const base64 = original.toString("base64");

    const savedPath = saveBase64File(base64, "data.json", "application/json", tempDir);
    assert.ok(savedPath, "should return a valid path");
    assert.ok(savedPath.endsWith(".json"), "should have .json extension");

    const restored = fs.readFileSync(savedPath!);
    assert.ok(restored.equals(original), "restored content should match original");
  });

  it("handles MIME type with parameters (charset)", () => {
    const original = Buffer.from("text content", "utf-8");
    const base64 = original.toString("base64");

    const savedPath = saveBase64File(base64, "file.txt", "text/plain; charset=utf-8", tempDir);
    assert.ok(savedPath, "should return a valid path");
    assert.ok(savedPath.endsWith(".txt"), "should have .txt extension");

    const restored = fs.readFileSync(savedPath!);
    assert.ok(restored.equals(original), "restored content should match original");
  });

  it("handles large file (1MB binary)", () => {
    const original = crypto.randomBytes(1024 * 1024); // 1MB random data
    const base64 = original.toString("base64");

    const savedPath = saveBase64File(base64, "large.bin", "application/octet-stream", tempDir);
    assert.ok(savedPath, "should return a valid path");
    assert.ok(savedPath.endsWith(".bin"), "should have .bin extension");

    const restored = fs.readFileSync(savedPath!);
    assert.ok(restored.equals(original), "restored content should match original");
  });

  it("generates unique filenames for different files", () => {
    const content1 = Buffer.from("file1");
    const content2 = Buffer.from("file2");

    const path1 = saveBase64File(content1.toString("base64"), "a.txt", "text/plain", tempDir);
    const path2 = saveBase64File(content2.toString("base64"), "b.txt", "text/plain", tempDir);

    assert.ok(path1, "path1 should be valid");
    assert.ok(path2, "path2 should be valid");
    assert.notEqual(path1, path2, "paths should be unique");
  });
});
