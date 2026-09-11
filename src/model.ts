import { BedrockModel, type Model, type BaseModelConfig } from "@strands-agents/sdk";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";

export const BEDROCK_MODEL_ID = process.env.MODEL_ID ?? "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
const ANTHROPIC_MODEL_ID = process.env.ANTHROPIC_MODEL_ID ?? "claude-sonnet-4-5";

/**
 * Provider-agnostic brain: Bedrock when AWS credentials are configured,
 * direct Anthropic API when ANTHROPIC_API_KEY is set. Same Claude either way.
 */
export function createModel(maxTokens: number): Model<BaseModelConfig> {
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicModel({ modelId: ANTHROPIC_MODEL_ID, apiKey: process.env.ANTHROPIC_API_KEY, maxTokens, temperature: 0 });
  }
  return new BedrockModel({ modelId: BEDROCK_MODEL_ID, maxTokens, temperature: 0 });
}
