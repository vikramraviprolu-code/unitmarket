export const PACKAGE_NAME = '@umsbx/model' as const;
export { AGENT_TOOLS, BRIEF_SYSTEM, COMPOSE_SYSTEM } from './prompts';
export { BriefParseOutputSchema, ComposeOutputSchema } from './schemas';
export type { BriefParseOutput, ComposeInput, ComposeOutput } from './schemas';
export { parseBrief } from './parse-brief';
export { composePack } from './compose';
export { dispatchTool, sanitiseModelOutput } from './tools';
export { createScriptedModel } from './scripted';
// AI-A (D-067): the Claude adapter and its spend rules. Built by composition only when UMS_AI_ADAPTER=claude.
export { CLAUDE_MODEL_ID, createClaudeModel } from './claude';
export type { ClaudeModelDeps } from './claude';
export { DAILY_CAP_MICRO_USD, TOTAL_CAP_MICRO_USD } from './caps';
