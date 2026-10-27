const fs = require('fs');
const iconv = require('iconv-lite');

const bytes = fs.readFileSync('C:/Users/Think/project/BingDashan/server.js');

// The garbled text looks like UTF-8 bytes interpreted as GBK
// Current file: garbled_utf8_bytes (what we have)
// Original file: original_utf8_bytes
// The corruption: original_utf8_bytes -> (decode as GBK) -> garbled_string -> (encode as UTF-8) -> garbled_utf8_bytes

// So: current_bytes = UTF8(GBK_DECODE(original_utf8_bytes))
// To recover: original_utf8_bytes = GBK_ENCODE(UTF8_DECODE(current_bytes))

const garbledString = iconv.decode(bytes, 'utf8');
console.log('Garbled sample:', garbledString.slice(0, 100));

// Encode the garbled string as GBK to get back original UTF-8 bytes
try {
  const originalBytes = iconv.encode(garbledString, 'gbk');
  const original = iconv.decode(originalBytes, 'utf8');
  console.log('Recovered sample:', original.slice(0, 200));
  fs.writeFileSync('C:/Users/Think/project/BingDashan/server.js', original, 'utf8');
  console.log('Recovery written');
} catch (e) {
  console.error('Recovery failed:', e.message);
}

// Also try: maybe the file was read as UTF-8 but written with a different encoding
// Try: current is UTF-8 bytes that represent GBK-encoded original
// i.e., original_string -> GBK_ENCODE -> bytes -> (misread as UTF-8) -> garbled_string -> UTF-8_ENCODE -> current_bytes
// So: current_bytes = UTF8(GBK(original_string))
// Recover: original_string = GBK_DECODE(UTF8_DECODE(current_bytes))

try {
  const altRecovered = iconv.decode(bytes, 'gbk');
  console.log('Alt recovery sample:', altRecovered.slice(0, 200));
} catch (e) {
  console.error('Alt failed:', e.message);
}