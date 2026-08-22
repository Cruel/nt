// @ts-expect-error The private built-in workflow package is materialized only during release builds.
import * as embeddedComfyUiWorkflows from 'noveltea-scriptc-comfyui-workflows';

export const scriptcComfyUiWorkflowFiles =
  embeddedComfyUiWorkflows.scriptcComfyUiWorkflowFiles as Readonly<Record<string, string>>;
