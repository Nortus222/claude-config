import { decodeOperationOutput, type OperationInput, type OperationName, type OperationOutput } from '@nortuscc/agent/operations';
import type { Bridge } from './bridge.ts';

export const OPERATION_MAX_BYTES = 1_048_576;

export async function operation<N extends OperationName>(bridge: Bridge, name: N, input: OperationInput<N>): Promise<{ generation: number; data: OperationOutput<N> }> {
  const result = await bridge.invoke('operation', { name, input });
  try {
    return { generation: result.generation, data: decodeOperationOutput(name, result.data) };
  } catch {
    throw new Error('Invalid operation response');
  }
}
