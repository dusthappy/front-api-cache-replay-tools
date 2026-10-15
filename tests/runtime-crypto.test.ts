import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256Hex } from '../src/content/sha256';

test('HTTP origin SHA-256 fallback matches standard vectors and block boundaries', () => {
  const encoder = new TextEncoder();
  for (const value of ['', 'abc', 'Bearer 开发用户令牌', 'a'.repeat(1_000_000)]) {
    assert.equal(sha256Hex(encoder.encode(value)), createHash('sha256').update(value).digest('hex'));
  }
  for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 255]) {
    const bytes = randomBytes(length);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
});
