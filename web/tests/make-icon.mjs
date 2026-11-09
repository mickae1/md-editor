// Generates assets/mdeditor.ico (embedded 256 PNG) from assets/icon.svg.
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'
const svg = readFileSync('../assets/icon.svg', 'utf8')
const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 256, height: 256 } })
await p.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body>`)
const png = await p.screenshot({ omitBackground: true })
await b.close()
const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
header.writeUInt8(0, 6); header.writeUInt8(0, 7); header.writeUInt8(0, 8); header.writeUInt8(0, 9)
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)
writeFileSync('../assets/mdeditor.ico', Buffer.concat([header, png]))
console.log('icon written')
