// @ts-expect-error The private agent-kit source package is materialized only during release builds.
import { scriptcAgentKitSourceFiles as embeddedSourceFiles } from 'noveltea-scriptc-agent-kit-source';

export const scriptcAgentKitSourceFiles = embeddedSourceFiles as Readonly<Record<string, string>>;
