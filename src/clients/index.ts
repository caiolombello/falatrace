import { CLIENTS_KNOWN_ERRORS } from "./build";
import { CLIENT_CATALOG_KNOWN_ERRORS } from "./catalog";
import { CLIENT_OVERRIDE_KNOWN_ERRORS } from "./overrides";

export * from "./resolve";
export * from "./overrides";
export * from "./catalog";
export * from "./build";

/** Every fixed message the clients module can show, for the bridge whitelist and translations. */
export const CLIENTS_MODULE_KNOWN_ERRORS: readonly string[] = [
  ...new Set([...CLIENT_CATALOG_KNOWN_ERRORS, ...CLIENT_OVERRIDE_KNOWN_ERRORS, ...CLIENTS_KNOWN_ERRORS])
];
