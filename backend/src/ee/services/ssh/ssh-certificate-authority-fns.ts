import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import ms from "ms";

import { TSshCertificateTemplates } from "@app/db/schemas";
import { BadRequestError } from "@app/lib/errors";
import { CertKeyAlgorithm } from "@app/services/certificate/certificate-types";

import {
  isValidHostPattern,
  isValidUserPattern
} from "../ssh-certificate-template/ssh-certificate-template-validators";
import { SshCertType, TCreateSshCertDTO } from "./ssh-certificate-authority-types";

/* eslint-disable no-bitwise */
export const createSshCertSerialNumber = () => {
  const randomBytes = crypto.randomBytes(8); // 8 bytes = 64 bits
  randomBytes[0] &= 0x7f; // Ensure the most significant bit is 0 (to stay within unsigned range)
  return BigInt(`0x${randomBytes.toString("hex")}`).toString(10); // Convert to decimal
};

/**
 * Return a pair of SSH CA keys based on the specified key algorithm [keyAlgorithm].
 * We use this function because the key format generated by `ssh-keygen` is unique.
 */
export const createSshKeyPair = (keyAlgorithm: CertKeyAlgorithm, comment: string) => {
  const uniqueId = crypto.randomBytes(8).toString("hex"); // to avoid collions if high-volume key generation
  const privateKeyFile = `ssh_key_${uniqueId}`; // temp key path
  const publicKeyFile = `${privateKeyFile}.pub`;

  if (fs.existsSync(publicKeyFile)) fs.unlinkSync(publicKeyFile);
  if (fs.existsSync(privateKeyFile)) fs.unlinkSync(privateKeyFile);

  let keyType = "";
  let keyBits = "";

  switch (keyAlgorithm) {
    case CertKeyAlgorithm.RSA_2048:
      keyType = "rsa";
      keyBits = "2048";
      break;
    case CertKeyAlgorithm.RSA_4096:
      keyType = "rsa";
      keyBits = "4096";
      break;
    case CertKeyAlgorithm.ECDSA_P256:
      keyType = "ecdsa";
      keyBits = "256";
      break;
    case CertKeyAlgorithm.ECDSA_P384:
      keyType = "ecdsa";
      keyBits = "384";
      break;
    default:
      throw new Error("Failed to produce SSH CA key pair generation command due to unrecognized key algorithm");
  }

  execSync(`ssh-keygen -t ${keyType} -b ${keyBits} -f ${privateKeyFile} -N '' -C "${comment}"`);

  const publicKey = fs.readFileSync(publicKeyFile, "utf8");
  const privateKey = fs.readFileSync(privateKeyFile, "utf8");

  fs.unlinkSync(privateKeyFile);
  fs.unlinkSync(publicKeyFile);

  return { publicKey, privateKey };
};

/**
 * Return the SSH public key for the given SSH private key.
 * @param privateKey - The SSH private key to get the public key for
 */
export const getSshPublicKey = (privateKey: string) => {
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const privateKeyFile = `ssh_key_${uniqueId}`;
  const publicKeyFile = `${privateKeyFile}.pub`;

  if (fs.existsSync(publicKeyFile)) fs.unlinkSync(publicKeyFile);
  if (fs.existsSync(privateKeyFile)) fs.unlinkSync(privateKeyFile);

  fs.writeFileSync(privateKeyFile, privateKey);
  fs.chmodSync(privateKeyFile, 0o600);

  const command = `ssh-keygen -y -f ${privateKeyFile} > ${publicKeyFile}`;
  execSync(command);

  const publicKey = fs.readFileSync(publicKeyFile, "utf8");

  fs.unlinkSync(privateKeyFile);
  fs.unlinkSync(publicKeyFile);

  return publicKey;
};

/**
 * Validate the requested SSH certificate type based on the SSH certificate template configuration.
 * @param template - The SSH certificate template configuration
 * @param certType - The SSH certificate type
 */
export const validateSshCertificateType = (template: TSshCertificateTemplates, certType: SshCertType) => {
  if (!template.allowUserCertificates && certType === SshCertType.USER) {
    throw new BadRequestError({ message: "Failed to validate user certificate type due to template restriction" });
  }

  if (!template.allowHostCertificates && certType === SshCertType.HOST) {
    throw new BadRequestError({ message: "Failed to validate host certificate type due to template restriction" });
  }
};

