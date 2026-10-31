// The part of fzstd 0.1.1's typings (lib/index.d.ts) the viewer uses; see fzstd.js.

/**
 * Decompresses Zstandard data.
 * @param dat The input data
 * @param buf The output buffer. Without it, exactly enough memory is allocated.
 */
export declare function decompress(dat: Uint8Array, buf?: Uint8Array): Uint8Array
