import { getLLM } from "../../llm/factory";
import { invokeStructuredLlmDetailed } from "../../llm/structuredInvoke";
import {
  executeStructuredPrompt,
  type PromptRunnerStructuredInvoker,
} from "../execution/StructuredPromptExecutor";
import {
  executeTextPrompt,
  type PromptRunnerLLMFactory,
} from "../execution/TextPromptExecutor";
import {
  preparePromptExecution,
  type PromptContextBlocks,
} from "../execution/PromptExecutionPreparation";
import { executeStructuredPromptStream } from "../streaming/StructuredPromptStreamExecutor";
import { executeTextPromptStream } from "../streaming/TextPromptStreamExecutor";
import type {
  PromptAsset,
  PromptExecutionOptions,
  PromptRunResult,
  PromptStreamRunResult,
} from "./promptTypes";

let promptRunnerLLMFactory: PromptRunnerLLMFactory = getLLM;
let promptRunnerStructuredInvoker: PromptRunnerStructuredInvoker = invokeStructuredLlmDetailed;

export { preparePromptExecution };

export async function runStructuredPrompt<I, O, R = O>(input: {
  asset: PromptAsset<I, O, R>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
}): Promise<PromptRunResult<O>> {
  return executeStructuredPrompt({
    ...input,
    structuredInvoker: promptRunnerStructuredInvoker,
  });
}

export async function runTextPrompt<I>(input: {
  asset: PromptAsset<I, string, string>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
}): Promise<PromptRunResult<string>> {
  return executeTextPrompt({
    ...input,
    llmFactory: promptRunnerLLMFactory,
  });
}

export async function streamTextPrompt<I>(input: {
  asset: PromptAsset<I, string, string>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
}): Promise<PromptStreamRunResult<string>> {
  return executeTextPromptStream({
    ...input,
    llmFactory: promptRunnerLLMFactory,
  });
}

export async function streamStructuredPrompt<I, O, R = O>(input: {
  asset: PromptAsset<I, O, R>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
}): Promise<PromptStreamRunResult<O>> {
  return executeStructuredPromptStream({
    ...input,
    llmFactory: promptRunnerLLMFactory,
    structuredInvoker: promptRunnerStructuredInvoker,
  });
}

export function setPromptRunnerLLMFactoryForTests(factory?: PromptRunnerLLMFactory): void {
  promptRunnerLLMFactory = factory ?? getLLM;
}

export function setPromptRunnerStructuredInvokerForTests(
  invoker?: PromptRunnerStructuredInvoker,
): void {
  promptRunnerStructuredInvoker = invoker ?? invokeStructuredLlmDetailed;
}
