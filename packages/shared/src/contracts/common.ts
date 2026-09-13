export const CURRENT_CONTRACT_VERSION = '1.0' as const;
export const SUPPORTED_CONTRACT_VERSIONS = [CURRENT_CONTRACT_VERSION] as const;

export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];

export type ContractEnvelope<T> = {
  contract: string;
  version: ContractVersion;
  payload: T;
};

export type PortableScalar = string | number | boolean | null;

export type PortableTaggedValue =
  | {
      $schemanautType: 'bigint';
      value: string;
    }
  | {
      $schemanautType: 'datetime';
      value: string;
    }
  | {
      $schemanautType: 'binary';
      encoding: 'base64';
      value: string;
    };

export type PortableValue =
  | PortableScalar
  | PortableTaggedValue
  | PortableValue[]
  | { [key: string]: PortableValue };

export type OperationOutcome = 'unchanged' | 'changed' | 'unknown';

export type PublicErrorBase = {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  outcome?: OperationOutcome;
  recovery?: string;
};

export type ContractValidationIssue = {
  code:
    | 'INVALID_TYPE'
    | 'MISSING_FIELD'
    | 'INVALID_VALUE'
    | 'INVALID_TIME'
    | 'UNSUPPORTED_VERSION'
    | 'NON_PORTABLE_VALUE';
  path: string;
  message: string;
};

export function createContractEnvelope<T>(
  contract: string,
  payload: T,
  version: ContractVersion = CURRENT_CONTRACT_VERSION,
): ContractEnvelope<T> {
  if (!contract.trim()) {
    throw new Error('Contract name cannot be empty');
  }
  return { contract, version, payload };
}
