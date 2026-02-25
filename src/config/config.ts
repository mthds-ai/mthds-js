/**
 * Re-export from credentials module for backward compatibility.
 * All config is now stored in ~/.mthds/credentials (dotenv format).
 */
export {
  type MthdsCredentials as MthdsConfig,
  type CredentialSource,
  VALID_KEYS,
  resolveKey,
  loadCredentials as loadConfig,
  getCredentialValue as getConfigValue,
  setCredentialValue as setConfigValue,
  listCredentials as listConfig,
} from "./credentials.js";
