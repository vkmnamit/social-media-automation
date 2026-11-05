import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class TokenVault {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error("Token vault key must be exactly 32 bytes");
    }
    this.key = key;
  }

  encrypt(value) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("Only non-empty string tokens can be encrypted");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return {
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(envelope) {
    if (
      envelope?.version !== 1 ||
      typeof envelope.nonce !== "string" ||
      typeof envelope.ciphertext !== "string" ||
      typeof envelope.tag !== "string"
    ) {
      throw new Error("Unsupported or malformed encrypted token");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