/**
 * Validate the requested SSH certificate principals based on the SSH certificate template configuration.
 * @param certType - The SSH certificate type
 * @param template - The SSH certificate template configuration
 * @param principals - The requested SSH certificate principals
 * @returns The validated SSH certificate principals
 */
export const validateSshCertificatePrincipals = (
  certType: SshCertType,
  template: TSshCertificateTemplates,
  principals: string[]
) => {
  switch (certType) {
    case SshCertType.USER: {
      const allowsAllUsers = template.allowedUsers?.includes("*") ?? false;
      return principals.every((principal) => {
        if (principal === "*") return false;
        if (allowsAllUsers) return isValidUserPattern(principal);
        return template.allowedUsers?.includes(principal);
      });
    }
    case SshCertType.HOST: {
      const allowsAllHosts = template.allowedHosts?.includes("*") ?? false;
      return principals.every((principal) => {
        if (principal.includes("*")) return false;
        if (allowsAllHosts) return isValidHostPattern(principal);

        // Validate against allowed domains
        return (
          isValidHostPattern(principal) &&
          template.allowedHosts?.some((allowedHost) => {
            if (allowedHost.startsWith("*.")) {
              // Match subdomains of a wildcard domain
              const baseDomain = allowedHost.slice(2); // Remove the leading "*."
              return principal.endsWith(`.${baseDomain}`);
            }

            // Exact match for non-wildcard domains
            return principal === allowedHost;
          })
        );
      });
    }
    default:
      throw new BadRequestError({
        message: "Failed to validate SSH certificate principals due to unrecognized requested certificate type"
      });
  }
};

/**
 * Validate the requested SSH certificate TTL based on the SSH certificate template configuration.
 * @param template - The SSH certificate template configuration
 * @param ttl - The TTL to validate
 * @returns The TTL (in seconds) to use for issuing the SSH certificate
 */
export const validateSshCertificateTtl = (template: TSshCertificateTemplates, ttl: string | undefined) => {
  if (!ttl) {
    // use default template ttl
    return ms(template.ttl);
  }

  if (ms(ttl) > ms(template.maxTTL)) {
    throw new BadRequestError({
      message: "Failed TTL validation due to TTL being greater than configured max TTL on template"
    });
  }

  return ms(ttl) / 1000;
};

/**
 * Create an SSH certificate for a user or host.
 */
export const createSshCert = ({ caPrivateKey, userPublicKey, keyId, principals, ttl, certType }: TCreateSshCertDTO) => {
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const publicKeyFile = `user_key_${uniqueId}.pub`;
  const privateKeyFile = `ssh_ca_key_${uniqueId}`;
  const signedPublicKeyFile = `user_key_${uniqueId}-cert.pub`;

  if (fs.existsSync(publicKeyFile)) fs.unlinkSync(publicKeyFile);
  if (fs.existsSync(privateKeyFile)) fs.unlinkSync(privateKeyFile);
  if (fs.existsSync(signedPublicKeyFile)) fs.unlinkSync(signedPublicKeyFile);

  // write public and private keys to temp files
  fs.writeFileSync(publicKeyFile, userPublicKey);
  fs.writeFileSync(privateKeyFile, caPrivateKey);
  fs.chmodSync(privateKeyFile, 0o600);

  const serialNumber = createSshCertSerialNumber();

  const certOptions = [
    `-s ${privateKeyFile}`, // path to SSH CA private key
    `-I "${keyId}"`, // identity for the issued certificate (key id)
    `-n "${principals.join(",")}"`, // principal(s) that is user(s) or host(s)
    `-V +${ttl}s`, // TTL in seconds (validity period) for the issue certificate
    `-z ${serialNumber}`, // custom serial number for certificate
    certType === "host" ? "-h" : "", // host certificate flag
    publicKeyFile // path to signed [publicKey]
  ]
    .filter(Boolean)
    .join(" ");

  const command = `ssh-keygen ${certOptions}`;

  // Execute the signing process
  execSync(command);

  const signedPublicKey = fs.readFileSync(signedPublicKeyFile, "utf8");

  fs.unlinkSync(publicKeyFile);
  fs.unlinkSync(privateKeyFile);
  fs.unlinkSync(signedPublicKeyFile);

  return { serialNumber, signedPublicKey };
};
