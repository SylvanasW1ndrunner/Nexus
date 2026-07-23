import { createHash } from 'node:crypto';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { LlmProviderError, type JsonSchema, type LlmTool, type LlmToolCall } from './types.js';

export type SchemaValidationIssue = {
  path: string;
  keyword: string;
  message: string;
};

export type StructuredOutputResult<T> = {
  value: T;
  repaired: boolean;
};

export class StructuredOutputValidator {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    });
  }

  parseAndValidate<T>(text: string, schema: JsonSchema): StructuredOutputResult<T> {
    const normalized = normalizeJsonText(text);
    let value: unknown;
    try {
      value = JSON.parse(normalized);
    } catch (error) {
      throw invalidStructuredOutput('Model response is not valid JSON.', [
        {
          path: '',
          keyword: 'parse',
          message: error instanceof Error ? error.message : 'Invalid JSON.',
        },
      ]);
    }
    this.assertValid(value, schema);
    return { value: value as T, repaired: normalized !== text.trim() };
  }

  assertValid(value: unknown, schema: JsonSchema): void {
    const validator = this.validatorFor(schema);
    if (validator(value)) return;
    throw invalidStructuredOutput('Model response does not satisfy the JSON Schema.', mapErrors(validator.errors));
  }

  validateToolCalls(toolCalls: LlmToolCall[], tools: LlmTool[]): void {
    const definitions = new Map(tools.map((tool) => [tool.name, tool]));
    for (const call of toolCalls) {
      const tool = definitions.get(call.name);
      if (!tool) {
        throw invalidStructuredOutput(`Model called an unknown tool: ${call.name}`, [
          { path: call.name, keyword: 'tool', message: 'Tool is not present in the request.' },
        ]);
      }
      try {
        this.assertValid(call.arguments, tool.inputSchema);
      } catch (error) {
        if (error instanceof LlmProviderError) {
          throw invalidStructuredOutput(`Tool arguments are invalid: ${call.name}`, [
            {
              path: call.name,
              keyword: 'tool_arguments',
              message: error.message,
            },
          ]);
        }
        throw error;
      }
    }
  }

  correctionInstruction(error: LlmProviderError): string {
    const issues = Array.isArray(error.detail?.issues)
      ? (error.detail.issues as SchemaValidationIssue[])
          .slice(0, 8)
          .map((issue) => `${issue.path || '/'}: ${issue.message}`)
          .join('; ')
      : error.message;
    return `Your previous output was rejected by JSON Schema validation. Return only corrected JSON. Problems: ${issues}`;
  }

  private validatorFor(schema: JsonSchema): ValidateFunction {
    const key = createHash('sha256').update(stableStringify(schema)).digest('hex');
    const existing = this.validators.get(key);
    if (existing) return existing;
    let validator: ValidateFunction;
    try {
      validator = this.ajv.compile(schema);
    } catch (error) {
      throw new Error(`Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.validators.set(key, validator);
    return validator;
  }
}

function normalizeJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function mapErrors(errors: ErrorObject[] | null | undefined): SchemaValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'Schema validation failed.',
  }));
}

function invalidStructuredOutput(message: string, issues: SchemaValidationIssue[]): LlmProviderError {
  return new LlmProviderError('LLM_STRUCTURED_OUTPUT_INVALID', message, false, undefined, { issues });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
