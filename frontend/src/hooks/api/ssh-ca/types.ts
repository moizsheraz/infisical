import { CertKeyAlgorithm } from "../certificates/enums";
import { SshCaStatus } from "./enums";

export type TSshCertificateAuthority = {
  id: string;
  orgId: string;
  status: SshCaStatus;
  friendlyName: string;
  keyAlgorithm: CertKeyAlgorithm;
  createdAt: string;
  updatedAt: string;
  publicKey: string;
};

export type TCreateSshCaDTO = {
  friendlyName?: string;
  keyAlgorithm: CertKeyAlgorithm;
};

export type TUpdateSshCaDTO = {
  caId: string;
  friendlyName?: string;
  status?: SshCaStatus;
};

export type TDeleteSshCaDTO = {
  caId: string;
};
