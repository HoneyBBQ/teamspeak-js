import type { Crypt } from "../crypto/crypt.js";
import { importPublicKey } from "../crypto/identity.js";
import { verifySign, getSharedSecret2 } from "../crypto/primitives.js";
import { parseLicenses } from "./license.js";

/**
 * CryptoInit2 performs the second stage of crypto initialization (Ed25519 ECDH).
 * Mirrors Go's handshake.CryptoInit2.
 */
export function cryptoInit2(
  crypt: Crypt,
  license: string,
  omega: string,
  proof: string,
  beta: string,
  privateKey: Uint8Array,
): void {
  if (crypt.alphaTmp.length === 0) {
    throw new Error("alpha is not initialized");
  }

  const licenseBytes = Buffer.from(license, "base64");
  const omegaBytes = Buffer.from(omega, "base64");
  const proofBytes = Buffer.from(proof, "base64");
  const betaBytes = Buffer.from(beta, "base64");

  const serverPubKey = importPublicKey(omegaBytes);
  if (!verifySign(serverPubKey, licenseBytes, proofBytes)) {
    throw new Error("init proof is not valid");
  }

  const licenses = parseLicenses(licenseBytes);
  const key = licenses.deriveKey();

  const sharedSecret = getSharedSecret2(key, privateKey);

  crypt.setSharedSecret(crypt.alphaTmp, betaBytes, sharedSecret);
}
