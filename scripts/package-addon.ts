// Builds dist/AHTracker-<version>.zip (unzip it into Interface/AddOns/ to install the addon by hand).
// Plain Node, no zip tool needed, so it works the same on Windows, macOS and Linux.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const addon = join(root, "addon", "AHTracker");
const version = /^## Version:\s*(\S+)/m.exec(readFileSync(join(addon, "AHTracker.toc"), "utf8"))?.[1] ?? "dev";

function dosTime(d: Date): [number, number] {
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}

const local: Buffer[] = [], central: Buffer[] = [];
let offset = 0;
for (const name of readdirSync(addon).sort()) {
  const path = join(addon, name);
  const data = readFileSync(path);
  const packed = deflateRawSync(data);
  const fileName = Buffer.from(`AHTracker/${name}`);
  const [time, date] = dosTime(statSync(path).mtime);
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
  head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(fileName.length, 26);
  local.push(head, fileName, packed);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
  dir.writeUInt16LE(time, 12); dir.writeUInt16LE(date, 14); dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(fileName.length, 28);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, fileName);
  offset += head.length + fileName.length + packed.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);

mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", `AHTracker-${version}.zip`);
writeFileSync(out, Buffer.concat([...local, centralBuf, end]));
console.log(`wrote ${out}`);
