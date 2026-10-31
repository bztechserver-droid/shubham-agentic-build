import { createHash } from 'node:crypto'

// A Windows pointer shape as RGBA (F-006), ported from RustDesk 1.5.0's get_cursor_data
// (src/platform/windows.rs:262-330, with handleMask and drawOutline from src/platform/windows.cc:
// 361-455, themselves from TigerVNC and noVNC). Pure, so the tests can feed it bitmaps.
//
// One deliberate difference: for a colour shape without alpha, RustDesk's fix_cursor_mask
// swaps red and blue on the way out (windows.rs:533-538) after get_di_bits has already put the
// bytes in RGBA order; here the colours stay as Windows drew them.

export interface CursorBitmaps {
  /** The shape's size: the colour bitmap's, or half the mask's height for a monochrome one. */
  width: number
  height: number
  /** The 1-bit mask as GetBitmapBits gives it: AND rows (and for monochrome, XOR rows below them). */
  mask: Uint8Array
  /** Bytes per mask row (BITMAP.bmWidthBytes). */
  maskStride: number
  /** The colour bitmap as top-down 32-bit BGRA (GetDIBits, BI_RGB), or null for a monochrome shape. */
  bgra: Uint8Array | null
  hotx: number
  hoty: number
}

export interface CursorImage {
  /** Names the content (RustDesk 1.5.0 does the same, common.rs:152-157): equal shapes, equal ids. */
  id: string
  width: number
  height: number
  hotx: number
  hoty: number
  rgba: Uint8Array
}

const bitAt = (bits: Uint8Array, stride: number, x: number, y: number) => {
  const byte = y * stride + (x >> 3)
  return byte < bits.length ? (bits[byte] >> (7 - (x & 7))) & 1 : 0
}

/**
 * A white outline one pixel wide around every visible pixel, on a canvas 2 pixels larger each
 * way (drawOutline): what makes a black XOR shape such as the I-beam visible on a dark background.
 */
function outline(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const W = w + 2
  const out = new Uint8Array(W * (h + 2) * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] === 0) continue
      for (let dy = 0; dy < 3; dy++) out.fill(0xff, ((y + dy) * W + x) * 4, ((y + dy) * W + x + 3) * 4)
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (rgba[i + 3] > 0) out.set(rgba.subarray(i, i + 4), ((y + 1) * W + x + 1) * 4)
    }
  }
  return out
}

/** The shape as RGBA, with its hotspot; null when it is too small or too large to send. */
export function cursorImage(b: CursorBitmaps): CursorImage | null {
  let { width: w, height: h, hotx, hoty } = b
  if (w * h < 4 || w > 510 || h > 510) return null
  let rgba: Uint8Array = new Uint8Array(w * h * 4)
  let drawOutline = false

  if (b.bgra) {
    let alpha = false
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = b.bgra[i * 4 + 2]
      rgba[i * 4 + 1] = b.bgra[i * 4 + 1]
      rgba[i * 4 + 2] = b.bgra[i * 4]
      rgba[i * 4 + 3] = b.bgra[i * 4 + 3]
      if (b.bgra[i * 4 + 3]) alpha = true
    }
    if (!alpha) {
      // No alpha: the AND mask says what shows (0 = the shape). Where it says "screen" but the
      // colour isn't black, Windows would invert the screen; that becomes black (fix_cursor_mask).
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const shows = bitAt(b.mask, b.maskStride, x, y) === 0
          const inverts = !shows && (rgba[i] | rgba[i + 1] | rgba[i + 2]) !== 0
          if (inverts) rgba.fill(0, i, i + 3)
          rgba[i + 3] = shows || inverts ? 0xff : 0
        }
      }
      drawOutline = true
    }
  } else {
    // Monochrome: AND rows, then XOR rows (handleMask). AND 0: black or white by XOR;
    // AND 1 and XOR 1: inverted screen, drawn black with an outline; else transparent.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const and = bitAt(b.mask, b.maskStride, x, y)
        const xor = bitAt(b.mask, b.maskStride, x, y + h)
        if (and === 0) {
          rgba.fill(xor ? 0xff : 0, i, i + 3)
          rgba[i + 3] = 0xff
        } else if (xor) {
          rgba[i + 3] = 0xff
          drawOutline = true
        }
      }
    }
  }

  if (drawOutline) {
    rgba = outline(rgba, w, h)
    w += 2
    h += 2
    hotx += 1
    hoty += 1
  }
  hotx = Math.min(Math.max(0, hotx), w - 1)
  hoty = Math.min(Math.max(0, hoty), h - 1)
  const digest = createHash('sha256').update(rgba).update(`${w}x${h}@${hotx},${hoty}`).digest()
  // 48 bits: an exact JS number, sent as RustDesk's uint64.
  const id = String(digest.readUIntBE(0, 6))
  return { id, width: w, height: h, hotx, hoty, rgba }
}
