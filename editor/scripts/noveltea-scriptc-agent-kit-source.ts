// @ts-expect-error The private agent-kit source package is materialized only during release builds.
import * as embeddedAgentKitSource from 'noveltea-scriptc-agent-kit-source';

export const scriptcAgentKitSourceFiles =
  embeddedAgentKitSource.scriptcAgentKitSourceFiles as Readonly<Record<string, string>>;
export const scriptcAgentKitProvenance =
  embeddedAgentKitSource.scriptcAgentKitProvenance as unknown;
