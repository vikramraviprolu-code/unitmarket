export const PACKAGE_NAME = '@umsbx/model' as const;
export { AGENT_TOOLS, BRIEF_SYSTEM, COMPOSE_SYSTEM } from './prompts';
export { BriefParseOutputSchema, ComposeOutputSchema } from './schemas';
export type { BriefParseOutput, ComposeInput, ComposeOutput } from './schemas';
export { parseBrief } from './parse-brief';
export { composePack } from './compose';
export { dispatchTool, sanitiseModelOutput } from './tools';
export { createScriptedModel } from './scripted';
