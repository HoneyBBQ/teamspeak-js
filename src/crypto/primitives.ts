import { createSign, createVerify, createHash, randomBytes, type KeyObject } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const CURVE25519_KEY_SIZE = 32;
const CLAMP_MASK_LOW = 248;
const CLAMP_MASK_HIGH = 127;
const CLAMP_HIGH_BIT = 64;
const SHARED_SIGN_BIT = 0x80;
const PRIVATE_KEY_TOP_MASK = 0x7f;

/** Clamp a Curve25519 scalar in-place (required before scalar multiplication). */
export function clampScalar(key: Uint8Array): void {
  if (key.length < CURVE25519_KEY_SIZE) return;
  key[0] = (key[0] ?? 0) & CLAMP_MASK_LOW;
  key[CURVE25519_KEY_SIZE - 1] =
    ((key[CURVE25519_KEY_SIZE - 1] ?? 0) & CLAMP_MASK_HIGH) | CLAMP_HIGH_BIT;
}

/**
 * Generate an ephemeral Ed25519 key pair for the TS3 handshake.
 * Returns [publicKey (32 bytes, RFC-8032 encoded), privateKey (32 bytes)].
 */
export function generateTemporaryKey(): [Uint8Array, Uint8Array] {
  const privateKey = new Uint8Array(randomBytes(CURVE25519_KEY_SIZE));
  clampScalar(privateKey);

  // Base point G is in the prime-order subgroup, so G*s = G*(s mod n).
  // Safe to reduce here since G has no small-order component.
  const scalar = bytesToBigIntLE(privateKey) % ed25519.Point.CURVE().n;
  const publicKey = ed25519.Point.BASE.multiply(scalar).toBytes();

  return [publicKey, Uint8Array.from(privateKey)];
}

/**
 * Sign data with a P-256 private key (SHA-256 hash, ASN.1 DER encoded).
 */
export function sign(privateKey: KeyObject, data: Uint8Array): Uint8Array {
  const signer = createSign("SHA256");
  signer.update(data);
  return signer.sign(privateKey);
}

/**
 * Verify a P-256 ECDSA signature (SHA-256 hash, ASN.1 DER encoded).
 */
export function verifySign(publicKey: KeyObject, data: Uint8Array, sig: Uint8Array): boolean {
  try {
    const verifier = createVerify("SHA256");
    verifier.update(data);
    return verifier.verify(publicKey, Buffer.from(sig));
  } catch {
    return false;
  }
}

/**
 * TS3-specific shared secret derivation using Ed25519 point arithmetic.
 * Mirrors NaCl's ge_scalarmult_vartime:
 *   1. Negate the public point
 *   2. Scalar-multiply by clamped private key bytes (NOT reduced mod n)
 *   3. Flip sign bit of result
 *   4. SHA-512 the resulting point bytes
 *
 * IMPORTANT: Must use multiplyUnsafe with the raw scalar (not reduced mod n)
 * because the derived key may contain a small-order component (cofactor 8).
 * Reducing mod n loses this component and produces a different result.
 */
export function getSharedSecret2(
  publicKeyBytes: Uint8Array,
  privateKeyBytes: Uint8Array,
): Uint8Array {
  if (
    publicKeyBytes.length !== CURVE25519_KEY_SIZE ||
    privateKeyBytes.length !== CURVE25519_KEY_SIZE
  ) {
    throw new Error("invalid key length");
  }

  const privCopy = Uint8Array.from(privateKeyBytes);
  privCopy[CURVE25519_KEY_SIZE - 1] =
    (privCopy[CURVE25519_KEY_SIZE - 1] ?? 0) & PRIVATE_KEY_TOP_MASK;

  // Use raw scalar WITHOUT reducing mod n — matches NaCl's ge_scalarmult_vartime.
  // Ed25519 has cofactor 8, so P*s ≠ P*(s mod n) when P has a small-order component.
  // Since @noble/curves rejects scalars >= n, we decompose: P*s = P*(s%n) + (P*n)*q
  const rawScalar = bytesToBigIntLE(privCopy);

  const pub = ed25519.Point.fromBytes(publicKeyBytes);
  const negPub = pub.negate();

  const sharedPoint = scalarMultFull(negPub, rawScalar);
  const sharedBytes = sharedPoint.toBytes();

  // Flip sign bit (mirrors Go: shared[31] ^= 0x80)
  sharedBytes[CURVE25519_KEY_SIZE - 1] =
    (sharedBytes[CURVE25519_KEY_SIZE - 1] ?? 0) ^ SHARED_SIGN_BIT;

  return createHash("sha512").update(sharedBytes).digest();
}

// ---- Internal ---------------------------------------------------------------

/**
 * Multiply an Ed25519 point by a scalar that may be >= curve order n.
 * Decomposes as: P*s = P*(s mod n) + (P*n)*q  where q = floor(s/n).
 * This preserves the small-order component (cofactor 8) that would be
 * lost by reducing mod n first.
 */
export function scalarMultFull(
  point: InstanceType<typeof ed25519.Point>,
  scalar: bigint,
): InstanceType<typeof ed25519.Point> {
  const n = ed25519.Point.CURVE().n;
  if (scalar < n) {
    return scalar === 0n ? ed25519.Point.ZERO : point.multiply(scalar);
  }
  const remainder = scalar % n;
  const quotient = scalar / n; // integer division

  // P * (s mod n)
  let result = remainder === 0n ? ed25519.Point.ZERO : point.multiply(remainder);

  // P * n = P * (n-1) + P  (since multiply rejects n directly)
  if (quotient > 0n) {
    const pointTimesN = point.multiply(n - 1n).add(point);
    for (let i = 0n; i < quotient; i++) {
      result = result.add(pointTimesN);
    }
  }

  return result;
}

/** Interpret a little-endian byte array as an unsigned BigInt. */
export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}
