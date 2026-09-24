/** Incremental 64-bit (two-lane FNV-1a) hash over bytes, for determinism checks. */
export class StateHasher {
  private h1 = 0x811c9dc5;
  private h2 = 0x01000193 ^ 0x5bd1e995;

  bytes(b: Uint8Array): this {
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < b.length; i++) {
      h1 = Math.imul(h1 ^ b[i], 16777619);
      h2 = Math.imul(h2 ^ b[i], 2246822519);
    }
    this.h1 = h1;
    this.h2 = h2;
    return this;
  }

  typed(a: Float64Array | Int32Array | Uint8Array, length = a.length): this {
    return this.bytes(new Uint8Array(a.buffer, a.byteOffset, length * a.BYTES_PER_ELEMENT));
  }

  string(s: string): this {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      b[2 * i] = code & 255;
      b[2 * i + 1] = code >>> 8;
    }
    return this.bytes(b);
  }

  number(n: number): this {
    return this.typed(new Float64Array([n]));
  }

  digest(): string {
    return (this.h1 >>> 0).toString(16).padStart(8, '0') + (this.h2 >>> 0).toString(16).padStart(8, '0');
  }
}
